/**
 * Agent loop wiring.
 * @vanrel/context does NOT import @vanrel/agent (cycle ban §2): hooks are typed
 * structurally; assignment into AgentLoopConfig is done by the wiring (@vanrel/cli).
 */
import type { ContextBudget } from "./budget.ts";
import type { HistoryCompactor } from "./compactor.ts";
import { type Logger, NOOP_LOGGER } from "./logger.ts";
import { filterToolOutput, type NoiseFilterOptions } from "./noise-filter.ts";

export interface ContextHooks {
	/** transformContext: history compaction before the request (§6.3). */
	transformContext(messages: unknown[], signal?: AbortSignal): Promise<unknown[]>;
	/** afterToolCall: NoiseFilter applied to raw output; called AFTER raw is written to the trace (tap T4). */
	afterToolCall(call: { toolId: string; output: string }): { output: string };
	/** prepareNextTurn: budget recompute / model switch on quota failover. */
	prepareNextTurn(ctx: { prevStopReason?: string }): void;
}

export interface ContextHooksDeps {
	budget: (prevStopReason?: string) => ContextBudget; // recompute per request; input for R adaptation (§6.2)
	compactor: HistoryCompactor;
	noiseFilter?: NoiseFilterOptions;
	recorder?: { record(t: "tool_result", p: unknown): void }; // tap T4 (raw before filtering)
	log?: Logger;
}

export function createContextHooks(deps: ContextHooksDeps): ContextHooks {
	const log = deps.log ?? NOOP_LOGGER;
	let currentBudget: ContextBudget | undefined;

	return {
		async transformContext(messages: unknown[], signal?: AbortSignal): Promise<unknown[]> {
			const budget = currentBudget ?? deps.budget();
			const result = await deps.compactor.maybeCompact(messages, budget, signal);
			if (result.compacted) {
				log.info("transformContext compacted history", {
					level: result.level,
					tokensBefore: result.tokensBefore,
					tokensAfter: result.tokensAfter,
					spilledTo: result.spilledTo,
				});
			}
			return result.messages;
		},
		afterToolCall(call: { toolId: string; output: string }): { output: string } {
			// Tap T4: RAW output to the trace before filtering (§3.1).
			deps.recorder?.record("tool_result", { tool: call.toolId, rawOutput: call.output });
			const filtered = filterToolOutput(call.toolId, call.output, deps.noiseFilter);
			log.debug("tool output filtered", { tool: call.toolId, class: filtered.class, ...filtered.stats });
			return { output: filtered.text };
		},
		prepareNextTurn(ctx: { prevStopReason?: string }): void {
			currentBudget = deps.budget(ctx.prevStopReason);
			log.debug("budget recomputed for next turn", {
				R: currentBudget.R,
				historyBudget: currentBudget.historyBudget,
				requestMaxTokens: currentBudget.requestMaxTokens,
				prevStopReason: ctx.prevStopReason ?? null,
			});
		},
	};
}
