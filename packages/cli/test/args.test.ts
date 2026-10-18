import { describe, expect, it } from "vitest";
import { ArgsError, EXIT_AUTH, EXIT_BUDGET, EXIT_ERROR, EXIT_OK, EXIT_SIGINT, parseArgs, USAGE } from "../src/args.ts";

describe("parseArgs (CLI contract §4.6)", () => {
	it("no arguments → interactive run", () => {
		expect(parseArgs([])).toEqual({
			kind: "run",
			print: undefined,
			sessionId: undefined,
			noSplash: false,
			provider: undefined,
			model: undefined,
		});
	});

	it("--print with a separate value and -p", () => {
		expect(parseArgs(["--print", "hello"])).toMatchObject({ kind: "run", print: "hello" });
		expect(parseArgs(["-p", "hi"])).toMatchObject({ kind: "run", print: "hi" });
	});

	it("--print=inline value", () => {
		expect(parseArgs(["--print=inline prompt"])).toMatchObject({ kind: "run", print: "inline prompt" });
	});

	it("--session <id>", () => {
		expect(parseArgs(["--session", "abc-123"])).toMatchObject({ kind: "run", sessionId: "abc-123" });
		expect(parseArgs(["--session=abc-123"])).toMatchObject({ kind: "run", sessionId: "abc-123" });
	});

	it("--no-splash takes no value", () => {
		expect(parseArgs(["--no-splash"])).toMatchObject({ kind: "run", noSplash: true });
		expect(() => parseArgs(["--no-splash=yes"])).toThrow(ArgsError);
	});

	it("--provider accepts only auth provider ids", () => {
		expect(parseArgs(["--provider", "agy"])).toMatchObject({ kind: "run", provider: "agy" });
		expect(() => parseArgs(["--provider", "openai"])).toThrow(ArgsError);
		expect(() => parseArgs(["--provider"])).toThrow(ArgsError);
	});

	it("--model explicit id or alias", () => {
		expect(parseArgs(["--model", "cheap"])).toMatchObject({ kind: "run", model: "cheap" });
		expect(parseArgs(["--model=claude-haiku-4-5"])).toMatchObject({ kind: "run", model: "claude-haiku-4-5" });
	});

	it("flag combination", () => {
		expect(
			parseArgs(["--no-splash", "--print", "x", "--session", "s1", "--provider", "codex", "--model", "gpt-6.1-sol"]),
		).toEqual({
			kind: "run",
			print: "x",
			sessionId: "s1",
			noSplash: true,
			provider: "codex",
			model: "gpt-6.1-sol",
		});
	});

	it("login <provider>", () => {
		expect(parseArgs(["login", "anthropic"])).toEqual({ kind: "login", provider: "anthropic", pasteCode: false });
		expect(parseArgs(["login", "agy"])).toEqual({ kind: "login", provider: "agy", pasteCode: false });
		expect(parseArgs(["login", "codex"])).toEqual({ kind: "login", provider: "codex", pasteCode: false });
		expect(() => parseArgs(["login"])).toThrow(ArgsError);
		expect(() => parseArgs(["login", "openai"])).toThrow(ArgsError);
		expect(() => parseArgs(["login", "anthropic", "extra"])).toThrow(ArgsError);
	});

	it("login <provider> --paste-code", () => {
		expect(parseArgs(["login", "codex", "--paste-code"])).toEqual({
			kind: "login",
			provider: "codex",
			pasteCode: true,
		});
		expect(parseArgs(["--paste-code", "login", "agy"])).toEqual({
			kind: "login",
			provider: "agy",
			pasteCode: true,
		});
		expect(() => parseArgs(["login", "codex", "--paste-code=yes"])).toThrow(ArgsError);
	});

	it("auth status", () => {
		expect(parseArgs(["auth", "status"])).toEqual({ kind: "auth-status" });
		expect(() => parseArgs(["auth"])).toThrow(ArgsError);
		expect(() => parseArgs(["auth", "login"])).toThrow(ArgsError);
	});

	it("--help and -h", () => {
		expect(parseArgs(["--help"])).toEqual({ kind: "help" });
		expect(parseArgs(["-h"])).toEqual({ kind: "help" });
		expect(USAGE).toContain("--print");
		expect(USAGE).toContain("auth status");
	});

	it("unknown flag / positional → ArgsError", () => {
		expect(() => parseArgs(["--bogus"])).toThrow(ArgsError);
		expect(() => parseArgs(["hello"])).toThrow(ArgsError);
		expect(() => parseArgs(["--print"])).toThrow(ArgsError);
		expect(() => parseArgs(["--session"])).toThrow(ArgsError);
	});
});

describe("exit codes (§4.6)", () => {
	it("constants 0/1/2/3/130", () => {
		expect(EXIT_OK).toBe(0);
		expect(EXIT_ERROR).toBe(1);
		expect(EXIT_AUTH).toBe(2);
		expect(EXIT_BUDGET).toBe(3);
		expect(EXIT_SIGINT).toBe(130);
	});
});
