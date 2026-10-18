/**
 * Wiring (§3.1, §4.3.4): assembling the session loop from ready-made packages.
 *
 * Flow: tap T0 session_start → resolveAuth (§4.2.2) → ProviderRouter (§4.2.4) →
 * Agent (pi-agent-core) with ContextHooks: transformContext = HistoryCompactor (§6.3),
 * afterToolCall = NoiseFilter AFTER writing raw to tap T4, prepareNextTurn = budget
 * recompute with prevStopReason (§6.2) → tool exec → persist entries → tap T5 session_end
 * + recorder.close().
 *
 * Note on tap T4 (§4.1.1 ToolResultPayload): createContextHooks does NOT get the recorder
 * directly — the full payload needs toolCallId/durationMs/isError, known only to the
 * agent hooks layer. afterToolCall in Agent does: capture raw → hooks.afterToolCall
 * (NoiseFilter) → write ONE tool_result event {rawOutput, filteredOutput, stats}.
 * recorder.record does not throw (contract §4.1.2), so raw is guaranteed not to be lost.
 */
import { randomUUID } from "node:crypto";
import { join, relative, sep } from "node:path";
import { Agent, type AgentMessage, type AgentTool } from "@vanrel/agent";
import {
	type AuthProvider,
	type AuthProviderId,
	builtinAuthProviders,
	type Message,
	type Model,
	ProviderRouter,
	QuotaLedger,
	type ResolvedAuth,
	resolveAuth,
	type ToolResultMessage,
} from "@vanrel/ai";
import { estimateContextTokens, estimateTextTokens } from "@vanrel/ai/utils/estimate";
import {
	type CompactionDeps,
	type CompactionResult,
	type ContextBudget,
	computeBudget,
	createContextHooks,
	DEFAULT_TRIGGER_RATIO,
	HistoryCompactor,
} from "@vanrel/context";
import { createDefaultChecks, OscillationGuard, PreCommitGate, ShadowWorktree } from "@vanrel/qc";
import { createFlightRecorder, type FlightRecorder, type Logger } from "@vanrel/telemetry";
import { type CliConfig, createSettingsFacade, type SettingsFacade } from "./config.ts";
import { createMcpRuntime, type McpRuntime } from "./mcp.ts";
import type { VanrelPaths } from "./paths.ts";
import { SessionManager } from "./session.ts";
import {
	createRoutedStreamFn,
	findCatalogModel,
	type RoutedStreamDeps,
	resolveModelRef,
	summarizeText,
} from "./stream.ts";
import { createBuiltinTools, type QcHooks } from "./tools.ts";

export const VANREL_VERSION = "0.1.0";

/** All providers unavailable (§4.6 exit 2): a clear message, no crash. */
export class AuthUnavailableError extends Error {
	readonly kind = "auth-unavailable";
	readonly skipped: { provider: AuthProviderId; reason: string }[];
	constructor(skipped: { provider: AuthProviderId; reason: string }[]) {
		super("no subscription credentials available — all auth providers unavailable");
		this.name = "AuthUnavailableError";
		this.skipped = skipped;
	}
}

const SYSTEM_PROMPT = [
	"You are vanrel, a minimal terminal coding assistant.",
	"Use the provided tools (read, bash, edit, write, grep, glob) to inspect and modify the workspace.",
	"Be concise. Prefer reading before writing. Never fabricate file contents or command output.",
].join("\n");

export interface SessionStats {
	turns: number;
	llmRequests: number;
	toolCalls: number;
	inputTokens: number;
	outputTokens: number;
	startedAt: number;
}

/**
 * W14: compaction events for InteractiveHost.subscribeSession (recon §3.3 R1).
 * reason: "manual" — compactNow (host.compact), "threshold" — transformContext before a request.
 */
export type SessionCompactionEvent =
	| { type: "compaction_start"; reason: "manual" | "threshold" }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold";
			result?: CompactionResult;
			errorMessage?: string;
	  };

export interface SessionRuntime {
	readonly sessionId: string;
	readonly recorder: FlightRecorder;
	readonly session: SessionManager;
	readonly agent: Agent;
	readonly stats: SessionStats;
	/** A0 (recon interactive-vendor §3.3): passthrough to InteractiveHost — already assembled in assembleRuntime. */
	readonly router: ProviderRouter;
	readonly paths: VanrelPaths;
	readonly log: Logger;
	/** W14/A3: interactive settings (seed = config.interactive, persisted to config.json). */
	readonly settings: SettingsFacade;
	/**
	 * W14: runtime model switch — resolveModelRef (router + catalog + credential),
	 * updating the stream's requestedModel and recomputing the budget. RouteError/BudgetError propagate up.
	 */
	setModel(ref: string): Model<any>;
	/**
	 * W14: manual compaction (host.compact): maybeCompact against the current budget; on
	 * trigger it replaces the agent history (the system message is preserved). Persisting the
	 * compaction entry goes through SessionCompactor.onCompacted. maybeCompact does not throw
	 * (contract §6.3).
	 */
	compactNow(instructions?: string, signal?: AbortSignal): Promise<CompactionResult>;
	/** W14: subscription to compaction_start/end (manual + threshold) for InteractiveHost. */
	onCompaction(listener: (event: SessionCompactionEvent) => void): () => void;
	/** tap T5 + persist + recorder.close() + qc finalize. Idempotent. */
	close(reason: "user_exit" | "error" | "completed"): Promise<void>;
}

/** Predicted compaction trigger in transformContext (W14) — the default shared with HistoryCompactor. */
const COMPACTION_TRIGGER_RATIO = DEFAULT_TRIGGER_RATIO;

/** Compactor with a callback to persist the compaction entry into the session JSONL (§3.1 step 9). */
class SessionCompactor extends HistoryCompactor {
	onCompacted?: (result: CompactionResult) => Promise<void>;
	override async maybeCompact(
		messages: unknown[],
		budget: ContextBudget,
		signal?: AbortSignal,
	): Promise<CompactionResult> {
		const result = await super.maybeCompact(messages, budget, signal);
		if (result.compacted) await this.onCompacted?.(result);
		return result;
	}
}

interface QcRuntime {
	hooks: QcHooks;
	finalize: () => Promise<void>;
	/** Delete the shadow worktree without apply (cleanup on runtime assembly failure, M6). Idempotent. */
	dispose: () => Promise<void>;
}

/** QC loop (§4.4): optional qc.enabled (default false in M8). Not a git repo → WARN + off. */
async function createQcRuntime(
	config: CliConfig,
	cwd: string,
	paths: VanrelPaths,
	sessionId: string,
	recorder: FlightRecorder,
	log: Logger,
): Promise<QcRuntime | undefined> {
	if (config.qc?.enabled !== true) return undefined;
	try {
		const worktree = await ShadowWorktree.create({
			repoRoot: cwd,
			worktreesDir: paths.worktrees,
			sessionId,
			log,
		});
		const gate = new PreCommitGate(
			createDefaultChecks({ uiSnapshot: config.qc?.checks?.includes("ui-snapshot") === true }, log),
			{
				// The gate guarantees the full ToolResultPayload shape (packages/qc/src/gate.ts) — structural cast.
				recorder: { record: (_t, p) => recorder.record("tool_result", p as never) },
				log,
			},
		);
		const oscillation = new OscillationGuard({ log });
		let lastGateOk = false;
		return {
			hooks: {
				toWorktreePath: (abs) =>
					abs === cwd || abs.startsWith(`${cwd}${sep}`) ? join(worktree.path, relative(cwd, abs)) : undefined,
				afterEdit: async () => {
					const report = await gate.run(worktree);
					lastGateOk = report.ok;
					const diff = await worktree.diff();
					const decision = oscillation.observe(diff);
					if (decision.action === "abort") {
						// §4.4: abort the loop + error event in the trace; changing strategy is up to the model/user.
						recorder.record("error", {
							scope: "qc",
							message: `oscillation abort: ${decision.reason}`,
							fatal: false,
						});
						return {
							ok: false,
							report: `oscillation detected (A→B→A): ${decision.reason}. Change strategy.`,
							terminate: true,
						};
					}
					if (!report.ok) {
						recorder.record("error", {
							scope: "qc",
							message: `pre-commit gate failed: ${report.summary}`,
							fatal: false,
						});
						return { ok: false, report: report.summary };
					}
					return { ok: true, report: report.summary };
				},
			},
			finalize: async () => {
				try {
					const diff = await worktree.diff();
					if (diff !== "" && lastGateOk) {
						await worktree.applyTo();
						log.info("qc: shadow worktree applied to repo", { repoRoot: cwd });
					} else if (diff !== "") {
						log.warn("qc: edits discarded (last gate not green)", { repoRoot: cwd, bytes: diff.length });
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					log.error("qc: applyTo failed", { error: message });
					recorder.record("error", { scope: "qc", message: `applyTo failed: ${message}`, fatal: false });
				} finally {
					await worktree.dispose(); // dispose is idempotent (ShadowWorktree.disposed guard)
				}
			},
			dispose: async () => {
				await worktree.dispose();
			},
		};
	} catch (error) {
		log.warn("qc: disabled (shadow worktree unavailable)", {
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

export interface CreateRuntimeOptions {
	cwd: string;
	argv: string[];
	paths: VanrelPaths;
	config: CliConfig;
	sessionId?: string; // --session: resume
	provider?: AuthProviderId; // --provider
	model?: string; // --model (alias or explicit id)
	log: Logger;
	onAssistantText?: (delta: string) => void; // streaming output
}

export async function createSessionRuntime(options: CreateRuntimeOptions): Promise<SessionRuntime> {
	const sessionId = options.sessionId ?? randomUUID();
	const recorder = createFlightRecorder({ dir: options.paths.traces, sessionId, log: options.log });
	try {
		return await assembleRuntime(options, recorder, sessionId);
	} catch (error) {
		// Assembly failure: record and close the recorder (buffer is not lost), otherwise the T0 trace has no finale.
		recorder.record("error", {
			scope: error instanceof AuthUnavailableError ? "auth" : "session",
			message: error instanceof Error ? error.message : String(error),
			fatal: true,
		});
		await recorder.close();
		throw error;
	}
}

async function assembleRuntime(
	options: CreateRuntimeOptions,
	recorder: FlightRecorder,
	sessionId: string,
): Promise<SessionRuntime> {
	const { cwd, paths, config, log } = options;

	// Providers + discovery (§5.6); storePath is our only write target (§5.5).
	const providerList: AuthProvider[] = builtinAuthProviders({ storePath: paths.authFile, config: config.auth, log });
	const providersById = new Map<AuthProviderId, AuthProvider>(providerList.map((p) => [p.id, p]));
	const auth: ResolvedAuth = await resolveAuth({
		storePath: paths.authFile,
		providers: providerList,
		preferred: config.preferred,
		log,
	});

	// Tap T0: session_start (available providers — after resolveAuth).
	recorder.record("session_start", {
		cwd,
		argv: options.argv,
		pid: process.pid,
		vanrelVersion: VANREL_VERSION,
		providers: [...auth.byProvider.keys()],
	});

	// Session: load|create (append-only JSONL).
	const resumed = options.sessionId ? await SessionManager.resume(paths.sessions, options.sessionId, log) : undefined;
	const session = resumed?.manager ?? (await SessionManager.create(paths.sessions, sessionId, log));
	const restored: AgentMessage[] = resumed?.messages ?? [];

	if (auth.byProvider.size === 0) {
		log.error("auth: no provider available", { skipped: auth.skipped });
		throw new AuthUnavailableError(auth.skipped);
	}

	const quota = new QuotaLedger({ filePath: paths.quotaFile, log });
	await quota.load();
	const router = new ProviderRouter({
		auth,
		quota,
		policy: { order: options.provider ? [options.provider] : (config.preferred ?? ["anthropic", "agy", "codex"]) },
		log,
	});

	// Initial routing: session model + W for the budget. RouteError propagates up (exit mapping in cli).
	const requestedModel = options.model ?? "default";
	const initialTarget = router.route({ model: requestedModel });
	const initialModel = findCatalogModel(initialTarget.provider, initialTarget.model);
	if (!initialModel) throw new Error(`model not in catalog: ${initialTarget.provider}/${initialTarget.model}`);

	// Budget (§6.1): stateless computeBudget, R adaptation via prevStopReason (§6.2).
	const tools: AgentTool<any>[] = [];
	const toolSchemaTokens = (decls: AgentTool<any>[]): number =>
		estimateTextTokens(
			JSON.stringify(decls.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))),
		);
	const systemTokens = estimateTextTokens(SYSTEM_PROMPT);
	let currentModel: Model<any> = initialModel;
	const userTurnTokens = 1024; // before the first prompt — a minimal estimate (clamp §6.1)
	// Pure budget recompute for an arbitrary model — setModel validates the candidate BEFORE mutations (M3).
	const computeBudgetFor = (model: Model<any>, prevStopReason?: string): ContextBudget =>
		computeBudget({
			contextWindow: model.contextWindow,
			systemTokens,
			toolSchemaTokens: toolSchemaTokens(tools),
			userTurnTokens,
			minReasoningReserve: model.reasoning ? 4096 : 1024,
			maxOutputTokens: Math.min(model.maxTokens, 8192),
			prevStopReason,
		});
	const budget = (prevStopReason?: string): ContextBudget => computeBudgetFor(currentModel, prevStopReason);
	// fail-fast budget() call — AFTER pushing all tools (builtin + MCP): toolSchemaTokens
	// reads the array by reference, MCP schemas must be included in T (recon mcp-wiring §3.3).

	const stats: SessionStats = {
		turns: 0,
		llmRequests: 0,
		toolCalls: 0,
		inputTokens: 0,
		outputTokens: 0,
		startedAt: Date.now(),
	};

	// W14: compaction event bus (manual compactNow + threshold transformContext)
	// for InteractiveHost.subscribeSession (recon §3.3 R1).
	const compactionListeners = new Set<(event: SessionCompactionEvent) => void>();
	const emitCompaction = (event: SessionCompactionEvent): void => {
		for (const listener of compactionListeners) {
			try {
				listener(event);
			} catch (error) {
				log.warn("compaction listener failed", { error: error instanceof Error ? error.message : String(error) });
			}
		}
	};

	const compactorDeps: CompactionDeps = {
		summarize: (transcript, signal) =>
			summarizeText(
				{
					router,
					providers: providersById,
					requestedModel: "cheap",
					budget,
					recorder,
					sessionId,
					log,
					onUsage: (u: { input: number; output: number }) => {
						stats.inputTokens += u.input;
						stats.outputTokens += u.output;
					},
				},
				transcript,
				signal,
			),
		spillDir: join(paths.spill, sessionId),
		estimateTokens: (messages) => estimateContextTokens(messages as readonly Message[]).tokens,
		log,
	};
	const compactor = new SessionCompactor(compactorDeps, {});
	compactor.onCompacted = async (result) => {
		await session.appendCompaction({
			level: result.level ?? "structural",
			tokensBefore: result.tokensBefore,
			tokensAfter: result.tokensAfter,
			spilledTo: result.spilledTo,
		});
	};

	const hooks = createContextHooks({ budget, compactor, log });
	let lastStopReason: string | undefined;

	const qc = await createQcRuntime(config, cwd, paths, sessionId, recorder, log);
	// M6: any throw after qc is created goes to the shared cleanup tail (mcp.close + qc.dispose),
	// otherwise BudgetError/assembly failure leaks server stdio processes and the shadow worktree.
	let mcp: McpRuntime | undefined;
	try {
		tools.push(...createBuiltinTools({ cwd, log, qc: qc?.hooks }));

		// MCP (recon mcp-wiring §3.3): start after qc and before new Agent. An unavailable server =
		// WARN + error{scope:"mcp",fatal:false}, the session continues without its tools.
		// M8: servers that come up after startupWait arrive via onToolsAdded — a live push
		// into the budget array (toolSchemaTokens reads by reference) and into agent.state.tools.
		mcp = config.mcpServers
			? await createMcpRuntime({
					servers: config.mcpServers,
					cwd,
					log,
					recorder,
					onToolsAdded: (added) => {
						tools.push(...added);
						// The callback arrives only after the mcp.tools snapshot (createMcpRuntime has returned);
						// there is no await between it and new Agent — the agent is already constructed, no TDZ.
						agent.state.tools = [...agent.state.tools, ...added];
						log.info("mcp: late tools registered after startup wait", {
							count: added.length,
							names: added.map((tool) => tool.name),
						});
					},
				})
			: undefined;
		tools.push(...(mcp?.tools ?? []));

		budget(); // fail-fast: BudgetError → exit 3 (§4.6), before the agent starts

		// streamDeps is a live object: createRoutedStreamFn reads requestedModel on every request,
		// W14 setModel mutates it to switch the model at runtime.
		const streamDeps: RoutedStreamDeps = {
			router,
			providers: providersById,
			requestedModel,
			budget,
			recorder,
			sessionId,
			log,
			onUsage: (u) => {
				stats.inputTokens += u.input;
				stats.outputTokens += u.output;
			},
			onRouted: (_provider, model) => {
				currentModel = model;
			},
		};
		const streamFn = createRoutedStreamFn(streamDeps);

		const toolStartedAt = new Map<string, number>();

		const agent = new Agent({
			initialState: { model: initialModel, systemPrompt: SYSTEM_PROMPT, tools, messages: restored },
			streamFn,
			toolExecution: "sequential", // deterministic order; the QC gate is correct per-edit (§4.4)
			sessionId,
			// Equivalent of hooks.transformContext (maybeCompact against the budget with prevStopReason), plus
			// compaction_start/end events for the TUI (W14): start only on an actual trigger
			// (token-based prediction, the compactor's shared DEFAULT_TRIGGER_RATIO).
			transformContext: async (messages, signal) => {
				const currentBudget = budget(lastStopReason);
				const tokens = estimateContextTokens(messages as readonly Message[]).tokens;
				const triggered = tokens >= COMPACTION_TRIGGER_RATIO * currentBudget.historyBudget;
				if (triggered) emitCompaction({ type: "compaction_start", reason: "threshold" });
				try {
					const result = await compactor.maybeCompact(messages, currentBudget, signal);
					if (result.compacted) {
						log.info("transformContext compacted history", {
							level: result.level,
							tokensBefore: result.tokensBefore,
							tokensAfter: result.tokensAfter,
							spilledTo: result.spilledTo,
						});
						emitCompaction({ type: "compaction_end", reason: "threshold", result });
					} else if (triggered) {
						emitCompaction({ type: "compaction_end", reason: "threshold" });
					}
					return result.messages as AgentMessage[];
				} catch (error) {
					if (triggered) {
						emitCompaction({
							type: "compaction_end",
							reason: "threshold",
							errorMessage: error instanceof Error ? error.message : String(error),
						});
					}
					throw error;
				}
			},
			prepareNextTurnWithContext: (ctx) => {
				lastStopReason = ctx.message.role === "assistant" ? ctx.message.stopReason : undefined;
				hooks.prepareNextTurn({ prevStopReason: lastStopReason }); // budget recompute with R adaptation (§6.2)
				return undefined;
			},
			beforeToolCall: async (ctx) => {
				toolStartedAt.set(ctx.toolCall.id, Date.now());
				recorder.record("tool_call", { toolCallId: ctx.toolCall.id, tool: ctx.toolCall.name, args: ctx.args }); // tap T3
				stats.toolCalls++;
				return undefined;
			},
			afterToolCall: async (ctx) => {
				const raw = ctx.result.content
					.map((block) => (block.type === "text" ? block.text : "[image content]"))
					.join("\n");
				// NoiseFilter AFTER capturing raw; one tap T4 event is written (see the module header).
				const { output } = hooks.afterToolCall({ toolId: ctx.toolCall.name, output: raw });
				recorder.record("tool_result", {
					toolCallId: ctx.toolCall.id,
					tool: ctx.toolCall.name,
					durationMs: Date.now() - (toolStartedAt.get(ctx.toolCall.id) ?? Date.now()),
					isError: ctx.isError,
					rawOutput: raw,
					filteredOutput: output,
				});
				toolStartedAt.delete(ctx.toolCall.id);
				return { content: [{ type: "text", text: output }] };
			},
		});

		agent.subscribe((event) => {
			switch (event.type) {
				case "turn_start":
					stats.turns++;
					stats.llmRequests++;
					break;
				case "message_update":
					if (options.onAssistantText && event.assistantMessageEvent.type === "text_delta")
						options.onAssistantText(event.assistantMessageEvent.delta);
					break;
				case "turn_end": {
					const message = event.message;
					if (message.role === "assistant") {
						lastStopReason = message.stopReason;
						void session.appendAssistant(message).catch((error: unknown) => {
							log.warn("session persist failed (assistant)", { error: String(error) });
						});
					}
					for (const toolResult of event.toolResults as ToolResultMessage[]) {
						void session.appendToolResult(toolResult).catch((error: unknown) => {
							log.warn("session persist failed (tool_result)", { error: String(error) });
						});
					}
					break;
				}
				default:
					break;
			}
		});

		const settings = createSettingsFacade(paths.configFile, log, config.interactive);

		let closed = false;
		return {
			sessionId,
			recorder,
			session,
			agent,
			stats,
			router,
			paths,
			log,
			settings,
			setModel(ref: string): Model<any> {
				const { model } = resolveModelRef(ref, router, auth); // RouteError propagates up
				// Request-time routing reads streamDeps.requestedModel; an explicit "provider/id" →
				// bare id (the router cannot pin to a provider — VENDOR-GAP W12c).
				const slash = ref.indexOf("/");
				const nextRequested = slash > 0 ? ref.slice(slash + 1).trim() : ref.trim();
				// M3: transactional — fail-fast budget recompute with the NEW contextWindow BEFORE mutations;
				// BudgetError → currentModel/requestedModel stay unchanged.
				computeBudgetFor(model, lastStopReason);
				currentModel = model;
				streamDeps.requestedModel = nextRequested;
				log.info("model changed", { ref, model: model.id });
				return model;
			},
			async compactNow(instructions?: string, signal?: AbortSignal): Promise<CompactionResult> {
				let active: SessionCompactor = compactor;
				if (instructions !== undefined && instructions.trim() !== "") {
					// HistoryCompactor does not support custom instructions — wrap summarize.
					const wrapped = new SessionCompactor(
						{
							...compactorDeps,
							summarize: (transcript, s) =>
								compactorDeps.summarize(
									`${transcript}\n\n[vanrel: additional summarization instructions]\n${instructions}`,
									s,
								),
						},
						{},
					);
					wrapped.onCompacted = compactor.onCompacted;
					active = wrapped;
				}
				emitCompaction({ type: "compaction_start", reason: "manual" });
				try {
					const result = await active.maybeCompact(agent.state.messages, budget(lastStopReason), signal);
					if (result.compacted) {
						// The system message lives only in agent state — the compactor drops it; keep it on top.
						const first = agent.state.messages[0];
						const head = first !== undefined && first.role === "system" ? [first] : [];
						const compactedMessages = result.messages as AgentMessage[];
						agent.state.messages =
							compactedMessages[0]?.role === "system" ? compactedMessages : [...head, ...compactedMessages];
					}
					emitCompaction({ type: "compaction_end", reason: "manual", result });
					return result;
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : String(error);
					log.error("manual compaction failed", { error: errorMessage });
					emitCompaction({ type: "compaction_end", reason: "manual", errorMessage });
					throw error;
				}
			},
			onCompaction(listener) {
				compactionListeners.add(listener);
				return () => compactionListeners.delete(listener);
			},
			async close(reason) {
				if (closed) return;
				closed = true;
				// Tap T5: session_end + recorder.close() (§3.1).
				recorder.record("session_end", {
					reason,
					stats: {
						turns: stats.turns,
						llmRequests: stats.llmRequests,
						toolCalls: stats.toolCalls,
						inputTokens: stats.inputTokens,
						outputTokens: stats.outputTokens,
						durationMs: Date.now() - stats.startedAt,
					},
				});
				await qc?.finalize();
				await mcp?.close(); // client.close() per server: stdin end → SIGTERM(500ms) → SIGKILL(2s)
				await recorder.close();
			},
		};
	} catch (error) {
		// M6: shared cleanup tail — mcp servers and the qc shadow worktree must not survive an assembly failure.
		const message = error instanceof Error ? error.message : String(error);
		log.warn("runtime assembly failed; disposing mcp/qc", { error: message });
		try {
			await mcp?.close();
		} finally {
			await qc?.dispose();
		}
		throw error;
	}
}
