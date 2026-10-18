// MIT License, Copyright (c) 2025 Mario Zechner
// Vendored from earendil-works/pi (packages/coding-agent/src/core/tools/renderers/find.ts), adapted for vanrel.
//
// Adaptation: the pi find-tool is replaced by glob in vanrel (packages/cli/src/tools/glob.ts, W9) —
// title/details renamed (FindToolDetails → GlobToolDetails, "find" → "glob").
// pi-tui → @vanrel/tui; theme → ../../theme/theme.ts; render-utils → ../render-utils.ts;
// extensions/types.ts → ./types.ts. Image render stripped (R2).

import { Text } from "@vanrel/tui";
import type { GlobToolDetails } from "../../../tools/glob.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult } from "../../../tools/truncate.ts";
import { keyHint } from "../../components/keybinding-hints.ts";
import type { Theme } from "../../theme/theme.ts";
import { getTextOutput, invalidArgText, shortenPath, str } from "../render-utils.ts";
import type { ToolRenderers, ToolRenderResultOptions, ToolResultContent } from "./types.ts";

function formatGlobCall(args: { pattern: string; path?: string; limit?: number } | undefined, theme: Theme): string {
	const pattern = str(args?.pattern);
	const rawPath = str(args?.path);
	const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
	const limit = args?.limit;
	const invalidArg = invalidArgText(theme);
	let text =
		theme.fg("toolTitle", theme.bold("glob")) +
		" " +
		(pattern === null ? invalidArg : theme.fg("accent", pattern || "")) +
		theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
	if (limit !== undefined) {
		text += theme.fg("toolOutput", ` (limit ${limit})`);
	}
	return text;
}
function formatGlobResult(
	result: {
		content: ToolResultContent[];
		details?: GlobToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
): string {
	const output = getTextOutput(result).trim();
	let text = "";
	if (output) {
		const lines = output.split("\n");
		const maxLines = options.expanded ? lines.length : 20;
		const displayLines = lines.slice(0, maxLines);
		const remaining = lines.length - maxLines;
		text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
	}

	const resultLimit = result.details?.resultLimitReached;
	const truncation = result.details?.truncation as TruncationResult | undefined;
	if (resultLimit || truncation?.truncated) {
		const warnings: string[] = [];
		if (resultLimit) warnings.push(`${resultLimit} results limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

export const globRenderers: Required<Pick<ToolRenderers, "renderCall" | "renderResult">> = {
	renderCall(args, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(formatGlobCall(args as { pattern: string; path?: string; limit?: number } | undefined, theme));
		return text;
	},
	renderResult(result, options, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(
			formatGlobResult(result as { content: ToolResultContent[]; details?: GlobToolDetails }, options, theme),
		);
		return text;
	},
};
