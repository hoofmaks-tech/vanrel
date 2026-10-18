// MIT License, Copyright (c) 2025 Mario Zechner
// Vendored from earendil-works/pi (packages/coding-agent/src/modes/interactive/program-status-reporter.ts), adapted for vanrel.
//
// Adaptation: pi-tui → @vanrel/tui; APP_NAME from ../paths.ts (A4); AgentSessionEvent →
// InteractiveSessionEvent (./host.ts, recon interactive-vendor §3.3). vanrel event differences:
// no agent_settled — agent_end is used instead (the vanrel Agent drains queues inside the run,
// agent_end ≈ settled; aborted is derived from the stopReason of the last assistant message);
// compaction_end carries no reason (host-impl drops the wiring field) — the reason is
// remembered from compaction_start; InteractiveHost has abortCompaction (host.ts), but the
// TUI never calls it, so the Pi aborted branches are removed.

import type { AssistantMessage } from "@vanrel/ai";
import type { ProgramStatus, Terminal } from "@vanrel/tui";
import { APP_NAME } from "../paths.ts";
import type { InteractiveSessionEvent } from "./host.ts";

export type BlockedStatus = { kind: NonNullable<ProgramStatus["kind"]>; message: string };

function firstLine(text: string | undefined): string {
	return text?.split(/\r?\n/, 1)[0]?.trim() || "Error";
}

/** stopReason of the last assistant message of the run (for agent_end → settled estimate). */
function lastAssistantStopReason(messages: readonly { role: string }[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant") return (message as AssistantMessage).stopReason;
	}
	return undefined;
}

/**
 * Reports interactive-mode state to the terminal (OSC 7501): `working` during agent runs and
 * compaction, `blocked` while a dialog waits for the user, then `done`, `error`, or `idle` once the run
 * settles. Messages are limited to the session name, dialog titles, and the first line of errors; prompts
 * and assistant output are never reported.
 */
export class ProgramStatusReporter {
	private readonly getTerminal: () => Terminal;
	private readonly getSessionName: () => string | undefined;
	private runActive = false;
	private compacting = false;
	/** reason of the last compaction_start (compaction_end has no reason of its own). */
	private lastCompactionReason: "manual" | "threshold" = "threshold";
	/** Outcome of the current run, reported once it settles. */
	private runResult: ProgramStatus = { state: "done" };
	/** Status while no run is active. */
	private restingStatus: ProgramStatus = { state: "idle" };
	/** Open dialogs by source, in the order they opened. The most recent one is reported. */
	private readonly blocked = new Map<string, BlockedStatus>();
	private lastReport: string | undefined;

	constructor(getTerminal: () => Terminal, getSessionName: () => string | undefined) {
		this.getTerminal = getTerminal;
		this.getSessionName = getSessionName;
	}

	handleEvent(event: InteractiveSessionEvent): void {
		switch (event.type) {
			case "agent_start":
				this.runActive = true;
				this.runResult = { state: "done" };
				break;
			case "message_end":
				// The latest response decides the outcome, so a retried error is replaced by its successful retry.
				if (event.message.role !== "assistant") return;
				{
					const message = event.message as AssistantMessage;
					this.runResult =
						message.stopReason === "error"
							? { state: "error", message: firstLine(message.errorMessage) }
							: { state: "done" };
				}
				break;
			case "compaction_start":
				this.compacting = true;
				this.lastCompactionReason = event.reason;
				break;
			case "compaction_end":
				this.compacting = false;
				// vanrel: compaction is not interruptible from the TUI; no Pi aborted branches.
				if (this.runActive) {
					// A failed recovery compaction ends the run unless a later response succeeds.
					if (event.errorMessage) this.runResult = { state: "error", message: firstLine(event.errorMessage) };
				} else if (this.lastCompactionReason === "manual") {
					this.restingStatus = event.errorMessage
						? { state: "error", message: firstLine(event.errorMessage) }
						: { state: "done" };
				}
				break;
			case "agent_end":
				// vanrel Agent does not emit agent_settled: queues drain inside the run, agent_end ≈ settled.
				this.runActive = false;
				this.restingStatus =
					lastAssistantStopReason(event.messages) === "aborted" ? { state: "idle" } : this.runResult;
				break;
			case "session_info_changed":
				// The session name is part of working and done reports.
				break;
			default:
				return;
		}
		this.report();
	}

	/** Report `blocked` for a dialog until it is cleared with `undefined`. Reopening a source replaces it. */
	setBlocked(source: string, status: BlockedStatus | undefined): void {
		this.blocked.delete(source);
		if (status) this.blocked.set(source, status);
		this.report();
	}

	/** Forget the previous session's run, for example after switching sessions. */
	reset(): void {
		this.runActive = false;
		this.compacting = false;
		this.runResult = { state: "done" };
		this.restingStatus = { state: "idle" };
		this.report();
	}

	report(): void {
		const status: ProgramStatus = { ...this.currentStatus(), app: APP_NAME };
		const key = JSON.stringify(status);
		if (key === this.lastReport) return;
		this.lastReport = key;
		this.getTerminal().setProgramStatus(status);
	}

	private currentStatus(): ProgramStatus {
		const blocked = [...this.blocked.values()].at(-1);
		if (blocked) return { state: "blocked", ...blocked };
		if (this.compacting) return { state: "working", message: "Compacting context" };
		const status = this.runActive ? { state: "working" as const } : this.restingStatus;
		if (status.state === "working" || status.state === "done") return { ...status, message: this.getSessionName() };
		return status;
	}
}
