#!/usr/bin/env node
/**
 * The `vanrel` binary (§4.6). Entry point: parse → dispatch → exit code.
 * Unhandled exceptions: one line to stderr + exit 1 (no stack trace on the normal path).
 */
import { runCli } from "./cli.ts";

try {
	process.exitCode = await runCli(process.argv.slice(2));
} catch (error) {
	process.stderr.write(`vanrel: fatal: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
}
