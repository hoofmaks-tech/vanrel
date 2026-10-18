import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { UsageRecord } from "../../src/auth/gateway-types.ts";
import { QuotaLedger } from "../../src/auth/quota-ledger.ts";

const HOUR = 3600_000;
const NOW = 1_900_000_000_000;
let now = NOW;
let dir: string;
let filePath: string;
let ledger: QuotaLedger;

function rec(ts: number, provider: UsageRecord["provider"] = "anthropic", input = 100, output = 50): UsageRecord {
	return { ts, provider, model: "claude-sonnet-5", inputTokens: input, outputTokens: output };
}

beforeEach(async () => {
	now = NOW;
	dir = await mkdtemp(join(tmpdir(), "vanrel-quota-"));
	filePath = join(dir, "quota.json");
	ledger = new QuotaLedger({ filePath, now: () => now });
	await ledger.load();
});

afterEach(async () => {
	await ledger.flush();
	await rm(dir, { recursive: true, force: true });
});

describe("QuotaLedger (§4.2.3)", () => {
	it("sliding 5-hour window aggregates only records inside the window", async () => {
		await ledger.record(rec(now)); // inside the window
		await ledger.record(rec(now - 4 * HOUR, "anthropic", 200, 100)); // inside the window
		await ledger.record(rec(now - 6 * HOUR, "anthropic", 1000, 1000)); // outside the window
		await ledger.record(rec(now - HOUR, "agy", 7, 7));
		const [a] = ledger.peek("anthropic");
		expect(a?.window).toEqual({ start: now - 5 * HOUR, requests: 2, inputTokens: 300, outputTokens: 150 });
		const [g] = ledger.peek("agy");
		expect(g?.window.requests).toBe(1);
	});

	it("recordExhaustion: available=false until blockedUntil, true after; null → conservative +15min", async () => {
		expect(ledger.available("anthropic")).toBe(true);
		await ledger.recordExhaustion("anthropic", null);
		expect(ledger.available("anthropic")).toBe(false);
		expect(ledger.peek("anthropic")[0]?.blockedUntil).toBe(now + 15 * 60_000);
		now += 15 * 60_000;
		expect(ledger.available("anthropic")).toBe(true); // now >= blockedUntil
	});

	it("recordExhaustion with explicit blockedUntil (from Retry-After)", async () => {
		await ledger.recordExhaustion("codex", now + 60_000);
		expect(ledger.available("codex")).toBe(false);
		now += 61_000;
		expect(ledger.available("codex")).toBe(true);
	});

	it("probe-derived block: utilization >= 1 → blockedUntil from resetsAt (R-5, all-optional)", async () => {
		await ledger.recordProbe("anthropic", { ts: now }); // all fields absent → does not block
		expect(ledger.available("anthropic")).toBe(true);
		await ledger.recordProbe("anthropic", { ts: now, fiveHourUtilization: 1, fiveHourResetsAt: now + 30 * 60_000 });
		expect(ledger.available("anthropic")).toBe(false);
		expect(ledger.peek("anthropic")[0]?.blockedUntil).toBe(now + 30 * 60_000);
		now += 31 * 60_000;
		expect(ledger.available("anthropic")).toBe(true);
	});

	it("prune: records older than retainMs are dropped on record and load", async () => {
		await ledger.record(rec(now - 8 * 24 * HOUR)); // older than 7d retainMs
		await ledger.record(rec(now));
		expect(ledger.peek("anthropic")[0]?.window.requests).toBe(1);
		await ledger.flush();
		// re-read from disk: prune on load
		const fresh = new QuotaLedger({ filePath, now: () => now });
		await fresh.load();
		expect(fresh.peek("anthropic")[0]?.window.requests).toBe(1);
	});

	it("debounced persist: without flush no file exists, after flush — v:1 + records + mode 0600", async () => {
		await ledger.record(rec(now));
		await expect(stat(filePath)).rejects.toMatchObject({ code: "ENOENT" }); // 500ms debounce has not elapsed
		await ledger.flush();
		const raw = JSON.parse(await readFile(filePath, "utf8")) as {
			v: number;
			records: UsageRecord[];
			exhaustion: Record<string, number>;
		};
		expect(raw.v).toBe(1);
		expect(raw.records).toHaveLength(1);
		expect((await stat(filePath)).mode & 0o777).toBe(0o600);
	});

	it("corrupt file on load → empty ledger, no exceptions", async () => {
		const { writeFile } = await import("node:fs/promises");
		await writeFile(filePath, "{corrupt");
		const broken = new QuotaLedger({ filePath, now: () => now });
		await broken.load();
		expect(broken.peek()).toEqual([]);
		expect(broken.available("anthropic")).toBe(true);
	});

	it("peek() without arguments — only providers with data", async () => {
		expect(ledger.peek()).toEqual([]);
		await ledger.record(rec(now, "agy"));
		expect(ledger.peek().map((s) => s.provider)).toEqual(["agy"]);
	});
});
