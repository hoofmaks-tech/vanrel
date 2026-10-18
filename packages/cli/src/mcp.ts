// MIT License, Copyright (c) 2025 Mario Zechner
// Vendored from earendil-works/pi (packages/coding-agent/src/extensions/mcp/{runtime,tools}.ts),
// adapted for vanrel: the mcp__<server>__<tool> naming scheme (sanitize/64/hash suffix) is an exact copy of pi;
// the connection lifecycle is simplified (recon mcp-wiring §3.2): no exposure/codemode, OAuth,
// transient HTTP connect retries, or 20KB truncate-middle (NoiseFilter owns the context, §3.4).

/**
 * CLI MCP runtime (recon mcp-wiring §3.2): starts connections from the `mcpServers` config
 * (lazy, memoized getClient), registers server tools as AgentTool and hands them to wiring.
 *
 * Errors (matrix §4): a server unavailable at startup = WARN + error{scope:"mcp",fatal:false} +
 * continue without its tools; a runtime drop → disconnected, the next call reconnects;
 * McpSessionExpiredError (http 404) → 1 retry on a new session; tool calls are otherwise NOT retried.
 */
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentTool } from "@vanrel/agent";
import {
	type CallToolResult,
	McpAuthRequiredError,
	McpClient,
	type McpRequestOptions,
	McpSessionExpiredError,
	type Tool as McpTool,
	type McpTransport,
	StdioTransport,
	StreamableHttpTransport,
	toLlmContent,
} from "@vanrel/mcp";
import type { FlightRecorder, Logger } from "@vanrel/telemetry";
import type { TSchema } from "typebox";
import type { McpServerConfig } from "./config.ts";
import { VANREL_VERSION } from "./wiring.ts";

const DEFAULT_TIMEOUT_SECONDS = 60;
const DEFAULT_STARTUP_WAIT_MS = 10_000;
const STDERR_TAIL_CHARS = 2_000;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// --- Tool naming (exact copy of pi tools.ts createMcpToolName, see the MIT header) ---

/** Provider tool names are limited to 64 characters of `[A-Za-z0-9_-]`. */
const MAX_TOOL_NAME_LENGTH = 64;

/**
 * `mcp__<server>__<tool>`, sanitized and shortened with a hash suffix when too long. Everything
 * but `[A-Za-z0-9_]` becomes `_`. `isTaken` reports names used by a different MCP tool:
 * sanitizing can map two tools to one name (`a-b` and `a_b`), which then get the hash suffix.
 */
export function mcpToolName(server: string, tool: string, isTaken: (name: string) => boolean = () => false): string {
	const name = `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");
	if (name.length <= MAX_TOOL_NAME_LENGTH && !isTaken(name)) return name;
	const hash = createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8);
	return `${name.slice(0, MAX_TOOL_NAME_LENGTH - hash.length - 1)}_${hash}`;
}

// --- Connection to a single server (simplified pi McpServerConnection) ---

/** `disconnected`: the transport broke (stdio server died) — the next call will reconnect. */
type ServerState = "connecting" | "connected" | "disconnected" | "failed" | "closed";

interface McpConnectionDeps {
	name: string;
	config: McpServerConfig;
	cwd: string;
	log: Logger;
	recorder: FlightRecorder;
}

class McpConnection {
	readonly name: string;
	readonly config: McpServerConfig;
	state: ServerState = "connecting";
	/** Tools from the last successful connect (listTools; without capabilities.tools — []). */
	tools: McpTool[] = [];
	private client: McpClient | undefined;
	private opening: Promise<McpClient> | undefined;
	/** Abort on close(): cancels an in-flight connect. */
	private readonly shutdown = new AbortController();
	/** Stderr tail of the last stdio server that failed to connect. */
	private stderrTail: string | undefined;
	private closingPromise: Promise<void> | undefined;
	private readonly cwd: string;
	private readonly log: Logger;
	private readonly recorder: FlightRecorder;

	constructor(deps: McpConnectionDeps) {
		this.name = deps.name;
		this.config = deps.config;
		this.cwd = deps.cwd;
		this.log = deps.log;
		this.recorder = deps.recorder;
	}

	private get closed(): boolean {
		return this.shutdown.signal.aborted;
	}

	get timeoutMs(): number {
		return (this.config.timeout ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
	}

	/** Live client or one memoized connect; after a drop the next call reconnects. */
	getClient(): Promise<McpClient> {
		if (this.closed) return Promise.reject(new Error(`MCP server "${this.name}" is shut down`));
		if (this.client?.connectionState === "connected") return Promise.resolve(this.client);
		this.opening ??= this.open().finally(() => {
			this.opening = undefined;
		});
		return this.opening;
	}

	/** No retry: the call may have executed. Exception — 1 retry on a new session for 404 (§4). */
	async callTool(name: string, args: Record<string, unknown>, options: McpRequestOptions): Promise<CallToolResult> {
		for (let attempt = 1; ; attempt++) {
			const client = await this.getClient();
			try {
				return await client.callTool(name, args, options);
			} catch (error) {
				if (error instanceof McpSessionExpiredError && attempt === 1) {
					// The server forgot the session (restart/deploy) — the request did not execute. The old
					// client is not closed: its in-flight calls will get the same 404 and reconnect the same way.
					if (this.client === client) this.client = undefined;
					continue;
				}
				throw error;
			}
		}
	}

	private async open(): Promise<McpClient> {
		this.state = "connecting";
		try {
			return await this.connectOnce();
		} catch (error) {
			throw this.connectFailed(error);
		}
	}

	private async connectOnce(): Promise<McpClient> {
		const client = new McpClient({
			name: "vanrel",
			version: VANREL_VERSION,
			requestTimeoutMs: this.timeoutMs,
			roots: [{ uri: pathToFileURL(this.cwd).href, name: basename(this.cwd) }],
		});
		// close() during connect: cancels the pending initialize and closes the transport (memoized).
		let closing: Promise<void> | undefined;
		const closeClient = () => {
			closing ??= client.close().catch(() => undefined);
			return closing;
		};
		this.shutdown.signal.addEventListener("abort", closeClient, { once: true });
		let transport: McpTransport | undefined;
		try {
			transport = this.createTransport();
			await client.connect(transport);
			const stdio = transport instanceof StdioTransport ? transport : undefined;
			client.onClose(() => this.handleClientClose(client, stdio));
			// Servers without the tools capability (prompts/resources only) do not answer tools/list.
			const tools = client.serverCapabilities?.tools ? await client.listTools() : [];
			if (this.closed) throw new Error("shut down while connecting");
			if (client.connectionState !== "connected") throw new Error("connection closed during setup");
			this.client = client;
			this.tools = tools;
			this.state = "connected";
			this.log.info("mcp: server connected", { server: this.name, tools: tools.length });
			return client;
		} catch (error) {
			await closeClient();
			if (transport instanceof StdioTransport) {
				this.stderrTail = transport.stderr.trim().slice(-STDERR_TAIL_CHARS) || undefined;
			}
			throw error;
		} finally {
			this.shutdown.signal.removeEventListener("abort", closeClient);
		}
	}

	private createTransport(): McpTransport {
		const config = this.config;
		if ("url" in config) {
			return new StreamableHttpTransport({ url: config.url, headers: config.headers });
		}
		return new StdioTransport({
			command: config.command,
			args: config.args,
			cwd: resolve(this.cwd, config.cwd ?? "."),
			env: config.env,
			stderr: "pipe",
		});
	}

	private connectFailed(error: unknown): Error {
		this.state = this.closed ? "closed" : "failed";
		let message = errorMessage(error);
		// http 401/403: vanrel has no OAuth flow (recon §3.1) — an honest WARN, server marked failed.
		if (error instanceof McpAuthRequiredError) message = `${message} (requires auth — unsupported)`;
		if (this.stderrTail) message = `${message}\n${this.stderrTail}`;
		return new Error(`MCP server "${this.name}" failed to connect: ${message}`);
	}

	/** Transport dropped: disconnected + WARN + error tap; the next call reconnects itself (§4). */
	private handleClientClose(client: McpClient, stdio: StdioTransport | undefined): void {
		if (this.client !== client || this.closed) return;
		this.client = undefined;
		this.state = "disconnected";
		const stderr = stdio?.stderr.trim().slice(-STDERR_TAIL_CHARS);
		const message = stderr ? `connection closed\n${stderr}` : "connection closed";
		this.log.warn("mcp: server connection dropped; next call reconnects", { server: this.name, error: message });
		this.recorder.record("error", { scope: "mcp", message: `server "${this.name}": ${message}`, fatal: false });
	}

	/** Idempotent: abort in flight + client.close() (stdin end → SIGTERM 500ms → SIGKILL 2s). */
	close(): Promise<void> {
		this.closingPromise ??= (async () => {
			this.shutdown.abort();
			this.state = "closed";
			const client = this.client;
			this.client = undefined;
			await Promise.all([client?.close().catch(() => undefined), this.opening?.catch(() => undefined)]);
		})();
		return this.closingPromise;
	}
}

// --- AgentTool on top of an MCP tool ---

export interface McpToolDetails {
	server: string;
	tool: string;
}

/** Tool input schemas must be objects; some providers reject object schemas without `properties`. */
function toParameters(schema: Record<string, unknown>): TSchema {
	return {
		...schema,
		type: schema.type ?? "object",
		...(schema.properties === undefined ? { properties: {} } : {}),
	} as unknown as TSchema;
}

function buildMcpTool(
	server: string,
	tool: McpTool,
	name: string,
	connection: McpConnection,
): AgentTool<TSchema, McpToolDetails> {
	const title = tool.title ?? tool.annotations?.title;
	return {
		name,
		label: `${server}/${tool.name}`,
		description: tool.description?.trim() || title || `MCP tool ${tool.name} from server ${server}`,
		parameters: toParameters(tool.inputSchema),
		async execute(_toolCallId, params, signal, onUpdate) {
			// throw → the agent loop makes an error-result itself (recon §3.2).
			const result = await connection.callTool(tool.name, (params ?? {}) as Record<string, unknown>, {
				signal,
				timeoutMs: connection.timeoutMs,
				onProgress: (progress) => {
					const total = progress.total === undefined ? "" : `/${progress.total}`;
					const text = progress.message ?? `Progress ${progress.progress}${total}`;
					onUpdate?.({ content: [{ type: "text", text }], details: { server, tool: tool.name } });
				},
			});
			const content = toLlmContent(result); // text/image; audio and the rest → placeholder
			if (result.isError && content.every((block) => block.type !== "text" || block.text === "")) {
				content.push({ type: "text", text: `MCP tool ${server}/${tool.name} returned an error` });
			}
			return { content, details: { server, tool: tool.name }, ...(result.isError ? { isError: true } : {}) };
		},
	};
}

// --- Runtime ---

export interface McpRuntime {
	tools: AgentTool<any>[];
	/** Idempotent: close all connections. */
	close(): Promise<void>;
}

export interface McpRuntimeDeps {
	servers: Record<string, McpServerConfig>;
	cwd: string;
	log: Logger;
	recorder: FlightRecorder;
	/** Budget for waiting on all servers to start, ms. Default 10_000 (like pi). */
	startupWaitMs?: number;
	/**
	 * Tools of servers that came up AFTER createMcpRuntime returned (the startupWaitMs deadline
	 * expired, the connect continues in background). Without the callback, late tools are visible
	 * only in runtime.tools (a live array), but not in the snapshot wiring took when building
	 * the agent (recon M8).
	 */
	onToolsAdded?: (tools: AgentTool<any>[]) => void;
}

/** Shared startup deadline; overdue connects continue in background (not aborted). */
function awaitStartup(pending: Promise<void>[], waitMs: number): Promise<void> {
	if (pending.length === 0) return Promise.resolve();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<void>((resolvePromise) => {
		timer = setTimeout(resolvePromise, waitMs);
		timer.unref?.();
	});
	return Promise.race([Promise.allSettled(pending).then(() => undefined), deadline]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

export async function createMcpRuntime(deps: McpRuntimeDeps): Promise<McpRuntime> {
	const { servers, cwd, log, recorder } = deps;
	const startupWaitMs = deps.startupWaitMs ?? DEFAULT_STARTUP_WAIT_MS;
	const tools: AgentTool<any>[] = [];
	const connections: McpConnection[] = [];

	// In-server collisions are detected on listTools (sanitize `a-b` vs `a_b`) → hash suffix.
	// Once the snapshot is taken (createMcpRuntime returned), late tools additionally go to onToolsAdded.
	let snapshotTaken = false;
	const registerTools = (connection: McpConnection): void => {
		const taken = new Set<string>();
		const added: AgentTool<any>[] = [];
		for (const tool of connection.tools) {
			const name = mcpToolName(connection.name, tool.name, (candidate) => taken.has(candidate));
			taken.add(name);
			const built = buildMcpTool(connection.name, tool, name, connection);
			tools.push(built);
			added.push(built);
		}
		if (snapshotTaken && added.length > 0 && deps.onToolsAdded !== undefined) {
			try {
				deps.onToolsAdded(added);
			} catch (error) {
				log.warn("mcp: onToolsAdded listener failed", { server: connection.name, error: errorMessage(error) });
			}
		}
	};

	const pending: Promise<void>[] = [];
	for (const [name, config] of Object.entries(servers)) {
		if (config.enabled === false) {
			log.info("mcp: server disabled in config, skipped", { server: name });
			continue;
		}
		const connection = new McpConnection({ name, config, cwd, log, recorder });
		connections.push(connection);
		// Background start: success → tools into the runtime; failure → WARN + error tap, the session continues (§4).
		pending.push(
			connection.getClient().then(
				() => {
					registerTools(connection);
				},
				(error) => {
					const message = errorMessage(error);
					log.warn("mcp: server unavailable, continuing without its tools", { server: name, error: message });
					recorder.record("error", { scope: "mcp", message, fatal: false });
				},
			),
		);
	}

	await awaitStartup(pending, startupWaitMs);
	const stillConnecting = connections.filter((connection) => connection.state === "connecting").length;
	if (stillConnecting > 0) {
		log.debug("mcp: startup wait budget exhausted; servers still connecting in background", {
			servers: stillConnecting,
			startupWaitMs,
		});
	}
	// Snapshot point: registerTools after this line (late connects) notifies onToolsAdded.
	// There is no await between awaitStartup and return — no partial snapshot race.
	snapshotTaken = true;

	let closing: Promise<void> | undefined;
	return {
		tools,
		close() {
			closing ??= Promise.all(connections.map((connection) => connection.close())).then(() => undefined);
			return closing;
		},
	};
}
