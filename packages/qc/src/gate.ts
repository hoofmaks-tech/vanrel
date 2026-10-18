/**
 * PreCommitGate — deterministic worktree checks without LLM.
 * Default: tsc --noEmit → biome check; ui-snapshot — strictly opt-in (createDefaultChecks
 * with { uiSnapshot: true }, matching the project config qc.checks with "ui-snapshot").
 * Short-circuit: the first failure stops the chain. Raw output of each check goes
 * to deps.recorder (tap T4, 0 tokens); GateCheckResult.output carries only the
 * NoiseFilter-filtered text (≤2KB, sent to the context on failure).
 */
import { lstatSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { filterToolOutput } from "@vanrel/context";
import { QcError } from "./error.ts";
import { type Logger, NOOP_LOGGER } from "./logger.ts";
import { runCommand } from "./proc.ts";
import type { ShadowWorktree } from "./worktree.ts";

export interface GateCheckResult {
	id: string;
	ok: boolean;
	durationMs: number;
	output: string; // FILTERED output (NoiseFilter, ≤2KB) — it is sent to the context on failure
}

/** Contract of a single check. The output field is returned RAW: the gate itself writes
    it to the recorder and replaces it with the filtered one in the final GateReport. */
export interface GateCheck {
	readonly id: "tsc" | "biome" | "ui-snapshot";
	run(worktreePath: string, signal?: AbortSignal): Promise<GateCheckResult>;
}

export interface GateReport {
	ok: boolean;
	checks: GateCheckResult[];
	summary: string;
}

/** Structural writer of the gate's raw output (structurally compatible with FlightRecorder,
    no dependency on @vanrel/telemetry is declared — §4.4 preamble). */
export interface GateRecorder {
	record(t: "tool_result", p: unknown): void;
}

export interface PreCommitGateDeps {
	filterOutput?: typeof filterToolOutput;
	recorder?: GateRecorder;
	provision?: "symlink-modules" | "install"; // default "symlink-modules"
	log?: Logger;
}

/** Cap of the gate's filtered output (spec §3.1: gate report into context ≤2KB). */
export const GATE_OUTPUT_MAX_BYTES = 2048;

/** Timeout of a single check (tsc/biome on a mid-size repo fit with margin). */
export const GATE_CHECK_TIMEOUT_MS = 180_000;

/** Timeout of `npm ci` with provision="install" (network/cache, allowed to be longer). */
export const PROVISION_INSTALL_TIMEOUT_MS = 600_000;

function commandCheck(id: "tsc" | "biome" | "ui-snapshot", cmd: string, args: string[], log: Logger): GateCheck {
	return {
		id,
		async run(worktreePath, signal) {
			log.debug("gate check started", { id, worktreePath, cmd: `${cmd} ${args.join(" ")}` });
			let raw: string;
			let ok: boolean;
			try {
				const r = await runCommand(cmd, args, {
					cwd: worktreePath,
					timeoutMs: GATE_CHECK_TIMEOUT_MS,
					signal,
					env: { ...process.env, CI: "1" },
				});
				raw = r.stdout + (r.stderr === "" ? "" : `\n${r.stderr}`);
				ok = r.code === 0;
			} catch (err) {
				// Spawn error / timeout / abort — the check could not run: this is a failed gate,
				// not a loop crash; the message is recorded in the raw output (I5: no silent paths).
				raw = `[vanrel-qc: check "${id}" failed to execute: ${err instanceof Error ? err.message : String(err)}]`;
				ok = false;
				log.error("gate check execution failed", { id, worktreePath, error: raw });
			}
			return { id, ok, durationMs: 0 /* measured by the gate */, output: raw };
		},
	};
}

/** Default checks (§4.4): tsc → biome. ui-snapshot (vitest run -t splash, headless) —
    opt-in only via { uiSnapshot: true } (project config qc.checks with "ui-snapshot"). */
export function createDefaultChecks(options?: { uiSnapshot?: boolean }, log?: Logger): GateCheck[] {
	const lg = log ?? NOOP_LOGGER;
	const checks: GateCheck[] = [
		commandCheck("tsc", "npx", ["tsc", "--noEmit"], lg),
		commandCheck("biome", "npx", ["biome", "check", "."], lg),
	];
	if (options?.uiSnapshot === true) {
		checks.push(commandCheck("ui-snapshot", "npx", ["vitest", "run", "-t", "splash"], lg));
	}
	return checks;
}

/** All node_modules of repoRoot (root + per-package), relative paths.
    Does not descend into node_modules and .git; symlinks are not followed (readdir
    reports them as non-directories). */
function findNodeModulesDirs(repoRoot: string): string[] {
	const found: string[] = [];
	const walk = (absDir: string): void => {
		for (const entry of readdirSync(absDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			if (entry.name === ".git") continue;
			const abs = join(absDir, entry.name);
			if (entry.name === "node_modules") {
				found.push(relative(repoRoot, abs));
				continue;
			}
			walk(abs);
		}
	};
	walk(repoRoot);
	return found.sort();
}

/** Default provisioning: symlink repoRoot node_modules (root + per-package) into the worktree.
    Fast, no network, workspaces-compatible. Existing directories are left untouched. */
function provisionSymlinkModules(repoRoot: string, wtPath: string, log: Logger): void {
	const dirs = findNodeModulesDirs(repoRoot);
	let linked = 0;
	for (const rel of dirs) {
		const linkPath = join(wtPath, rel);
		// lstat, not existsSync: a dangling symlink also counts as existing.
		if (lstatSync(linkPath, { throwIfNoEntry: false }) !== undefined) {
			log.debug("provision: node_modules already exists, skipping", { linkPath });
			continue;
		}
		mkdirSync(dirname(linkPath), { recursive: true });
		symlinkSync(resolve(repoRoot, rel), linkPath, "dir");
		linked++;
	}
	log.info("provision symlink-modules done", { worktreePath: wtPath, linked, skipped: dirs.length - linked });
}

/** Fallback provisioning for exotic layouts: npm ci in the worktree (slow). */
async function provisionInstall(wtPath: string, signal: AbortSignal | undefined, log: Logger): Promise<void> {
	log.info("provision install started", { worktreePath: wtPath });
	const r = await runCommand("npm", ["ci", "--prefer-offline", "--ignore-scripts", "--legacy-peer-deps"], {
		cwd: wtPath,
		timeoutMs: PROVISION_INSTALL_TIMEOUT_MS,
		signal,
	});
	if (r.code !== 0) {
		log.error("provision install failed", { worktreePath: wtPath, code: r.code, stderr: r.stderr.trim() });
		throw new QcError(`provision "install" failed (exit ${r.code}): ${r.stderr.trim()}`);
	}
	log.info("provision install done", { worktreePath: wtPath });
}

export class PreCommitGate {
	private readonly checks: GateCheck[];
	private readonly filterOutput: typeof filterToolOutput;
	private readonly recorder: GateRecorder | undefined;
	private readonly provision: "symlink-modules" | "install";
	private readonly log: Logger;

	constructor(checks?: GateCheck[], deps?: PreCommitGateDeps) {
		this.log = deps?.log ?? NOOP_LOGGER;
		this.checks = checks ?? createDefaultChecks(undefined, this.log);
		this.filterOutput = deps?.filterOutput ?? filterToolOutput;
		this.recorder = deps?.recorder;
		this.provision = deps?.provision ?? "symlink-modules";
	}

	async run(wt: ShadowWorktree, signal?: AbortSignal): Promise<GateReport> {
		if (this.provision === "symlink-modules") {
			provisionSymlinkModules(wt.repoRoot, wt.path, this.log);
		} else {
			await provisionInstall(wt.path, signal, this.log);
		}

		const results: GateCheckResult[] = [];
		for (const check of this.checks) {
			const startedAt = Date.now();
			let raw: string;
			let ok: boolean;
			try {
				const r = await check.run(wt.path, signal);
				raw = r.output;
				ok = r.ok;
			} catch (err) {
				// A custom check threw — a failed gate with recording, not a loop crash.
				raw = `[vanrel-qc: check "${check.id}" threw: ${err instanceof Error ? err.message : String(err)}]`;
				ok = false;
				this.log.error("gate check threw", { id: check.id, error: raw });
			}
			const durationMs = Date.now() - startedAt;

			// The full raw output goes to the trace (tap T4); only filtered ≤2KB goes to the context.
			const filtered = this.filterOutput("qc-gate", raw, {
				policies: {
					build: { maxBytes: GATE_OUTPUT_MAX_BYTES },
					test: { maxBytes: GATE_OUTPUT_MAX_BYTES },
					"git-diff": { maxBytes: GATE_OUTPUT_MAX_BYTES },
					generic: { maxBytes: GATE_OUTPUT_MAX_BYTES },
				},
			});
			this.recorder?.record("tool_result", {
				toolCallId: `qc-gate-${check.id}`,
				tool: "qc-gate",
				durationMs,
				isError: !ok,
				rawOutput: raw,
				filteredOutput: filtered.text,
				filterStats: {
					class: filtered.class,
					inputBytes: filtered.stats.inputBytes,
					outputBytes: filtered.stats.outputBytes,
					omittedLines: filtered.stats.omittedLines,
				},
			});

			results.push({ id: check.id, ok, durationMs, output: filtered.text });
			if (!ok) {
				this.log.warn("gate check failed, short-circuit", { id: check.id, durationMs });
				break;
			}
			this.log.info("gate check passed", { id: check.id, durationMs });
		}

		const ok = results.every((r) => r.ok);
		const summary = ok
			? `gate ok: ${results.length} check(s) passed (${results.map((r) => r.id).join(", ")})`
			: `gate failed: ${results[results.length - 1].id} (${results.length}/${this.checks.length} checks ran)`;
		this.log.info("gate finished", { ok, ran: results.length, total: this.checks.length });
		return { ok, checks: results, summary };
	}
}
