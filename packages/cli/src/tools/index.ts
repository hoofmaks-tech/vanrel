/**
 * Builtin tools (§4.6): read / bash / edit / write / grep / glob / ls.
 * Output limits for the LLM context are applied by NoiseFilter in wiring (afterToolCall, §4.3.4);
 * only hard raw-data caps (memory/process) and pi-compatible notices are built in here.
 *
 * bash is a shell by definition (spawn sh -c) with a timeout and an OutputAccumulator (0600 temp
 * file for full output); the agent abort signal kills the process.
 *
 * QC (§4.4, optional qc.enabled): edit/write write into the ShadowWorktree (path mapping
 * via QcHooks.toWorktreePath); after every edit — PreCommitGate + OscillationGuard.
 *
 * Structure is pi-vendor (W9): truncate/output-accumulator/output-files/file-mutation-queue/
 * edit-diff are vendored with MIT headers; edit/write/ls are vendor-adapted;
 * path-utils/read/bash/grep/glob are merges of our code with pi.
 */
import type { AgentTool } from "@vanrel/agent";
import { buildBashTool } from "./bash.ts";
import type { BuiltinToolsDeps } from "./common.ts";
import { buildEditTool } from "./edit.ts";
import { buildGlobTool } from "./glob.ts";
import { buildGrepTool } from "./grep.ts";
import { buildLsTool } from "./ls.ts";
import { buildReadTool } from "./read.ts";
import { buildWriteTool } from "./write.ts";

export type { BuiltinToolsDeps, QcHooks } from "./common.ts";

export function createBuiltinTools(deps: BuiltinToolsDeps): AgentTool<any>[] {
	return [
		buildReadTool(deps),
		buildBashTool(deps),
		buildEditTool(deps),
		buildWriteTool(deps),
		buildGrepTool(deps),
		buildGlobTool(deps),
		buildLsTool(deps),
	];
}
