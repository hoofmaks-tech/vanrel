// MIT License, Copyright (c) 2025 Mario Zechner
// Vendored from earendil-works/pi (packages/coding-agent/src/core/tools/renderers/ls.ts), adapted for vanrel.
//
// Adaptation: pi-tui → @vanrel/tui; theme → ../../theme/theme.ts; keybinding-hints → ../../components/;
// LsToolDetails/truncate → ../../../tools/ (W9); render-utils → ../render-utils.ts;
// extensions/types.ts → ./types.ts. Image render stripped (R2).

import { Text } from "@vanrel/tui";
import type { LsToolDetails } from "../../../tools/ls.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult } from "../../../tools/truncate.ts";
import { keyHint } from "../../components/keybinding-hints.ts";
import type { Theme } from "../../theme/theme.ts";
import { getTextOutput, renderToolPath, str } from "../render-utils.ts";
import type { ToolRenderers, ToolRenderResultOptions, ToolResultContent } from "./types.ts";

function formatLsCall(args: { path?: string; limit?: number } | undefined, theme: Theme, cwd: string): string {
	const limit = args?.limit;
	const pathDisplay = renderToolPath(str(args?.path), theme, cwd, { emptyFallback: "." });
	let text = `${theme.fg("toolTitle", theme.bold("ls"))} ${pathDisplay}`;
	if (limit !== undefined) {
		text += theme.fg("toolOutput", ` (limit ${limit})`);
	}
	return text;
}
function formatLsResult(
	result: {
		content: ToolResultContent[];
		details?: LsToolDetails;
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

	const entryLimit = result.details?.entryLimitReached;
	const truncation = result.details?.truncation as TruncationResult | undefined;
	if (entryLimit || truncation?.truncated) {
		const warnings: string[] = [];
		if (entryLimit) warnings.push(`${entryLimit} entries limit`);
		if (truncation?.truncated) warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
		text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
	}
	return text;
}

export const lsRenderers: Required<Pick<ToolRenderers, "renderCall" | "renderResult">> = {
	renderCall(args, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(formatLsCall(args as { path?: string; limit?: number } | undefined, theme, context.cwd));
		return text;
	},
	renderResult(result, options, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(formatLsResult(result as { content: ToolResultContent[]; details?: LsToolDetails }, options, theme));
		return text;
	},
};
