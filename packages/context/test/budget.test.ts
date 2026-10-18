import { describe, expect, it } from "vitest";
import { BudgetError, computeBudget } from "../src/index.ts";

describe("computeBudget (formulas §6.1–6.2)", () => {
	it("base vector W=200k: R=max(⌈0.25W⌉,R_min)=50000, U=clamp(150)=1024", () => {
		const b = computeBudget({
			contextWindow: 200_000,
			systemTokens: 2_000,
			toolSchemaTokens: 3_000,
			userTurnTokens: 150,
			minReasoningReserve: 4_096,
		});
		expect(b.R).toBe(50_000);
		expect(b.U).toBe(1_024);
		expect(b.historyBudget).toBe(200_000 - 2_000 - 3_000 - 50_000 - 1_024);
		expect(b.historyBudget).toBe(143_976);
		// requestMaxTokens = min(maxOutputTokens default 8192, R)
		expect(b.requestMaxTokens).toBe(8_192);
	});

	it("prevStopReason='length' → doubling of R capped at ⌊0.5W⌋", () => {
		const b = computeBudget({
			contextWindow: 200_000,
			systemTokens: 2_000,
			toolSchemaTokens: 3_000,
			userTurnTokens: 150,
			minReasoningReserve: 4_096,
			prevStopReason: "length",
		});
		// R* = min(2·50000, 100000) = 100000; R = min(100000, 100000)
		expect(b.R).toBe(100_000);
		expect(b.historyBudget).toBe(200_000 - 2_000 - 3_000 - 100_000 - 1_024);
		expect(b.historyBudget).toBe(93_976);
	});

	it("doubling of R is clamped by the ⌊0.5W⌋ ceiling on a small window", () => {
		const b = computeBudget({
			contextWindow: 32_768,
			systemTokens: 100,
			toolSchemaTokens: 100,
			userTurnTokens: 150,
			minReasoningReserve: 4_096,
			prevStopReason: "length",
		});
		// R* = max(8192, 4096) = 8192; length → min(16384, 16384) = 16384
		expect(b.R).toBe(16_384);
		expect(b.historyBudget).toBe(32_768 - 100 - 100 - 16_384 - 1_024);
	});

	it("R_min=1024 protects the minimal output on a small window (non-reasoning)", () => {
		const b = computeBudget({
			contextWindow: 8_192,
			systemTokens: 100,
			toolSchemaTokens: 100,
			userTurnTokens: 150,
			minReasoningReserve: 1_024,
		});
		// R* = max(2048, 1024) = 2048
		expect(b.R).toBe(2_048);
	});

	it("requestMaxTokens = min(maxOutputTokens, R): maxOutputTokens cap", () => {
		const b = computeBudget({
			contextWindow: 200_000,
			systemTokens: 2_000,
			toolSchemaTokens: 3_000,
			userTurnTokens: 1_024,
			minReasoningReserve: 4_096,
			maxOutputTokens: 16_000,
		});
		expect(b.requestMaxTokens).toBe(16_000);
	});

	it("requestMaxTokens = min(maxOutputTokens, R): R cap", () => {
		const b = computeBudget({
			contextWindow: 32_768,
			systemTokens: 100,
			toolSchemaTokens: 100,
			userTurnTokens: 150,
			minReasoningReserve: 4_096,
			maxOutputTokens: 32_000,
		});
		// R = 8192 < maxOutputTokens
		expect(b.requestMaxTokens).toBe(8_192);
	});

	it("U clamp: lower bound 1024 and upper bound 16384", () => {
		const lo = computeBudget({
			contextWindow: 200_000,
			systemTokens: 0,
			toolSchemaTokens: 0,
			userTurnTokens: 10,
			minReasoningReserve: 1_024,
		});
		expect(lo.U).toBe(1_024);
		const hi = computeBudget({
			contextWindow: 200_000,
			systemTokens: 0,
			toolSchemaTokens: 0,
			userTurnTokens: 500_000,
			minReasoningReserve: 1_024,
		});
		expect(hi.U).toBe(16_384);
	});

	it("S+T+R+U ≥ W → BudgetError (kind='budget')", () => {
		let caught: unknown;
		try {
			computeBudget({
				contextWindow: 10_000,
				systemTokens: 4_000,
				toolSchemaTokens: 3_000,
				userTurnTokens: 150, // clamp → 1024
				minReasoningReserve: 1_024, // R = max(2500, 1024) = 2500; total 4000+3000+2500+1024=10524 ≥ 10000
			});
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(BudgetError);
		expect(caught).toBeInstanceOf(Error);
		expect((caught as BudgetError).kind).toBe("budget");
		expect((caught as Error).message).toContain("10000");
	});

	it("invalid W → BudgetError", () => {
		expect(() =>
			computeBudget({
				contextWindow: 0,
				systemTokens: 0,
				toolSchemaTokens: 0,
				userTurnTokens: 0,
				minReasoningReserve: 1_024,
			}),
		).toThrow(BudgetError);
	});
});
