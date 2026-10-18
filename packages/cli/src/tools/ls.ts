// MIT License, Copyright (c) 2025 Mario Zechner
// Vendored from https://github.com/earendil-works/pi (packages/coding-agent/src/core/tools/ls.ts).
// vanrel adaptation: AgentTool interface from @vanrel/agent (no ToolDefinition wrapper/renderers);
// errors are text error-results; deps.log.debug instead of renderers.

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { AgentTool, AgentToolResult } from "@vanrel/agent";
import { type Static, Type } from "@vanrel/ai";
import { type BuiltinToolsDeps, text } from "./common.ts";
import { pathExists, resolveToCwd } from "./path-utils.ts";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./truncate.ts";

const lsSchema = Type.Object({
	path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)" })),
});

export type LsToolInput = Static<typeof lsSchema>;

const DEFAULT_LIMIT = 500;

export interface LsToolDetails {
	truncation?: unknown;
	entryLimitReached?: number;
}

export function buildLsTool(deps: BuiltinToolsDeps): AgentTool<any> {
	return {
		name: "ls",
		label: "List directory",
		description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
		parameters: lsSchema,
		execute: async (_id, rawParams, signal): Promise<AgentToolResult<any>> => {
			const params = rawParams as Static<typeof lsSchema>; // agent loop validates against parameters
			if (signal?.aborted) return text("ls failed: Operation aborted", true);
			try {
				const dirPath = resolveToCwd(params.path || ".", deps.cwd);
				const effectiveLimit = params.limit ?? DEFAULT_LIMIT;

				// Check if path exists.
				if (!(await pathExists(dirPath))) {
					return text(`ls failed: Path not found: ${dirPath}`, true);
				}

				// Check if path is a directory.
				if (!(await stat(dirPath)).isDirectory()) {
					return text(`ls failed: Not a directory: ${dirPath}`, true);
				}

				// Read directory entries.
				let entries: string[];
				try {
					entries = await readdir(dirPath);
				} catch (error) {
					return text(
						`ls failed: Cannot read directory: ${error instanceof Error ? error.message : String(error)}`,
						true,
					);
				}

				// Sort alphabetically, case-insensitive.
				entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

				// Format entries with directory indicators.
				const results: string[] = [];
				let entryLimitReached = false;
				for (const entry of entries) {
					if (signal?.aborted) return text("ls failed: Operation aborted", true);
					if (results.length >= effectiveLimit) {
						entryLimitReached = true;
						break;
					}

					let suffix = "";
					try {
						if ((await stat(join(dirPath, entry))).isDirectory()) suffix = "/";
					} catch {
						// Skip entries we cannot stat.
						continue;
					}
					results.push(entry + suffix);
				}

				if (results.length === 0) {
					return text("(empty directory)");
				}

				const rawOutput = results.join("\n");
				// Apply byte truncation. There is no separate line limit because entry count is already capped.
				const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
				let output = truncation.content;
				const details: Record<string, unknown> = {};
				// Build actionable notices for truncation and entry limits.
				const notices: string[] = [];
				if (entryLimitReached) {
					notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`);
					details.entryLimitReached = effectiveLimit;
				}
				if (truncation.truncated) {
					notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
					details.truncation = truncation;
				}
				if (notices.length > 0) {
					output += `\n\n[${notices.join(". ")}]`;
				}

				deps.log?.debug("ls", { path: dirPath, entries: results.length, entryLimitReached });
				return text(output, false, Object.keys(details).length > 0 ? details : undefined);
			} catch (error) {
				return text(`ls failed: ${error instanceof Error ? error.message : String(error)}`, true);
			}
		},
	};
}
