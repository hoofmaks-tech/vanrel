/**
 * NoiseFilter — deterministic noise suppression of tool output.
 * No LLM, no I/O. Classification by toolId + content signatures; entropy-based
 * classification is deliberately not used (non-deterministic at boundaries).
 */

export type OutputClass = "build" | "test" | "git-diff" | "generic";

export interface ClassifierPolicy {
	maxBytes: number; // hard cap AFTER filtering
	headLines: number; // first N lines
	tailLines: number; // last M lines
	errorContextLines: number; // ±C around an error line / failing block
	gitDiffMaxFiles?: number; // git-diff: first N files in full (default 3)
}

export interface NoiseFilterOptions {
	policies?: Partial<Record<OutputClass, Partial<ClassifierPolicy>>>;
	maxLineLength?: number; // default 500 (same as GREP_MAX_LINE_LENGTH in Pi)
	/** Trace reference in the marker line (§3.1); absent → marker without a reference. */
	trace?: { sessionId: string; seq: number };
}

export interface FilteredOutput {
	text: string; // digest + marker lines "[vanrel: omitted N lines / B bytes ...]"
	class: OutputClass;
	stats: {
		inputBytes: number;
		outputBytes: number;
		inputLines: number;
		outputLines: number;
		omittedLines: number;
		truncated: boolean;
	};
}

/** Default policies (§6.5): build 6KB, test 6KB, git-diff 8KB, generic 8KB. */
export const DEFAULT_POLICIES: Record<OutputClass, ClassifierPolicy> = {
	build: { maxBytes: 6144, headLines: 20, tailLines: 40, errorContextLines: 2 },
	test: { maxBytes: 6144, headLines: 10, tailLines: 30, errorContextLines: 2 },
	"git-diff": { maxBytes: 8192, headLines: 0, tailLines: 0, errorContextLines: 0, gitDiffMaxFiles: 3 },
	generic: { maxBytes: 8192, headLines: 40, tailLines: 60, errorContextLines: 0 },
};

export const DEFAULT_MAX_LINE_LENGTH = 500;

/** Combined §6.5 error regex (case-insensitive) — anchors for the build/test digest. */
const ERROR_LINE_RE = /\berror\b|ERR!|FAILED|FAIL\b|panic:|Exception|Traceback|AssertionError|✖|✗|failing/i;

const GIT_DIFF_HEADER_RE = /^diff --git \S/m;
const GIT_DIFF_BODY_RE = /^@@ -\d+/m;

const BUILD_SIGNATURES: readonly RegExp[] = [
	/\berror TS\d+/,
	/ERR!/,
	/\bFAILED\b/,
	/✖/,
	/(^|[\s[(])error:/im,
	/\bwarning\b/i,
];

const TEST_SIGNATURES: readonly RegExp[] = [
	/\b\d+\s+(passed|failed|skipped)\b/i,
	/\b(passing|failing|pending)\b/i,
	/[✓✗×]/,
	/AssertionError/,
	/^\s*(not )?ok\s+\d+/m,
	/\bTest Suites?:/,
	/\bFAIL\s+\S/,
];

const TEST_SUMMARY_RE = /\b(passing|failing|failed|passed)\b|\bTests?:\s|\bTest Suites?:/i;

function countHits(sigs: readonly RegExp[], output: string): number {
	let n = 0;
	for (const re of sigs) if (re.test(output)) n++;
	return n;
}

/** Classification by toolId + content signatures (§6.5). Deterministic, no LLM. */
export function classifyToolOutput(toolId: string, output: string): OutputClass {
	if (toolId.toLowerCase() !== "bash") return "generic";
	if (GIT_DIFF_HEADER_RE.test(output) && GIT_DIFF_BODY_RE.test(output)) return "git-diff";
	const buildScore = countHits(BUILD_SIGNATURES, output);
	const testScore = countHits(TEST_SIGNATURES, output);
	if (testScore > 0 && testScore >= buildScore) return "test";
	if (buildScore > 0) return "build";
	return "generic";
}

function byteLength(s: string): number {
	return Buffer.byteLength(s, "utf8");
}

/** Truncates a string to a byte limit without breaking UTF-8 sequences. */
function cutToBytes(s: string, maxBytes: number): string {
	const buf = Buffer.from(s, "utf8");
	if (buf.length <= maxBytes) return s;
	let out = buf.subarray(0, maxBytes).toString("utf8");
	while (out.endsWith("\uFFFD")) out = out.slice(0, -1);
	return out;
}

function tailToBytes(s: string, maxBytes: number): string {
	const buf = Buffer.from(s, "utf8");
	if (buf.length <= maxBytes) return s;
	let out = buf.subarray(buf.length - maxBytes).toString("utf8");
	while (out.startsWith("\uFFFD")) out = out.slice(1);
	return out;
}

function truncateLine(line: string, max: number): string {
	if (line.length <= max) return line;
	return `${line.slice(0, max)}…[${line.length - max} chars]`;
}

function gapMarker(omitted: number): string {
	return `[vanrel: omitted ${omitted} lines]`;
}

function finalMarker(
	cls: OutputClass,
	omittedLines: number,
	omittedBytes: number,
	trace?: { sessionId: string; seq: number },
): string {
	const ref = trace
		? `full output in trace session-${trace.sessionId}.jsonl seq=${trace.seq}`
		: "full output in flight recorder";
	return `[vanrel: omitted ${omittedLines} lines / ${omittedBytes} bytes, class=${cls}; ${ref}]`;
}

interface Selection {
	keep: boolean[]; // indices of lines included in the digest
}

/** Head + tail + anchors via ERROR_LINE_RE with ±C context. Overlaps are deduplicated by the boolean array. */
function selectByAnchors(lineCount: number, policy: ClassifierPolicy, anchors: number[]): Selection {
	const keep = new Array<boolean>(lineCount).fill(false);
	const mark = (i: number): void => {
		if (i >= 0 && i < lineCount) keep[i] = true;
	};
	for (let i = 0; i < Math.min(policy.headLines, lineCount); i++) mark(i);
	for (let i = Math.max(0, lineCount - policy.tailLines); i < lineCount; i++) mark(i);
	for (const a of anchors) {
		for (let i = a - policy.errorContextLines; i <= a + policy.errorContextLines; i++) mark(i);
	}
	return { keep };
}

function composeWithGapMarkers(lines: string[], keep: boolean[]): { body: string; keptIndices: number[] } {
	const parts: string[] = [];
	const keptIndices: number[] = [];
	let omittedRun = 0;
	for (let i = 0; i < lines.length; i++) {
		if (keep[i]) {
			if (omittedRun > 0) {
				parts.push(gapMarker(omittedRun));
				omittedRun = 0;
			}
			parts.push(lines[i]);
			keptIndices.push(i);
		} else {
			omittedRun++;
		}
	}
	if (omittedRun > 0) parts.push(gapMarker(omittedRun));
	return { body: parts.join("\n"), keptIndices };
}

interface DiffFile {
	name: string;
	startLine: number; // index of the "diff --git" line in the array
	endLine: number; // exclusive
	added: number;
	removed: number;
}

function parseDiffFiles(lines: string[]): DiffFile[] {
	const files: DiffFile[] = [];
	for (let i = 0; i < lines.length; i++) {
		const m = /^diff --git a\/\S+ b\/(\S+)/.exec(lines[i]);
		if (m) {
			if (files.length > 0) files[files.length - 1].endLine = i;
			files.push({ name: m[1], startLine: i, endLine: lines.length, added: 0, removed: 0 });
		} else if (files.length > 0) {
			const line = lines[i];
			if (line.startsWith("+") && !line.startsWith("+++")) files[files.length - 1].added++;
			else if (line.startsWith("-") && !line.startsWith("---")) files[files.length - 1].removed++;
		}
	}
	return files;
}

function diffStatLine(f: DiffFile): string {
	const total = f.added + f.removed;
	const scale = total > 40 ? 40 / total : 1;
	const pluses = "+".repeat(Math.round(f.added * scale));
	const minuses = "-".repeat(Math.round(f.removed * scale));
	return ` ${f.name} | ${total} ${pluses}${minuses}`;
}

interface FilterPlan {
	body: string; // digest text without the final marker
	keptOriginalBytes: number; // total bytes of the kept original lines
	omittedLines: number;
}

function planBuildOrTest(lines: string[], policy: ClassifierPolicy, cls: OutputClass): FilterPlan {
	const anchors: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (ERROR_LINE_RE.test(lines[i])) anchors.push(i);
	}
	if (cls === "test") {
		// The final summary line is always kept (§6.5).
		for (let i = lines.length - 1; i >= 0; i--) {
			if (TEST_SUMMARY_RE.test(lines[i])) {
				anchors.push(i);
				break;
			}
		}
	}
	const { keep } = selectByAnchors(lines.length, policy, anchors);
	const { body, keptIndices } = composeWithGapMarkers(lines, keep);
	let keptOriginalBytes = 0;
	for (const i of keptIndices) keptOriginalBytes += byteLength(lines[i]) + 1;
	return { body, keptOriginalBytes, omittedLines: lines.length - keptIndices.length };
}

function planGitDiff(lines: string[], policy: ClassifierPolicy): FilterPlan {
	const files = parseDiffFiles(lines);
	const maxFiles = policy.gitDiffMaxFiles ?? 3;
	const keep = new Array<boolean>(lines.length).fill(false);
	for (let i = 0; i < Math.min(maxFiles, files.length); i++) {
		for (let j = files[i].startLine; j < files[i].endLine; j++) keep[j] = true;
	}
	const header = `[vanrel: git-diff — ${files.length} files changed; first ${Math.min(maxFiles, files.length)} shown in full, rest as stat]`;
	const stat = files.map(diffStatLine);
	const { body, keptIndices } = composeWithGapMarkers(lines, keep);
	let keptOriginalBytes = 0;
	for (const i of keptIndices) keptOriginalBytes += byteLength(lines[i]) + 1;
	return {
		body: [header, ...stat, "", body].join("\n"),
		keptOriginalBytes,
		omittedLines: lines.length - keptIndices.length,
	};
}

function planGeneric(lines: string[], policy: ClassifierPolicy): FilterPlan {
	const { keep } = selectByAnchors(lines.length, policy, []);
	const { body, keptIndices } = composeWithGapMarkers(lines, keep);
	let keptOriginalBytes = 0;
	for (const i of keptIndices) keptOriginalBytes += byteLength(lines[i]) + 1;
	return { body, keptOriginalBytes, omittedLines: lines.length - keptIndices.length };
}

/** Hard cap: middle truncation with a marker (§6.5). The result is guaranteed ≤ maxBytes. */
function enforceCap(body: string, maxBytes: number, cls: OutputClass): { body: string; truncated: boolean } {
	if (byteLength(body) <= maxBytes) return { body, truncated: false };
	const marker = `\n[vanrel: truncated middle — output capped at ${maxBytes} bytes, class=${cls}]\n`;
	const budget = maxBytes - byteLength(marker);
	const headBytes = Math.floor(budget / 2);
	const tailBytes = budget - headBytes;
	return { body: cutToBytes(body, headBytes) + marker + tailToBytes(body, tailBytes), truncated: true };
}

/** Default policies (§6.5): build 6KB, test 6KB, git-diff 8KB, generic 8KB. */
export function filterToolOutput(toolId: string, output: string, opts?: NoiseFilterOptions): FilteredOutput {
	const cls = classifyToolOutput(toolId, output);
	const policy: ClassifierPolicy = { ...DEFAULT_POLICIES[cls], ...opts?.policies?.[cls] };
	const maxLineLength = opts?.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;

	const inputBytes = byteLength(output);
	const rawLines = output.split("\n");
	const inputLines = rawLines.length;
	// Global limit: line ≤ maxLineLength, truncated with the "…[n chars]" marker.
	const lines = rawLines.map((l) => truncateLine(l, maxLineLength));

	// git-diff: kept in full if ≤ maxBytes (§6.5).
	if (cls === "git-diff" && byteLength(lines.join("\n")) <= policy.maxBytes) {
		const text = lines.join("\n");
		return {
			text,
			class: cls,
			stats: {
				inputBytes,
				outputBytes: byteLength(text),
				inputLines,
				outputLines: lines.length,
				omittedLines: 0,
				truncated: false,
			},
		};
	}

	let plan: FilterPlan;
	if (cls === "build" || cls === "test") plan = planBuildOrTest(lines, policy, cls);
	else if (cls === "git-diff") plan = planGitDiff(lines, policy);
	else plan = planGeneric(lines, policy);

	const omittedBytes = Math.max(0, inputBytes - plan.keptOriginalBytes);
	const markerNeeded = plan.omittedLines > 0;
	const marker = finalMarker(cls, plan.omittedLines, omittedBytes, opts?.trace);

	// The cap accounts for the final marker: the total is ≤ the class maxBytes.
	const capBudget = markerNeeded ? policy.maxBytes - byteLength(marker) - 1 : policy.maxBytes;
	const capped = enforceCap(plan.body, Math.max(capBudget, 0), cls);
	const needMarker = markerNeeded || capped.truncated;
	const text = needMarker ? `${capped.body}\n${marker}` : capped.body;

	return {
		text,
		class: cls,
		stats: {
			inputBytes,
			outputBytes: byteLength(text),
			inputLines,
			outputLines: text.split("\n").length,
			omittedLines: plan.omittedLines,
			truncated: capped.truncated,
		},
	};
}
