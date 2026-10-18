/**
 * W14 host-impl: InteractiveHost on top of createSessionRuntime — a fake oauth record
 * (test/mcp.test.ts pattern), scripted streamFunction. No network, no TTY.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "@vanrel/agent";
import { type AssistantMessage, createAssistantMessageEventStream, RouteError, type Usage } from "@vanrel/ai";
import { NOOP_LOGGER } from "@vanrel/telemetry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InteractiveSessionEvent } from "../src/interactive/host.ts";
import { createInteractiveHost } from "../src/interactive/host-impl.ts";
import { vanrelPaths } from "../src/paths.ts";
import { createSessionRuntime, type SessionRuntime } from "../src/wiring.ts";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/** Fake subscription-oauth record: expiresAt far in the future → no refresh/network. */
async function createTestRuntime(dir: string): Promise<SessionRuntime> {
	const home = join(dir, "home");
	await mkdir(home, { recursive: true });
	const paths = vanrelPaths({ VANREL_HOME: home } as NodeJS.ProcessEnv);
	await writeFile(
		paths.authFile,
		JSON.stringify({
			v: 1,
			credentials: {
				anthropic: { type: "oauth", accessToken: "fake", refreshToken: "fake", expiresAt: Date.now() + 86_400_000 },
			},
		}),
	);
	return createSessionRuntime({ cwd: dir, argv: ["vanrel"], paths, config: {}, log: NOOP_LOGGER });
}

function scriptedAssistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-5",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

/** LLM stub: each request answers with the next text from the list (the last one repeats). */
function installScriptedStream(runtime: SessionRuntime, texts: string[]): void {
	let call = 0;
	runtime.agent.streamFunction = (() => {
		const message = scriptedAssistant(texts[Math.min(call++, texts.length - 1)] ?? "done");
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	}) as StreamFn;
}

/** wiring persists assistant/tool_result fire-and-forget — poll until the write lands. */
async function waitForFileContaining(path: string, needle: string, timeoutMs = 5000): Promise<string> {
	const startedAt = Date.now();
	for (;;) {
		const raw = await readFile(path, "utf8").catch(() => "");
		if (raw.includes(needle)) return raw;
		if (Date.now() - startedAt > timeoutMs)
			throw new Error(`timeout waiting for ${JSON.stringify(needle)} in ${path}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe("interactive host (W14)", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "vanrel-host-test-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("prompt: persist user+assistant into the session JSONL; subscribeSession sees the AgentEvent proxy", async () => {
		const runtime = await createTestRuntime(dir);
		installScriptedStream(runtime, ["hello"]);
		const host = createInteractiveHost(runtime);
		const events: string[] = [];
		host.subscribeSession((e) => events.push(e.type));

		await host.prompt("hi");
		await host.close("completed");

		const raw = await waitForFileContaining(runtime.session.filePath, '"hello"');
		const entries = raw
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string; content?: string; message?: AssistantMessage });
		expect(entries.some((e) => e.type === "user" && e.content === "hi")).toBe(true);
		expect(
			entries.some(
				(e) =>
					e.type === "assistant" &&
					e.message?.content[0]?.type === "text" &&
					e.message.content[0].text === "hello",
			),
		).toBe(true);

		for (const type of ["agent_start", "turn_start", "message_start", "message_end", "turn_end", "agent_end"]) {
			expect(events).toContain(type);
		}
	});

	it("compact: small history → does not trigger; stuffed → structural + compaction_end + persist", async () => {
		const runtime = await createTestRuntime(dir);
		installScriptedStream(runtime, ["ok"]);
		const host = createInteractiveHost(runtime);
		await host.prompt("hi");

		const events: InteractiveSessionEvent[] = [];
		host.subscribeSession((e) => events.push(e));

		// Small history — below the triggerRatio threshold.
		await host.compact();
		const smallEnd = events.find((e) => e.type === "compaction_end");
		expect(events.some((e) => e.type === "compaction_start" && e.reason === "manual")).toBe(true);
		expect(smallEnd?.type === "compaction_end" && smallEnd.result?.compacted).toBe(false);

		// Stuff the history directly: 16 user+toolResult turns with ~60KB of raw output each
		// (≈274k tokens against a ≈117k threshold for claude-sonnet-5 200k).
		const big = "x".repeat(60 * 1024);
		for (let i = 0; i < 16; i++) {
			runtime.agent.state.messages.push(
				{ role: "user", content: `q${i}`, timestamp: Date.now() },
				{
					role: "toolResult",
					toolCallId: `tc-${i}`,
					toolName: "bash",
					content: [{ type: "text", text: big }],
					isError: false,
					timestamp: Date.now(),
				},
			);
		}
		events.length = 0;
		const before = runtime.agent.state.messages.length;
		await host.compact();

		const end = events.find((e) => e.type === "compaction_end");
		expect(end?.type === "compaction_end" && end.result?.compacted).toBe(true);
		expect(end?.type === "compaction_end" && end.result?.level).toBe("structural");
		// Structural elision: same message count, tokens drop, raw toolResults replaced by descriptors.
		expect(end?.type === "compaction_end" && end.result && end.result.tokensAfter < end.result.tokensBefore).toBe(
			true,
		);
		expect(runtime.agent.state.messages.length).toBe(before);
		expect(
			runtime.agent.state.messages.some(
				(m) => m.role === "toolResult" && JSON.stringify(m).includes("elided; raw →"),
			),
		).toBe(true);
		// System message preserved at the top of the history.
		expect(runtime.agent.state.messages[0]?.role).toBe("system");

		await host.close("completed");
		const raw = await waitForFileContaining(runtime.session.filePath, '"compaction"');
		expect(raw).toContain('"structural"');
	}, 15_000);

	it("executeBash: echo → onUpdate delta + persist; excludeFromContext → no persist; abortBash interrupts sleep", async () => {
		const runtime = await createTestRuntime(dir);
		const host = createInteractiveHost(runtime);

		const deltas: string[] = [];
		const result = await host.executeBash("echo hello-host", false, (delta) => deltas.push(delta));
		expect(result.exitCode).toBe(0);
		expect(result.cancelled).toBe(false);
		expect(result.output).toContain("hello-host");
		expect(deltas.join("")).toContain("hello-host");

		const excluded = await host.executeBash("echo secret-host", true, () => {});
		expect(excluded.exitCode).toBe(0);

		const sleeping = host.executeBash("sleep 30", true, () => {});
		setTimeout(() => host.abortBash(), 100);
		const aborted = await sleeping;
		expect(aborted.cancelled).toBe(true);
		expect(aborted.exitCode).toBeUndefined();

		await host.close("completed");
		const raw = await waitForFileContaining(runtime.session.filePath, "bashExecution");
		expect(raw).toContain("hello-host"); // persist custom entry
		expect(raw).not.toContain("secret-host"); // excludeFromContext — not persisted
	}, 15_000);

	it("setModel: invalid ref → RouteError; valid alias switches the model; setThinkingLevel", async () => {
		const runtime = await createTestRuntime(dir);
		const host = createInteractiveHost(runtime);

		expect(() => host.setModel("")).toThrow(RouteError);
		expect(() => host.setModel("anthropic/no-such-model")).toThrow(RouteError);
		expect(() => host.setModel("agy/gemini-3-pro-preview")).toThrow(RouteError); // not logged in

		host.setModel("cheap");
		expect(runtime.agent.state.model.id).toBe("claude-haiku-4-5");

		host.setThinkingLevel("high");
		expect(runtime.agent.state.thinkingLevel).toBe("high");

		await host.close("completed");
	});

	it("close is idempotent: exactly one session_end in the trace", async () => {
		const runtime = await createTestRuntime(dir);
		const host = createInteractiveHost(runtime);
		await host.close("user_exit");
		await host.close("completed");
		await host.close("error");

		const events = (await readFile(runtime.recorder.filePath, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { type: string; payload: { reason?: string } });
		const ends = events.filter((e) => e.type === "session_end");
		expect(ends).toHaveLength(1);
		expect(ends[0]?.payload.reason).toBe("user_exit");
	});
});
