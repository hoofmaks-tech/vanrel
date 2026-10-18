import { describe, expect, it } from "vitest";
import { buildSplashLines, shouldShowSplash } from "../src/splash.ts";

const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, "");

describe("splash (§4.5, §4.6)", () => {
	it("full splash: 4 logo lines + hint bar + footer + placeholder", () => {
		const lines = buildSplashLines({ cols: 80, rows: 24, cwd: "/home/user/proj" });
		// 4 logo lines (the 4th half-block grid line is empty) + blank + hint + footer + blank + placeholder
		expect(lines).toHaveLength(9);
		const plain = lines.map(stripAnsi);
		expect(plain[5]).toContain("tab");
		expect(plain[5]).toContain("ctrl+p");
		expect(plain[5]).toContain("ctrl+c");
		expect(plain[6]).toContain("/home/user/proj");
		expect(plain[8]).toContain("Ask anything");
	});

	it("narrow terminal (12–28 cols) → wordmark instead of the logo", () => {
		const lines = buildSplashLines({ cols: 20, rows: 24, cwd: "/tmp" });
		expect(lines.length).toBeGreaterThan(0);
		expect(stripAnsi(lines[0]!)).toContain("vanrel");
	});

	it("too narrow/short terminal → splash suppressed ([])", () => {
		expect(buildSplashLines({ cols: 10, rows: 24, cwd: "/tmp" })).toEqual([]);
		expect(buildSplashLines({ cols: 80, rows: 5, cwd: "/tmp" })).toEqual([]);
	});

	it("footer abbreviates $HOME → ~", () => {
		const home = process.env.HOME;
		if (home) {
			const lines = buildSplashLines({ cols: 120, rows: 24, cwd: `${home}/work` });
			expect(lines.some((l) => stripAnsi(l).includes("~/work"))).toBe(true);
		}
	});

	it("shouldShowSplash: only interactive TTY without --no-splash", () => {
		expect(shouldShowSplash({ isTty: true, noSplash: false })).toBe(true);
		expect(shouldShowSplash({ isTty: true, noSplash: true })).toBe(false); // --no-splash suppresses
		expect(shouldShowSplash({ isTty: false, noSplash: false })).toBe(false); // not a TTY — no splash
		expect(shouldShowSplash({ isTty: false, noSplash: true })).toBe(false);
	});
});
