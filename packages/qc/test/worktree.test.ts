import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { QcError, ShadowWorktree } from "../src/index.ts";
import { makeRepo } from "./git-repo.ts";

describe("ShadowWorktree (real git)", () => {
	it("create: name wt-<sessionId>-<n>, an edit in wt is not visible in repoRoot", async () => {
		const { root, worktreesDir } = makeRepo("qc-wt-iso-");
		const wt = await ShadowWorktree.create({ repoRoot: root, worktreesDir, sessionId: "s1" });
		expect(wt.path).toBe(join(worktreesDir, "wt-s1-1"));
		expect(wt.baseRef).toBe("HEAD");
		writeFileSync(join(wt.path, "file.txt"), "changed\n");
		expect(readFileSync(join(root, "file.txt"), "utf8")).toBe("one\n");
		await wt.dispose();
	});

	it("second worktree of the same session gets n=2", async () => {
		const { root, worktreesDir } = makeRepo("qc-wt-seq-");
		const wt1 = await ShadowWorktree.create({ repoRoot: root, worktreesDir, sessionId: "seq" });
		const wt2 = await ShadowWorktree.create({ repoRoot: root, worktreesDir, sessionId: "seq" });
		expect(wt1.path).toBe(join(worktreesDir, "wt-seq-1"));
		expect(wt2.path).toBe(join(worktreesDir, "wt-seq-2"));
		await wt1.dispose();
		await wt2.dispose();
	});

	it("diff roundtrip: empty without edits, applyTo transfers the edit to repoRoot", async () => {
		const { root, worktreesDir } = makeRepo("qc-wt-rt-");
		const wt = await ShadowWorktree.create({ repoRoot: root, worktreesDir, sessionId: "rt" });
		expect(await wt.diff()).toBe("");
		writeFileSync(join(wt.path, "file.txt"), "two\n");
		const d = await wt.diff();
		expect(d).toContain("-one");
		expect(d).toContain("+two");
		await wt.applyTo();
		expect(readFileSync(join(root, "file.txt"), "utf8")).toBe("two\n");
		await wt.dispose();
	});

	it("applyTo: conflict → QcError, repoRoot not damaged", async () => {
		const { root, worktreesDir } = makeRepo("qc-wt-conf-");
		const wt = await ShadowWorktree.create({ repoRoot: root, worktreesDir, sessionId: "conf" });
		writeFileSync(join(wt.path, "file.txt"), "two\n");
		writeFileSync(join(root, "file.txt"), "three\n"); // working tree diverged from baseRef
		const err = await wt.applyTo().catch((e: unknown) => e);
		expect(err).toBeInstanceOf(QcError);
		expect((err as QcError).name).toBe("QcError");
		expect(readFileSync(join(root, "file.txt"), "utf8")).toBe("three\n");
		await wt.dispose();
	});

	it("dispose is idempotent; diff/applyTo after dispose → QcError", async () => {
		const { root, worktreesDir } = makeRepo("qc-wt-disp-");
		const wt = await ShadowWorktree.create({ repoRoot: root, worktreesDir, sessionId: "disp" });
		await wt.dispose();
		expect(existsSync(wt.path)).toBe(false);
		await wt.dispose(); // WARN, not throw
		await expect(wt.diff()).rejects.toBeInstanceOf(QcError);
		await expect(wt.applyTo()).rejects.toBeInstanceOf(QcError);
	});
});
