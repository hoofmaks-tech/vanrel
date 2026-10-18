/**
 * A0 SessionHost (recon interactive-vendor §3.3): contract between wiring.ts and the future
 * InteractiveMode. Fields extend SessionRuntime (agent/session/recorder/stats/close are
 * already assembled in wiring; router/paths/log are passed through as A0 fields); operations
 * are what Pi InteractiveMode consumes from AgentSession, adapted to the vanrel linear model.
 *
 * TYPES ONLY. Implementation comes with the interactive-mode worker (recon §5 item 7).
 */
import type { Agent, AgentEvent, ThinkingLevel } from "@vanrel/agent";
import type { ImageContent, ProviderRouter } from "@vanrel/ai";
import type { CompactionResult } from "@vanrel/context";
import type { FlightRecorder, Logger } from "@vanrel/telemetry";
import type { SettingsFacade } from "../config.ts";
import type { VanrelPaths } from "../paths.ts";
import type { SessionManager } from "../session.ts";
import type { SessionStats } from "../wiring.ts";

/** executeBash result (mirrors BashResult from Pi core/bash-executor). */
export interface BashResult {
	/** Merged stdout+stderr (sanitized, possibly truncated). */
	output: string;
	/** Process exit code (undefined on kill/cancel). */
	exitCode: number | undefined;
	cancelled: boolean;
	truncated: boolean;
	/** Path to the temp file with full output (if truncation happened). */
	fullOutputPath?: string;
}

/**
 * TUI event model: AgentEvent (@vanrel/agent) + session events that Pi emits from
 * AgentSession and vanrel synthesizes from wiring.ts hooks (R1):
 * compaction ← HistoryCompactor, auto_retry ← router/retry, queue ← agent queues,
 * bash_execution ← executeBash, session_info ← setSessionName.
 */
export type InteractiveSessionEvent =
	| AgentEvent
	| { type: "compaction_start"; reason: "manual" | "threshold" }
	| { type: "compaction_end"; result?: CompactionResult; errorMessage?: string }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number } // from router/retry
	| { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] } // agent queue
	| { type: "bash_execution_update"; delta: string }
	| { type: "session_info_changed"; name?: string };

export interface InteractiveHost {
	// --- ready-made from SessionRuntime (wiring.ts) ---
	readonly agent: Agent; // @vanrel/agent: prompt/abort/subscribe/state
	readonly session: SessionManager; // extended, see A2
	readonly recorder: FlightRecorder; // TUI tap events (session_end already written by close)
	readonly stats: SessionStats;
	close(reason: "user_exit" | "error" | "completed"): Promise<void>;

	// --- new fields for the TUI ---
	readonly router: ProviderRouter; // A1: /model, cycleModel, available providers
	readonly settings: SettingsFacade; // A3
	readonly paths: VanrelPaths; // A4 (agentDir → paths.home)
	readonly log: Logger;

	// --- operations missing from SessionRuntime ---
	prompt(text: string, opts?: { images?: ImageContent[] }): Promise<void>; // = agent.prompt + persist user
	compact(instructions?: string): Promise<void>; // HistoryCompactor in manual mode + persist entry
	setModel(ref: string): void; // router.route + currentModel change + budget recompute
	setThinkingLevel(level: ThinkingLevel): void; // agent.state.thinkingLevel (no such method in @vanrel/agent)
	executeBash(command: string, excludeFromContext: boolean, onUpdate: (delta: string) => void): Promise<BashResult>;
	subscribeSession(cb: (e: InteractiveSessionEvent) => void): () => void;

	// --- abort operations (W14, closing VENDOR-GAP W13) ---
	abortBash(): void; // AbortController of the current executeBash; no-op outside a run
	abortCompaction(): void; // AbortSignal into compactNow; no-op outside manual compaction
	/** Fallback: ProviderRouter has no dedicated retry controller — aborts the whole agent run. */
	abortRetry(): void;
}
