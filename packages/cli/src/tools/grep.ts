// Fragments (notices/patterns) vendored from earendil-works/pi (MIT, © 2025 Mario Zechner), adapted.
// MERGE-lite (recon §1): our dep-free JS walk stays (rg-spawn/tools-manager NOT ported);
// ported from pi grep.ts: the context/literal/ignoreCase parameters, notices format
// (`N matches limit reached. Use limit=M for more, or refine pattern`, `... Use read tool ...`),
// truncateLine for long lines, and byte-truncation of the collected output.

import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { relative, sep } from "node:path";
import type { AgentTool, AgentToolResult } from "@vanrel/agent";
import { type Static, Type } from "@vanrel/ai";
import { type BuiltinToolsDeps, globToRegExp, MAX_FILE_BYTES, text, walk } from "./common.ts";
import { resolveToCwd } from "./path-utils.ts";
import { DEFAULT_MAX_BYTES, formatSize, GREP_MAX_LINE_LENGTH, truncateHead, truncateLine } from "./truncate.ts";

const GREP_DEFAULT_LIMIT = 100;

const grepSchema = Type.Object({
	pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
	path: Type.Optional(Type.String({ description: "File or directory to search (default: current directory)" })),
	glob: Type.Optional(Type.String({ description: 'File name filter, e.g. "*.ts"' })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
	),
	context: Type.Optional(Type.Number({ description: "Lines to show before and after each match (default: 0)" })),
	limit: Type.Optional(
		Type.Number({ description: `Maximum number of matches to return (default: ${GREP_DEFAULT_LIMIT})` }),
	),
});

export interface GrepToolDetails {
	truncation?: unknown;
	matchLimitReached?: number;
	linesTruncated?: boolean;
}

function escapeRegExp(literal: string): string {
	return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function buildGrepTool(deps: BuiltinToolsDeps): AgentTool<any> {
	return {
		name: "grep",
		label: "Search content",
		description: `Search file contents for a pattern (regex or literal string), recursive. Returns \`path:line: text\` for matches and \`path-line- text\` for context lines. Output is truncated to ${GREP_DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
		parameters: grepSchema,
		execute: async (_id, rawParams, signal): Promise<AgentToolResult<any>> => {
			const params = rawParams as Static<typeof grepSchema>; // agent loop validates against parameters
			let regex: RegExp;
			try {
				regex = new RegExp(
					params.literal ? escapeRegExp(params.pattern) : params.pattern,
					params.ignoreCase ? "i" : "",
				);
			} catch (error) {
				return text(`invalid regex: ${error instanceof Error ? error.message : String(error)}`, true);
			}
			const root = resolveToCwd(params.path ?? ".", deps.cwd);
			const include = params.glob ? globToRegExp(params.glob) : undefined;
			const effectiveLimit = Math.max(1, Math.trunc(params.limit ?? GREP_DEFAULT_LIMIT));
			const contextValue = params.context && params.context > 0 ? Math.trunc(params.context) : 0;
			const outputLines: string[] = [];
			let matchCount = 0;
			let matchLimitReached = false;
			let linesTruncated = false;
			try {
				const st = await stat(root);
				const files: AsyncGenerator<string> | string[] = st.isDirectory() ? walk(root, signal) : [root];
				for await (const file of files) {
					if (signal?.aborted) break;
					const rel = relative(deps.cwd, file) || file;
					if (include && !include.test(file.split(sep).pop() ?? "")) continue;
					let content: string;
					try {
						await access(file, constants.R_OK);
						if ((await stat(file)).size > MAX_FILE_BYTES) continue;
						content = await readFile(file, "utf8");
					} catch {
						continue; // binary/unreadable files are skipped
					}
					const lines = content.split("\n");
					for (const [index, line] of lines.entries()) {
						if (!regex.test(line)) continue;
						matchCount++;
						if (matchCount > effectiveLimit) {
							matchLimitReached = true;
							break;
						}
						// Match block: context lines `rel-N- text`, match line `rel:N: text` (pi format).
						const start = contextValue > 0 ? Math.max(0, index - contextValue) : index;
						const end = contextValue > 0 ? Math.min(lines.length - 1, index + contextValue) : index;
						for (let current = start; current <= end; current++) {
							const { text: lineText, wasTruncated } = truncateLine(lines[current].replace(/\r/g, ""));
							if (wasTruncated) linesTruncated = true;
							if (current === index) outputLines.push(`${rel}:${current + 1}: ${lineText}`);
							else outputLines.push(`${rel}-${current + 1}- ${lineText}`);
						}
					}
					if (matchLimitReached) break;
				}
				deps.log?.debug("grep", { pattern: params.pattern, matches: matchCount, matchLimitReached });
				if (matchCount === 0) return text("no matches");

				// Apply byte truncation. There is no line limit here because the match limit already capped rows.
				const truncation = truncateHead(outputLines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
				let output = truncation.content;
				const details: Record<string, unknown> = {};
				// Build actionable notices for truncation and match limits (pi format).
				const notices: string[] = [];
				if (matchLimitReached) {
					notices.push(
						`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
					);
					details.matchLimitReached = effectiveLimit;
				}
				if (truncation.truncated) {
					notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
					details.truncation = truncation;
				}
				if (linesTruncated) {
					notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
					details.linesTruncated = true;
				}
				if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
				return text(output, false, Object.keys(details).length > 0 ? details : undefined);
			} catch (error) {
				return text(`grep failed: ${error instanceof Error ? error.message : String(error)}`, true);
			}
		},
	};
}
