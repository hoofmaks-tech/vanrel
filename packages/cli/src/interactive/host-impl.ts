/**
 * W14: InteractiveHost on top of SessionRuntime (contract ./host.ts, recon interactive-vendor §3.3).
 *
 * InteractiveSessionEvent synthesis:
 * - AgentEvent — proxied as-is from agent.subscribe;
 * - compaction_start/end — from wiring hooks (SessionRuntime.onCompaction: manual compactNow +
 *   threshold transformContext);
 * - bash_execution_update — from executeBash (final output chunk);
 * - session_info_changed — from a Proxy wrapper around SessionManager.setSessionName;
 * - auto_retry_start is NOT emitted: ProviderRouter has no retry/backoff event interface
 *   (W13 fallback: the retry indicator is cleared on turn_start/agent_end);
 * - queue_update is NOT emitted: the TUI tracks steer/followUp queues locally (W13).
 *
 * Deviations:
 * - the bash tool does not stream deltas (OutputAccumulator has no onUpdate hook) — onUpdate
 *   receives the whole output in one chunk on completion;
 * - executeBash persist — custom "bashExecution" entry in the session JSONL; the result is
 *   not pushed into the agent live context (the wiring agent has the default convertToLlm);
 *   on resume, custom entries are not restored into history (linear model, A2).
 */
import { EventEmitter } from "node:events";
import type { Agent, ThinkingLevel } from "@vanrel/agent";
import type { ImageContent, ProviderRouter } from "@vanrel/ai";
import type { FlightRecorder, Logger } from "@vanrel/telemetry";
import type { SettingsFacade } from "../config.ts";
import type { VanrelPaths } from "../paths.ts";
import type { SessionManager } from "../session.ts";
import type { BashToolOutput } from "../tools/bash.ts";
import type { SessionRuntime, SessionStats } from "../wiring.ts";
import type { BashResult, InteractiveHost, InteractiveSessionEvent } from "./host.ts";

export interface InteractiveHostOptions {
	/** Settings override (tests); default — runtime.settings from wiring. */
	settings?: SettingsFacade;
}

class InteractiveHostImpl implements InteractiveHost {
	readonly session: SessionManager;
	readonly settings: SettingsFacade;

	private readonly runtime: SessionRuntime;
	private readonly emitter = new EventEmitter();
	private readonly unsubscribeAgent: () => void;
	private readonly unsubscribeCompaction: () => void;
	private bashController: AbortController | undefined;
	private compactionController: AbortController | undefined;
	private closed = false;

	constructor(runtime: SessionRuntime, opts: InteractiveHostOptions = {}) {
		this.runtime = runtime;
		this.settings = opts.settings ?? runtime.settings;
		// Proxy for session_info_changed synthesis (host.ts R1): methods are bound to target —
		// SessionManager private fields are not touched through the proxy.
		this.session = new Proxy(runtime.session, {
			get: (target, prop) => {
				if (prop === "setSessionName") {
					return async (name: string) => {
						await target.setSessionName(name);
						this.emit({ type: "session_info_changed", name });
					};
				}
				const value: unknown = Reflect.get(target, prop);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		this.unsubscribeAgent = runtime.agent.subscribe((event) => this.emit(event));
		this.unsubscribeCompaction = runtime.onCompaction((event) => {
			if (event.type === "compaction_start") {
				this.emit({ type: "compaction_start", reason: event.reason });
			} else {
				this.emit({
					type: "compaction_end",
					...(event.result !== undefined ? { result: event.result } : {}),
					...(event.errorMessage !== undefined ? { errorMessage: event.errorMessage } : {}),
				});
			}
		});
	}

	get agent(): Agent {
		return this.runtime.agent;
	}
	get recorder(): FlightRecorder {
		return this.runtime.recorder;
	}
	get stats(): SessionStats {
		return this.runtime.stats;
	}
	get router(): ProviderRouter {
		return this.runtime.router;
	}
	get paths(): VanrelPaths {
		return this.runtime.paths;
	}
	get log(): Logger {
		return this.runtime.log;
	}

	/** drivePrompt semantics of run.ts: persist user → agent.prompt; exception propagates up (the TUI shows it). */
	async prompt(text: string, opts?: { images?: ImageContent[] }): Promise<void> {
		await this.runtime.session.appendUser(text);
		try {
			await this.runtime.agent.prompt(text, opts?.images);
		} catch (error) {
			this.runtime.log.error("agent run failed", { error: error instanceof Error ? error.message : String(error) });
			throw error;
		}
	}

	async compact(instructions?: string): Promise<void> {
		if (this.compactionController !== undefined) throw new Error("compaction already in progress");
		const controller = new AbortController();
		this.compactionController = controller;
		try {
			// compaction_start/end are emitted by wiring (SessionRuntime.onCompaction).
			await this.runtime.compactNow(instructions, controller.signal);
		} finally {
			this.compactionController = undefined;
		}
	}

	setModel(ref: string): void {
		// RouteError/BudgetError propagate up (facade.set → UI). agent.state.model is synced here
		// so the host is self-sufficient (InteractiveMode does the same again).
		const model = this.runtime.setModel(ref);
		this.runtime.agent.state.model = model;
	}

	setThinkingLevel(level: ThinkingLevel): void {
		// @vanrel/agent has no setThinkingLevel method — thinkingLevel lives in mutable state,
		// the agent loop reads it when building each request (createLoopConfig).
		this.runtime.agent.state.thinkingLevel = level;
		this.runtime.log.debug("thinking level changed", { level });
	}

	async executeBash(
		command: string,
		excludeFromContext: boolean,
		onUpdate: (delta: string) => void,
	): Promise<BashResult> {
		const bashTool = this.runtime.agent.state.tools.find((tool) => tool.name === "bash");
		if (!bashTool) throw new Error("bash tool is not registered in the agent");
		if (this.bashController !== undefined) throw new Error("a bash command is already running");
		const controller = new AbortController();
		this.bashController = controller;
		const startedAt = Date.now();
		this.runtime.log.debug("executeBash started", { command, excludeFromContext });
		try {
			const result = await bashTool.execute(`interactive-${startedAt}`, { command }, controller.signal);
			const structured = result.structuredContent as BashToolOutput | undefined;
			// structured.output — full output without the model-facing "[vanrel: exit N]" suffix.
			const output =
				structured?.output ?? result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
			const cancelled = controller.signal.aborted;
			if (output !== "") {
				onUpdate(output);
				this.emit({ type: "bash_execution_update", delta: output });
			}
			const bashResult: BashResult = {
				output,
				exitCode: cancelled ? undefined : structured?.exit_code,
				cancelled,
				truncated: structured?.truncated ?? false,
				...(structured?.full_output_path !== undefined ? { fullOutputPath: structured.full_output_path } : {}),
			};
			if (!excludeFromContext) {
				// excludeFromContext=true (!!) — onUpdate only, nothing written to the session (host.ts contract).
				await this.runtime.session
					.appendCustomEntry("bashExecution", {
						command,
						output,
						exitCode: bashResult.exitCode ?? null,
						cancelled,
						truncated: bashResult.truncated,
						fullOutputPath: bashResult.fullOutputPath ?? null,
						timestamp: startedAt,
					})
					.catch((error: unknown) => {
						this.runtime.log.warn("session persist failed (bashExecution)", { error: String(error) });
					});
			}
			return bashResult;
		} finally {
			this.bashController = undefined;
		}
	}

	subscribeSession(cb: (e: InteractiveSessionEvent) => void): () => void {
		this.emitter.on("event", cb);
		return () => {
			this.emitter.off("event", cb);
		};
	}

	abortBash(): void {
		this.bashController?.abort();
	}

	abortCompaction(): void {
		this.compactionController?.abort();
	}

	abortRetry(): void {
		// Fallback (host.ts): ProviderRouter has no targeted retry cancel — abort the whole run.
		this.runtime.agent.abort();
	}

	async close(reason: "user_exit" | "error" | "completed"): Promise<void> {
		// Idempotent: exactly one proxy into runtime.close (tap T5 is not duplicated).
		if (this.closed) return;
		this.closed = true;
		this.unsubscribeAgent();
		this.unsubscribeCompaction();
		this.emitter.removeAllListeners();
		await this.runtime.close(reason);
	}

	/** A listener that throws does not break the bus or the agent loop (logged). */
	private emit(event: InteractiveSessionEvent): void {
		for (const listener of this.emitter.listeners("event")) {
			try {
				(listener as (e: InteractiveSessionEvent) => void)(event);
			} catch (error) {
				this.runtime.log.error("session event listener failed", {
					type: event.type,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}
}

export function createInteractiveHost(runtime: SessionRuntime, opts: InteractiveHostOptions = {}): InteractiveHost {
	return new InteractiveHostImpl(runtime, opts);
}
