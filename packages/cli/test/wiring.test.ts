/**
 * Wiring Challenger remediations (recon challenger-integration):
 * - M3: setModel is transactional — a BudgetError from the budget check leaves currentModel unmutated.
 * - M6: a throw during assembly (fail-fast budget) → mcp cleanup (child process dead) + qc (worktree removed).
 *
 * BudgetError is injected via a computeBudget mock (real catalog: W≥128k on all models,
 * the budget cannot blow up organically). The mock passes through all of @vanrel/context except computeBudget.
 * Fake oauth record (test/mcp.test.ts pattern), no network.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BudgetError } from "@vanrel/context";
import { NOOP_LOGGER } from "@vanrel/telemetry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type VanrelPaths, vanrelPaths } from "../src/paths.ts";
import { createSessionRuntime } from "../src/wiring.ts";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-mcp-server.mjs", import.meta.url));

/** computeBudget mock control: failNext — a one-shot BudgetError; seen — context windows of all calls. */
const budgetControl = vi.hoisted(() => ({ failNext: false, seen: [] as number[] }));

vi.mock("@vanrel/context", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@vanrel/context")>();
	return {
		...actual,
		computeBudget: (input: Parameters<typeof actual.computeBudget>[0]) => {
			budgetControl.seen.push(input.contextWindow);
			if (budgetControl.failNext) {
				budgetControl.failNext = false;
				throw new actual.BudgetError("test: injected budget failure");
			}
			return actual.computeBudget(input);
		},
	};
});

function fakeServer(env: Record<string, string>) {
	return { command: process.execPath, args: [FIXTURE], env };
}

async function writeAuthFile(paths: VanrelPaths, providers: string[]): Promise<void> {
	const credentials = Object.fromEntries(
		providers.map((provider) => [
			provider,
			{ type: "oauth", accessToken: "fake", refreshToken: "fake", expiresAt: Date.now() + 86_400_000 },
		]),
	);
	await writeFile(paths.authFile, JSON.stringify({ v: 1, credentials }));
}

describe("wiring remediation (M3/M6)", () => {
	let dir: string;
	let home: string;
	let paths: VanrelPaths;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "vanrel-wiring-rem-"));
		home = join(dir, "home");
		await mkdir(home, { recursive: true });
		paths = vanrelPaths({ VANREL_HOME: home } as NodeJS.ProcessEnv);
		budgetControl.failNext = false;
		budgetControl.seen.length = 0;
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("M3: BudgetError in setModel does not mutate state; a repeated setModel succeeds", async () => {
		await writeAuthFile(paths, ["anthropic", "agy"]);
		const runtime = await createSessionRuntime({ cwd: dir, argv: ["vanrel"], paths, config: {}, log: NOOP_LOGGER });
		try {
			expect(runtime.agent.state.model.id).toBe("claude-sonnet-5"); // default, W=200000

			budgetControl.failNext = true;
			expect(() => runtime.setModel("agy/gemini-3-pro-preview")).toThrow(BudgetError);

			// State fully unchanged: the budget in compactNow is computed for the OLD model (W=200000),
			// not agy (W=1048576) — a marker of an unmutated currentModel.
			budgetControl.seen.length = 0;
			await runtime.compactNow();
			expect(budgetControl.seen.at(-1)).toBe(200_000);

			// Once the failure is lifted the same transition commits — no half-synchronized state.
			const model = runtime.setModel("agy/gemini-3-pro-preview");
			expect(model.id).toBe("gemini-3-pro-preview");
			budgetControl.seen.length = 0;
			await runtime.compactNow();
			expect(budgetControl.seen.at(-1)).toBe(1_048_576);
		} finally {
			await runtime.close("completed");
		}
	}, 15_000);

	it("M6: BudgetError on the fail-fast budget → mcp process killed, shadow worktree removed", async () => {
		// QC requires a git repository with HEAD (git worktree add --detach <path> HEAD).
		execFileSync("git", ["init"], { cwd: dir });
		await writeFile(join(dir, "seed.txt"), "seed\n");
		execFileSync("git", ["add", "."], { cwd: dir });
		execFileSync("git", ["-c", "user.email=vanrel@test", "-c", "user.name=vanrel", "commit", "-m", "init"], {
			cwd: dir,
		});

		await writeAuthFile(paths, ["anthropic"]);
		const pidFile = join(dir, "mcp.pid");
		budgetControl.failNext = true; // the very first computeBudget (fail-fast in assembleRuntime) will throw
		await expect(
			createSessionRuntime({
				cwd: dir,
				argv: ["vanrel"],
				paths,
				config: { qc: { enabled: true }, mcpServers: { fake: fakeServer({ FAKE_MCP_PID_FILE: pidFile }) } },
				log: NOOP_LOGGER,
			}),
		).rejects.toThrow(BudgetError);

		// mcp: cleanup closed the connection — the child process is dead (ESRCH).
		const pid = Number((await readFile(pidFile, "utf8")).trim());
		expect(Number.isInteger(pid)).toBe(true);
		expect(() => process.kill(pid, 0)).toThrow();

		// qc: cleanup removed the shadow worktree (createQcRuntime had completed before budget()).
		const worktrees = existsSync(paths.worktrees) ? await readdir(paths.worktrees) : [];
		expect(worktrees.filter((name) => name.startsWith("wt-"))).toEqual([]);
	}, 20_000);
});
