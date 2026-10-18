/**
 * Command dispatcher + exit code mapping (§4.6): 0 ok; 1 generic; 2 auth; 3 budget; 130 SIGINT.
 * Composition without auth/budget/qc logic — wiring only (§4.6).
 */
import { BudgetError } from "@vanrel/context";
import { createLogger, type Logger } from "@vanrel/telemetry";
import {
	ArgsError,
	type CliCommand,
	EXIT_AUTH,
	EXIT_BUDGET,
	EXIT_ERROR,
	EXIT_OK,
	EXIT_SIGINT,
	parseArgs,
	USAGE,
} from "./args.ts";
import { authStatusCommand } from "./auth-status.ts";
import { loadConfig } from "./config.ts";
import { loginCommand } from "./login.ts";
import { vanrelPaths } from "./paths.ts";
import { type CliIo, runSession } from "./run.ts";
import { buildSplashLines, shouldShowSplash } from "./splash.ts";
import { AuthUnavailableError, createSessionRuntime, type SessionRuntime } from "./wiring.ts";

function createCliLogger(): Logger {
	const level = process.env.VANREL_LOG_LEVEL;
	const minLevel = level === "debug" || level === "info" || level === "warn" || level === "error" ? level : "warn";
	return createLogger({ minLevel, name: "vanrel-cli" });
}

async function runCommand(command: Extract<CliCommand, { kind: "run" }>, io: CliIo, log: Logger): Promise<number> {
	const paths = vanrelPaths();
	const config = await loadConfig(paths.configFile, log);
	const interactive = command.print === undefined && io.stdin.isTTY === true;
	if (shouldShowSplash({ noSplash: command.noSplash, isTty: interactive })) {
		const lines = buildSplashLines({ cols: io.stdout.columns ?? 80, rows: io.stdout.rows ?? 24, cwd: process.cwd() });
		if (lines.length > 0) io.stdout.write(`${lines.join("\n")}\n`);
	}

	let runtime: SessionRuntime;
	try {
		runtime = await createSessionRuntime({
			cwd: process.cwd(),
			argv: process.argv,
			paths,
			config,
			sessionId: command.sessionId,
			provider: command.provider,
			model: command.model,
			log,
			// stdout streaming is print/pipe only; in interactive mode the TUI renders the stream (W14).
			onAssistantText: interactive ? undefined : (delta) => io.stdout.write(delta),
		});
	} catch (error) {
		if (error instanceof AuthUnavailableError) {
			// §4.6 exit 2: clear message + skipped reasons, no crash.
			io.stderr.write(`vanrel: ${error.message}\n`);
			for (const skipped of error.skipped) io.stderr.write(`  ${skipped.provider}: ${skipped.reason}\n`);
			io.stderr.write("Run `vanrel login <anthropic|agy|codex>` to authenticate.\n");
			return EXIT_AUTH;
		}
		if (error instanceof BudgetError) {
			io.stderr.write(`vanrel: context budget error: ${error.message}\nTry --model with a larger context window.\n`);
			return EXIT_BUDGET;
		}
		const message = error instanceof Error ? error.message : String(error);
		log.error("runtime setup failed", { error: message });
		io.stderr.write(`vanrel: ${message}\n`);
		return EXIT_ERROR;
	}

	if (interactive) {
		// W14: TUI branch. close/switchSession inside runSession (mode owns host.close, R5);
		// recorder lives per-runtime — tap T5 is written on every close (session switch is fine).
		return runSession(runtime, { interactive: true }, io, log, {
			createRuntime: (sessionId) =>
				createSessionRuntime({
					cwd: process.cwd(),
					argv: process.argv,
					paths,
					config,
					sessionId,
					provider: command.provider,
					model: command.model,
					log,
				}),
		});
	}

	let code = EXIT_OK;
	let closeReason: "user_exit" | "error" | "completed" = "completed";
	try {
		code = await runSession(runtime, { print: command.print, interactive }, io, log);
		if (code === EXIT_SIGINT) closeReason = "user_exit";
		else if (code !== EXIT_OK) closeReason = "error";
	} finally {
		await runtime.close(closeReason);
	}
	return code;
}

export async function runCli(argv: readonly string[], io?: Partial<CliIo>): Promise<number> {
	const fullIo: CliIo = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, ...io };
	const log = createCliLogger();
	let command: CliCommand;
	try {
		command = parseArgs(argv);
	} catch (error) {
		if (error instanceof ArgsError) {
			fullIo.stderr.write(`vanrel: ${error.message}\n`);
			fullIo.stderr.write(USAGE);
			return EXIT_ERROR;
		}
		throw error;
	}
	switch (command.kind) {
		case "help":
			fullIo.stdout.write(USAGE);
			return EXIT_OK;
		case "login":
			return loginCommand(command.provider, vanrelPaths(), fullIo, log, { pasteCode: command.pasteCode });
		case "auth-status":
			return authStatusCommand(vanrelPaths(), await loadConfig(vanrelPaths().configFile, log), fullIo, log);
		case "run":
			return runCommand(command, fullIo, log);
	}
}
