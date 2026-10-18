/** The only structured logger of the system (I5). Defined HERE, in @vanrel/telemetry;
	all other packages import the type from here (`import type { Logger } from "@vanrel/telemetry"`).
	The default implementation writes JSONL to stderr; tests use NOOP_LOGGER. */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
	debug(msg: string, fields?: Record<string, unknown>): void;
	info(msg: string, fields?: Record<string, unknown>): void;
	warn(msg: string, fields?: Record<string, unknown>): void;
	error(msg: string, fields?: Record<string, unknown>): void;
}

/** All methods are no-op. */
export const NOOP_LOGGER: Logger = Object.freeze({
	debug: (): void => {},
	info: (): void => {},
	warn: (): void => {},
	error: (): void => {},
});

export interface LoggerOptions {
	minLevel?: LogLevel; // default "info"
	now?: () => number; // injection for tests
	sink?: (line: string) => void; // default: JSONL line to process.stderr
	name?: string; // component name, added as a field to every entry
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Structured logger: one JSON line per event, levels DEBUG/INFO/WARN/ERROR (I5). */
export function createLogger(options?: LoggerOptions): Logger {
	const minLevel = options?.minLevel ?? "info";
	const now = options?.now ?? ((): number => Date.now());
	const sink = options?.sink ?? ((line: string): void => void process.stderr.write(`${line}\n`));
	const name = options?.name;
	const emit = (level: LogLevel, msg: string, fields?: Record<string, unknown>): void => {
		if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
		const entry: Record<string, unknown> = {
			ts: now(),
			level,
			msg,
			...(name === undefined ? {} : { name }),
			...fields,
		};
		let line: string;
		try {
			line = JSON.stringify(entry);
		} catch {
			// fields may contain circular references — the logger must not crash
			line = JSON.stringify({ ts: now(), level, msg, error: "log fields not serializable" });
		}
		try {
			sink(line);
		} catch {
			// a sink failure (e.g., closed stderr) must not bring down the host process
		}
	};
	return {
		debug: (msg, fields) => emit("debug", msg, fields),
		info: (msg, fields) => emit("info", msg, fields),
		warn: (msg, fields) => emit("warn", msg, fields),
		error: (msg, fields) => emit("error", msg, fields),
	};
}
