import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ToolResultMessage } from "@vanrel/ai";
import { NOOP_LOGGER } from "@vanrel/telemetry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionError, SessionManager } from "../src/session.ts";

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(text: string, ts: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-5",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: ts,
	};
}

function toolResultMessage(text: string, ts: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: ts,
	};
}

describe("SessionManager (append-only JSONL, §3.1)", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "vanrel-cli-test-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("append + resume roundtrip: user/assistant/tool_result/compaction", async () => {
		const mgr = await SessionManager.create(dir, "s1", NOOP_LOGGER);
		await mgr.appendUser("hello");
		await mgr.appendAssistant(assistantMessage("hi there", 1000));
		await mgr.appendToolResult(toolResultMessage("raw tool output", 1001));
		await mgr.appendCompaction({
			level: "structural",
			tokensBefore: 5000,
			tokensAfter: 1200,
			spilledTo: "/tmp/x.json",
		});

		const raw = await readFile(mgr.filePath, "utf8");
		const lines = raw.trim().split("\n");
		expect(lines).toHaveLength(4);
		expect(lines.map((l) => (JSON.parse(l) as { seq: number }).seq)).toEqual([1, 2, 3, 4]);
		expect(lines.map((l) => (JSON.parse(l) as { type: string }).type)).toEqual([
			"user",
			"assistant",
			"tool_result",
			"compaction",
		]);

		const resumed = await SessionManager.resume(dir, "s1", NOOP_LOGGER);
		expect(resumed.manager.id).toBe("s1");
		expect(resumed.messages).toHaveLength(3); // compaction is informational, not part of the history
		expect(resumed.messages[0]).toMatchObject({ role: "user", content: "hello" });
		expect(resumed.messages[1]).toMatchObject({ role: "assistant" });
		expect((resumed.messages[1] as AssistantMessage).content[0]).toMatchObject({ type: "text", text: "hi there" });
		expect(resumed.messages[2]).toMatchObject({ role: "toolResult", toolCallId: "call-1" });

		// append after resume continues seq
		await resumed.manager.appendUser("follow up");
		const raw2 = await readFile(mgr.filePath, "utf8");
		const last = JSON.parse(raw2.trim().split("\n").at(-1)!) as { seq: number; type: string };
		expect(last).toMatchObject({ seq: 5, type: "user" });
	});

	it("resume of a missing session → SessionError", async () => {
		await expect(SessionManager.resume(dir, "nope", NOOP_LOGGER)).rejects.toThrow(SessionError);
	});

	it("invalid id (path traversal) → SessionError", async () => {
		await expect(SessionManager.create(dir, "../etc", NOOP_LOGGER)).rejects.toThrow(SessionError);
		await expect(SessionManager.resume(dir, "a/b", NOOP_LOGGER)).rejects.toThrow(SessionError);
	});

	it("broken line in JSONL — skip with WARN, valid entries survive", async () => {
		const mgr = await SessionManager.create(dir, "s2", NOOP_LOGGER);
		await mgr.appendUser("good");
		const { appendFile } = await import("node:fs/promises");
		await appendFile(mgr.filePath, "{not json}\n", "utf8");
		const resumed = await SessionManager.resume(dir, "s2", NOOP_LOGGER);
		expect(resumed.messages).toHaveLength(1);
		expect(resumed.messages[0]).toMatchObject({ role: "user", content: "good" });
	});

	it("M7: 20 concurrent appends — file order = call order, seq is monotonic", async () => {
		const mgr = await SessionManager.create(dir, "s3", NOOP_LOGGER);
		const count = 20;
		// Promise.all: calls are initiated synchronously in array order.
		await Promise.all(Array.from({ length: count }, (_, i) => mgr.appendUser(`msg-${i}`)));
		const raw = await readFile(mgr.filePath, "utf8");
		const lines = raw
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { seq: number; content: string });
		expect(lines).toHaveLength(count);
		expect(lines.map((l) => l.content)).toEqual(Array.from({ length: count }, (_, i) => `msg-${i}`));
		expect(lines.map((l) => l.seq)).toEqual(Array.from({ length: count }, (_, i) => i + 1));
		// the in-memory index matches the file (order and seq)
		expect(mgr.getEntries().map((e) => e.seq)).toEqual(lines.map((l) => l.seq));
	});

	it("M7: concurrent appends of different types preserve call order", async () => {
		const mgr = await SessionManager.create(dir, "s4", NOOP_LOGGER);
		await Promise.all([
			mgr.appendUser("u1"),
			mgr.appendAssistant(assistantMessage("a1", 2000)),
			mgr.appendToolResult(toolResultMessage("t1", 2001)),
			mgr.appendCustomEntry("customX", { k: 1 }),
			mgr.setSessionName("name1"),
			mgr.appendCompaction({ level: "structural", tokensBefore: 10, tokensAfter: 5 }),
		]);
		const raw = await readFile(mgr.filePath, "utf8");
		const entries = raw
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { seq: number; type: string });
		expect(entries.map((e) => e.type)).toEqual([
			"user",
			"assistant",
			"tool_result",
			"custom",
			"session_info",
			"compaction",
		]);
		expect(entries.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
	});
});
