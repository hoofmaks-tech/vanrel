/**
 * Fixture V5: synthetic 20-turn tool-heavy scenario.
 * Both sides (naive / vanrel) are measured with ONE estimator — estimateContextTokens
 * from @vanrel/ai. Cache metrics are excluded from K. Deterministic generator
 * (seeded PRNG): 10 build logs (~140KB), 6 test outputs (~60KB), 4 git diff (~35KB).
 */
import { estimateContextTokens, estimateTextTokens } from "@vanrel/ai/utils/estimate";
import { computeBudget } from "../src/budget.ts";
import { HistoryCompactor } from "../src/compactor.ts";
import { DEFAULT_POLICIES, filterToolOutput } from "../src/noise-filter.ts";

export const FIXTURE = {
	turns: 20,
	W: 200_000,
	S: 2_000,
	T: 3_000,
	userTokens: 150,
	assistantTokens: 800,
	buildBytes: 140 * 1024,
	testBytes: 60 * 1024,
	diffBytes: 35 * 1024,
	seed: 0x5eed,
} as const;

/** Deterministic PRNG (mulberry32). */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

function makeBuildLog(rand: () => number, targetBytes: number, variant: number): string {
	const lines = ["$ npm run build", `> pkg-${variant}@1.0.${variant} build`, "> tsc -p tsconfig.build.json", ""];
	const errorFractions = [0.2, 0.35, 0.5, 0.7, 0.85];
	let errIdx = 0;
	let total = bytes(lines.join("\n"));
	let i = 0;
	while (total < targetBytes) {
		const line = `[${String(9000 + (i % 900)).padStart(4, "0")}ms] compiled src/gen/v${variant}/module-${i}.ts (${20 + Math.floor(rand() * 97)} kB)`;
		lines.push(line);
		total += bytes(line) + 1;
		i++;
		if (errIdx < errorFractions.length && total >= errorFractions[errIdx] * targetBytes) {
			const err = `src/gen/v${variant}/worker-${errIdx}.ts(${10 + errIdx},${3 + errIdx}): error TS2304: Cannot find name 'handle_${variant}_${errIdx}'.`;
			lines.push(err);
			total += bytes(err) + 1;
			errIdx++;
		}
	}
	lines.push(`Build finished with ${errorFractions.length} errors in 84.21s`);
	return lines.join("\n");
}

function makeTestOutput(rand: () => number, targetBytes: number, variant: number): string {
	const lines = [` RUN  v3.2.4 /repo/packages/pkg-${variant}`, ""];
	const footer = [" Test Files  1 failed | 14 passed (15)", "      Tests  2 failed | 58 passed (60)", "   Duration  12.41s"];
	const footerBytes = bytes(footer.join("\n"));
	let total = bytes(lines.join("\n"));
	let i = 0;
	const failingAt = [0.45, 0.75];
	let failIdx = 0;
	while (total + footerBytes < targetBytes) {
		if (failIdx < failingAt.length && total >= failingAt[failIdx] * targetBytes) {
			const block = [
				` ✗ src/payments/v${variant}/charge.test.ts > charge_${failIdx} > declines expired card`,
				`   AssertionError: expected 402 to equal 200`,
				`    at src/payments/v${variant}/charge.test.ts:${58 + failIdx}:9`,
				"    at processTicksAndRejections (node:internal/process/task_queues:95:5)",
			];
			for (const l of block) {
				lines.push(l);
				total += bytes(l) + 1;
			}
			failIdx++;
		}
		const line = ` ✓ src/gen/v${variant}/case-${i}.test.ts (${3 + Math.floor(rand() * 5)} tests) ${4 + Math.floor(rand() * 9)}ms`;
		lines.push(line);
		total += bytes(line) + 1;
		i++;
	}
	lines.push(...footer);
	return lines.join("\n");
}

function makeGitDiff(rand: () => number, targetBytes: number, variant: number): string {
	const lines: string[] = [];
	let total = 0;
	const fileCount = 8;
	for (let f = 0; f < fileCount; f++) {
		// First 3 files are small (shown in full), the rest are large.
		const hunkLines = f < 3 ? 24 : 130;
		const header = [
			`diff --git a/src/gen/v${variant}/file-${f}.ts b/src/gen/v${variant}/file-${f}.ts`,
			`index ${Math.floor(rand() * 0xffffff).toString(16)}..${Math.floor(rand() * 0xffffff).toString(16)} 100644`,
			`--- a/src/gen/v${variant}/file-${f}.ts`,
			`+++ b/src/gen/v${variant}/file-${f}.ts`,
			`@@ -1,${hunkLines} +1,${hunkLines} @@ export const`,
		];
		for (const l of header) {
			lines.push(l);
			total += bytes(l) + 1;
		}
		for (let i = 0; i < hunkLines; i++) {
			const sign = i % 3 === 0 ? "-" : i % 3 === 1 ? "+" : " ";
			const line = `${sign}\tconst value_${variant}_${f}_${i} = compute_${f}(${i}, ${Math.floor(rand() * 1000)});`;
			lines.push(line);
			total += bytes(line) + 1;
		}
	}
	// Pad the last file to the declared size.
	while (total < targetBytes) {
		const line = `+\tconst pad_${variant}_${total % 9973} = ${total % 65536};`;
		lines.push(line);
		total += bytes(line) + 1;
	}
	return lines.join("\n");
}

export interface GeneratedTurn {
	kind: "build" | "test" | "git-diff";
	toolId: "bash";
	raw: string;
}

/** 20 turns: pattern [B,T,B,D,B,T,B,D,T,B] x2 -> exactly 10 build, 6 test, 4 diff. */
export function generateScenario(): GeneratedTurn[] {
	const pattern = ["build", "test", "build", "git-diff", "build", "test", "build", "git-diff", "test", "build"] as const;
	const rand = mulberry32(FIXTURE.seed);
	const counters = { build: 0, test: 0, "git-diff": 0 };
	const turns: GeneratedTurn[] = [];
	for (let t = 0; t < FIXTURE.turns; t++) {
		const kind = pattern[t % pattern.length];
		const variant = counters[kind]++;
		const raw =
			kind === "build"
				? makeBuildLog(rand, FIXTURE.buildBytes, variant)
				: kind === "test"
					? makeTestOutput(rand, FIXTURE.testBytes, variant)
					: makeGitDiff(rand, FIXTURE.diffBytes, variant);
		turns.push({ kind, toolId: "bash", raw });
	}
	return turns;
}

const textOfTokens = (tokens: number, tag: string): string => `${tag} ${"a".repeat(Math.round(tokens * 3.5))}`;

let ts = 0;
function userMsg(): unknown {
	return { role: "user", content: textOfTokens(FIXTURE.userTokens, `u${ts}`), timestamp: ts++ };
}
function assistantMsg(): unknown {
	return {
		role: "assistant",
		content: [{ type: "text", text: textOfTokens(FIXTURE.assistantTokens, `a${ts}`) }],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		stopReason: "stop",
		timestamp: ts++,
	};
}
function toolResultMsg(text: string): unknown {
	return {
		role: "toolResult",
		toolCallId: `call-${ts}`,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: ts++,
	};
}

export interface KFixtureReport {
	naiveTotal: number;
	vanrelTotal: number;
	compactionCost: number;
	K: number;
	compactionTriggered: boolean;
	typicalFilteredBytes: number;
	rawBytesByClass: Record<string, number>;
	filteredBytesByClass: Record<string, number>;
	policies: typeof DEFAULT_POLICIES;
}

const est = (messages: unknown[]): number => estimateContextTokens(messages as never).tokens;

export async function runKFixture(spillDir: string): Promise<KFixtureReport> {
	const scenario = generateScenario();
	const budget = computeBudget({
		contextWindow: FIXTURE.W,
		systemTokens: FIXTURE.S,
		toolSchemaTokens: FIXTURE.T,
		userTurnTokens: FIXTURE.userTokens,
		minReasoningReserve: 4_096,
	});

	// naive: full outputs, full history.
	let naiveTotal = 0;
	const naiveHistory: unknown[] = [];
	for (const turn of scenario) {
		naiveTotal += FIXTURE.S + FIXTURE.T + est(naiveHistory);
		naiveHistory.push(userMsg(), assistantMsg(), toolResultMsg(turn.raw));
	}

	// vanrel: NoiseFilter + budget (compaction counted honestly, expected 0).
	let vanrelTotal = 0;
	let compactionCost = 0;
	let compactionTriggered = false;
	const vanrelHistoryInit: unknown[] = [];
	let vanrelHistory = vanrelHistoryInit;
	const compactor = new HistoryCompactor({
		summarize: (transcript) => {
			const summary = "fixture summary";
			compactionCost += estimateTextTokens(transcript) + estimateTextTokens(summary);
			return Promise.resolve(summary);
		},
		spillDir,
		estimateTokens: est,
	});
	const filteredBytes: number[] = [];
	const rawBytesByClass: Record<string, number> = {};
	const filteredBytesByClass: Record<string, number> = {};
	for (const turn of scenario) {
		const r = await compactor.maybeCompact(vanrelHistory, budget);
		if (r.compacted) {
			compactionTriggered = true;
			vanrelHistory = r.messages;
		}
		vanrelTotal += FIXTURE.S + FIXTURE.T + est(vanrelHistory);
		const filtered = filterToolOutput(turn.toolId, turn.raw);
		filteredBytes.push(filtered.stats.outputBytes);
		rawBytesByClass[turn.kind] = (rawBytesByClass[turn.kind] ?? 0) + bytes(turn.raw);
		filteredBytesByClass[turn.kind] = (filteredBytesByClass[turn.kind] ?? 0) + filtered.stats.outputBytes;
		vanrelHistory = [...vanrelHistory, userMsg(), assistantMsg(), toolResultMsg(filtered.text)];
	}

	const sorted = [...filteredBytes].sort((a, b) => a - b);
	const typicalFilteredBytes = sorted[Math.floor(sorted.length / 2)];
	return {
		naiveTotal,
		vanrelTotal,
		compactionCost,
		K: naiveTotal / (vanrelTotal + compactionCost),
		compactionTriggered,
		typicalFilteredBytes,
		rawBytesByClass,
		filteredBytesByClass,
		policies: DEFAULT_POLICIES,
	};
}
