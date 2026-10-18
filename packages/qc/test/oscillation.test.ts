import { describe, expect, it } from "vitest";
import { hashDiff, OscillationGuard } from "../src/index.ts";

const DIFF_A = [
	"diff --git a/f.ts b/f.ts",
	"index 1111111..2222222 100644",
	"--- a/f.ts",
	"+++ b/f.ts",
	"@@ -1 +1 @@",
	"-one",
	"+two",
	"",
].join("\n");

const DIFF_B = [
	"diff --git a/f.ts b/f.ts",
	"index 2222222..3333333 100644",
	"--- a/f.ts",
	"+++ b/f.ts",
	"@@ -1 +1 @@",
	"-two",
	"+three",
	"",
].join("\n");

describe("OscillationGuard", () => {
	it("A→B→A → abort on the third step with repeatedHash", () => {
		const g = new OscillationGuard();
		expect(g.observe(DIFF_A)).toEqual({ action: "continue" });
		expect(g.observe(DIFF_B)).toEqual({ action: "continue" });
		const d = g.observe(DIFF_A);
		expect(d.action).toBe("abort");
		if (d.action === "abort") expect(d.repeatedHash).toBe(hashDiff(DIFF_A));
	});

	it("different diffs → continue; A,B,A with window=3 → continue", () => {
		const g = new OscillationGuard();
		for (const d of [DIFF_A, DIFF_B, `${DIFF_A}\n+extra`, `${DIFF_B}\n+extra`]) {
			expect(g.observe(d)).toEqual({ action: "continue" });
		}
		const g3 = new OscillationGuard({ window: 3 });
		expect(g3.observe(DIFF_A).action).toBe("continue");
		expect(g3.observe(DIFF_B).action).toBe("continue");
		expect(g3.observe(DIFF_A).action).toBe("continue"); // t vs t−3: not enough history
	});

	it("reset() clears the history", () => {
		const g = new OscillationGuard();
		g.observe(DIFF_A);
		g.observe(DIFF_B);
		g.reset();
		expect(g.observe(DIFF_A)).toEqual({ action: "continue" });
	});
});

describe("hashDiff normalize", () => {
	it("robust to index lines: different blob-sha → same hash", () => {
		const variant = DIFF_A.replace("index 1111111..2222222 100644", "index 9999999..8888888 100644");
		expect(hashDiff(variant)).toBe(hashDiff(DIFF_A));
	});

	it("robust to trailing whitespace and CRLF", () => {
		const messy = DIFF_A.split("\n").join(" \r\n"); // CRLF + trailing space on each line
		expect(hashDiff(messy)).toBe(hashDiff(DIFF_A));
	});

	it("robust to the timestamp suffix on ---/+++ lines (GNU diff)", () => {
		const withTs = DIFF_A.replace("--- a/f.ts", "--- a/f.ts\t2026-10-18 12:00:00").replace(
			"+++ b/f.ts",
			"+++ b/f.ts\t2026-10-18 12:00:01",
		);
		expect(hashDiff(withTs)).toBe(hashDiff(DIFF_A));
	});

	it("different content → different hash", () => {
		expect(hashDiff(DIFF_A)).not.toBe(hashDiff(DIFF_B));
	});
});
