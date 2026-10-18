import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateContextTokens } from "@vanrel/ai/utils/estimate";
import { describe, expect, it } from "vitest";
import { computeBudget, HistoryCompactor } from "../src/index.ts";

const est = (messages: unknown[]): number => estimateContextTokens(messages as never).tokens;

const textOfTokens = (tokens: number, tag: string): string => `${tag} ${"a".repeat(Math.round(tokens * 3.5))}`;

function userMsg(i: number, tokens = 150): unknown {
	return { role: "user", content: textOfTokens(tokens, `user-${i}`), timestamp: i * 10 };
}
function assistantMsg(i: number, tokens = 800): unknown {
	return {
		role: "assistant",
		content: [{ type: "text", text: textOfTokens(tokens, `assistant-${i}`) }],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		stopReason: "stop",
		timestamp: i * 10 + 1,
	};
}
function toolResultMsg(i: number, bytes = 4000): unknown {
	return {
		role: "toolResult",
		toolCallId: `call-${i}`,
		toolName: "bash",
		content: [{ type: "text", text: `RAW-OUTPUT-${i} ${"r".repeat(bytes)}` }],
		isError: false,
		timestamp: i * 10 + 2,
	};
}

/** W=32768: R=8192, U=1024 → H_max = 32768−100−100−8192−1024 = 23352; trigger τ=0.8 → 18681. */
const smallBudget = () =>
	computeBudget({
		contextWindow: 32_768,
		systemTokens: 100,
		toolSchemaTokens: 100,
		userTurnTokens: 150,
		minReasoningReserve: 4_096,
	});

describe("HistoryCompactor (§6.3)", () => {
	it("does not trigger below τ=0.8·H_max", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vanrel-spill-"));
		const summarize = () => Promise.reject(new Error("must not be called"));
		const c = new HistoryCompactor({ summarize, spillDir: dir, estimateTokens: est });
		const messages: unknown[] = [];
		for (let i = 0; i < 5; i++) messages.push(userMsg(i), assistantMsg(i), toolResultMsg(i));
		const r = await c.maybeCompact(messages, smallBudget());
		expect(r.compacted).toBe(false);
		expect(r.messages).toBe(messages);
		expect(r.tokensAfter).toBe(r.tokensBefore);
		expect(await readdir(dir)).toHaveLength(0);
	});

	it("W=32768 fixture: trigger fires, structural elision + spill BEFORE replacement", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vanrel-spill-"));
		let summarizeCalls = 0;
		const summarize = () => {
			summarizeCalls++;
			return Promise.resolve("summary");
		};
		const c = new HistoryCompactor({ summarize, spillDir: dir, estimateTokens: est });
		const messages: unknown[] = [];
		for (let i = 0; i < 10; i++) messages.push(userMsg(i), assistantMsg(i), toolResultMsg(i));
		const budget = smallBudget();
		const before = est(messages);
		expect(before).toBeGreaterThanOrEqual(0.8 * budget.historyBudget); // trigger τ=0.8

		const r = await c.maybeCompact(messages, budget);
		expect(r.compacted).toBe(true);
		expect(r.level).toBe("structural");
		expect(summarizeCalls).toBe(0); // the LLM level was not invoked
		expect(r.tokensAfter).toBeLessThanOrEqual(budget.historyBudget);
		expect(r.tokensBefore).toBe(before);

		// spill file created and contains the raw data
		expect(r.spilledTo).toBe(join(dir, "chunk-1.json"));
		const spill = JSON.parse(await readFile(r.spilledTo!, "utf8")) as { messages: { content: { text: string }[] }[] };
		const spillText = JSON.stringify(spill);
		expect(spillText).toContain("RAW-OUTPUT-0");
		expect(spillText).toContain("RAW-OUTPUT-3");

		// old tool_result → descriptor references
		const resultText = JSON.stringify(r.messages);
		expect(resultText).not.toContain("RAW-OUTPUT-0");
		expect(resultText).toContain("tool_result bash elided");
		expect(resultText).toContain("chunk-1.json#call-0");

		// keepLastTurns=6 untouched: raw outputs of the last 6 turns are in place
		for (let i = 4; i < 10; i++) expect(resultText).toContain(`RAW-OUTPUT-${i}`);
		expect(r.messages).toHaveLength(messages.length);
	});

	it("LLM-summary when structural is not enough; summary inserted as a prefix", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vanrel-spill-"));
		const c = new HistoryCompactor({
			summarize: () => Promise.resolve("SUMMARY-TEXT"),
			spillDir: dir,
			estimateTokens: est,
		});
		// Conversational history without tool_result: nothing for elision to cut.
		const messages: unknown[] = [];
		for (let i = 0; i < 10; i++) messages.push(userMsg(i), assistantMsg(i, 2_286));
		const budget = smallBudget();
		expect(est(messages)).toBeGreaterThanOrEqual(0.8 * budget.historyBudget);

		const r = await c.maybeCompact(messages, budget);
		expect(r.compacted).toBe(true);
		expect(r.level).toBe("llm");
		expect(r.summary).toBe("SUMMARY-TEXT");
		const first = r.messages[0] as { role: string; content: { text: string }[] };
		expect(first.role).toBe("user");
		expect(first.content[0].text).toContain("SUMMARY-TEXT");
		// raw old part in spill
		const spillText = JSON.stringify(JSON.parse(await readFile(r.spilledTo!, "utf8")) as unknown);
		expect(spillText).toContain("assistant-0");
		// keepLastTurns tail preserved
		expect(JSON.stringify(r.messages)).toContain("assistant-9");
		expect(r.tokensAfter).toBeLessThan(r.tokensBefore);
	});

	it("abort of summarize via signal → compacted:false without truncation and without spill (M4)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vanrel-spill-"));
		const controller = new AbortController();
		// summarize hangs until abort and rejects with AbortError — like a real fetch on signal.
		const summarize = (_transcript: string, signal?: AbortSignal) =>
			new Promise<string>((_resolve, reject) => {
				const onAbort = () => reject(new DOMException("The operation was aborted", "AbortError"));
				if (signal?.aborted) onAbort();
				else signal?.addEventListener("abort", onAbort, { once: true });
			});
		const c = new HistoryCompactor({ summarize, spillDir: dir, estimateTokens: est });
		const messages: unknown[] = [];
		for (let i = 0; i < 10; i++) messages.push(userMsg(i), assistantMsg(i, 2_286));
		const budget = smallBudget();
		expect(est(messages)).toBeGreaterThanOrEqual(0.8 * budget.historyBudget);

		const pending = c.maybeCompact(messages, budget, controller.signal);
		controller.abort(); // host.abortCompaction()
		const r = await pending; // the "maybeCompact never throws" contract holds for abort too
		expect(r.compacted).toBe(false);
		expect(r.level).toBeUndefined();
		expect(r.messages).toBe(messages); // identity: history not replaced by tail-truncation
		expect(r.tokensAfter).toBe(r.tokensBefore);
		expect(await readdir(dir)).toHaveLength(0); // cancellation is non-destructive: no spill was created
	});

	it("AbortError without signal (abort inside summarize) → compacted:false, not truncation (M4)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vanrel-spill-"));
		const c = new HistoryCompactor({
			summarize: () => Promise.reject(new DOMException("The operation was aborted", "AbortError")),
			spillDir: dir,
			estimateTokens: est,
		});
		const messages: unknown[] = [];
		for (let i = 0; i < 10; i++) messages.push(userMsg(i), assistantMsg(i, 2_286));
		const r = await c.maybeCompact(messages, smallBudget());
		expect(r.compacted).toBe(false);
		expect(r.messages).toBe(messages);
		expect(r.tokensAfter).toBe(r.tokensBefore);
		expect(await readdir(dir)).toHaveLength(0);
	});

	it("summarize error → tail-truncation fallback, never throws", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vanrel-spill-"));
		const c = new HistoryCompactor({
			summarize: () => Promise.reject(new Error("LLM unavailable")),
			spillDir: dir,
			estimateTokens: est,
		});
		const messages: unknown[] = [];
		for (let i = 0; i < 10; i++) messages.push(userMsg(i), assistantMsg(i, 2_286));
		const budget = smallBudget();

		const r = await c.maybeCompact(messages, budget); // does not throw
		expect(r.compacted).toBe(true);
		expect(r.level).toBe("truncation");
		expect(r.messages.length).toBeLessThan(messages.length);
		expect(r.tokensAfter).toBeLessThanOrEqual(budget.historyBudget);
		// the oldest turns are dropped, the tail is in place
		expect(JSON.stringify(r.messages)).toContain("assistant-9");
		// the raw part went to spill BEFORE truncation
		const spillText = JSON.stringify(JSON.parse(await readFile(r.spilledTo!, "utf8")) as unknown);
		expect(spillText).toContain("assistant-0");
	});

	it("spill file numbering continues from existing chunk-<n>.json", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vanrel-spill-"));
		const c1 = new HistoryCompactor({
			summarize: () => Promise.resolve("s"),
			spillDir: dir,
			estimateTokens: est,
		});
		const messages: unknown[] = [];
		for (let i = 0; i < 10; i++) messages.push(userMsg(i), assistantMsg(i), toolResultMsg(i));
		const r1 = await c1.maybeCompact(messages, smallBudget());
		expect(r1.spilledTo).toBe(join(dir, "chunk-1.json"));
		// A new instance on the same directory → next number.
		const c2 = new HistoryCompactor({
			summarize: () => Promise.resolve("s"),
			spillDir: dir,
			estimateTokens: est,
		});
		const r2 = await c2.maybeCompact(messages, smallBudget());
		expect(r2.spilledTo).toBe(join(dir, "chunk-2.json"));
	});
});
