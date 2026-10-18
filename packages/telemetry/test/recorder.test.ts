import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createFlightRecorder,
	type ErrorPayload,
	type FlightEventEnvelope,
	type FlightEventType,
	type FlightRecorderOptions,
	type LlmRequestPayload,
	type LlmResponsePayload,
	type LogLevel,
	NOOP_FLIGHT_RECORDER,
	NOOP_LOGGER,
	type SessionEndPayload,
	type SessionStartPayload,
	type ToolCallPayload,
	type ToolResultPayload,
} from "../src/index.ts";

const BASE_TS = 1_700_000_000_000;

interface CapturedLog {
	level: LogLevel;
	msg: string;
	fields?: Record<string, unknown>;
}

function makeHarness(dir: string, sessionId: string, options?: Partial<FlightRecorderOptions>) {
	let tick = 0;
	const logs: CapturedLog[] = [];
	const recorder = createFlightRecorder({
		dir,
		sessionId,
		flushIntervalMs: 0, // timer disabled by default for determinism
		log: {
			debug: (msg, fields) => logs.push({ level: "debug", msg, fields }),
			info: (msg, fields) => logs.push({ level: "info", msg, fields }),
			warn: (msg, fields) => logs.push({ level: "warn", msg, fields }),
			error: (msg, fields) => logs.push({ level: "error", msg, fields }),
		},
		now: () => BASE_TS + ++tick * 10,
		...options,
	});
	return { recorder, logs };
}

function rotationIndex(file: string, sessionId: string): number {
	if (file === `session-${sessionId}.jsonl`) return 0;
	const match = file.match(new RegExp(`^session-${sessionId}\\.(\\d+)\\.jsonl$`));
	if (match === null) throw new Error(`unexpected trace file name: ${file}`);
	return Number.parseInt(match[1], 10);
}

async function readAllEvents(dir: string, sessionId: string): Promise<FlightEventEnvelope[]> {
	const files = (await readdir(dir))
		.filter((f) => f.startsWith(`session-${sessionId}`))
		.sort((a, b) => rotationIndex(a, sessionId) - rotationIndex(b, sessionId));
	const events: FlightEventEnvelope[] = [];
	for (const file of files) {
		const content = await readFile(join(dir, file), "utf8");
		for (const line of content.split("\n")) {
			if (line.length > 0) events.push(JSON.parse(line) as FlightEventEnvelope);
		}
	}
	return events;
}

const sessionStart: SessionStartPayload = {
	cwd: "/tmp/work",
	argv: ["node", "vanrel"],
	pid: 4321,
	vanrelVersion: "0.1.0",
	gitRev: "deadbeef",
	providers: ["anthropic", "agy", "codex"],
};
const sessionEnd: SessionEndPayload = {
	reason: "user_exit",
	stats: { turns: 3, llmRequests: 4, toolCalls: 5, inputTokens: 111, outputTokens: 222, durationMs: 9001 },
};
const llmRequest: LlmRequestPayload = {
	provider: "anthropic",
	model: "claude-opus",
	baseUrl: "https://api.anthropic.com",
	request: { messages: [{ role: "user", content: "hi" }], stream: true },
	budgetContext: { W: 200000, S: 1200, T: 800, H: 190000, R: 4096, U: 300 },
};
const llmResponse: LlmResponsePayload = {
	provider: "anthropic",
	model: "claude-opus",
	stopReason: "end_turn",
	usage: { input: 10, output: 20, cacheRead: 3, cacheWrite: 4, reasoning: 5 },
	message: { role: "assistant", content: [{ type: "text", text: "hello" }] },
	durationMs: 321,
};
const toolCall: ToolCallPayload = { toolCallId: "tc-1", tool: "bash", args: { command: "ls -la" } };
const toolResult: ToolResultPayload = {
	toolCallId: "tc-1",
	tool: "bash",
	durationMs: 42,
	isError: false,
	rawOutput: "x".repeat(100_000),
	filteredOutput: "x".repeat(1000),
	filterStats: { class: "generic", inputBytes: 100_000, outputBytes: 1000, omittedLines: 900 },
};
const errorPayload: ErrorPayload = { scope: "llm", message: "boom", stack: "Error: boom\n    at x", fatal: true };

describe("FileFlightRecorder", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "vanrel-telemetry-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("writes JSONL envelopes for all 7 event types (v, seq monotonic from 1, ts)", async () => {
		const { recorder } = makeHarness(dir, "all-types");
		const payloads = [sessionStart, llmRequest, llmResponse, toolCall, toolResult, errorPayload, sessionEnd];
		const types: FlightEventType[] = [
			"session_start",
			"llm_request",
			"llm_response",
			"tool_call",
			"tool_result",
			"error",
			"session_end",
		];
		for (let i = 0; i < types.length; i++) {
			recorder.record(types[i], payloads[i] as never);
		}
		await recorder.close();

		const events = await readAllEvents(dir, "all-types");
		expect(events).toHaveLength(7);
		for (let i = 0; i < events.length; i++) {
			expect(events[i].v).toBe(1);
			expect(events[i].seq).toBe(i + 1);
			expect(events[i].ts).toBe(BASE_TS + (i + 1) * 10);
			expect(events[i].sessionId).toBe("all-types");
			expect(events[i].type).toBe(types[i]);
			expect(events[i].payload).toEqual(payloads[i]);
		}
	});

	it("generates a uuid v4 sessionId and filePath <dir>/session-<id>.jsonl by default", async () => {
		const recorder = createFlightRecorder({ dir, flushIntervalMs: 0, log: NOOP_LOGGER });
		expect(recorder.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(recorder.filePath).toBe(join(dir, `session-${recorder.sessionId}.jsonl`));
		await recorder.close();
	});

	it("flush() is idempotent and serializes concurrent calls without duplicates", async () => {
		const { recorder } = makeHarness(dir, "flush");
		recorder.record("tool_call", toolCall);
		recorder.record("tool_call", { ...toolCall, toolCallId: "tc-2" });
		await Promise.all([recorder.flush(), recorder.flush(), recorder.flush()]);
		await recorder.flush();
		await recorder.close();

		const events = await readAllEvents(dir, "flush");
		expect(events).toHaveLength(2);
		expect(events.map((e) => e.seq)).toEqual([1, 2]);
	});

	it("close() is idempotent; record() after close is a no-op with a DEBUG log", async () => {
		const { recorder, logs } = makeHarness(dir, "close");
		recorder.record("session_start", sessionStart);
		await recorder.close();
		await recorder.close();
		recorder.record("session_end", sessionEnd);
		await recorder.flush();

		const events = await readAllEvents(dir, "close");
		expect(events).toHaveLength(1);
		expect(events[0].type).toBe("session_start");
		expect(recorder.droppedCount).toBe(0);
		expect(logs.some((l) => l.level === "debug" && l.msg.includes("after close"))).toBe(true);
	});

	it("rotates the file at maxFileBytes; seq is not reset", async () => {
		const { recorder, logs } = makeHarness(dir, "rotate", { maxFileBytes: 300 });
		for (let i = 0; i < 12; i++) {
			recorder.record("tool_call", { toolCallId: `tc-${i}`, tool: "bash", args: { i, pad: "x".repeat(40) } });
		}
		await recorder.close();

		const files = await readdir(dir);
		expect(files.length).toBeGreaterThanOrEqual(2);
		expect(files).toContain("session-rotate.jsonl");
		expect(files).toContain("session-rotate.1.jsonl");
		expect(logs.some((l) => l.level === "info" && l.msg.includes("rotated"))).toBe(true);

		const events = await readAllEvents(dir, "rotate");
		expect(events).toHaveLength(12);
		expect(events.map((e) => e.seq)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
	});

	it("circular payload: record does not throw, droppedCount++, WARN logged, seq not consumed", async () => {
		const { recorder, logs } = makeHarness(dir, "circular");
		const args: Record<string, unknown> = { a: 1 };
		args.self = args;
		recorder.record("tool_call", { toolCallId: "bad", tool: "bash", args });
		expect(recorder.droppedCount).toBe(1);
		expect(logs.some((l) => l.level === "warn" && l.msg.includes("serialization failed"))).toBe(true);

		recorder.record("tool_call", { toolCallId: "good", tool: "bash", args: {} });
		await recorder.close();

		const events = await readAllEvents(dir, "circular");
		expect(events).toHaveLength(1);
		expect(events[0].seq).toBe(1);
		expect((events[0].payload as ToolCallPayload).toolCallId).toBe("good");
		expect(recorder.droppedCount).toBe(1);
	});

	it("snapshot semantics: mutating payload after record does not change the entry", async () => {
		const { recorder } = makeHarness(dir, "snapshot");
		const args = { list: [1, 2, 3], nested: { value: "before" } };
		recorder.record("tool_call", { toolCallId: "snap", tool: "bash", args });
		const request = { body: { text: "original" } };
		recorder.record("llm_request", { ...llmRequest, request });

		args.list.push(4);
		args.nested.value = "after";
		request.body.text = "mutated";
		await recorder.close();

		const events = await readAllEvents(dir, "snapshot");
		expect((events[0].payload as ToolCallPayload).args).toEqual({ list: [1, 2, 3], nested: { value: "before" } });
		expect((events[1].payload as LlmRequestPayload).request).toEqual({ body: { text: "original" } });
	});

	it("forces flush when flushThresholdBytes is exceeded", async () => {
		const { recorder } = makeHarness(dir, "threshold", { flushThresholdBytes: 10 });
		recorder.record("session_start", sessionStart); // buffer is definitely > 10 bytes
		await vi.waitFor(async () => {
			const events = await readAllEvents(dir, "threshold");
			expect(events.length).toBeGreaterThan(0);
		});
		await recorder.close();
		const events = await readAllEvents(dir, "threshold");
		expect(events).toHaveLength(1);
		expect(events[0].type).toBe("session_start");
	});

	it("periodic flush via the flushIntervalMs timer", async () => {
		const { recorder } = makeHarness(dir, "timer", { flushIntervalMs: 20 });
		recorder.record("error", errorPayload);
		await vi.waitFor(async () => {
			const events = await readAllEvents(dir, "timer");
			expect(events).toHaveLength(1);
		});
		await recorder.close();
	});

	it("FS error on flush: WARN logged, droppedCount += number of lines, no throw", async () => {
		const blocked = join(dir, "not-a-dir"); // a file in the directory path → mkdir/append will fail
		await import("node:fs/promises").then((fs) => fs.writeFile(blocked, "occupied"));
		const { recorder, logs } = makeHarness(join(blocked, "traces"), "fs-fail");
		recorder.record("session_start", sessionStart);
		recorder.record("session_end", sessionEnd);
		await recorder.flush();
		expect(recorder.droppedCount).toBe(2);
		expect(logs.some((l) => l.level === "warn" && l.msg.includes("write failed"))).toBe(true);
		await recorder.close();
	});
});

describe("NOOP_FLIGHT_RECORDER", () => {
	it("all methods are no-op; flush/close resolve", async () => {
		expect(NOOP_FLIGHT_RECORDER.sessionId).toBe("noop");
		expect(NOOP_FLIGHT_RECORDER.filePath).toBe("");
		expect(NOOP_FLIGHT_RECORDER.droppedCount).toBe(0);
		NOOP_FLIGHT_RECORDER.record("session_start", sessionStart);
		NOOP_FLIGHT_RECORDER.record("error", errorPayload);
		expect(NOOP_FLIGHT_RECORDER.droppedCount).toBe(0);
		await expect(NOOP_FLIGHT_RECORDER.flush()).resolves.toBeUndefined();
		await expect(NOOP_FLIGHT_RECORDER.close()).resolves.toBeUndefined();
	});
});
