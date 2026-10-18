// MIT License, Copyright (c) 2025 Mario Zechner
// Vendored from earendil-works/pi (packages/coding-agent/src/core/tools/render-utils.ts), adapted for vanrel.
//
// Adaptation: @earendil-works/pi-ai → @vanrel/ai, @earendil-works/pi-tui → @vanrel/tui,
// theme → ../theme/theme.ts, utils → ../utils/. ToolRenderContext from pi core/extensions/types.ts
// lives in ./renderers/types.ts (renderers worker; extension subsystem not vendored, recon §4) —
// the timer functions below are typed by a minimal structural ToolTimerContext compatible with it.
// getTextOutput without showImages (R2: no image protocols, nothing to show).
// VENDOR-GAP: getImageDimensions/imageFallback — image protocols stripped from @vanrel/tui
// (recon R2); image blocks are always replaced by a text indicator.
// VENDOR-GAP: sanitizeBinaryOutput — utils/shell.ts vendored in a reduced form without it;
// local copy below.

import * as os from "node:os";
import { pathToFileURL } from "node:url";
import type { ImageContent, TextContent } from "@vanrel/ai";
import { getCapabilities, hyperlink } from "@vanrel/tui";
import type { Theme } from "../theme/theme.ts";
import { stripAnsi } from "../utils/ansi.ts";
import { resolvePath } from "../utils/paths.ts";

/**
 * Strip control characters that break TUI rendering (see pi utils/shell.ts).
 * Removes C0 controls except \t and \n, plus Unicode interlinear annotation
 * U+FFF9..U+FFFB (crashes string-width).
 */
function sanitizeBinaryOutput(str: string): string {
	// All removed characters are single UTF-16 code units, so surrogate pairs are never split.
	return str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFF9-\uFFFB]/g, "");
}

export function shortenPath(path: unknown): string {
	if (typeof path !== "string") return "";
	const home = os.homedir();
	if (path.startsWith(home)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

export function linkPath(styledText: string, rawPath: string, cwd: string): string {
	if (!getCapabilities().hyperlinks) return styledText;
	const absolutePath = resolvePath(rawPath, cwd);
	return hyperlink(styledText, pathToFileURL(absolutePath).href);
}

export function str(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null;
}

function parseLineNumber(value: unknown): number | undefined {
	if (typeof value === "string" && value.trim() !== "") value = Number(value);
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Format finite numbers or numeric strings as a read line range, omitting malformed ranges. */
export function formatReadLineRange(offset: unknown, limit: unknown): string {
	// Strict schemas represent omitted optional arguments as null.
	if (offset == null && limit == null) return "";
	const start = offset == null ? 1 : parseLineNumber(offset);
	if (start === undefined) return "";
	if (limit == null) return `:${start}`;
	const count = parseLineNumber(limit);
	if (count === undefined) return "";
	const end = start + count - 1;
	return `:${start}${end ? `-${end}` : ""}`;
}

export function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

export function normalizeDisplayText(text: string): string {
	return text.replace(/\r/g, "");
}

export function getTextOutput(
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> } | undefined,
): string {
	if (!result) return "";

	const textBlocks = result.content.filter((c) => c.type === "text");
	const imageBlocks = result.content.filter((c) => c.type === "image");

	let output = textBlocks.map((c) => sanitizeBinaryOutput(stripAnsi(c.text || "")).replace(/\r/g, "")).join("\n");

	// Image protocols are stripped from @vanrel/tui (recon R2): an image cannot be shown,
	// so image blocks are always replaced by a text indicator.
	if (imageBlocks.length > 0) {
		const imageIndicators = imageBlocks.map((img) => `[Image: ${img.mimeType ?? "image/unknown"}]`).join("\n");
		output = output ? `${output}\n${imageIndicators}` : imageIndicators;
	}

	return output;
}

export type ToolRenderResultLike<TDetails> = {
	content: (TextContent | ImageContent)[];
	details: TDetails;
};

const COLLAPSED_ARGS_CHARS = 100;

/**
 * Generic tool call header: the title followed by the arguments. Collapsed, they are `key=value`
 * pairs on the title line, cut to {@link COLLAPSED_ARGS_CHARS}. Expanded, each is a `key: value`
 * line below the title, with strings shown raw and continuation lines indented.
 */
export function formatToolCallWithArgs(title: string, args: unknown, theme: Theme, expanded: boolean): string {
	const header = theme.fg("toolTitle", theme.bold(title));
	if (args == null) return header;
	const entries =
		typeof args === "object" && !Array.isArray(args)
			? Object.entries(args)
			: ([["args", args]] as [string, unknown][]);
	if (entries.length === 0) return header;
	if (expanded) {
		const lines = entries.map(([key, value]) => {
			const text = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
			return `  ${key}: ${replaceTabs(text).replace(/\r/g, "").split("\n").join("\n    ")}`;
		});
		return `${header}\n${theme.fg("muted", lines.join("\n"))}`;
	}
	const pairs = entries.map(([key, value]) => `${key}=${JSON.stringify(value) ?? String(value)}`).join(" ");
	const preview = pairs.length > COLLAPSED_ARGS_CHARS ? `${pairs.slice(0, COLLAPSED_ARGS_CHARS - 3)}...` : pairs;
	return `${header} ${theme.fg("muted", preview)}`;
}

/** Duration as `4.2s` below a minute, then `1m 30s` and `2h 3m 4s`. */
export function formatToolDuration(ms: number): string {
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;

	const totalSeconds = Math.floor(seconds);
	const minutes = Math.floor(totalSeconds / 60);
	const remainder = totalSeconds % 60;
	if (minutes < 60) return `${minutes}m ${remainder}s`;

	return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainder}s`;
}

/** Renderer state of {@link startToolTimer} and {@link toolTimerText}, kept in `ToolRenderContext.state`. */
interface ToolTimerState {
	startedAt?: number;
	endedAt?: number;
	interval?: ReturnType<typeof setInterval>;
}

/**
 * Minimal structural timer contract — a subset of ToolRenderContext
 * (./renderers/types.ts); any pi-shaped ToolRenderContext satisfies it.
 */
export interface ToolTimerContext {
	state: ToolTimerState;
	executionStarted: boolean;
	invalidate: () => void;
	isError: boolean;
	durationMs: number | undefined;
}

/** Start the row's clock once execution starts. Call from `renderCall`. */
export function startToolTimer(context: ToolTimerContext): void {
	const state = context.state;
	if (context.executionStarted && state.startedAt === undefined) {
		state.startedAt = Date.now();
		state.endedAt = undefined;
	}
}

/**
 * The row's timing line, from `renderResult`: `Elapsed 4.2s` while the result is partial, redrawn
 * every second, and `Took 4.2s` once it is final. Undefined when the row has no start time and no
 * recorded duration.
 */
export function toolTimerText(context: ToolTimerContext, isPartial: boolean): string | undefined {
	const state = context.state;
	if (state.startedAt !== undefined && isPartial && !state.interval) {
		state.interval = setInterval(() => context.invalidate(), 1000);
	}
	if (!isPartial || context.isError) {
		state.endedAt ??= Date.now();
		if (state.interval) {
			clearInterval(state.interval);
			state.interval = undefined;
		}
	}
	// A final result's recorded duration wins: it is monotonic and survives reloads. The renderer's own clock is the
	// fallback for live progress and for results stored without one.
	if (!isPartial && context.durationMs !== undefined) return `Took ${formatToolDuration(context.durationMs)}`;
	if (state.startedAt === undefined) return undefined;
	const endTime = state.endedAt ?? Date.now();
	return `${isPartial ? "Elapsed" : "Took"} ${formatToolDuration(endTime - state.startedAt)}`;
}

export function invalidArgText(theme: Theme): string {
	return theme.fg("error", "[invalid arg]");
}

/**
 * m17: minimal QC gate-status marker from details.qc (tools/common.ts QcStatus).
 * A positive gate is otherwise invisible in the TUI: [qc:ok] is non-error text for the
 * model; only the diff (or nothing) was rendered. Error branches ([qc:gate-failed|abort])
 * are visible in the result text — not duplicated here, but the mapping stays complete
 * for direct calls.
 */
export function formatQcStatus(qc: unknown, theme: Theme): string | undefined {
	if (qc === "ok") return theme.fg("success", "[qc:ok]");
	if (qc === "gate-failed") return theme.fg("error", "[qc:gate-failed]");
	if (qc === "abort") return theme.fg("error", "[qc:abort]");
	return undefined;
}

export function renderToolPath(
	rawPath: string | null,
	theme: Theme,
	cwd: string,
	options?: { emptyFallback?: string },
): string {
	if (rawPath === null) return invalidArgText(theme);
	const value = rawPath || options?.emptyFallback;
	if (!value) return theme.fg("toolOutput", "...");
	return linkPath(theme.fg("accent", shortenPath(value)), value, cwd);
}
