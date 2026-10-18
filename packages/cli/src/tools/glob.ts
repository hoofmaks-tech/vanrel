// Fragments (notices/patterns) vendored from earendil-works/pi (MIT, © 2025 Mario Zechner), adapted.
// MERGE-lite (recon §1): our dep-free glob (walk + globToRegExp) stays (pi fd/ensureTool are
// NOT ported — runtime network download); ported from pi find.ts: the limit parameter,
// notices format, byte-truncation of the collected output; posix path normalization was already here.

import { stat } from "node:fs/promises";
import { relative, sep } from "node:path";
import type { AgentTool, AgentToolResult } from "@vanrel/agent";
import { type Static, Type } from "@vanrel/ai";
import { type BuiltinToolsDeps, globToRegExp, text, walk } from "./common.ts";
import { resolveToCwd } from "./path-utils.ts";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./truncate.ts";

const GLOB_DEFAULT_LIMIT = 1000;

const globSchema = Type.Object({
	pattern: Type.String({ description: 'Glob pattern, e.g. "src/**/*.ts" (supports **, *, ?, {a,b})' }),
	path: Type.Optional(Type.String({ description: "Base directory (default cwd)" })),
	limit: Type.Optional(Type.Number({ description: `Maximum number of results (default: ${GLOB_DEFAULT_LIMIT})` })),
});

export interface GlobToolDetails {
	truncation?: unknown;
	resultLimitReached?: number;
}

export function buildGlobTool(deps: BuiltinToolsDeps): AgentTool<any> {
	return {
		name: "glob",
		label: "Find files",
		description: `Find files by glob pattern relative to a base directory. Returns relative paths (posix separators), sorted. Output is truncated to ${GLOB_DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
		parameters: globSchema,
		execute: async (_id, rawParams, signal): Promise<AgentToolResult<any>> => {
			const params = rawParams as Static<typeof globSchema>; // agent loop validates against parameters
			const root = resolveToCwd(params.path ?? ".", deps.cwd);
			const effectiveLimit = Math.max(1, Math.trunc(params.limit ?? GLOB_DEFAULT_LIMIT));
			let matcher: RegExp;
			try {
				matcher = globToRegExp(params.pattern);
			} catch (error) {
				return text(`invalid glob: ${error instanceof Error ? error.message : String(error)}`, true);
			}
			try {
				if (!(await stat(root)).isDirectory()) return text(`not a directory: ${root}`, true);
				const matches: string[] = [];
				for await (const file of walk(root, signal)) {
					if (signal?.aborted) break;
					const rel = relative(root, file).split(sep).join("/"); // posix normalization (pi find.ts)
					if (matcher.test(rel)) matches.push(rel);
					if (matches.length >= effectiveLimit) break;
				}
				matches.sort();
				deps.log?.debug("glob", { pattern: params.pattern, matches: matches.length });
				if (matches.length === 0) return text("no matches");

				const resultLimitReached = matches.length >= effectiveLimit;
				const truncation = truncateHead(matches.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
				let output = truncation.content;
				const details: Record<string, unknown> = {};
				// Build actionable notices for result and byte limits (pi format).
				const notices: string[] = [];
				if (resultLimitReached) {
					notices.push(
						`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
					);
					details.resultLimitReached = effectiveLimit;
				}
				if (truncation.truncated) {
					notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
					details.truncation = truncation;
				}
				if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
				return text(output, false, Object.keys(details).length > 0 ? details : undefined);
			} catch (error) {
				return text(`glob failed: ${error instanceof Error ? error.message : String(error)}`, true);
			}
		},
	};
}
