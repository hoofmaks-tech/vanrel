/**
 * M3 (recon challenger-integration): DefaultModelFacade.set is transactional — onModelChange
 * (wiring.setModel with budget recompute) is called BEFORE the currentModel/currentRef mutation;
 * its throw (BudgetError) leaves the facade state completely unchanged.
 * Fake oauth record (test/host.test.ts pattern), no network.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinAuthProviders, resolveAuth } from "@vanrel/ai";
import { BudgetError } from "@vanrel/context";
import { NOOP_LOGGER } from "@vanrel/telemetry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultModelFacade } from "../src/interactive/model-facade.ts";
import { vanrelPaths } from "../src/paths.ts";
import { createSessionRuntime } from "../src/wiring.ts";

describe("DefaultModelFacade (M3)", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "vanrel-facade-test-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("set: a throw from onModelChange → currentModel/currentRef unchanged; set succeeds after the failure", async () => {
		const home = join(dir, "home");
		await mkdir(home, { recursive: true });
		const paths = vanrelPaths({ VANREL_HOME: home } as NodeJS.ProcessEnv);
		await writeFile(
			paths.authFile,
			JSON.stringify({
				v: 1,
				credentials: {
					anthropic: {
						type: "oauth",
						accessToken: "fake",
						refreshToken: "fake",
						expiresAt: Date.now() + 86_400_000,
					},
				},
			}),
		);
		const runtime = await createSessionRuntime({ cwd: dir, argv: ["vanrel"], paths, config: {}, log: NOOP_LOGGER });
		try {
			const auth = await resolveAuth({
				storePath: paths.authFile,
				providers: builtinAuthProviders({ storePath: paths.authFile, log: NOOP_LOGGER }),
				log: NOOP_LOGGER,
			});
			let failChange = false;
			const facade = new DefaultModelFacade({
				router: runtime.router,
				auth,
				log: NOOP_LOGGER,
				initialModel: runtime.agent.state.model,
				onModelChange: () => {
					if (failChange) throw new BudgetError("test: window cannot serve even empty history");
				},
			});

			expect(facade.current().id).toBe("claude-sonnet-5");
			failChange = true;
			expect(() => facade.set("cheap")).toThrow(BudgetError);
			// Completely unchanged state: current() did not switch to claude-haiku-4-5.
			expect(facade.current().id).toBe("claude-sonnet-5");

			failChange = false;
			facade.set("cheap");
			expect(facade.current().id).toBe("claude-haiku-4-5");
		} finally {
			await runtime.close("completed");
		}
	}, 15_000);
});
