import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createDefaultChecks,
	GATE_OUTPUT_MAX_BYTES,
	type GateCheck,
	type GateRecorder,
	PreCommitGate,
	ShadowWorktree,
} from "../src/index.ts";
import { git, makeRepo } from "./git-repo.ts";

function mockCheck(id: "tsc" | "biome" | "ui-snapshot", ok: boolean, output: string, calls?: string[]): GateCheck {
	return {
		id,
		async run(worktreePath) {
			calls?.push(id);
			expect(typeof worktreePath).toBe("string");
			return { id, ok, durationMs: 0, output };
		},
	};
}

function collectRecorder(): { recorder: GateRecorder; events: { t: string; p: unknown }[] } {
	const events: { t: string; p: unknown }[] = [];
	return { recorder: { record: (t, p) => events.push({ t, p }) }, events };
}

async function makeWorktree(prefix: string): Promise<{ wt: ShadowWorktree; root: string }> {
	const { root, worktreesDir } = makeRepo(prefix);
	const wt = await ShadowWorktree.create({ repoRoot: root, worktreesDir, sessionId: "gate" });
	return { wt, root };
}

describe("PreCommitGate (mock checks, real tsc is not launched)", () => {
	it("default checks — tsc and biome; ui-snapshot strictly opt-in", () => {
		expect(createDefaultChecks().map((c) => c.id)).toEqual(["tsc", "biome"]);
		expect(createDefaultChecks({ uiSnapshot: true }).map((c) => c.id)).toEqual(["tsc", "biome", "ui-snapshot"]);
	});

	it("all checks ok → gate ok, order preserved", async () => {
		const { wt } = await makeWorktree("qc-gate-ok-");
		const calls: string[] = [];
		const gate = new PreCommitGate([
			mockCheck("tsc", true, "clean", calls),
			mockCheck("biome", true, "clean", calls),
		]);
		const report = await gate.run(wt);
		expect(report.ok).toBe(true);
		expect(report.checks.map((c) => c.id)).toEqual(["tsc", "biome"]);
		expect(calls).toEqual(["tsc", "biome"]);
		expect(report.summary).toContain("gate ok");
		await wt.dispose();
	});

	it("short-circuit: the first failure stops the chain", async () => {
		const { wt } = await makeWorktree("qc-gate-sc-");
		const calls: string[] = [];
		const gate = new PreCommitGate([
			mockCheck("tsc", false, "error TS2322", calls),
			mockCheck("biome", true, "", calls),
		]);
		const report = await gate.run(wt);
		expect(report.ok).toBe(false);
		expect(report.checks).toHaveLength(1);
		expect(report.checks[0].id).toBe("tsc");
		expect(calls).toEqual(["tsc"]); // biome was not run
		expect(report.summary).toContain("gate failed: tsc");
		await wt.dispose();
	});

	it("raw output → recorder (full), GateCheckResult.output — filtered ≤2KB", async () => {
		const { wt } = await makeWorktree("qc-gate-filt-");
		const raw = `head\n${"x".repeat(10000)}\ntail error TS1`;
		const { recorder, events } = collectRecorder();
		const gate = new PreCommitGate([mockCheck("tsc", false, raw)], { recorder });
		const report = await gate.run(wt);
		expect(report.ok).toBe(false);

		const out = report.checks[0].output;
		expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(GATE_OUTPUT_MAX_BYTES);
		expect(out).not.toBe(raw);

		expect(events).toHaveLength(1);
		expect(events[0].t).toBe("tool_result");
		const p = events[0].p as { rawOutput: string; filteredOutput: string; isError: boolean; tool: string };
		expect(p.tool).toBe("qc-gate");
		expect(p.isError).toBe(true);
		expect(p.rawOutput).toBe(raw); // raw, in full
		expect(p.filteredOutput).toBe(out);
		await wt.dispose();
	});

	it("check threw an exception → failed gate, message in output, no crash", async () => {
		const { wt } = await makeWorktree("qc-gate-throw-");
		const bad: GateCheck = {
			id: "tsc",
			async run() {
				throw new Error("boom");
			},
		};
		const gate = new PreCommitGate([bad]);
		const report = await gate.run(wt);
		expect(report.ok).toBe(false);
		expect(report.checks[0].output).toContain("boom");
		await wt.dispose();
	});

	it("integration (real git): provision symlink-modules links root and per-package node_modules", async () => {
		const { root, worktreesDir } = makeRepo("qc-gate-prov-");
		writeFileSync(join(root, ".gitignore"), "node_modules/\n");
		writeFileSync(join(root, "package.json"), "{}\n");
		mkdirSync(join(root, "node_modules", "dep-marker"), { recursive: true });
		writeFileSync(join(root, "node_modules", "dep-marker", "index.js"), "module.exports = 1;\n");
		mkdirSync(join(root, "packages", "pkg-a", "node_modules"), { recursive: true });
		writeFileSync(join(root, "packages", "pkg-a", "package.json"), "{}\n");
		writeFileSync(join(root, "packages", "pkg-a", "node_modules", "marker2.txt"), "x\n");
		git(root, ["add", "."]);
		git(root, ["-c", "commit.gpgsign=false", "commit", "-m", "add packages"]);

		const wt = await ShadowWorktree.create({ repoRoot: root, worktreesDir, sessionId: "prov" });
		// Provisioning does not touch an already existing node_modules in the worktree.
		mkdirSync(join(wt.path, "node_modules"));
		writeFileSync(join(wt.path, "node_modules", "sentinel.txt"), "keep\n");

		const probe: GateCheck = {
			id: "tsc",
			async run(worktreePath) {
				// root one — pre-existing real dir, not replaced by a symlink
				const rootNm = lstatSync(join(worktreePath, "node_modules"));
				expect(rootNm.isSymbolicLink()).toBe(false);
				expect(existsSync(join(worktreePath, "node_modules", "sentinel.txt"))).toBe(true);
				// per-package — symlink to repoRoot node_modules, content accessible
				const pkgNm = lstatSync(join(worktreePath, "packages", "pkg-a", "node_modules"));
				expect(pkgNm.isSymbolicLink()).toBe(true);
				expect(existsSync(join(worktreePath, "packages", "pkg-a", "node_modules", "marker2.txt"))).toBe(true);
				return { id: "tsc", ok: true, durationMs: 0, output: "provision ok" };
			},
		};
		const gate = new PreCommitGate([probe]); // default provision = "symlink-modules"
		const report = await gate.run(wt);
		expect(report.ok).toBe(true);
		await wt.dispose();
	});
});
