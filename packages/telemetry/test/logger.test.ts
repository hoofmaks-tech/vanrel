import { describe, expect, it } from "vitest";
import { createLogger, type LogLevel, NOOP_LOGGER } from "../src/index.ts";

interface LogLine {
	ts: number;
	level: LogLevel;
	msg: string;
	name?: string;
	[key: string]: unknown;
}

function capture(minLevel?: LogLevel) {
	const lines: LogLine[] = [];
	const logger = createLogger({
		minLevel,
		now: () => 42,
		name: "test",
		sink: (line) => lines.push(JSON.parse(line) as LogLine),
	});
	return { logger, lines };
}

describe("createLogger", () => {
	it("writes structured JSON lines with ts/level/msg/name and fields", () => {
		const { logger, lines } = capture("debug");
		logger.debug("dbg", { a: 1 });
		logger.info("inf");
		logger.warn("wrn", { b: "x" });
		logger.error("err");
		expect(lines).toHaveLength(4);
		expect(lines[0]).toMatchObject({ ts: 42, level: "debug", msg: "dbg", name: "test", a: 1 });
		expect(lines[1]).toMatchObject({ ts: 42, level: "info", msg: "inf" });
		expect(lines[2]).toMatchObject({ ts: 42, level: "warn", msg: "wrn", b: "x" });
		expect(lines[3]).toMatchObject({ ts: 42, level: "error", msg: "err" });
	});

	it("filters levels below minLevel (default info)", () => {
		const { logger, lines } = capture();
		logger.debug("skip");
		logger.info("keep");
		expect(lines.map((l) => l.msg)).toEqual(["keep"]);
	});

	it("does not throw on circular fields and a failing sink", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		const { logger, lines } = capture("info");
		logger.info("circular", circular);
		expect(lines).toHaveLength(1);
		expect(lines[0].error).toBe("log fields not serializable");

		const throwing = createLogger({
			sink: () => {
				throw new Error("sink dead");
			},
		});
		throwing.error("still no throw");
	});
});

describe("NOOP_LOGGER", () => {
	it("all methods are callable and silent", () => {
		NOOP_LOGGER.debug("a", { x: 1 });
		NOOP_LOGGER.info("b");
		NOOP_LOGGER.warn("c");
		NOOP_LOGGER.error("d", { y: 2 });
	});
});
