/**
 * Shared infrastructure of the builtin tools: deps contracts (QC hooks, Logger), text-result helper,
 * filesystem utilities walk/globToRegExp. Previously lived in src/tools.ts; extracted when moving
 * to the tools/ directory (pi-vendor, W9).
 */
import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentToolResult } from "@vanrel/agent";
import type { Logger } from "@vanrel/telemetry";

/** Hard cap on the readable file size (raw data; before NoiseFilter). */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn"]);

export interface QcHooks {
	/** Absolute target path → path in the shadow worktree; undefined — target outside repoRoot (direct edit, WARN). */
	toWorktreePath(absPath: string): string | undefined;
	/** PreCommitGate + OscillationGuard after an edit; ok=false/terminate → error-result for the model. */
	afterEdit(): Promise<{ ok: boolean; report: string; terminate?: boolean }>;
}

/** Machine-readable QC edit status in details (m17: TUI marker; [qc:*] stays in the text for the model). */
export type QcStatus = "ok" | "gate-failed" | "abort";

export interface BuiltinToolsDeps {
	cwd: string;
	log?: Logger;
	qc?: QcHooks;
}

/**
 * text-result helper. terminate=true (M5) is propagated into AgentToolResult: the agent loop aborts
 * the batch only on result.terminate===true (agent-loop.ts shouldTerminateToolBatch) — without it a
 * QC/OscillationGuard abort reached the model only as text while the loop kept running.
 */
export function text(
	text: string,
	isError = false,
	details?: Record<string, unknown>,
	terminate = false,
): AgentToolResult<any> {
	return { content: [{ type: "text", text }], details, isError, ...(terminate ? { terminate: true } : {}) };
}

export async function assertFile(absPath: string): Promise<void> {
	const st = await stat(absPath);
	if (!st.isFile()) throw new Error(`not a file: ${absPath}`);
	if (st.size > MAX_FILE_BYTES) throw new Error(`file too large: ${st.size} bytes (cap ${MAX_FILE_BYTES})`);
}

export async function* walk(dir: string, signal?: AbortSignal): AsyncGenerator<string> {
	if (signal?.aborted) return;
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return; // unreadable directory — skip (search must not fail on permission denied)
	}
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (!SKIP_DIRS.has(entry.name)) yield* walk(full, signal);
		} else if (entry.isFile()) {
			yield full;
		}
	}
}

export function globToRegExp(glob: string): RegExp {
	let out = "^";
	let i = 0;
	while (i < glob.length) {
		const ch = glob[i]!;
		if (ch === "*") {
			if (glob[i + 1] === "*") {
				out += ".*";
				i += 2;
				if (glob[i] === "/") i++;
			} else {
				out += "[^/]*";
				i++;
			}
		} else if (ch === "?") {
			out += "[^/]";
			i++;
		} else if (ch === "{") {
			const end = glob.indexOf("}", i);
			if (end === -1) {
				out += "\\{";
				i++;
			} else {
				out += `(?:${glob
					.slice(i + 1, end)
					.split(",")
					.map((alt) => alt.replace(/[.+^${}()|[\]\\]/g, "\\$&"))
					.join("|")})`;
				i = end + 1;
			}
		} else {
			out += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
			i++;
		}
	}
	return new RegExp(`${out}$`);
}
