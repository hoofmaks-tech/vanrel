/**
 * MCP wiring (recon mcp-wiring §5): a fake stdio server (fixtures/fake-mcp-server.mjs) covers
 * the real path — spawn, NDJSON, kill. No network; the wiring integration runs against a stubbed
 * agent.streamFunction (the LLM is not called).
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, type StreamFn } from "@vanrel/agent";
import { type AssistantMessage, createAssistantMessageEventStream, type Model, type Usage } from "@vanrel/ai";
import { McpTimeoutError } from "@vanrel/mcp";
import { createFlightRecorder, type FlightRecorder, type Logger, NOOP_LOGGER } from "@vanrel/telemetry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type McpServerConfig, type McpStdioServerConfig } from "../src/config.ts";
import { createMcpRuntime, type McpRuntime, mcpToolName } from "../src/mcp.ts";
import { vanrelPaths } from "../src/paths.ts";
import { createSessionRuntime } from "../src/wiring.ts";

// biome-ignore lint/suspicious/noTemplateCurlyInString: literal config value reference
const TOKEN_ENV_REF = "${VANREL_TEST_MCP_TOKEN}";
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal config value reference
const MISSING_ENV_REF = "${VANREL_TEST_MCP_MISSING}";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-mcp-server.mjs", import.meta.url));

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function fakeServer(overrides: Partial<McpStdioServerConfig> = {}): McpStdioServerConfig {
	return { command: process.execPath, args: [FIXTURE], ...overrides };
}

interface LogRecord {
	level: string;
	msg: string;
	fields?: Record<string, unknown>;
}

function createTestLogger(): { log: Logger; records: LogRecord[] } {
	const records: LogRecord[] = [];
	const push = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
		records.push({ level, msg, fields });
	};
	return { log: { debug: push("debug"), info: push("info"), warn: push("warn"), error: push("error") }, records };
}

interface RecordedEvent {
	type: string;
	payload: unknown;
}

function createTestRecorder(): { recorder: FlightRecorder; events: RecordedEvent[] } {
	const events: RecordedEvent[] = [];
	const recorder: FlightRecorder = {
		sessionId: "test",
		filePath: "",
		record: ((type: string, payload: unknown) => {
			events.push({ type, payload });
		}) as FlightRecorder["record"],
		droppedCount: 0,
		flush: () => Promise.resolve(),
		close: () => Promise.resolve(),
	};
	return { recorder, events };
}

describe("mcpToolName (port of pi createMcpToolName)", () => {
	it("sanitize, 64-char limit and hash suffix on collision", () => {
		expect(mcpToolName("docs", "search")).toBe("mcp__docs__search");
		expect(mcpToolName("my-server", "get.item/v2")).toBe("mcp__my_server__get_item_v2");
		const long = mcpToolName("server", "x".repeat(100));
		expect(long).toHaveLength(64);
		expect(long).toMatch(/^mcp__server__x+_[0-9a-f]{8}$/);
		expect(mcpToolName("server", `${"x".repeat(100)}y`)).not.toBe(long);
		// `a-b` and `a_b` sanitize to the same name → the second gets a hash suffix.
		const taken = mcpToolName("s", "a_b");
		const second = mcpToolName("s", "a-b", (name) => name === taken);
		expect(second).toMatch(/^mcp__s__a_b_[0-9a-f]{8}$/);
	});
});

describe("createMcpRuntime (fake stdio server)", () => {
	const runtimes: McpRuntime[] = [];
	const testLog = createTestLogger();
	const testRecorder = createTestRecorder();

	afterEach(async () => {
		await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
	});

	async function startRuntime(servers: Record<string, McpServerConfig>, startupWaitMs?: number): Promise<McpRuntime> {
		const runtime = await createMcpRuntime({
			servers,
			cwd: process.cwd(),
			log: testLog.log,
			recorder: testRecorder.recorder,
			...(startupWaitMs === undefined ? {} : { startupWaitMs }),
		});
		runtimes.push(runtime);
		return runtime;
	}

	it("startup: tools are registered with sanitized names", async () => {
		const runtime = await startRuntime({ fake: fakeServer() });
		expect(runtime.tools.map((tool) => tool.name)).toEqual(["mcp__fake__echo", "mcp__fake__a_b"]);
		const weird = runtime.tools[1];
		expect(weird.label).toBe("fake/a-b");
		expect(weird.parameters).toMatchObject({ type: "object", properties: {} });
	});

	it("call: echo → text content + details {server, tool}", async () => {
		const runtime = await startRuntime({ fake: fakeServer() });
		const echo = runtime.tools.find((tool) => tool.name === "mcp__fake__echo")!;
		const result = await echo.execute("call-1", { text: "hi" });
		expect(result.content).toEqual([{ type: "text", text: "hi" }]);
		expect(result.details).toEqual({ server: "fake", tool: "echo" });
		expect(result.isError).toBeUndefined();
	});

	it("server isError → isError:true and non-empty content (placeholder)", async () => {
		const runtime = await startRuntime({ fake: fakeServer({ env: { FAKE_MCP_TOOLS: "fail" } }) });
		const fail = runtime.tools.find((tool) => tool.name === "mcp__fake__fail")!;
		const result = await fail.execute("call-1", {});
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: "MCP tool fake/fail returned an error" }]);
	});

	it("timeout: silent tool → McpTimeoutError; progress resets the timer", async () => {
		const runtime = await startRuntime({
			fake: fakeServer({ env: { FAKE_MCP_TOOLS: "silent,slow" }, timeout: 1 }),
		});
		const silent = runtime.tools.find((tool) => tool.name === "mcp__fake__silent")!;
		await expect(silent.execute("call-1", {})).rejects.toThrow(McpTimeoutError);
		// slow sends progress every 250ms (6 steps ≈1.5s) — with a 1s timeout it finishes successfully.
		const slow = runtime.tools.find((tool) => tool.name === "mcp__fake__slow")!;
		const result = await slow.execute("call-2", {});
		expect(result.content).toEqual([{ type: "text", text: "slow-done" }]);
	}, 15_000);

	it("kill → lazy reconnect on the next call; unavailable reconnect → error-result in the agent loop", async () => {
		const runtime = await startRuntime({ fake: fakeServer({ env: { FAKE_MCP_TOOLS: "echo,kill" } }) });
		const kill = runtime.tools.find((tool) => tool.name === "mcp__fake__kill")!;
		const echo = runtime.tools.find((tool) => tool.name === "mcp__fake__echo")!;

		// kill drops the server process: the call is interrupted, WARN + error tap are recorded.
		await expect(kill.execute("call-kill", {})).rejects.toThrow();
		expect(testLog.records.some((r) => r.level === "warn" && r.msg.includes("connection dropped"))).toBe(true);
		expect(
			testRecorder.events.some(
				(event) =>
					event.type === "error" &&
					(event.payload as { scope?: string; fatal?: boolean }).scope === "mcp" &&
					(event.payload as { fatal?: boolean }).fatal === false,
			),
		).toBe(true);

		// The next call reconnects itself (memoized getClient → re-spawn) and answers.
		const revived = await echo.execute("call-echo", { text: "again" });
		expect(revived.content).toEqual([{ type: "text", text: "again" }]);

		// Reconnect unavailable (the server dies on start): execute throws, the agent loop
		// turns it into an error-result — the exception does not escape outward (recon §4).
		process.env.FAKE_MCP_DIE_ON_START = "1";
		try {
			await expect(kill.execute("call-kill-2", {})).rejects.toThrow();
			const model = {
				id: "fake-model",
				name: "Fake",
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl: "https://example.invalid",
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				reasoning: false,
				contextWindow: 128_000,
				maxTokens: 8192,
			} as unknown as Model<any>;
			const scripted: AssistantMessage[] = [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "tc-1", name: "mcp__fake__echo", arguments: { text: "hi" } }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "fake-model",
					usage: ZERO_USAGE,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				{
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "fake-model",
					usage: ZERO_USAGE,
					stopReason: "stop",
					timestamp: Date.now(),
				},
			];
			let call = 0;
			const streamFn: StreamFn = () => {
				const message = scripted[Math.min(call++, scripted.length - 1)];
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
				});
				return stream;
			};
			const agent = new Agent({
				initialState: { model, systemPrompt: "test", tools: runtime.tools, messages: [] },
				streamFn,
				toolExecution: "sequential",
			});
			await agent.prompt("go"); // does not throw
			const toolResult = agent.state.messages.find((message) => message.role === "toolResult");
			expect(toolResult).toMatchObject({ role: "toolResult", toolCallId: "tc-1", isError: true });
			expect(JSON.stringify(toolResult)).toContain("failed to connect");
		} finally {
			delete process.env.FAKE_MCP_DIE_ON_START;
		}
	}, 15_000);

	it("start with an unavailable command: resolves without tools + error{scope:mcp,fatal:false} in the trace", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vanrel-mcp-test-"));
		try {
			const recorder = createFlightRecorder({ dir, sessionId: "mcp-dead", log: NOOP_LOGGER });
			const runtime = await createMcpRuntime({
				servers: { dead: { command: "/nonexistent/vanrel-mcp-fake" } },
				cwd: process.cwd(),
				log: testLog.log,
				recorder,
			});
			runtimes.push(runtime);
			expect(runtime.tools).toEqual([]);
			await recorder.close();
			const events = (await readFile(recorder.filePath, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { type: string; payload: { scope?: string; fatal?: boolean } });
			expect(events.some((e) => e.type === "error" && e.payload.scope === "mcp" && e.payload.fatal === false)).toBe(
				true,
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("close(): idempotent, the child process is dead", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vanrel-mcp-test-"));
		try {
			const pidFile = join(dir, "pid");
			const runtime = await startRuntime({ fake: fakeServer({ env: { FAKE_MCP_PID_FILE: pidFile } }) });
			expect(runtime.tools.length).toBeGreaterThan(0);
			const pid = Number((await readFile(pidFile, "utf8")).trim());
			expect(Number.isInteger(pid)).toBe(true);
			expect(() => process.kill(pid, 0)).not.toThrow(); // alive
			await runtime.close();
			await runtime.close(); // second call — no-op
			expect(() => process.kill(pid, 0)).toThrow(); // ESRCH — the process is dead
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("config: mcpServers section (recon §3.1)", () => {
	let dir: string;
	const testLog = createTestLogger();

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "vanrel-config-test-"));
		testLog.records.length = 0;
		process.env.VANREL_TEST_MCP_TOKEN = "secret-token";
	});
	afterEach(async () => {
		delete process.env.VANREL_TEST_MCP_TOKEN;
		await rm(dir, { recursive: true, force: true });
	});

	it("parsing, env interpolation, tolerant WARN+skip, enabled:false is not started", async () => {
		const path = join(dir, "config.json");
		await writeFile(
			path,
			JSON.stringify({
				mcpServers: {
					fs: { command: "npx", args: ["-y", "srv"], env: { TOKEN: TOKEN_ENV_REF }, timeout: 30 },
					remote: { url: "https://mcp.example.com/mcp", headers: { Authorization: `Bearer ${TOKEN_ENV_REF}` } },
					off: { command: "x", enabled: false },
					broken: { args: ["no-command"] },
					"bad name": { command: "x" },
					badurl: { url: "ftp://example.com/mcp" },
					unresolved: { command: "x", env: { A: MISSING_ENV_REF } },
					cmdval: { command: "x", env: { A: "!echo hi" } },
					legacy: { type: "sse", url: "https://example.com/sse" },
					badtimeout: { command: "x", timeout: 0 },
				},
			}),
		);
		const config = await loadConfig(path, testLog.log);
		expect(Object.keys(config.mcpServers ?? {})).toEqual(["fs", "remote", "off"]);
		expect(config.mcpServers?.fs).toMatchObject({
			command: "npx",
			args: ["-y", "srv"],
			env: { TOKEN: "secret-token" },
			timeout: 30,
		});
		expect(config.mcpServers?.remote).toMatchObject({
			url: "https://mcp.example.com/mcp",
			headers: { Authorization: "Bearer secret-token" },
		});
		const warns = testLog.records.filter((r) => r.level === "warn" && r.msg.includes("skipping MCP server"));
		expect(warns.map((w) => w.fields?.name)).toEqual([
			"broken",
			"bad name",
			"badurl",
			"unresolved",
			"cmdval",
			"legacy",
			"badtimeout",
		]);
		expect(warns.find((w) => w.fields?.name === "unresolved")?.fields?.reason).toContain("VANREL_TEST_MCP_MISSING");
		expect(warns.find((w) => w.fields?.name === "cmdval")?.fields?.reason).toContain("unsupported");

		// enabled:false → the server is not started (no spawn, no tools).
		const runtime = await createMcpRuntime({
			servers: { off: config.mcpServers!.off! },
			cwd: process.cwd(),
			log: testLog.log,
			recorder: createTestRecorder().recorder,
		});
		await runtime.close();
		expect(runtime.tools).toEqual([]);
		expect(testLog.records.some((r) => r.msg.includes("disabled in config"))).toBe(true);
	});

	it("non-object section → WARN + ignored entirely", async () => {
		const path = join(dir, "config.json");
		await writeFile(path, JSON.stringify({ mcpServers: ["nope"] }));
		const config = await loadConfig(path, testLog.log);
		expect(config.mcpServers).toBeUndefined();
		expect(testLog.records.some((r) => r.level === "warn" && r.msg.includes("mcpServers must be an object"))).toBe(
			true,
		);
	});
});

describe("wiring integration: MCP tool through the agent loop (tap T3/T4, recon §3.4)", () => {
	it("T4 contains the full rawOutput and the filteredOutput after the generic filter", async () => {
		const dir = await mkdtemp(join(tmpdir(), "vanrel-wiring-test-"));
		try {
			const home = join(dir, "home");
			await mkdir(home, { recursive: true });
			const paths = vanrelPaths({ VANREL_HOME: home } as NodeJS.ProcessEnv);
			// Fake subscription-oauth record: expiresAt far in the future → no refresh/network.
			await writeFile(
				paths.authFile,
				JSON.stringify({
					v: 1,
					credentials: {
						anthropic: {
							type: "oauth",
							accessToken: "fake",
							refreshToken: "fake",
							expiresAt: Date.now() + 86_400_000,
						},
					},
				}),
			);
			const runtime = await createSessionRuntime({
				cwd: dir,
				argv: ["vanrel"],
				paths,
				config: { mcpServers: { fake: fakeServer({ env: { FAKE_MCP_TOOLS: "echo" } }) } },
				log: NOOP_LOGGER,
			});

			const names = runtime.agent.state.tools.map((tool) => tool.name);
			expect(names).toContain("mcp__fake__echo");
			expect(names).toContain("bash"); // builtin tools untouched

			// Stub the LLM with a script: 1) echo toolCall with a large output, 2) final text.
			const big = "x".repeat(16 * 1024);
			const scripted: AssistantMessage[] = [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "tc-big", name: "mcp__fake__echo", arguments: { text: big } }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-5",
					usage: ZERO_USAGE,
					stopReason: "toolUse",
					timestamp: Date.now(),
				},
				{
					role: "assistant",
					content: [{ type: "text", text: "done" }],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-5",
					usage: ZERO_USAGE,
					stopReason: "stop",
					timestamp: Date.now(),
				},
			];
			let call = 0;
			runtime.agent.streamFunction = () => {
				const message = scripted[Math.min(call++, scripted.length - 1)];
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
				});
				return stream;
			};
			await runtime.agent.prompt("go");
			await runtime.close("completed");

			const events = (await readFile(runtime.recorder.filePath, "utf8"))
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { type: string; payload: Record<string, unknown> });

			// Tap T3: the MCP tool call is recorded as a regular tool_call.
			const t3 = events.find((e) => e.type === "tool_call");
			expect(t3?.payload).toMatchObject({ toolCallId: "tc-big", tool: "mcp__fake__echo" });

			// Tap T4: raw is full, filtered is post NoiseFilter generic filter (8KB cap).
			const t4 = events.find((e) => e.type === "tool_result");
			expect(t4?.payload.tool).toBe("mcp__fake__echo");
			expect(t4?.payload.isError).toBe(false);
			expect(t4?.payload.rawOutput).toBe(big);
			const filtered = t4?.payload.filteredOutput as string;
			expect(filtered.length).toBeLessThanOrEqual(8192);
			expect(filtered.length).toBeLessThan(big.length);

			// The model received the filtered text (afterToolCall replaces content).
			const toolResult = runtime.agent.state.messages.find((message) => message.role === "toolResult");
			expect(toolResult).toMatchObject({ role: "toolResult", content: [{ type: "text", text: filtered }] });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 20_000);
});
