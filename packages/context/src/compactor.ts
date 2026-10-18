/**
 * HistoryCompactor.
 * Two levels: structural elision of tool-results (0 tokens, spill to disk BEFORE
 * replacement) → LLM-summary only if structural is not enough. A summarize error →
 * tail-truncation fallback + ERROR log; maybeCompact never throws
 * (pi-agent-core hooks contract).
 */
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ContextBudget } from "./budget.ts";
import { type Logger, NOOP_LOGGER } from "./logger.ts";

export interface CompactionDeps {
	/** LLM summarization via the router's cheap alias ("cheap"). */
	summarize: (transcript: string, signal?: AbortSignal) => Promise<string>;
	spillDir: string; // ~/.vanrel/spill/<sessionId>/
	estimateTokens: (messages: unknown[]) => number; // estimateContextTokens from @vanrel/ai
	log?: Logger;
}

/** Default for CompactionOptions.triggerRatio (§6.3). Exported — single source for the wiring predicate (W14). */
export const DEFAULT_TRIGGER_RATIO = 0.8;

export interface CompactionOptions {
	triggerRatio?: number; // default DEFAULT_TRIGGER_RATIO (0.8) — fraction of H_max at which compaction starts
	keepLastTurns?: number; // default 6 — the last N turns are never touched
	summaryMaxTokens?: number; // default 2000 — cap on the summary (instruction to the summarize prompt)
}

export interface CompactionResult {
	compacted: boolean;
	level?: "structural" | "llm" | "truncation"; // which level fired (§6.3)
	messages: unknown[];
	summary?: string;
	spilledTo?: string; // path to chunk-<n>.json with the RAW history (disk, 0 tokens)
	tokensBefore: number;
	tokensAfter: number;
}

interface MessageLike {
	role?: unknown;
	content?: unknown;
	toolCallId?: unknown;
	toolName?: unknown;
	[key: string]: unknown;
}

const isObject = (v: unknown): v is MessageLike => typeof v === "object" && v !== null;

/** AbortError from DOMException/custom controllers — checked by name (cross-realm safe). */
const isAbortError = (err: unknown): boolean => isObject(err) && err.name === "AbortError";

function isToolResult(m: unknown): boolean {
	return isObject(m) && m.role === "toolResult";
}

/** Turn = a sequence starting with a user message. Returns the start index of the keepLastTurns tail. */
export function findKeepCutIndex(messages: unknown[], keepLastTurns: number): number {
	const userIdx: number[] = [];
	for (let i = 0; i < messages.length; i++) {
		const m = messages[i];
		if (isObject(m) && m.role === "user") userIdx.push(i);
	}
	if (userIdx.length === 0) return Math.max(0, messages.length - keepLastTurns);
	if (userIdx.length <= keepLastTurns) return 0;
	return userIdx[userIdx.length - keepLastTurns];
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		let out = "";
		for (const block of content) {
			if (isObject(block) && block.type === "text" && typeof block.text === "string") out += block.text;
		}
		return out;
	}
	return "";
}

function renderTranscript(messages: unknown[]): string {
	const lines: string[] = [];
	for (const m of messages) {
		if (!isObject(m)) continue;
		const role = typeof m.role === "string" ? m.role : "unknown";
		if (isToolResult(m)) {
			lines.push(`[tool_result ${typeof m.toolName === "string" ? m.toolName : "tool"}] ${contentText(m.content)}`);
		} else {
			lines.push(`[${role}] ${contentText(m.content)}`);
		}
	}
	return lines.join("\n");
}

export class HistoryCompactor {
	private readonly deps: CompactionDeps;
	private readonly log: Logger;
	private readonly triggerRatio: number;
	private readonly keepLastTurns: number;
	private readonly summaryMaxTokens: number;
	private nextChunk: number | null = null;

	constructor(deps: CompactionDeps, options?: CompactionOptions) {
		this.deps = deps;
		this.log = deps.log ?? NOOP_LOGGER;
		this.triggerRatio = options?.triggerRatio ?? DEFAULT_TRIGGER_RATIO;
		this.keepLastTurns = options?.keepLastTurns ?? 6;
		this.summaryMaxTokens = options?.summaryMaxTokens ?? 2000;
	}

	/** Next free chunk-<n>.json in spillDir (lazy directory scan, once). */
	private async reserveSpillPath(): Promise<string | null> {
		try {
			await mkdir(this.deps.spillDir, { recursive: true });
			if (this.nextChunk === null) {
				let max = 0;
				for (const name of await readdir(this.deps.spillDir)) {
					const m = /^chunk-(\d+)\.json$/.exec(name);
					if (m) max = Math.max(max, Number(m[1]));
				}
				this.nextChunk = max + 1;
			}
			const path = join(this.deps.spillDir, `chunk-${this.nextChunk}.json`);
			this.nextChunk++;
			return path;
		} catch (err) {
			this.log.error("compaction spill reserve failed", { spillDir: this.deps.spillDir, error: String(err) });
			return null;
		}
	}

	private async writeSpill(path: string, rawMessages: unknown[]): Promise<boolean> {
		try {
			const payload = JSON.stringify(
				{ v: 1, createdAt: Date.now(), messageCount: rawMessages.length, messages: rawMessages },
				null,
				2,
			);
			await writeFile(path, payload, "utf8");
			this.log.info("compaction spill written", { path, messages: rawMessages.length });
			return true;
		} catch (err) {
			this.log.error("compaction spill write failed", { path, error: String(err) });
			return false;
		}
	}

	/** Emergency truncation: drops the oldest messages (the raw ones are already in spill). */
	private tailTruncate(messages: unknown[], historyBudget: number, startIndex = 0): unknown[] {
		const result = [...messages];
		while (result.length > startIndex + 1 && this.deps.estimateTokens(result) > historyBudget) {
			result.splice(startIndex, 1);
		}
		return result;
	}

	async maybeCompact(messages: unknown[], budget: ContextBudget, signal?: AbortSignal): Promise<CompactionResult> {
		const tokensBefore = this.deps.estimateTokens(messages);
		const threshold = this.triggerRatio * budget.historyBudget;
		if (tokensBefore < threshold) {
			return { compacted: false, messages, tokensBefore, tokensAfter: tokensBefore };
		}
		this.log.info("compaction triggered", {
			tokensBefore,
			historyBudget: budget.historyBudget,
			triggerRatio: this.triggerRatio,
		});

		const cut = findKeepCutIndex(messages, this.keepLastTurns);
		if (cut === 0) {
			// The keepLastTurns tail alone exceeds the budget (§6.3-b pathology).
			if (tokensBefore > budget.historyBudget) {
				const truncated = this.tailTruncate(messages, budget.historyBudget);
				this.log.warn("nothing eligible outside keepLastTurns; tail-truncation applied", {
					kept: truncated.length,
					dropped: messages.length - truncated.length,
				});
				return {
					compacted: true,
					level: "truncation",
					messages: truncated,
					tokensBefore,
					tokensAfter: this.deps.estimateTokens(truncated),
				};
			}
			return { compacted: false, messages, tokensBefore, tokensAfter: tokensBefore };
		}

		const oldRaw = messages.slice(0, cut);
		const kept = messages.slice(cut);
		let working = messages;
		let oldForSummary = oldRaw;
		let spilledTo: string | undefined;

		// Level 1: structural elision of old tool_result messages (0 tokens). Spill — BEFORE replacement.
		if (oldRaw.some(isToolResult)) {
			const spillPath = await this.reserveSpillPath();
			if (spillPath !== null) {
				const descriptor = (m: unknown): unknown => {
					const like = isObject(m) ? m : {};
					const tool = typeof like.toolName === "string" ? like.toolName : "tool";
					const id = typeof like.toolCallId === "string" ? like.toolCallId : "unknown";
					return {
						...like,
						content: [{ type: "text", text: `[vanrel: tool_result ${tool} elided; raw → ${spillPath}#${id}]` }],
					};
				};
				const elidedOld = oldRaw.map((m) => (isToolResult(m) ? descriptor(m) : m));
				if (await this.writeSpill(spillPath, oldRaw)) {
					spilledTo = spillPath;
					oldForSummary = elidedOld;
					working = [...elidedOld, ...kept];
					const t = this.deps.estimateTokens(working);
					if (t <= budget.historyBudget) {
						this.log.info("structural elision sufficient", { tokensBefore, tokensAfter: t, spilledTo });
						return {
							compacted: true,
							level: "structural",
							messages: working,
							spilledTo,
							tokensBefore,
							tokensAfter: t,
						};
					}
				}
			}
		}

		// Level 2: LLM summary of the evicted part — only if structural is not enough.
		let summary: string;
		try {
			const transcript = `[vanrel: summarize the transcript below in at most ${this.summaryMaxTokens} tokens; preserve decisions, file paths, errors and open tasks]\n\n${renderTranscript(oldForSummary)}`;
			summary = await this.deps.summarize(transcript, signal);
		} catch (err) {
			// Cancellation (host.abortCompaction / agent abort) is NOT destructive: history is left
			// unchanged; the tail-truncation fallback is only for real summarize failures. The
			// "maybeCompact never throws" contract is preserved: abort returns compacted:false, not rethrown.
			if (signal?.aborted === true || isAbortError(err)) {
				this.log.info("compaction aborted; history left unchanged", { tokensBefore });
				return { compacted: false, messages, tokensBefore, tokensAfter: tokensBefore };
			}
			this.log.error("summarize failed; falling back to tail-truncation", { error: String(err) });
			// The raw part always goes to a spill file BEFORE truncation (§6.3).
			if (spilledTo === undefined) {
				const p = await this.reserveSpillPath();
				if (p !== null && (await this.writeSpill(p, oldRaw))) spilledTo = p;
			}
			const truncated = this.tailTruncate(working, budget.historyBudget);
			return {
				compacted: true,
				level: "truncation",
				messages: truncated,
				...(spilledTo !== undefined ? { spilledTo } : {}),
				tokensBefore,
				tokensAfter: this.deps.estimateTokens(truncated),
			};
		}

		// The raw evicted part goes to disk before the summary replacement (unless elision spilled it earlier).
		if (spilledTo === undefined) {
			const p = await this.reserveSpillPath();
			if (p !== null && (await this.writeSpill(p, oldRaw))) spilledTo = p;
		}

		// The summary is inserted as close to the history start as possible (§6.6: the tail is a stable cache suffix).
		const summaryMessage = {
			role: "user",
			content: [
				{
					type: "text",
					text: `[vanrel: summary of the first ${cut} messages (raw → ${spilledTo ?? "unavailable"})]\n\n${summary}`,
				},
			],
			timestamp: Date.now(),
		};
		let result: unknown[] = [summaryMessage, ...kept];
		let tokensAfter = this.deps.estimateTokens(result);
		if (tokensAfter > budget.historyBudget) {
			// Pathologically large keepLastTurns tail: tail-truncation of the oldest turns of the tail (§6.3-b).
			this.log.warn("history still over budget after summary; tail-truncating kept tail", {
				tokensAfter,
				historyBudget: budget.historyBudget,
			});
			result = this.tailTruncate(result, budget.historyBudget, 1);
			tokensAfter = this.deps.estimateTokens(result);
		}
		this.log.info("llm summary compaction applied", { tokensBefore, tokensAfter, spilledTo });
		return {
			compacted: true,
			level: "llm",
			messages: result,
			summary,
			...(spilledTo !== undefined ? { spilledTo } : {}),
			tokensBefore,
			tokensAfter,
		};
	}
}
