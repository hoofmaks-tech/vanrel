/**
 * ShadowWorktree — isolation of agent edits via git worktree.
 * With QC enabled, agent edit/write tools write ONLY into wt.path; transfer to the main
 * tree happens via applyTo() after a successful gate. All git invocations go through
 * execFile without a shell, 30s timeout (GIT_TIMEOUT_MS).
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { QcError } from "./error.ts";
import { type Logger, NOOP_LOGGER } from "./logger.ts";
import { runCommand } from "./proc.ts";

export interface ShadowWorktreeOptions {
	repoRoot: string;
	baseRef?: string; // default "HEAD"
	worktreesDir?: string; // default ~/.vanrel/worktrees
	sessionId?: string; // part of the wt-<sessionId>-<n> name; default: random suffix
	log?: Logger;
}

/** Timeout for any git invocation of the package (spec: 30s). */
export const GIT_TIMEOUT_MS = 30_000;

/** Worktree counter within a sessionId → name wt-<sessionId>-<n>, n from 1. */
const worktreeCounters = new Map<string, number>();

function nextWorktreeIndex(sessionId: string): number {
	const next = (worktreeCounters.get(sessionId) ?? 0) + 1;
	worktreeCounters.set(sessionId, next);
	return next;
}

/** A git command that must exit with code 0; otherwise ERROR log + QcError. */
async function runGit(args: readonly string[], cwd: string, input: string | undefined, log: Logger): Promise<string> {
	let result: { stdout: string; stderr: string; code: number };
	try {
		result = await runCommand("git", args, { cwd, input, timeoutMs: GIT_TIMEOUT_MS });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		log.error("git invocation failed", { cmd: `git ${args.join(" ")}`, cwd, error: msg });
		throw new QcError(`git ${args[0]} failed to execute: ${msg}`);
	}
	if (result.code !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim();
		log.error("git command exited non-zero", {
			cmd: `git ${args.join(" ")}`,
			cwd,
			code: result.code,
			stderr: detail,
		});
		throw new QcError(`git ${args[0]} exited ${result.code}: ${detail}`);
	}
	return result.stdout;
}

export class ShadowWorktree {
	readonly path: string;
	readonly baseRef: string;
	/** Absolute path of the main repository root (needed by the gate for provision). */
	readonly repoRoot: string;
	private readonly log: Logger;
	private disposed = false;

	private constructor(path: string, baseRef: string, repoRoot: string, log: Logger) {
		this.path = path;
		this.baseRef = baseRef;
		this.repoRoot = repoRoot;
		this.log = log;
	}

	/** `git worktree add --detach <path> <baseRef>`; path = <worktreesDir>/wt-<sessionId>-<n>. */
	static async create(options: ShadowWorktreeOptions): Promise<ShadowWorktree> {
		const log = options.log ?? NOOP_LOGGER;
		const repoRoot = resolve(options.repoRoot);
		const baseRef = options.baseRef ?? "HEAD";
		const sessionId = options.sessionId ?? randomBytes(4).toString("hex");
		const worktreesDir = options.worktreesDir ?? join(homedir(), ".vanrel", "worktrees");
		const path = join(worktreesDir, `wt-${sessionId}-${nextWorktreeIndex(sessionId)}`);
		await mkdir(worktreesDir, { recursive: true });
		await runGit(["worktree", "add", "--detach", path, baseRef], repoRoot, undefined, log);
		log.info("shadow worktree created", { path, baseRef, sessionId, repoRoot });
		return new ShadowWorktree(path, baseRef, repoRoot, log);
	}

	/** Full diff against baseRef (`git diff --binary <baseRef>`). "" if there are no edits. */
	async diff(): Promise<string> {
		this.assertAlive("diff");
		return runGit(["diff", "--binary", this.baseRef], this.path, undefined, this.log);
	}

	/** Transfer to the main tree: `git apply --check` then `git apply` in repoRoot.
	    Conflict → throw QcError (the diff is sent to the trace by the caller). */
	async applyTo(): Promise<void> {
		this.assertAlive("applyTo");
		const patch = await this.diff();
		if (patch === "") {
			this.log.info("applyTo: empty diff, nothing to transfer", { path: this.path });
			return;
		}
		await runGit(["apply", "--check"], this.repoRoot, patch, this.log);
		await runGit(["apply"], this.repoRoot, patch, this.log);
		this.log.info("shadow worktree applied to repoRoot", { path: this.path, repoRoot: this.repoRoot });
	}

	/** `git worktree remove --force`. Idempotent; WARN if already removed. */
	async dispose(): Promise<void> {
		if (this.disposed) {
			this.log.warn("dispose: worktree already removed, repeated call ignored", { path: this.path });
			return;
		}
		if (!existsSync(this.path)) {
			this.disposed = true;
			this.log.warn("dispose: worktree directory missing, marked as removed", { path: this.path });
			return;
		}
		await runGit(["worktree", "remove", "--force", this.path], this.repoRoot, undefined, this.log);
		this.disposed = true;
		this.log.info("shadow worktree disposed", { path: this.path });
	}

	private assertAlive(op: string): void {
		if (this.disposed) {
			this.log.error(`${op}: worktree already removed`, { path: this.path });
			throw new QcError(`${op}: shadow worktree ${this.path} already removed`);
		}
	}
}
