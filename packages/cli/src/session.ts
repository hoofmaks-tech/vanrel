/**
 * Session manager (§3.1 persist step): append-only JSONL ~/.vanrel/sessions/<id>.jsonl.
 * Entries: user / assistant / tool_result / compaction / session_info / custom.
 * --session reads the file and restores the history (AgentMessage[]) for continuation.
 *
 * Assistant/tool_result entries are persisted AFTER filtering (the context gets the summary —
 * and it is the summary that is restored on resume; raw data lives in the flight recorder,
 * §1 invariant 1).
 *
 * A2 (recon interactive-vendor §3.3): in-memory entry index, session name
 * (session_info), list() for the /resume selector, appendCustomEntry. Linear model —
 * the Pi tree API (fork/branch/navigate) is deliberately not ported.
 *
 * M7: append* calls are serialized by an internal promise chain (writeQueue) — call order
 * equals record order in the file under concurrent fire-and-forget appends.
 */
import { appendFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@vanrel/agent";
import type { AssistantMessage, ToolResultMessage } from "@vanrel/ai";
import type { Logger } from "@vanrel/telemetry";

export type SessionEntry =
	| { v: 1; seq: number; ts: number; type: "user"; content: string }
	| { v: 1; seq: number; ts: number; type: "assistant"; message: AssistantMessage }
	| { v: 1; seq: number; ts: number; type: "tool_result"; message: ToolResultMessage }
	| {
			v: 1;
			seq: number;
			ts: number;
			type: "compaction";
			level: string;
			tokensBefore: number;
			tokensAfter: number;
			spilledTo?: string;
	  }
	| { v: 1; seq: number; ts: number; type: "session_info"; name?: string }
	| { v: 1; seq: number; ts: number; type: "custom"; customType: string; data: unknown };

/** Summary of a session on disk for the /resume selector (A2, recon §3.3). */
export interface SessionInfo {
	id: string;
	filePath: string;
	/** Session file mtime, ms. list() returns newest first. */
	mtime: number;
	entryCount: number;
	/** Preview of the first user message (whitespace collapsed, truncated). */
	firstUserMessage?: string;
	/** Name from the last session_info entry (for the /resume selector: name filter, rename). */
	name?: string;
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SESSION_FILE_SUFFIX = ".jsonl";
const FIRST_USER_MESSAGE_PREVIEW_MAX = 120;

function previewFirstUserMessage(content: string): string {
	const flat = content.replace(/\s+/g, " ").trim();
	return flat.length <= FIRST_USER_MESSAGE_PREVIEW_MAX
		? flat
		: `${flat.slice(0, FIRST_USER_MESSAGE_PREVIEW_MAX - 1)}…`;
}

export class SessionError extends Error {
	readonly kind = "session";
	constructor(message: string) {
		super(message);
		this.name = "SessionError";
	}
}

export function assertValidSessionId(id: string): void {
	if (!SESSION_ID_PATTERN.test(id)) throw new SessionError(`invalid session id: ${JSON.stringify(id)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Minimal structural validation of replayable entries; broken lines get WARN + skip (I5). */
function entryToMessage(entry: Record<string, unknown>, log: Logger): AgentMessage | undefined {
	const ts = typeof entry.ts === "number" ? entry.ts : Date.now();
	switch (entry.type) {
		case "user":
			if (typeof entry.content !== "string") break;
			return { role: "user", content: entry.content, timestamp: ts };
		case "assistant": {
			const message = entry.message;
			if (isRecord(message) && message.role === "assistant") return message as unknown as AgentMessage;
			break;
		}
		case "tool_result": {
			const message = entry.message;
			if (isRecord(message) && message.role === "toolResult") return message as unknown as AgentMessage;
			break;
		}
		case "compaction":
		case "session_info":
		case "custom":
			return undefined; // informational records are not part of the history
		default:
			break;
	}
	log.warn("session: skipping malformed entry", { type: entry.type });
	return undefined;
}

export class SessionManager {
	readonly id: string;
	readonly filePath: string;
	private readonly cwd: string;
	private readonly log: Logger;
	private seq = 0;
	private readonly entries: SessionEntry[] = [];
	/**
	 * M7: append serialization. Public append* calls are fire-and-forget (wiring/interactive-mode) —
	 * without a queue the record order in the file would be the I/O completion order
	 * (user/assistant inversion). The chain guarantees: call order = file order, seq is assigned
	 * at the moment of the actual write (monotonic and matching the line order).
	 */
	private writeQueue: Promise<void> = Promise.resolve();
	private constructor(id: string, filePath: string, cwd: string, log: Logger) {
		this.id = id;
		this.filePath = filePath;
		this.cwd = cwd;
		this.log = log;
	}

	/** New session; the file is created on the first append (mkdir -p on the directory — immediately). */
	static async create(dir: string, id: string, log: Logger, cwd: string = process.cwd()): Promise<SessionManager> {
		assertValidSessionId(id);
		await mkdir(dir, { recursive: true });
		log.debug("session created", { id, dir });
		return new SessionManager(id, join(dir, `${id}.jsonl`), cwd, log);
	}

	/** Resume: reads the JSONL and restores the history. Missing file → SessionError. */
	static async resume(
		dir: string,
		id: string,
		log: Logger,
		cwd: string = process.cwd(),
	): Promise<{ manager: SessionManager; messages: AgentMessage[] }> {
		assertValidSessionId(id);
		const filePath = join(dir, `${id}.jsonl`);
		let raw: string;
		try {
			raw = await readFile(filePath, "utf8");
		} catch {
			throw new SessionError(`session not found: ${id} (${filePath})`);
		}
		const manager = new SessionManager(id, filePath, cwd, log);
		const messages: AgentMessage[] = [];
		const lines = raw.split("\n");
		for (const [index, line] of lines.entries()) {
			if (line.trim() === "") continue;
			let entry: unknown;
			try {
				entry = JSON.parse(line);
			} catch {
				log.warn("session: skipping unparseable line", { line: index + 1, filePath });
				continue;
			}
			if (!isRecord(entry) || typeof entry.seq !== "number") {
				log.warn("session: skipping malformed entry", { line: index + 1, filePath });
				continue;
			}
			manager.seq = Math.max(manager.seq, entry.seq);
			manager.entries.push(entry as unknown as SessionEntry);
			const message = entryToMessage(entry, log);
			if (message) messages.push(message);
		}
		log.info("session resumed", { id, messages: messages.length, filePath });
		return { manager, messages };
	}

	private append(
		entry:
			| { type: "user"; content: string; ts?: number }
			| { type: "assistant"; message: AssistantMessage; ts?: number }
			| { type: "tool_result"; message: ToolResultMessage; ts?: number }
			| {
					type: "compaction";
					level: string;
					tokensBefore: number;
					tokensAfter: number;
					spilledTo?: string;
					ts?: number;
			  }
			| { type: "session_info"; name?: string; ts?: number }
			| { type: "custom"; customType: string; data: unknown; ts?: number },
	): Promise<void> {
		// Enqueueing is synchronous with the call → call order = record order (M7).
		const write = this.writeQueue.then(async () => {
			const full = { v: 1, seq: ++this.seq, ts: entry.ts ?? Date.now(), ...entry } as SessionEntry;
			await appendFile(this.filePath, `${JSON.stringify(full)}\n`, "utf8");
			this.entries.push(full);
		});
		// One record's failure does not break the chain: the queue continues, the error goes only to the caller.
		this.writeQueue = write.catch((error: unknown) => {
			this.log.error("session append failed", { id: this.id, type: entry.type, error: String(error) });
		});
		return write;
	}

	appendUser(content: string): Promise<void> {
		return this.append({ type: "user", content });
	}
	appendAssistant(message: AssistantMessage): Promise<void> {
		return this.append({ type: "assistant", message, ts: message.timestamp });
	}
	appendToolResult(message: ToolResultMessage): Promise<void> {
		return this.append({ type: "tool_result", message, ts: message.timestamp });
	}
	appendCompaction(result: {
		level: string;
		tokensBefore: number;
		tokensAfter: number;
		spilledTo?: string;
	}): Promise<void> {
		return this.append({ type: "compaction", ...result });
	}

	// --- A2 (recon §3.3): accessors for interactive mode ---

	/** In-memory index of all valid entries (resume + append). */
	getEntries(): readonly SessionEntry[] {
		return this.entries;
	}

	getEntryCount(): number {
		return this.entries.length;
	}

	/** Name from the last session_info entry; undefined if not set. */
	getSessionName(): string | undefined {
		for (let i = this.entries.length - 1; i >= 0; i--) {
			const entry = this.entries[i];
			if (entry.type === "session_info") return entry.name;
		}
		return undefined;
	}

	async setSessionName(name: string): Promise<void> {
		await this.append({ type: "session_info", name });
		this.log.debug("session name set", { id: this.id, name });
	}

	/** Session cwd: from the ctor (there is no header record in the JSONL format). */
	getCwd(): string {
		return this.cwd;
	}

	getSessionFile(): string {
		return this.filePath;
	}

	getSessionDir(): string {
		return dirname(this.filePath);
	}

	getSessionId(): string {
		return this.id;
	}

	/** vanrel sessions are always persisted (append-only JSONL on disk). */
	isPersisted(): true {
		return true;
	}

	/** Generalized appendCompaction: an arbitrary custom record (not part of the history). */
	async appendCustomEntry(customType: string, data: unknown): Promise<void> {
		await this.append({ type: "custom", customType, data });
		this.log.debug("session custom entry appended", { id: this.id, customType });
	}

	/**
	 * Enumerate the sessions of a directory for the /resume selector: id, mtime, entryCount,
	 * first user message preview. Unreadable/broken files get WARN + skip (I5).
	 * Order: newest (mtime desc) first. A missing directory yields an empty list.
	 */
	static async *list(dir: string, log: Logger): AsyncIterable<SessionInfo> {
		let names: string[];
		try {
			names = await readdir(dir);
		} catch {
			return; // no directory yet — no sessions
		}
		const infos: SessionInfo[] = [];
		for (const name of names) {
			if (!name.endsWith(SESSION_FILE_SUFFIX)) continue;
			const id = name.slice(0, -SESSION_FILE_SUFFIX.length);
			if (!SESSION_ID_PATTERN.test(id)) continue;
			const filePath = join(dir, name);
			let raw: string;
			let mtime: number;
			try {
				const [content, stats] = await Promise.all([readFile(filePath, "utf8"), stat(filePath)]);
				raw = content;
				mtime = stats.mtimeMs;
			} catch (error) {
				log.warn("session list: skipping unreadable file", { filePath, error: String(error) });
				continue;
			}
			let entryCount = 0;
			let firstUserMessage: string | undefined;
			let sessionName: string | undefined;
			for (const [index, line] of raw.split("\n").entries()) {
				if (line.trim() === "") continue;
				let entry: unknown;
				try {
					entry = JSON.parse(line);
				} catch {
					log.warn("session list: skipping unparseable line", { filePath, line: index + 1 });
					continue;
				}
				if (!isRecord(entry) || typeof entry.seq !== "number") continue;
				entryCount++;
				if (firstUserMessage === undefined && entry.type === "user" && typeof entry.content === "string") {
					firstUserMessage = previewFirstUserMessage(entry.content);
				}
				if (entry.type === "session_info" && typeof entry.name === "string") {
					sessionName = entry.name;
				}
			}
			infos.push({ id, filePath, mtime, entryCount, firstUserMessage, name: sessionName });
		}
		infos.sort((a, b) => b.mtime - a.mtime);
		yield* infos;
	}
}
