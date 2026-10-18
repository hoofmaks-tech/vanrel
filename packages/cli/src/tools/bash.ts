// Fragments (notices/patterns) vendored from earendil-works/pi (MIT, © 2025 Mario Zechner), adapted.
// MERGE (recon §1): core is our `spawn sh -c` (pi shell.ts/PI_* env/spawnHook NOT ported);
// ported from pi bash.ts: OutputAccumulator streaming (rolling tail, full-output temp file
// 0600 via the vanrel- prefix), timeout validation, exit 128+signal, outputSchema/structuredContent.
// Full temp file path → details.fullOutputPath (tap T4, §3).

import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import type { AgentTool, AgentToolResult } from "@vanrel/agent";
import { type Static, Type } from "@vanrel/ai";
import { type BuiltinToolsDeps, text } from "./common.ts";
import { OutputAccumulator } from "./output-accumulator.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "./truncate.ts";

const BASH_DEFAULT_TIMEOUT_MS = 120_000;
const BASH_MAX_TIMEOUT_MS = 600_000;
/** Output limit of `structuredContent.output`, which programmatic callers receive. */
const STRUCTURED_OUTPUT_MAX_BYTES = 1024 * 1024;

/** Timeout validation (port of pi resolveTimeoutMs; units are milliseconds, our contract). */
function resolveTimeoutMs(timeout: number | undefined): number {
	if (timeout === undefined) return BASH_DEFAULT_TIMEOUT_MS;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite positive number of milliseconds");
	}
	const timeoutMs = Math.trunc(timeout);
	if (timeoutMs > BASH_MAX_TIMEOUT_MS) {
		throw new Error(`Invalid timeout: maximum is ${BASH_MAX_TIMEOUT_MS} ms`);
	}
	return timeoutMs;
}

const bashSchema = Type.Object({
	command: Type.String({ description: "Shell command (executed via sh -c)" }),
	timeout: Type.Optional(
		Type.Number({ description: `Timeout ms (default ${BASH_DEFAULT_TIMEOUT_MS}, max ${BASH_MAX_TIMEOUT_MS})` }),
	),
});

/**
 * Result for programmatic callers. A non-zero exit code is an error result for the model, but
 * scripts still resolve to this value. `output` is not limited like the model-facing output.
 */
const bashOutputSchema = Type.Object({
	output: Type.String({ description: "Combined stdout and stderr, possibly truncated" }),
	truncated: Type.Boolean(),
	full_output_path: Type.Optional(Type.String({ description: "Full output, when truncated" })),
	exit_code: Type.Number(),
	wall_time_seconds: Type.Number(),
});

export type BashToolOutput = Static<typeof bashOutputSchema>;

export function buildBashTool(deps: BuiltinToolsDeps): AgentTool<any> {
	return {
		name: "bash",
		label: "Run shell command",
		description: `Run a shell command (sh -c) with timeout. Returns combined stdout+stderr, truncated to the last 2000 lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first); if truncated, full output is saved to a temp file. Exit by signal is reported as 128+signal.`,
		parameters: bashSchema,
		outputSchema: bashOutputSchema,
		execute: (_id, rawParams, signal) => {
			const params = rawParams as Static<typeof bashSchema>; // agent loop validates against parameters
			let timeoutMs: number;
			try {
				timeoutMs = resolveTimeoutMs(params.timeout);
			} catch (error) {
				return Promise.resolve(text(error instanceof Error ? error.message : String(error), true));
			}
			return new Promise<AgentToolResult<any>>((resolvePromise) => {
				const output = new OutputAccumulator({ tempFilePrefix: "vanrel-bash" });
				const startedAt = performance.now();
				let timedOut = false;
				let aborted = false;
				let settled = false;
				let spawnError: Error | undefined;

				const finish = (code: number | null, signalCode: NodeJS.Signals | null): void => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					void settle(code, signalCode).catch((error: unknown) => {
						resolvePromise(text(`bash failed: ${error instanceof Error ? error.message : String(error)}`, true));
					});
				};

				const settle = async (code: number | null, signalCode: NodeJS.Signals | null): Promise<void> => {
					output.finish();
					const snapshot = output.snapshot({ persistIfTruncated: true });
					await output.closeTempFile();
					// A signal-killed shell has no exit code. Standard shell convention: 128 + signal number.
					const exitCode = code ?? (signalCode ? 128 + (osConstants.signals[signalCode] ?? 0) : 1);
					const truncation = snapshot.truncation;
					let body = snapshot.content || "(no output)";
					if (spawnError) body += `${body ? "\n" : ""}spawn error: ${spawnError.message}`;
					if (truncation.truncated) {
						const startLine = truncation.totalLines - truncation.outputLines + 1;
						const endLine = truncation.totalLines;
						if (truncation.lastLinePartial) {
							const lastLineSize = formatSize(output.getLastLineBytes());
							body += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
						} else if (truncation.truncatedBy === "lines") {
							body += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
						} else {
							body += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
						}
					}
					const status = aborted ? "aborted" : timedOut ? `timeout ${timeoutMs}ms` : `exit ${exitCode}`;
					body = `${body}\n[vanrel: ${status}]`;
					const wallTimeSeconds = Math.round((performance.now() - startedAt) / 100) / 10;
					const fullOutput = await output.readFullOutput(STRUCTURED_OUTPUT_MAX_BYTES);
					const structuredContent: BashToolOutput = {
						output: fullOutput.content,
						truncated: fullOutput.truncated,
						...(fullOutput.truncated && snapshot.fullOutputPath
							? { full_output_path: snapshot.fullOutputPath }
							: {}),
						exit_code: exitCode,
						wall_time_seconds: wallTimeSeconds,
					};
					// Full temp file path goes to details (raw data flows to tap T4 via wiring).
					const details: Record<string, unknown> = {
						truncation: truncation.truncated ? truncation : undefined,
						fullOutputPath: snapshot.fullOutputPath,
					};
					deps.log?.debug("bash", { command: params.command, status, bytes: body.length });
					resolvePromise({
						content: [{ type: "text", text: body }],
						details,
						structuredContent,
						isError: exitCode !== 0 || timedOut || aborted,
					});
				};

				const child = spawn("sh", ["-c", params.command], { cwd: deps.cwd, stdio: ["ignore", "pipe", "pipe"] });
				child.stdout.on("data", (chunk: Buffer) => output.append(chunk));
				child.stderr.on("data", (chunk: Buffer) => output.append(chunk));
				const timer = setTimeout(() => {
					timedOut = true;
					child.kill("SIGKILL");
				}, timeoutMs);
				const onAbort = () => {
					aborted = true;
					child.kill("SIGKILL");
				};
				if (signal?.aborted) onAbort();
				else signal?.addEventListener("abort", onAbort, { once: true });
				child.on("error", (error) => {
					spawnError = error;
					finish(null, null);
				});
				child.on("close", (code, signalCode) => finish(code, signalCode));
			});
		},
	};
}
