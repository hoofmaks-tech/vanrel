/**
 * OscillationGuard — edit-loop detector A→B→A.
 * sha256 of the normalized diff of step t equals the hash of step t−window (default 2) → abort:
 * the caller (cli) must change strategy and record the error to the trace.
 * Deterministic, no LLM, no I/O.
 */
import { createHash } from "node:crypto";
import { type Logger, NOOP_LOGGER } from "./logger.ts";

export type OscillationDecision = { action: "continue" } | { action: "abort"; reason: string; repeatedHash: string };

/** Diff normalization before hashing (spec): strips "^index " lines,
    timestamp suffixes on ---/+++ lines (GNU diff puts the file date after a TAB),
    trailing whitespace; line endings → LF; final empty lines are dropped. */
function normalizeDiff(diff: string): string {
	const lf = diff.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const out: string[] = [];
	for (const line of lf.split("\n")) {
		if (line.startsWith("index ")) continue; // "index abc123..def456 100644" — depends on blob sha
		let l = line;
		if (l.startsWith("--- ") || l.startsWith("+++ ")) {
			const tab = l.indexOf("\t");
			if (tab !== -1) l = l.slice(0, tab); // "--- a/f\t2026-10-18 ..." → "--- a/f"
		}
		out.push(l.replace(/[ \t]+$/g, ""));
	}
	while (out.length > 0 && out[out.length - 1] === "") out.pop();
	return out.join("\n");
}

/** sha256 of normalize(diff). Deterministic. */
export function hashDiff(diff: string): string {
	return createHash("sha256").update(normalizeDiff(diff), "utf8").digest("hex");
}

export class OscillationGuard {
	private readonly window: number;
	private readonly log: Logger;
	private hashes: string[] = [];

	constructor(options?: { window?: number; log?: Logger }) {
		this.window = options?.window ?? 2;
		this.log = options?.log ?? NOOP_LOGGER;
	}

	observe(diff: string): OscillationDecision {
		const hash = hashDiff(diff);
		// Hash of step t−window: before inserting the current one it sits at position length−window.
		const repeated = this.hashes.length >= this.window ? this.hashes[this.hashes.length - this.window] : undefined;
		this.hashes.push(hash);
		if (this.hashes.length > this.window) this.hashes.shift();
		if (repeated !== undefined && repeated === hash) {
			const reason = `oscillation detected: diff of step t matches step t−${this.window} (hash ${hash.slice(0, 12)}…)`;
			this.log.warn("oscillation guard: abort", { window: this.window, repeatedHash: hash });
			return { action: "abort", reason, repeatedHash: hash };
		}
		return { action: "continue" };
	}

	reset(): void {
		this.hashes = [];
		this.log.debug("oscillation guard reset", {});
	}
}
