// MIT License, Copyright (c) 2025 Mario Zechner
// Vendored from earendil-works/pi (packages/coding-agent/src/core/tools/renderers/grep.ts), adapted for vanrel.
//
// Adaptation: pi-tui → @vanrel/tui; theme → ../../theme/theme.ts; keybinding-hints → ../../components/;
// GrepToolDetails/truncate → ../../../tools/ (W9); render-utils → ../render-utils.ts;
// extensions/types.ts → ./types.ts. Image render stripped (R2).

import { Text } from "@vanrel/tui";
import type { GrepToolDetails } from "../../../tools/grep.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult } from "../../../tools/truncate.ts";
import { keyHint } from "../../components/keybinding-hints.ts";
import type { Theme } from "../../theme/theme.ts";
import { getTextOutput, invalidArgText, shortenPath, str } from "../render-utils.ts";
import type { ToolRenderers, ToolRenderResultOptions, ToolResultContent } from "./types.ts";

function formatGrepCall(
	args: { pattern: string; path?: string; glob?: string; limit?: number } | undefined,
	theme: Theme,
): string {
	const pattern = str(args?.pattern);
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
	const glob = str(args?.glob);
	const limit = args?.limit;
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold("grep")) +
		" " +
		(pattern === null ? invalidArg : theme.fg("accent", `/${pattern || ""}/`)) +
		theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	if (glob) text += theme.fg("toolOutput", ` (${glob})`);
	if (limit !== undefined) text += theme.fg("toolOutput", ` limit ${limit}`);
	return text;
}
function formatGrepResult(
	result: {
		content: ToolResultContent[];
		details?: GrepToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
): string {
	const output = getTextOutput(result).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 15;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
	}

	const matchLimit = result.details?.matchLimitReached;
	const truncation = result.details?.truncation as TruncationResult | undefined;
	const linesTruncated = result.details?.linesTruncated;
	if (matchLimit || truncation?.truncated || linesTruncated) {
		const warnings: string[] = [];
		if (matchLimit) warnings.push(`${matchLimit} matches limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		if (linesTruncated) warnings.push("some lines truncated");
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

export const grepRenderers: Required<Pick<ToolRenderers, "renderCall" | "renderResult">> = {
	renderCall(args, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(
			formatGrepCall(args as { pattern: string; path?: string; glob?: string; limit?: number } | undefined, theme),
		);
		return text;
	},
	renderResult(result, options, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(
			formatGrepResult(result as { content: ToolResultContent[]; details?: GrepToolDetails }, options, theme),
		);
		return text;
	},
};
