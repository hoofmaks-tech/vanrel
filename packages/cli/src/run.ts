/**
 * Session driver (§4.6): --print one-shot (answer to stdout), pipe one-shot, TTY interactive (TUI).
 * Non-TTY stdin without --print: the prompt is read from stdin in full (pipe mode = one-shot).
 * SIGINT → agent abort → exit 130 — one-shot/print only; in interactive mode signals are handled
 * by InteractiveMode itself (R5); we do NOT install a global handler there (double abort otherwise).
 * EOF/empty input → exit 0; agent error state → exit 1.
 *
 * Interactive branch (W14): InteractiveHost + InteractiveMode. switchSession (/resume, /new):
 * the mode has already closed the runtime via host.close (R5) — the integrator does NOT close
 * again; it rebuilds the runtime via deps.createRuntime and re-enters. stdout streaming in
 * interactive mode is disabled on the cli.ts side (the TUI renders the stream).
 */
import type { Logger } from "@vanrel/telemetry";
import { EXIT_ERROR, EXIT_OK, EXIT_SIGINT } from "./args.ts";
import type { InteractiveHost } from "./interactive/host.ts";
import { createInteractiveHost } from "./interactive/host-impl.ts";
import { InteractiveMode, type InteractiveRunResult } from "./interactive/interactive-mode.ts";
import type { SessionRuntime } from "./wiring.ts";

export interface CliIo {
	stdin: NodeJS.ReadStream;
	stdout: NodeJS.WriteStream;
	stderr: NodeJS.WriteStream;
}

export interface InteractiveSessionDeps {
	/** Runtime recreation on switchSession: undefined → new session (/new), otherwise resume. */
	createRuntime: (sessionId?: string) => Promise<SessionRuntime>;
}

async function readStdin(stream: NodeJS.ReadStream): Promise<string> {
	let data = "";
	stream.setEncoding("utf8");
	for await (const chunk of stream) data += chunk;
	return data.trim();
}

/** One prompt → agent → text streaming to stdout. Returns errorMessage (undefined = ok). */
async function drivePrompt(runtime: SessionRuntime, text: string, log: Logger): Promise<string | undefined> {
	await runtime.session.appendUser(text);
	try {
		await runtime.agent.prompt(text);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log.error("agent run failed", { error: message });
		return message;
	}
	const errorMessage = runtime.agent.state.errorMessage;
	if (errorMessage) log.error("agent turn ended with error", { error: errorMessage });
	return errorMessage;
}

/** W14: interactive mode loop; returns the code from InteractiveRunResult (0/1/130, exit mapping in cli.ts). */
async function runInteractive(initial: SessionRuntime, deps: InteractiveSessionDeps, log: Logger): Promise<number> {
	let runtime = initial;
	for (;;) {
		let host: InteractiveHost;
		try {
			host = createInteractiveHost(runtime);
		} catch (error) {
			// A constructor throw (Proxy/subscribe, host-impl) must not go unhandled: log, idempotent
			// runtime close (the host does not exist yet, nothing else to close), and exit with error.
			log.error("interactive host creation failed", {
				error: error instanceof Error ? error.message : String(error),
			});
			await runtime.close("error").catch((closeError: unknown) => {
				log.error("runtime close failed after host creation error", {
					error: closeError instanceof Error ? closeError.message : String(closeError),
				});
			});
			return EXIT_ERROR;
		}
		let result: InteractiveRunResult;
		try {
			result = await new InteractiveMode(host).run();
		} catch (error) {
			// Defensive perimeter: the mode always resolves a code (R5); on the impossible path, close is idempotent.
			log.error("interactive mode failed", { error: error instanceof Error ? error.message : String(error) });
			await host.close("error");
			return EXIT_ERROR;
		}
		if (!result.switchSession) return result.code;
		// The runtime is ALREADY closed by the mode (shutdown → host.close) — do not close again.
		// M2: the window between the old mode's unregisterSignalHandlers and the new one's init()
		// (createRuntime takes up to ~10s with MCP startupWait): a default SIGINT would kill the
		// process past close (T5, stdio MCP orphans). Temporary handler: idempotent graceful close
		// of the old runtime + exit 130.
		const onSigintDuringSwitch = (): void => {
			log.warn("SIGINT during session switch; closing runtime and exiting");
			void runtime
				.close("user_exit")
				.catch((error: unknown) => {
					log.error("close failed on SIGINT during session switch", {
						error: error instanceof Error ? error.message : String(error),
					});
				})
				.finally(() => process.exit(EXIT_SIGINT));
		};
		process.on("SIGINT", onSigintDuringSwitch);
		try {
			runtime = await deps.createRuntime(
				result.switchSession.kind === "resume" ? result.switchSession.sessionId : undefined,
			);
		} catch (error) {
			log.error("session switch failed", { error: error instanceof Error ? error.message : String(error) });
			return EXIT_ERROR;
		} finally {
			process.removeListener("SIGINT", onSigintDuringSwitch);
		}
	}
}

export async function runSession(
	runtime: SessionRuntime,
	mode: { print?: string; interactive: boolean },
	io: CliIo,
	log: Logger,
	interactiveDeps?: InteractiveSessionDeps,
): Promise<number> {
	if (mode.interactive && io.stdin.isTTY === true) {
		if (!interactiveDeps) throw new Error("runSession: interactive TTY mode requires interactiveDeps.createRuntime");
		return runInteractive(runtime, interactiveDeps, log);
	}

	let sigint = false;
	const onSigint = () => {
		sigint = true;
		runtime.agent.abort();
	};
	process.on("SIGINT", onSigint);
	try {
		const prompt = mode.print ?? (await readStdin(io.stdin));
		if (prompt === "") {
			io.stderr.write('vanrel: empty prompt (use --print "<prompt>" or pipe stdin)\n');
			return EXIT_ERROR;
		}
		const errorMessage = await drivePrompt(runtime, prompt, log);
		if (sigint) return EXIT_SIGINT;
		io.stdout.write("\n");
		if (errorMessage) {
			io.stderr.write(`vanrel: ${errorMessage}\n`);
			return EXIT_ERROR;
		}
		return EXIT_OK;
	} finally {
		process.removeListener("SIGINT", onSigint);
	}
}
