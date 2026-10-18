// Фейковый MCP stdio-сервер для тестов packages/cli/test/mcp.test.ts (recon mcp-wiring §5.1).
// NDJSON по stdin/stdout; console.* не используется — stdout это канал протокола.
//
// Тулы: echo (эхо args.text), a-b (weird-name), silent (не отвечает), slow (progress → ответ),
// fail (isError:true с пустым content), kill (process.exit(1)).
// Env:
//   FAKE_MCP_TOOLS        — список тулов в tools/list через запятую (default "echo,a-b");
//                           tools/call обрабатывает любой известный тул независимо от списка.
//   FAKE_MCP_PID_FILE     — записать pid процесса в файл (проверка смерти процесса в close()).
//   FAKE_MCP_DIE_ON_START — умереть сразу (сценарий неудачного reconnect).
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.env.FAKE_MCP_DIE_ON_START === "1") process.exit(1);
if (process.env.FAKE_MCP_PID_FILE) writeFileSync(process.env.FAKE_MCP_PID_FILE, String(process.pid));

const ALL_TOOLS = {
	echo: {
		name: "echo",
		description: "Echo text back",
		inputSchema: { type: "object", properties: { text: { type: "string" } } },
	},
	"a-b": { name: "a-b", description: "Weird tool name", inputSchema: { type: "object", properties: {} } },
	silent: { name: "silent", description: "Never answers", inputSchema: { type: "object", properties: {} } },
	slow: { name: "slow", description: "Sends progress, then answers", inputSchema: { type: "object", properties: {} } },
	fail: { name: "fail", description: "Always isError", inputSchema: { type: "object", properties: {} } },
	kill: { name: "kill", description: "Exits the process", inputSchema: { type: "object", properties: {} } },
};

const LISTED = (process.env.FAKE_MCP_TOOLS ?? "echo,a-b")
	.split(",")
	.map((name) => ALL_TOOLS[name.trim()])
	.filter(Boolean);

const SLOW_STEPS = 6;
const SLOW_STEP_MS = 250;

function send(message) {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handleCall(id, params) {
	const args = params?.arguments ?? {};
	switch (params?.name) {
		case "echo":
			return send({
				jsonrpc: "2.0",
				id,
				result: { content: [{ type: "text", text: typeof args.text === "string" ? args.text : "" }] },
			});
		case "a-b":
			return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "weird-ok" }] } });
		case "fail":
			return send({ jsonrpc: "2.0", id, result: { content: [], isError: true } });
		case "kill":
			process.exit(1);
			return;
		case "silent":
			return; // ответа не будет — клиент должен отработать таймаут
		case "slow": {
			const progressToken = params?._meta?.progressToken;
			let step = 0;
			const interval = setInterval(() => {
				step += 1;
				if (progressToken !== undefined) {
					send({
						jsonrpc: "2.0",
						method: "notifications/progress",
						params: { progressToken, progress: step, total: SLOW_STEPS, message: `tick ${step}` },
					});
				}
				if (step >= SLOW_STEPS) {
					clearInterval(interval);
					send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "slow-done" }] } });
				}
			}, SLOW_STEP_MS);
			return;
		}
		default:
			return send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown tool ${String(params?.name)}` } });
	}
}

for await (const line of createInterface({ input: process.stdin })) {
	if (!line.trim()) continue;
	let message;
	try {
		message = JSON.parse(line);
	} catch {
		continue;
	}
	if (message.id === undefined || typeof message.method !== "string") continue; // notifications/*
	if (message.method === "initialize") {
		send({
			jsonrpc: "2.0",
			id: message.id,
			result: {
				protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
				capabilities: { tools: {} },
				serverInfo: { name: "fake", version: "1.0.0" },
			},
		});
		continue;
	}
	if (message.method === "tools/list") {
		send({ jsonrpc: "2.0", id: message.id, result: { tools: LISTED } });
		continue;
	}
	if (message.method === "tools/call") {
		handleCall(message.id, message.params);
		continue;
	}
	if (message.method === "ping") {
		send({ jsonrpc: "2.0", id: message.id, result: {} });
		continue;
	}
	send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } });
}
