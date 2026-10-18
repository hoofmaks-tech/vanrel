import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import type { AgentTool, AgentToolResult } from "@vanrel/agent";
import { NOOP_LOGGER } from "@vanrel/telemetry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { text } from "../src/tools/common.ts";
import { createBuiltinTools, type QcHooks } from "../src/tools.ts";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "vanrel-tools-ext-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function tool(name: string, qc?: QcHooks): AgentTool<any> {
	const tools = createBuiltinTools({ cwd: dir, log: NOOP_LOGGER, qc });
	const found = tools.find((t) => t.name === name);
	if (!found) throw new Error(`tool not found: ${name}`);
	return found;
}

function out(result: AgentToolResult<any>): string {
	return result.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

describe("edit (pi-level)", () => {
	it("multi-edit: two edits in one call", async () => {
		const file = join(dir, "multi.txt");
		await writeFile(file, "alpha\nbeta\ngamma\n", "utf8");
		const edit = tool("edit");
		const res = await edit.execute("t1", {
			path: file,
			edits: [
				{ oldText: "alpha", newText: "ALPHA" },
				{ oldText: "gamma", newText: "GAMMA" },
			],
		});
		expect(res.isError).toBe(false);
		expect(await readFile(file, "utf8")).toBe("ALPHA\nbeta\nGAMMA\n");
		expect(res.details?.patch).toContain("-alpha");
		expect(res.details?.patch).toContain("+ALPHA");
		expect(res.details?.diff).toContain("+1 ALPHA");
		expect(res.details?.firstChangedLine).toBe(1);
	});

	it("multi-edit: overlap is rejected", async () => {
		const file = join(dir, "overlap.txt");
		await writeFile(file, "a\nb\nc\n", "utf8");
		const res = await tool("edit").execute("t2", {
			path: file,
			edits: [
				{ oldText: "a\nb", newText: "x" },
				{ oldText: "b\nc", newText: "y" },
			],
		});
		expect(res.isError).toBe(true);
		expect(out(res)).toContain("overlap");
		expect(await readFile(file, "utf8")).toBe("a\nb\nc\n");
	});

	it("prepareArguments: legacy oldText/newText and edits as a JSON string", async () => {
		const file = join(dir, "legacy.txt");
		await writeFile(file, "a\n", "utf8");
		const edit = tool("edit");
		expect(edit.prepareArguments).toBeTypeOf("function");
		const legacy = edit.prepareArguments!({ path: file, oldText: "a", newText: "b" });
		expect(legacy).toEqual({ path: file, edits: [{ oldText: "a", newText: "b" }] });
		const fromString = edit.prepareArguments!({ path: file, edits: '[{"oldText":"a","newText":"b"}]' });
		expect(fromString).toEqual({ path: file, edits: [{ oldText: "a", newText: "b" }] });
		// legacy call end-to-end: the prepared arguments execute
		const res = await edit.execute("t3", legacy);
		expect(res.isError).toBe(false);
		expect(await readFile(file, "utf8")).toBe("b\n");
	});

	it("BOM + CRLF roundtrip: the edit preserves BOM and CRLF", async () => {
		const file = join(dir, "bom.txt");
		await writeFile(file, "﻿line one\r\nline two\r\n", "utf8");
		const res = await tool("edit").execute("t4", {
			path: file,
			edits: [{ oldText: "line two", newText: "LINE TWO" }],
		});
		expect(res.isError).toBe(false);
		expect(await readFile(file, "utf8")).toBe("﻿line one\r\nLINE TWO\r\n");
	});

	it("QC gate after edit: gate-failed → error-result, the file went to the worktree", async () => {
		const shadow = join(dir, "shadow");
		let gateCalls = 0;
		const qc: QcHooks = {
			toWorktreePath: (abs) =>
				(abs === dir || abs.startsWith(`${dir}${sep}`)) && !abs.startsWith(`${shadow}${sep}`)
					? join(shadow, relative(dir, abs))
					: undefined,
			afterEdit: async () => {
				gateCalls++;
				return { ok: false, report: "gate failed" };
			},
		};
		const file = join(dir, "qc.txt");
		await writeFile(file, "hello\n", "utf8");
		// ShadowWorktree is a repo copy: the file exists in the worktree too (wiring.ts semantics).
		await mkdir(shadow, { recursive: true });
		await writeFile(join(shadow, "qc.txt"), "hello\n", "utf8");
		const res = await tool("edit", qc).execute("t5", {
			path: file,
			edits: [{ oldText: "hello", newText: "world" }],
		});
		expect(res.isError).toBe(true);
		expect(out(res)).toContain("[qc:gate-failed]");
		expect(out(res)).toContain("gate failed");
		expect(gateCalls).toBe(1);
		expect(await readFile(file, "utf8")).toBe("hello\n"); // original untouched
		expect(await readFile(join(shadow, "qc.txt"), "utf8")).toBe("world\n"); // the edit landed in the worktree
		expect(res.details?.patch).toContain("+world"); // details kept even on gate-failed
	});

	it("QC gate ok: [qc:ok] and not an error", async () => {
		const shadow = join(dir, "shadow");
		const qc: QcHooks = {
			toWorktreePath: (abs) =>
				(abs === dir || abs.startsWith(`${dir}${sep}`)) && !abs.startsWith(`${shadow}${sep}`)
					? join(shadow, relative(dir, abs))
					: undefined,
			afterEdit: async () => ({ ok: true, report: "all green" }),
		};
		const file = join(dir, "qc-ok.txt");
		await writeFile(file, "hello\n", "utf8");
		// ShadowWorktree is a repo copy: the file exists in the worktree too (wiring.ts semantics).
		await mkdir(shadow, { recursive: true });
		await writeFile(join(shadow, "qc-ok.txt"), "hello\n", "utf8");
		const res = await tool("edit", qc).execute("t6", {
			path: file,
			edits: [{ oldText: "hello", newText: "world" }],
		});
		expect(res.isError).toBe(false);
		expect(out(res)).toContain("[qc:ok] all green");
		expect(res.details?.qc).toBe("ok"); // m17: TUI marker from details
	});

	it("M5: QC oscillation abort (terminate) propagates into AgentToolResult.terminate — edit and write", async () => {
		const shadow = join(dir, "shadow");
		const qc: QcHooks = {
			toWorktreePath: (abs) =>
				(abs === dir || abs.startsWith(`${dir}${sep}`)) && !abs.startsWith(`${shadow}${sep}`)
					? join(shadow, relative(dir, abs))
					: undefined,
			afterEdit: async () => ({ ok: false, report: "oscillation detected (A→B→A)", terminate: true }),
		};
		const file = join(dir, "qc-abort.txt");
		await writeFile(file, "hello\n", "utf8");
		// ShadowWorktree is a repo copy: the file exists in the worktree too (wiring.ts semantics).
		await mkdir(shadow, { recursive: true });
		await writeFile(join(shadow, "qc-abort.txt"), "hello\n", "utf8");
		const editRes = await tool("edit", qc).execute("t30", {
			path: file,
			edits: [{ oldText: "hello", newText: "world" }],
		});
		expect(editRes.isError).toBe(true);
		expect(editRes.terminate).toBe(true); // the agent loop aborts the batch on terminate===true
		expect(out(editRes)).toContain("[qc:abort]");
		expect(editRes.details?.qc).toBe("abort");
		expect(editRes.details?.patch).toBeTruthy(); // details kept even on abort

		const writeRes = await tool("write", qc).execute("t31", {
			path: join(dir, "qc-abort-new.txt"),
			content: "x\n",
		});
		expect(writeRes.isError).toBe(true);
		expect(writeRes.terminate).toBe(true);
		expect(out(writeRes)).toContain("[qc:abort]");
		expect(writeRes.details?.qc).toBe("abort");
	});

	it("M5: QC gate-failed WITHOUT terminate does not set result.terminate", async () => {
		const shadow = join(dir, "shadow");
		const qc: QcHooks = {
			toWorktreePath: (abs) =>
				(abs === dir || abs.startsWith(`${dir}${sep}`)) && !abs.startsWith(`${shadow}${sep}`)
					? join(shadow, relative(dir, abs))
					: undefined,
			afterEdit: async () => ({ ok: false, report: "gate failed" }),
		};
		const file = join(dir, "qc-gate.txt");
		await writeFile(file, "hello\n", "utf8");
		await mkdir(shadow, { recursive: true });
		await writeFile(join(shadow, "qc-gate.txt"), "hello\n", "utf8");
		const res = await tool("edit", qc).execute("t32", {
			path: file,
			edits: [{ oldText: "hello", newText: "world" }],
		});
		expect(res.isError).toBe(true);
		expect(res.terminate).toBeUndefined();
		expect(res.details?.qc).toBe("gate-failed");
	});
});

describe("common.text (M5)", () => {
	it("terminate=false by default: the field is absent from the result", () => {
		const res = text("hello");
		expect(res.isError).toBe(false);
		expect("terminate" in res).toBe(false);
		const err = text("boom", true);
		expect(err.isError).toBe(true);
		expect("terminate" in err).toBe(false);
	});

	it("terminate=true propagates into AgentToolResult", () => {
		const res = text("stop", true, { qc: "abort" }, true);
		expect(res.terminate).toBe(true);
		expect(res.isError).toBe(true);
		expect(res.details).toEqual({ qc: "abort" });
	});
});

describe("ls", () => {
	it("case-insensitive sort and / suffix for directories", async () => {
		await writeFile(join(dir, "b.txt"), "", "utf8");
		await writeFile(join(dir, "A.txt"), "", "utf8");
		await mkdir(join(dir, "sub"));
		const res = await tool("ls").execute("t7", { path: dir });
		expect(res.isError).toBe(false);
		expect(out(res)).toBe("A.txt\nb.txt\nsub/");
	});

	it("limit → notice 'Use limit=N for more'", async () => {
		await writeFile(join(dir, "a.txt"), "", "utf8");
		await writeFile(join(dir, "b.txt"), "", "utf8");
		await writeFile(join(dir, "c.txt"), "", "utf8");
		const res = await tool("ls").execute("t8", { path: dir, limit: 2 });
		expect(out(res)).toBe("a.txt\nb.txt\n\n[2 entries limit reached. Use limit=4 for more]");
		expect(res.details?.entryLimitReached).toBe(2);
	});
});

describe("read", () => {
	it("limit with a remainder → continuation notice", async () => {
		const file = join(dir, "lines.txt");
		await writeFile(file, "l1\nl2\nl3\nl4\nl5\nl6", "utf8");
		const res = await tool("read").execute("t9", { path: file, limit: 2 });
		expect(out(res)).toBe("1: l1\n2: l2\n\n[4 more lines in file. Use offset=3 to continue.]");
	});

	it("truncateHead at 2000 lines → continuation notice with offset", async () => {
		const file = join(dir, "big.txt");
		await writeFile(file, Array.from({ length: 2100 }, () => "x").join("\n"), "utf8");
		const res = await tool("read").execute("t10", { path: file });
		const body = out(res);
		expect(body).toContain("1: x");
		expect(body).toContain("2000: x");
		expect(body).not.toContain("2001: x");
		expect(body).toContain("[Showing lines 1-2000 of 2100. Use offset=2001 to continue.]");
		expect(res.details?.totalLines).toBe(2100);
	});
});

describe("grep", () => {
	it("context=1: `rel-N- ctx` blocks around `rel:N: match`", async () => {
		await writeFile(join(dir, "a.txt"), "foo\nbar\nbaz\n", "utf8");
		const res = await tool("grep").execute("t11", { pattern: "bar", path: dir, context: 1 });
		expect(out(res)).toBe("a.txt-1- foo\na.txt:2: bar\na.txt-3- baz");
	});

	it("literal: a dot is not a regex; ignoreCase", async () => {
		await writeFile(join(dir, "b.txt"), "a.b\naxb\n", "utf8");
		const regex = await tool("grep").execute("t12", { pattern: "a.b", path: dir });
		expect(out(regex)).toBe("b.txt:1: a.b\nb.txt:2: axb");
		const literal = await tool("grep").execute("t13", { pattern: "a.b", path: dir, literal: true });
		expect(out(literal)).toBe("b.txt:1: a.b");
		const folded = await tool("grep").execute("t14", { pattern: "A.B", path: dir, literal: true, ignoreCase: true });
		expect(out(folded)).toBe("b.txt:1: a.b");
	});

	it("limit → notice 'matches limit reached'", async () => {
		await writeFile(join(dir, "c.txt"), "m\nm\nm\n", "utf8");
		const res = await tool("grep").execute("t15", { pattern: "m", path: dir, limit: 2 });
		expect(out(res)).toBe(
			"c.txt:1: m\nc.txt:2: m\n\n[2 matches limit reached. Use limit=4 for more, or refine pattern]",
		);
		expect(res.details?.matchLimitReached).toBe(2);
	});
});

describe("glob", () => {
	it("limit → notice 'results limit reached'", async () => {
		await writeFile(join(dir, "g1.ts"), "", "utf8");
		await writeFile(join(dir, "g2.ts"), "", "utf8");
		const res = await tool("glob").execute("t16", { pattern: "*.ts", path: dir, limit: 1 });
		expect(out(res)).toBe("g1.ts\n\n[1 results limit reached. Use limit=2 for more, or refine pattern]");
		expect(res.details?.resultLimitReached).toBe(1);
	});
});

describe("bash (pi-level)", () => {
	it("timeout validation: <=0 and >max are rejected", async () => {
		const bash = tool("bash");
		const zero = await bash.execute("t17", { command: "true", timeout: 0 });
		expect(zero.isError).toBe(true);
		expect(out(zero)).toContain("Invalid timeout");
		const over = await bash.execute("t18", { command: "true", timeout: 600_001 });
		expect(over.isError).toBe(true);
		expect(out(over)).toContain("Invalid timeout: maximum is 600000 ms");
		const ok = await bash.execute("t19", { command: "echo hi", timeout: 5000 });
		expect(ok.isError).toBe(false);
		expect(out(ok)).toContain("hi");
	});

	it("full output goes to a temp file (0600) on truncation", async () => {
		const res = await tool("bash").execute("t20", { command: "seq 1 100000" });
		expect(res.isError).toBe(false);
		const body = out(res);
		expect(body).toContain("Full output: ");
		expect(body).toContain("[vanrel: exit 0]");
		const fullPath = res.details?.fullOutputPath as string;
		expect(fullPath).toBeTruthy();
		expect(fullPath).toContain("vanrel-bash-");
		// The file exists, is private (0600), and contains the whole output.
		expect((await stat(fullPath)).mode & 0o777).toBe(0o600);
		const full = await readFile(fullPath, "utf8");
		expect(full.trimEnd().split("\n").length).toBe(100000);
		expect(full).toContain("100000");
		expect(res.structuredContent).toMatchObject({ exit_code: 0 });
		await rm(fullPath, { force: true });
	});

	it("exit 128+signal: SIGKILL → 137", async () => {
		const res = await tool("bash").execute("t21", { command: "kill -9 $$" });
		expect(res.isError).toBe(true);
		expect(out(res)).toContain("[vanrel: exit 137]");
		expect(res.structuredContent).toMatchObject({ exit_code: 137 });
	});

	it("timeout: the process is killed, status timeout", async () => {
		const res = await tool("bash").execute("t22", { command: "sleep 5", timeout: 200 });
		expect(res.isError).toBe(true);
		expect(out(res)).toContain("[vanrel: timeout 200ms]");
	});
});
