import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateContextTokens } from "@vanrel/ai/utils/estimate";
import { describe, expect, it } from "vitest";
import { type ContextBudget, computeBudget, createContextHooks, HistoryCompactor } from "../src/index.ts";

const est = (messages: unknown[]): number => estimateContextTokens(messages as never).tokens;

const bigBudget = (prevStopReason?: string): ContextBudget =>
	computeBudget({
		contextWindow: 200_000,
		systemTokens: 2_000,
		toolSchemaTokens: 3_000,
		userTurnTokens: 150,
		minReasoningReserve: 4_096,
		prevStopReason,
	});

describe("createContextHooks (§4.3.4)", () => {
	it("afterToolCall: raw into recorder (tap T4) BEFORE filtering, the digest goes to context", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vanrel-hooks-"));
		const recorded: unknown[] = [];
		const hooks = createContextHooks({
			budget: bigBudget,
			compactor: new HistoryCompactor({ summarize: () => Promise.resolve(""), spillDir: dir, estimateTokens: est }),
			recorder: { record: (_t, p) => recorded.push(p) },
		});
		const lines: string[] = [];
		for (let i = 0; i < 300; i++) lines.push(`[t] compiling src/m-${i}.ts ok`);
		lines.splice(150, 0, "src/x.ts(1,1): error TS2304: Cannot find name 'zzz'.");
		const raw = lines.join("\n");

		const { output } = hooks.afterToolCall({ toolId: "bash", output: raw });
		expect(recorded).toHaveLength(1);
		expect((recorded[0] as { rawOutput: string }).rawOutput).toBe(raw); // raw, complete
		expect(output).toContain("error TS2304");
		expect(Buffer.byteLength(output, "utf8")).toBeLessThanOrEqual(6144);
		expect(output).toContain("class=build");
		expect(Buffer.byteLength(output, "utf8")).toBeLessThan(Buffer.byteLength(raw, "utf8"));
	});

	it("transformContext: history under budget is returned unchanged", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vanrel-hooks-"));
		const hooks = createContextHooks({
			budget: bigBudget,
			compactor: new HistoryCompactor({ summarize: () => Promise.resolve(""), spillDir: dir, estimateTokens: est }),
		});
		const messages = [{ role: "user", content: "hi", timestamp: 1 }];
		const out = await hooks.transformContext(messages);
		expect(out).toEqual(messages);
	});

	it("prepareNextTurn: budget recompute with prevStopReason (input of R adaptation §6.2)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vanrel-hooks-"));
		const seen: (string | undefined)[] = [];
		const hooks = createContextHooks({
			budget: (prev) => {
				seen.push(prev);
				return bigBudget(prev);
			},
			compactor: new HistoryCompactor({ summarize: () => Promise.resolve(""), spillDir: dir, estimateTokens: est }),
		});
		hooks.prepareNextTurn({ prevStopReason: "length" });
		expect(seen).toEqual(["length"]);
		await hooks.transformContext([]);
		expect(seen).toEqual(["length"]); // budget not recomputed again — taken from prepareNextTurn
	});
});
