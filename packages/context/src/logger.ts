/**
 * Local structural Logger declaration.
 * Structurally compatible with Logger from @vanrel/telemetry: assigning a
 * telemetry logger instance is legal under TS structural typing, no runtime import
 * (a dependency on telemetry is forbidden by §4.1.3, enforced by check-import-graph.mjs).
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
	debug(msg: string, fields?: Record<string, unknown>): void;
	info(msg: string, fields?: Record<string, unknown>): void;
	warn(msg: string, fields?: Record<string, unknown>): void;
	error(msg: string, fields?: Record<string, unknown>): void;
}

const noop = (): void => {};

/** Default logger: all methods are no-op. */
export const NOOP_LOGGER: Logger = { debug: noop, info: noop, warn: noop, error: noop };
