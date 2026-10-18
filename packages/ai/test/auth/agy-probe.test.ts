/**
 * V9 (M4): read-only probe of the real ~/.gemini/ on this machine.
 * STRICT: readdir only (names), no reading of file contents,
 * no writes outside test/auth/agy-probe.report.json. Records the actual
 * state for R-6 (Antigravity OAuth storage — UNVERIFIED).
 */

import { readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface ProbeReport {
	probe: "V9";
	ts: string;
	note: string;
	geminiDir: { path: string; exists: boolean; entries: string[] };
	oauthCredsPresent: boolean;
	antigravity: { exists: boolean; entries: string[] };
	googleAccountsPresent: boolean;
}

const testDir = dirname(fileURLToPath(import.meta.url));

async function listNames(path: string): Promise<{ exists: boolean; entries: string[] }> {
	try {
		const entries = await readdir(path); // names ONLY, no content reads
		return { exists: true, entries: entries.sort() };
	} catch {
		return { exists: false, entries: [] };
	}
}

describe("V9: read-only probe ~/.gemini/", () => {
	it("records file names into agy-probe.report.json (without reading values)", async () => {
		const geminiDir = join(homedir(), ".gemini");
		const root = await listNames(geminiDir);
		const antigravity = await listNames(join(geminiDir, "antigravity"));

		const report: ProbeReport = {
			probe: "V9",
			ts: new Date().toISOString(),
			note: "read-only: readdir names only; no file contents read; no writes outside this report",
			geminiDir: { path: "~/.gemini", exists: root.exists, entries: root.entries },
			oauthCredsPresent: root.entries.includes("oauth_creds.json"),
			antigravity,
			googleAccountsPresent: root.entries.includes("google_accounts.json"),
		};

		const reportPath = join(testDir, "agy-probe.report.json");
		await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o644 });

		expect(report.geminiDir.path).toBe("~/.gemini");
		if (root.exists) {
			expect(Array.isArray(report.geminiDir.entries)).toBe(true);
		} else {
			expect(report.oauthCredsPresent).toBe(false);
		}
	});
});
