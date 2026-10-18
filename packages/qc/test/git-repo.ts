/** Helper: a real git repository in a tempdir (git is available on the host). */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function git(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** repo: git init + user config + one commit with file.txt ("one\n").
    worktreesDir sits next to repo so it stays out of its git index. */
export function makeRepo(prefix: string): { root: string; worktreesDir: string } {
	const base = mkdtempSync(join(tmpdir(), prefix));
	const root = join(base, "repo");
	mkdirSync(root, { recursive: true });
	git(root, ["init"]);
	git(root, ["config", "user.email", "qc@test.local"]);
	git(root, ["config", "user.name", "qc-test"]);
	writeFileSync(join(root, "file.txt"), "one\n");
	git(root, ["add", "."]);
	git(root, ["-c", "commit.gpgsign=false", "commit", "-m", "init"]);
	return { root, worktreesDir: join(base, "wt") };
}
