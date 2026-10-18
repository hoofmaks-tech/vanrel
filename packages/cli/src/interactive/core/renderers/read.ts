// MIT License, Copyright (c) 2025 Mario Zechner
// Vendored from earendil-works/pi (packages/coding-agent/src/core/tools/renderers/read.ts), adapted for vanrel.
//
// Adaptation: pi-tui → @vanrel/tui, pi-ai → @vanrel/ai; theme → ../../theme/theme.ts (W10);
// keybinding-hints → ../../components/; utils/paths → ../../utils/paths.ts (W5);
// path-utils/truncate/read-details → ../../../tools/ (W9); render-utils → ../render-utils.ts;
// extensions/types.ts → ./types.ts. Stripped: pi-docs classification (getPiDocsClassification,
// getReadmePath from pi config.ts — vanrel has no package-docs); image render (R2).

import { basename, dirname } from "node:path";
import type { ImageContent, TextContent } from "@vanrel/ai";
import { Text } from "@vanrel/tui";
import { resolveToCwd } from "../../../tools/path-utils.ts";
import type { ReadToolDetails } from "../../../tools/read.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "../../../tools/truncate.ts";
import { keyHint, keyText } from "../../components/keybinding-hints.ts";
import { getLanguageFromPath, highlightCode, type Theme } from "../../theme/theme.ts";
import { formatPathRelativeToCwdOrAbsolute } from "../../utils/paths.ts";
import { formatReadLineRange, getTextOutput, renderToolPath, replaceTabs, str } from "../render-utils.ts";
import type { ToolRenderers, ToolRenderResultOptions } from "./types.ts";

interface CompactReadClassification {
	kind: "resource" | "skill";
	label: string;
}
const COMPACT_RESOURCE_FILE_NAMES = new Set(["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]);
type ReadRenderArgs = { path?: string; file_path?: string; offset?: unknown; limit?: unknown };
function styledReadLineRange(args: ReadRenderArgs | undefined, theme: Theme): string {
	const range = formatReadLineRange(args?.offset, args?.limit);
	return range ? theme.fg("warning", range) : "";
}
function formatReadCall(args: ReadRenderArgs | undefined, theme: Theme, cwd: string): string {
	const pathDisplay = renderToolPath(str(args?.file_path ?? args?.path), theme, cwd);
	return `${theme.fg("toolTitle", theme.bold("read"))} ${pathDisplay}${styledReadLineRange(args, theme)}`;
}
function trimTrailingEmptyLines(lines: string[]): string[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1] === "") {
		end--;
	}
	return lines.slice(0, end);
}
function getCompactReadClassification(
	args: ReadRenderArgs | undefined,
	cwd: string,
): CompactReadClassification | undefined {
	const rawPath = str(args?.file_path ?? args?.path);
	if (!rawPath) return undefined;

	const absolutePath = resolveToCwd(rawPath, cwd);
	const fileName = basename(absolutePath);
	if (fileName === "SKILL.md") {
		return { kind: "skill", label: basename(dirname(absolutePath)) || fileName };
	}

	if (COMPACT_RESOURCE_FILE_NAMES.has(fileName)) {
		return { kind: "resource", label: formatPathRelativeToCwdOrAbsolute(absolutePath, cwd) };
	}

	return undefined;
}
function formatCompactReadCall(
	classification: CompactReadClassification,
	args: ReadRenderArgs | undefined,
	theme: Theme,
): string {
	const expandHint = theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`);
	if (classification.kind === "skill") {
		return (
			theme.fg("customMessageLabel", `\x1b[1m[skill]\x1b[22m `) +
			theme.fg("customMessageText", classification.label) +
			styledReadLineRange(args, theme) +
			expandHint
		);
	}

	return (
		theme.fg("toolTitle", theme.bold(`read ${classification.kind}`)) +
		" " +
		theme.fg("accent", classification.label) +
		styledReadLineRange(args, theme) +
		expandHint
	);
}
function formatReadResult(
	args: ReadRenderArgs | undefined,
	result: { content: (TextContent | ImageContent)[]; details?: ReadToolDetails },
	options: ToolRenderResultOptions,
	theme: Theme,
	isError: boolean,
): string {
	if (!options.expanded && !isError) {
		return "";
	}

	const rawPath = str(args?.file_path ?? args?.path);
	const output = getTextOutput(result);
	const lang = !isError && rawPath ? getLanguageFromPath(rawPath) : undefined;
	const renderedLines = lang ? highlightCode(replaceTabs(output), lang) : output.split("\n");
	const lines = trimTrailingEmptyLines(renderedLines);
	const maxLines = options.expanded ? lines.length : 10;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let text = `\n${displayLines.map((line) => (lang ? replaceTabs(line) : theme.fg("toolOutput", replaceTabs(line)))).join("\n")}`;
	if (remaining > 0) {
		text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
	}

	const truncation = result.details?.truncation;
	if (truncation?.truncated) {
		if (truncation.firstLineExceedsLimit) {
			text += `\n${theme.fg("warning", `[First line exceeds ${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit]`)}`;
		} else if (truncation.truncatedBy === "lines") {
			text += `\n${theme.fg("warning", `[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${truncation.maxLines ?? DEFAULT_MAX_LINES} line limit)]`)}`;
		} else {
			text += `\n${theme.fg("warning", `[Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)]`)}`;
		}
	}
	return text;
}

export const readRenderers: Required<Pick<ToolRenderers, "renderCall" | "renderResult">> = {
	renderCall(rawArgs, theme, context) {
		const args = rawArgs as ReadRenderArgs | undefined;
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		const classification = !context.expanded ? getCompactReadClassification(args, context.cwd) : undefined;
		text.setText(
			classification ? formatCompactReadCall(classification, args, theme) : formatReadCall(args, theme, context.cwd),
		);
		return text;
	},
	renderResult(result, options, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(
			formatReadResult(
				context.args as ReadRenderArgs | undefined,
				result as { content: (TextContent | ImageContent)[]; details?: ReadToolDetails },
				options,
				theme,
				context.isError,
			),
		);
		return text;
	},
};
