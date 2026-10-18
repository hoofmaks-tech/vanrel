import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FIXTURE, generateScenario, runKFixture } from "../fixtures/k-fixture.ts";

describe("K fixture (V5, §6.4)", () => {
	it("scenario: 20 turns, 10 build / 6 test / 4 diff with the declared sizes", () => {
		const scenario = generateScenario();
		expect(scenario).toHaveLength(20);
		const byKind = { build: 0, test: 0, "git-diff": 0 };
		for (const t of scenario) byKind[t.kind]++;
		expect(byKind).toEqual({ build: 10, test: 6, "git-diff": 4 });
		for (const t of scenario) {
			const size = Buffer.byteLength(t.raw, "utf8");
			const target =
				t.kind === "build" ? FIXTURE.buildBytes : t.kind === "test" ? FIXTURE.testBytes : FIXTURE.diffBytes;
			expect(size).toBeGreaterThanOrEqual(target);
			expect(size).toBeLessThan(target * 1.02);
		}
		// determinism
		expect(generateScenario().map((t) => t.raw)).toEqual(scenario.map((t) => t.raw));
	});

	it("run naive vs vanrel with a single estimator → fixtures/report.json, K ≥ 10, no compaction", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vanrel-kfixture-"));
		const report = await runKFixture(dir);
		const reportPath = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "report.json");
		await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

		// §6.4: H_vanrel grows logarithmically little → compaction never triggers.
		expect(report.compactionTriggered).toBe(false);
		expect(report.compactionCost).toBe(0);
		expect(report.naiveTotal).toBeGreaterThan(report.vanrelTotal);
		// Gate V5: K ≥ 10. No tuning: the numbers are recorded into report.json as is.
		expect(report.K).toBeGreaterThanOrEqual(10);
		// Typical digest ~1k tok (§6.4), worst case = cap 6/6/8KB.
		expect(report.typicalFilteredBytes).toBeLessThanOrEqual(8192);
	}, 60_000);
});
