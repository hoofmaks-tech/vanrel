// MIT License, Copyright (c) 2025 Mario Zechner
// Vendored from https://github.com/earendil-works/pi (packages/coding-agent/src/core/tools/write.ts).
// vanrel adaptation: AgentTool interface from @vanrel/agent (no ToolDefinition wrapper/renderers);
// QC integration (§3 recon): toWorktreePath before mkdir, afterEdit after writeFile,
// all inside withFileMutationQueue.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentTool, AgentToolResult } from "@vanrel/agent";
import { type Static, Type } from "@vanrel/ai";
import { type BuiltinToolsDeps, text } from "./common.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (created with parents)" }),
	content: Type.String({ description: "Full file content" }),
});

export type WriteToolInput = Static<typeof writeSchema>;

export function buildWriteTool(deps: BuiltinToolsDeps): AgentTool<any> {
	return {
		name: "write",
		label: "Write file",
		description: "Write full file content, creating parent directories. Overwrites if the file exists.",
		parameters: writeSchema,
		execute: async (_id, rawParams, signal): Promise<AgentToolResult<any>> => {
			const params = rawParams as Static<typeof writeSchema>; // agent loop validates against parameters
			const requested = resolveToCwd(params.path, deps.cwd);
			// QC point 1: map to the shadow worktree before mkdir (§3).
			const wtPath = deps.qc?.toWorktreePath(requested);
			const abs = deps.qc && wtPath ? wtPath : requested;
			if (deps.qc && !wtPath) deps.log?.warn("qc: path outside repoRoot, writing directly", { path: requested });
			try {
				return await withFileMutationQueue(abs, async () => {
					// Do not reject from an abort event listener here: that would release the
					// mutation queue while an in-flight filesystem operation may still finish.
					// Checking signal.aborted after each await observes the same aborts while
					// keeping the queue locked until the current operation has settled.
					const throwIfAborted = (): void => {
						if (signal?.aborted) throw new Error("Operation aborted");
					};

					throwIfAborted();
					// Create parent directories if needed.
					await mkdir(dirname(abs), { recursive: true });
					throwIfAborted();

					// Write the file contents.
					await writeFile(abs, params.content, "utf-8");
					throwIfAborted();

					// QC point 2: gate after the write (§3); the [qc:ok|gate-failed|abort] format is kept.
					// M5: terminate is propagated in AgentToolResult — the agent loop aborts the batch on
					// result.terminate===true, not on text. m17: qc status in details for the TUI.
					if (deps.qc && wtPath) {
						const qcResult = await deps.qc.afterEdit();
						const header = `write staged in shadow worktree: ${abs}\n`;
						if (qcResult.terminate)
							return text(`${header}[qc:abort] ${qcResult.report}`, true, { qc: "abort" }, true);
						if (!qcResult.ok)
							return text(`${header}[qc:gate-failed]\n${qcResult.report}`, true, { qc: "gate-failed" });
						return text(`${header}[qc:ok] ${qcResult.report}`, false, { qc: "ok" });
					}

					deps.log?.debug("write", { path: abs });
					return text(`write ok: ${requested}`);
				});
			} catch (error) {
				return text(`write failed: ${error instanceof Error ? error.message : String(error)}`, true);
			}
		},
	};
}
