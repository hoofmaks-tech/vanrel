import { describe, expect, it } from "vitest";
import { classifyToolOutput, filterToolOutput } from "../src/index.ts";

function buildLog(errorIdx: number[], lines = 400): string {
	const out: string[] = [];
	for (let i = 0; i < lines; i++) {
		if (errorIdx.includes(i)) {
			out.push(`src/mod${i}.ts(${i},5): error TS2304: Cannot find name 'foo_${i}'.`);
		} else {
			out.push(`[09:12:${String(i % 60).padStart(2, "0")}] compiling src/gen/module-${i}.ts ... ok ${i}`);
		}
	}
	return out.join("\n");
}

function vitestOutput(): string {
	const out: string[] = [];
	for (let i = 0; i < 300; i++) out.push(` ✓ src/gen/case-${i}.test.ts (${3 + (i % 5)} tests) ${4 + (i % 9)}ms`);
	out.push(" ✗ src/auth.test.ts > login > rejects bad token");
	out.push("   AssertionError: expected 401 to be 200");
	out.push("    at src/auth.test.ts:42:11");
	out.push(" ✗ src/auth.test.ts > login > rotates refresh");
	out.push("   AssertionError: expected token to be rotated");
	out.push("    at src/auth.test.ts:77:5");
	for (let i = 0; i < 60; i++) out.push(` ✓ src/gen/tail-${i}.test.ts (2 tests) 3ms`);
	out.push(" Test Files  1 failed | 12 passed (13)");
	out.push("      Tests  2 failed | 48 passed (50)");
	return out.join("\n");
}

function gitDiff(files: number, linesPerFile: number): string {
	const out: string[] = [];
	for (let f = 0; f < files; f++) {
		out.push(`diff --git a/src/file-${f}.ts b/src/file-${f}.ts`);
		out.push("index 1111111..2222222 100644");
		out.push(`--- a/src/file-${f}.ts`);
		out.push(`+++ b/src/file-${f}.ts`);
		out.push(`@@ -1,${linesPerFile} +1,${linesPerFile} @@`);
		for (let i = 0; i < linesPerFile; i++) {
			out.push(i % 2 === 0 ? `-const old_${f}_${i} = 1;` : `+const new_${f}_${i} = 2;`);
		}
	}
	return out.join("\n");
}

describe("classifyToolOutput (§6.5)", () => {
	it("bash + error TS → build", () => {
		expect(classifyToolOutput("bash", buildLog([10]))).toBe("build");
	});
	it("bash + vitest failing → test", () => {
		expect(classifyToolOutput("bash", vitestOutput())).toBe("test");
	});
	it("bash + diff --git + @@ → git-diff", () => {
		expect(classifyToolOutput("bash", gitDiff(2, 10))).toBe("git-diff");
	});
	it("bash without signatures → generic", () => {
		expect(classifyToolOutput("bash", "total 8\ndrwxr-xr-x 2 user user 4096 .")).toBe("generic");
	});
	it("non-bash toolId → generic even with signatures", () => {
		expect(classifyToolOutput("read", buildLog([3]))).toBe("generic");
	});
});

describe("filterToolOutput: build (§6.5)", () => {
	it("error±2 + head 20 + tail 40, ≤6KB, marker with omitted counts", () => {
		const errors = [100, 250];
		const raw = buildLog(errors);
		const r = filterToolOutput("bash", raw);
		expect(r.class).toBe("build");
		expect(r.stats.outputBytes).toBeLessThanOrEqual(6144);
		// error lines and ±2 context are kept
		for (const e of errors) {
			expect(r.text).toContain(`error TS2304: Cannot find name 'foo_${e}'`);
			expect(r.text).toContain(`module-${e - 2}.ts`);
			expect(r.text).toContain(`module-${e + 2}.ts`);
		}
		// head 20
		expect(r.text).toContain("module-0.ts");
		expect(r.text).toContain("module-19.ts");
		// tail 40
		expect(r.text).toContain("module-399.ts");
		expect(r.text).toContain("module-360.ts");
		// the middle is dropped
		expect(r.text).not.toContain("module-200.ts");
		expect(r.stats.omittedLines).toBeGreaterThan(0);
		expect(r.text).toMatch(/\[vanrel: omitted \d+ lines \/ \d+ bytes, class=build; full output in flight recorder\]/);
	});

	it("overlapping error contexts are deduplicated (lines are not duplicated)", () => {
		// errors at 100 and 102: the ±2 windows overlap
		const raw = buildLog([100, 102]);
		const r = filterToolOutput("bash", raw);
		const occurrences = r.text.split("module-101.ts").length - 1;
		expect(occurrences).toBe(1);
		// 400 lines − (20 head + 40 tail + 7 union [98..104]) = 333 omitted
		expect(r.stats.omittedLines).toBe(400 - 20 - 40 - 7);
	});
});

describe("filterToolOutput: test (§6.5)", () => {
	it("failing blocks ±2 + final summary line, ≤6KB", () => {
		const r = filterToolOutput("bash", vitestOutput());
		expect(r.class).toBe("test");
		expect(r.stats.outputBytes).toBeLessThanOrEqual(6144);
		expect(r.text).toContain("AssertionError: expected 401 to be 200");
		expect(r.text).toContain("rejects bad token");
		expect(r.text).toContain("Tests  2 failed | 48 passed (50)");
		expect(r.stats.omittedLines).toBeGreaterThan(0);
		expect(r.text).toMatch(/class=test/);
	});
});

describe("filterToolOutput: git-diff (§6.5)", () => {
	it("≤8KB → full output without marker", () => {
		const raw = gitDiff(1, 10);
		const r = filterToolOutput("bash", raw);
		expect(r.class).toBe("git-diff");
		expect(r.text).toBe(raw);
		expect(r.stats.omittedLines).toBe(0);
	});

	it(">8KB → stat of all files + first 3 files in full, ≤8KB", () => {
		const raw = gitDiff(6, 400);
		expect(Buffer.byteLength(raw, "utf8")).toBeGreaterThan(8192);
		const r = filterToolOutput("bash", raw);
		expect(r.class).toBe("git-diff");
		expect(r.stats.outputBytes).toBeLessThanOrEqual(8192);
		// stat of all 6 files
		for (let f = 0; f < 6; f++) expect(r.text).toContain(`src/file-${f}.ts | 400`);
		// first 3 files in full
		expect(r.text).toContain("new_2_399");
		expect(r.text).toContain("old_2_398");
		// file 4 is not shown in full
		expect(r.text).not.toContain("new_3_399");
		expect(r.text).toMatch(/class=git-diff/);
	});
});

describe("filterToolOutput: generic and global limits (§6.5)", () => {
	it("generic: head 40 + tail 60, middle dropped", () => {
		const raw = Array.from({ length: 300 }, (_, i) => `line-${i}`).join("\n");
		const r = filterToolOutput("read", raw);
		expect(r.class).toBe("generic");
		expect(r.text).toContain("line-0");
		expect(r.text).toContain("line-39");
		expect(r.text).toContain("line-240");
		expect(r.text).toContain("line-299");
		expect(r.text).not.toContain("line-150");
		expect(r.stats.omittedLines).toBe(300 - 100);
	});

	it("a line >500 chars is truncated with the …[n chars] marker", () => {
		const raw = `start ${"x".repeat(1200)} end`;
		const r = filterToolOutput("read", raw);
		expect(r.text).toContain(`start ${"x".repeat(494)}`);
		expect(r.text).toContain("…[710 chars]");
		expect(r.text).not.toContain("x end");
	});

	it("marker contains the trace reference when opts.trace is set", () => {
		const raw = Array.from({ length: 300 }, (_, i) => `line-${i}`).join("\n");
		const r = filterToolOutput("read", raw, { trace: { sessionId: "abc-123", seq: 42 } });
		expect(r.text).toContain("full output in trace session-abc-123.jsonl seq=42");
	});

	it("hard cap: giant lines in generic → ≤8KB with the truncated marker", () => {
		const raw = Array.from({ length: 200 }, (_, i) => `L${i}:${"y".repeat(490)}`).join("\n");
		const r = filterToolOutput("grep", raw);
		expect(r.class).toBe("generic");
		expect(r.stats.outputBytes).toBeLessThanOrEqual(8192);
		expect(r.stats.truncated).toBe(true);
		expect(r.text).toContain("truncated middle");
	});

	it("custom policies override the defaults", () => {
		const raw = Array.from({ length: 300 }, (_, i) => `line-${i}`).join("\n");
		const r = filterToolOutput("read", raw, { policies: { generic: { headLines: 5, tailLines: 5 } } });
		expect(r.text).toContain("line-4");
		expect(r.text).toContain("line-295");
		expect(r.text).not.toContain("line-39");
		expect(r.stats.omittedLines).toBe(290);
	});
});
