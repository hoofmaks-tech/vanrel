// MIT License, Copyright (c) 2025 Mario Zechner
// Vendored from earendil-works/pi (packages/coding-agent/src/core/tools/renderers/bash.ts), adapted for vanrel.
//
// Adaptation: pi-tui → @vanrel/tui; theme/keybinding-hints/visual-truncate → ../../{theme,components}/;
// render-utils → ../render-utils.ts; truncate → ../../../tools/truncate.ts (W9);
// extensions/types.ts → ./types.ts. Image render stripped (R2) — getTextOutput without showImages.
// powershell variant not vendored (vanrel has bash only); createShellRenderers kept
// parameterized by prompt for compatibility with the pi shape.

import { Container, Spacer, Text } from "@vanrel/tui";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult } from "../../../tools/truncate.ts";
import { keyHint } from "../../components/keybinding-hints.ts";
import { VisualLinePreview } from "../../components/visual-truncate.ts";
import { theme } from "../../theme/theme.ts";
import { getTextOutput, invalidArgText, startToolTimer, str, toolTimerText } from "../render-utils.ts";
import type { ToolRenderers, ToolRenderResultOptions, ToolResultContent } from "./types.ts";

/** details returned by our bash-tool (packages/cli/src/tools/bash.ts, W9). */
export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

const BASH_PREVIEW_LINES = 5;
export const BASH_UPDATE_THROTTLE_MS = 100;
function formatShellCall(args: { command?: string; timeout?: number } | undefined, prompt: string): string {
	const command = str(args?.command);
	const timeout = args?.timeout as number | undefined;
	const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
	const commandDisplay = command === null ? invalidArgText(theme) : command ? command : theme.fg("toolOutput", "...");
	return theme.fg("toolTitle", theme.bold(`${prompt} ${commandDisplay}`)) + timeoutSuffix;
}
function rebuildBashResultRenderComponent(
	component: Container,
	result: {
		content: ToolResultContent[];
		details?: BashToolDetails;
	},
	options: ToolRenderResultOptions,
	timerText: string | undefined,
): void {
	component.clear();

	let output = getTextOutput(result).trim();
	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	if (!options.isPartial && truncation?.truncated && fullOutputPath && output.endsWith("]")) {
		const footerStart = output.lastIndexOf("\n\n[");
		if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
			output = output.slice(0, footerStart).trimEnd();
		}
	}

	if (output) {
		const styledOutput = output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");

		if (options.expanded) {
			component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		} else {
			component.addChild(new Spacer(1));
			component.addChild(
				new VisualLinePreview({
					text: styledOutput,
					maxVisualLines: BASH_PREVIEW_LINES,
					keep: "end",
					formatHint: (hidden) =>
						theme.fg("muted", `... (${hidden} earlier lines,`) +
						` ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`,
				}),
			);
		}
	}

	if (truncation?.truncated || fullOutputPath) {
		const warnings: string[] = [];
		if (fullOutputPath) {
			warnings.push(`Full output: ${fullOutputPath}`);
		}
		if (truncation?.truncated) {
			if (truncation.truncatedBy === "lines") {
				warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
			} else {
				warnings.push(
					`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
				);
			}
		}
		component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
	}

	if (timerText) component.addChild(new Text(`\n${theme.fg("muted", timerText)}`, 0, 0));
}

/** Shell renderers; shared for bash/powershell in pi, bash only in vanrel (prompt "$"). */
export function createShellRenderers(prompt: string): Required<Pick<ToolRenderers, "renderCall" | "renderResult">> {
	return {
		renderCall(args, _theme, context) {
			startToolTimer(context);
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatShellCall(args as { command?: string; timeout?: number } | undefined, prompt));
			return text;
		},
		renderResult(result, options, _theme, context) {
			const timerText = toolTimerText(context, options.isPartial);
			const component = (context.lastComponent as Container | undefined) ?? new Container();
			rebuildBashResultRenderComponent(component, result, options, timerText);
			component.invalidate();
			return component;
		},
	};
}
