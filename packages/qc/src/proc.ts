/**
 * Wrapper over child_process.execFile: no shell, timeout, optional stdin and AbortSignal.
 * A non-zero exit code is DATA (resolve with code), not an exception: gates and git
 * commands decide how to interpret the code themselves. Reject only on spawn error /
 * timeout / abort.
 */
import { execFile } from "node:child_process";

export interface RunResult {
	stdout: string;
	stderr: string;
	code: number;
}

export interface RunOptions {
	cwd: string;
	input?: string;
	timeoutMs: number;
	signal?: AbortSignal;
	env?: NodeJS.ProcessEnv;
	maxBuffer?: number;
}

const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

export function runCommand(cmd: string, args: readonly string[], opts: RunOptions): Promise<RunResult> {
	return new Promise<RunResult>((resolvePromise, rejectPromise) => {
		const child = execFile(
			cmd,
			[...args],
			{
				cwd: opts.cwd,
				timeout: opts.timeoutMs,
				killSignal: "SIGTERM",
				maxBuffer: opts.maxBuffer ?? DEFAULT_MAX_BUFFER,
				signal: opts.signal,
				env: opts.env,
				encoding: "utf8",
				shell: false,
				windowsHide: true,
			},
			(error, stdout, stderr) => {
				if (error === null) {
					resolvePromise({ stdout, stderr, code: 0 });
					return;
				}
				// The process exited with a non-zero code — a valid outcome, returned as data.
				if (typeof error.code === "number") {
					resolvePromise({ stdout, stderr, code: error.code });
					return;
				}
				// ENOENT spawn / timeout (killed) / abort / maxBuffer — an infrastructure failure.
				rejectPromise(error);
			},
		);
		if (opts.input !== undefined && child.stdin !== null) {
			// The process may exit before we finish writing (apply --check) — EPIPE is ignored,
			// the final verdict still arrives via the exit code in the callback above.
			child.stdin.on("error", () => {});
			child.stdin.write(opts.input);
			child.stdin.end();
		}
	});
}
