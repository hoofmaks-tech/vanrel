// Fragments (notices/patterns) vendored from earendil-works/pi (MIT, © 2025 Mario Zechner), adapted.
// MERGE (recon §1): our read (`<n>:` numbering kept) + ported from pi read.ts:
// truncateHead with continuation notices ("Use offset=N to continue") and the
// firstLineExceedsLimit hint (bash fallback). Images are NOT ported (no image pipeline).

import { readFile } from "node:fs/promises";
import type { AgentTool, AgentToolResult } from "@vanrel/agent";
import { type Static, Type } from "@vanrel/ai";
import { assertFile, type BuiltinToolsDeps, text } from "./common.ts";
import { resolveReadPathAsync } from "./path-utils.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

const readSchema = Type.Object({
	path: Type.String({ description: "File path (absolute or relative to cwd)" }),
	offset: Type.Optional(Type.Number({ description: "First line to read, 1-based (default 1)" })),
	limit: Type.Optional(Type.Number({ description: "Max lines to read (default all)" })),
});

export interface ReadToolDetails {
	path: string;
	totalLines: number;
	truncation?: TruncationResult;
}

export function buildReadTool(deps: BuiltinToolsDeps): AgentTool<any> {
	return {
		name: "read",
		label: "Read file",
		description: `Read a text file. Returns lines as \`<n>: <content>\`; use offset/limit for slices. Output is truncated to 2000 lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first); continue with offset until complete.`,
		parameters: readSchema,
		execute: async (_id, rawParams): Promise<AgentToolResult<any>> => {
			const params = rawParams as Static<typeof readSchema>; // agent loop validates against parameters
			try {
				// macOS name variants (NFD/curly-quote/narrow NBSP) — from path-utils, read-only.
				const abs = await resolveReadPathAsync(params.path, deps.cwd);
				await assertFile(abs);
				const allLines = (await readFile(abs, "utf8")).split("\n");
				const totalFileLines = allLines.length;
				const from = Math.max(1, Math.trunc(params.offset ?? 1));
				const slice = allLines.slice(
					from - 1,
					params.limit === undefined ? undefined : from - 1 + Math.trunc(params.limit),
				);
				const numbered = slice.map((line, i) => `${from + i}: ${line}`).join("\n");
				const details: Record<string, unknown> = { path: abs, totalLines: totalFileLines };
				let body: string;
				if (numbered === "") {
					body = "(empty slice)";
				} else {
					// truncateHead over the numbered text; notices follow the pi read.ts format.
					const truncation = truncateHead(numbered);
					if (truncation.firstLineExceedsLimit) {
						// First line alone exceeds the byte limit. Point the model at a bash fallback.
						const firstLine = numbered.split("\n")[0];
						const firstLineSize = formatSize(Buffer.byteLength(firstLine, "utf-8"));
						body = `[Line ${from} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${from}p' ${params.path} | head -c ${DEFAULT_MAX_BYTES}]`;
						details.truncation = truncation;
					} else if (truncation.truncated) {
						// Truncation occurred. Build an actionable continuation notice.
						const endLineDisplay = from + truncation.outputLines - 1;
						const nextOffset = endLineDisplay + 1;
						body = truncation.content;
						if (truncation.truncatedBy === "lines") {
							body += `\n\n[Showing lines ${from}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
						} else {
							body += `\n\n[Showing lines ${from}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
						}
						details.truncation = truncation;
					} else if (params.limit !== undefined && from - 1 + slice.length < allLines.length) {
						// User-specified limit stopped early, but the file still has more content.
						const remaining = allLines.length - (from - 1 + slice.length);
						const nextOffset = from + slice.length;
						body = `${numbered}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
					} else {
						body = numbered;
					}
				}
				deps.log?.debug("read", { path: abs, lines: slice.length });
				return text(body, false, details);
			} catch (error) {
				return text(`read failed: ${error instanceof Error ? error.message : String(error)}`, true);
			}
		},
	};
}
