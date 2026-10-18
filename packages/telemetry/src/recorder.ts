import { randomUUID } from "node:crypto";
import { appendFile, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FlightEventEnvelope, FlightEventType, FlightPayloadMap } from "./events.ts";
import { createLogger, type Logger } from "./logger.ts";

export interface FlightRecorderOptions {
	dir?: string; // default: ~/.vanrel/traces
	sessionId?: string; // default: crypto.randomUUID()
	flushIntervalMs?: number; // default: 1000; <= 0 disables the timer
	flushThresholdBytes?: number; // default: 65536 — forced flush when the buffer is exceeded
	maxFileBytes?: number; // default: 64 * 1024 * 1024 — rotation into session-<id>.<n>.jsonl
	now?: () => number; // injection for tests
	log?: Logger; // structured logger (§I5); default: JSONL to stderr
}

export interface FlightRecorder {
	readonly sessionId: string;
	readonly filePath: string; // <dir>/session-<sessionId>.jsonl (base path, without the rotation suffix)
	/** Synchronous, O(1): JSON.stringify of the event into the buffer. Never throws;
		write/serialization errors (including circular JSON) — WARN to log and counted in droppedCount. */
	record<E extends FlightEventType>(type: E, payload: FlightPayloadMap[E]): void;
	readonly droppedCount: number;
	/** Append the buffer to disk. Idempotent. */
	flush(): Promise<void>;
	/** flush + close the file + cancel the timer. After close(), record() is a no-op with a DEBUG log. */
	close(): Promise<void>;
}

const DEFAULT_FLUSH_INTERVAL_MS = 1000;
const DEFAULT_FLUSH_THRESHOLD_BYTES = 65536;
const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Buffered JSONL flight recorder (§4.1.3): snapshot on record, writes on timer/threshold/flush,
	size-based file rotation, zero exceptions in the hot path. */
class FileFlightRecorder implements FlightRecorder {
	readonly sessionId: string;
	readonly filePath: string;
	private readonly dir: string;
	private readonly flushThresholdBytes: number;
	private readonly maxFileBytes: number;
	private readonly now: () => number;
	private readonly log: Logger;
	private readonly timer: NodeJS.Timeout | null = null;
	private buffer: string[] = [];
	private bufferBytes = 0;
	private seq = 0;
	private dropped = 0;
	private closed = false;
	private tail: Promise<void> = Promise.resolve();
	private fileIndex = 0; // 0 = base file; 1..n — session-<id>.<n>.jsonl
	private currentSize = 0;
	private ready: Promise<void> | null = null;

	constructor(options: FlightRecorderOptions = {}) {
		this.dir = options.dir ?? join(homedir(), ".vanrel", "traces");
		this.sessionId = options.sessionId ?? randomUUID();
		this.filePath = join(this.dir, `session-${this.sessionId}.jsonl`);
		this.flushThresholdBytes = options.flushThresholdBytes ?? DEFAULT_FLUSH_THRESHOLD_BYTES;
		this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
		this.now = options.now ?? ((): number => Date.now());
		this.log = options.log ?? createLogger({ name: "telemetry" });
		const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
		if (flushIntervalMs > 0) {
			const timer = setInterval((): void => {
				void this.flush();
			}, flushIntervalMs);
			timer.unref();
			this.timer = timer;
		}
	}

	get droppedCount(): number {
		return this.dropped;
	}

	record<E extends FlightEventType>(type: E, payload: FlightPayloadMap[E]): void {
		if (this.closed) {
			this.log.debug("record() after close(); event dropped", { type });
			return;
		}
		// Snapshot semantics: stringify at call time — later payload mutations do not corrupt the trace.
		const envelope: FlightEventEnvelope = {
			v: 1,
			seq: this.seq + 1,
			ts: this.now(),
			sessionId: this.sessionId,
			type,
			payload,
		};
		let line: string;
		try {
			line = `${JSON.stringify(envelope)}\n`;
		} catch (error) {
			this.dropped += 1;
			this.log.warn("event serialization failed; event dropped", { type, error: errorMessage(error) });
			return;
		}
		this.seq += 1;
		this.buffer.push(line);
		this.bufferBytes += Buffer.byteLength(line, "utf8");
		if (this.bufferBytes > this.flushThresholdBytes) {
			void this.flush();
		}
	}

	flush(): Promise<void> {
		// The chain serializes concurrent flush calls; drain never throws, so the chain stays healthy.
		this.tail = this.tail.then(() => this.drain());
		return this.tail;
	}

	async close(): Promise<void> {
		if (this.closed) {
			this.log.debug("close() on already closed recorder");
			return;
		}
		this.closed = true;
		if (this.timer !== null) {
			clearInterval(this.timer);
		}
		await this.flush();
	}

	private async drain(): Promise<void> {
		if (this.buffer.length === 0) return;
		const lines = this.buffer;
		this.buffer = [];
		this.bufferBytes = 0;
		try {
			await this.ensureReady();
			await this.writeLines(lines);
		} catch (error) {
			// Deviation from I5 is deliberate (§4.1.3): a tracer failure must not crash the session; the fact is recorded.
			this.dropped += lines.length;
			this.log.warn("trace write failed; events dropped", {
				dropped: lines.length,
				file: this.currentPath(),
				error: errorMessage(error),
			});
		}
	}

	/** mkdir -p dir + restore currentSize of an existing file (append semantics across processes). */
	private async ensureReady(): Promise<void> {
		if (this.ready !== null) return this.ready;
		try {
			const pending = (async (): Promise<void> => {
				await mkdir(this.dir, { recursive: true });
				try {
					const stats = await stat(this.filePath);
					this.currentSize = stats.size;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
						this.log.debug("could not stat existing trace file; assuming empty", {
							file: this.filePath,
							error: errorMessage(error),
						});
					}
				}
			})();
			this.ready = pending;
			await pending;
		} catch (error) {
			this.ready = null; // let the next flush retry mkdir
			throw error;
		}
	}

	private async writeLines(lines: string[]): Promise<void> {
		let i = 0;
		while (i < lines.length) {
			if (this.currentSize > this.maxFileBytes) {
				this.fileIndex += 1;
				this.currentSize = 0;
				this.log.info("trace file rotated", { file: this.currentPath() });
			}
			let chunk = "";
			let chunkBytes = 0;
			while (i < lines.length) {
				const lineBytes = Buffer.byteLength(lines[i], "utf8");
				// Rotate before a write that would exceed maxFileBytes;
				// a single line larger than the limit is still written (no data loss).
				if (chunkBytes > 0 && this.currentSize + chunkBytes + lineBytes > this.maxFileBytes) break;
				chunk += lines[i];
				chunkBytes += lineBytes;
				i += 1;
			}
			await appendFile(this.currentPath(), chunk, "utf8");
			this.currentSize += chunkBytes;
		}
	}

	private currentPath(): string {
		if (this.fileIndex === 0) return this.filePath;
		return join(this.dir, `session-${this.sessionId}.${this.fileIndex}.jsonl`);
	}
}

export function createFlightRecorder(options?: FlightRecorderOptions): FlightRecorder {
	return new FileFlightRecorder(options);
}

/** All methods are no-op; for tests/print mode. */
export const NOOP_FLIGHT_RECORDER: FlightRecorder = Object.freeze({
	sessionId: "noop",
	filePath: "",
	record: (): void => {},
	droppedCount: 0,
	flush: (): Promise<void> => Promise.resolve(),
	close: (): Promise<void> => Promise.resolve(),
});
