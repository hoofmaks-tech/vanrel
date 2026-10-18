// MIT License, Copyright (c) 2025 Mario Zechner
// Vendored from earendil-works/pi (packages/coding-agent/src/core/extensions/types.ts, partially), adapted for vanrel.
//
// Adaptation: renderer types only (ToolRenderContext/ToolRenderResultOptions/ToolRenderers).
// The pi extension subsystem is not vendored (recon §2c/§4); `showImages` removed from the
// context (R2: no Image in @vanrel/tui — images render as the "[image]" placeholder).

import type { Component } from "@vanrel/tui";
import type { Theme } from "../../theme/theme.ts";

/** Content block of a tool result (text or image). */
export interface ToolResultContent {
	type: string;
	text?: string;
	data?: string;
	mimeType?: string;
}

/** Tool result shape consumed by renderers (execution lives in tools/, W9). */
export interface ToolResultLike<TDetails = unknown> {
	content: ToolResultContent[];
	details?: TDetails;
	isError?: boolean;
	/** Execution time of a final result. */
	durationMs?: number;
}

/** Rendering options for tool results. */
export interface ToolRenderResultOptions {
	/** Whether the result view is expanded. */
	expanded: boolean;
	/** Whether this is a partial/streaming result. */
	isPartial: boolean;
}

/** Context passed to tool renderers. */
export interface ToolRenderContext<TState = any, TArgs = any> {
	/** Current tool call arguments. Shared across call/result renders for the same tool call. */
	args: TArgs;
	/** Unique id for this tool execution. Stable across call/result renders for the same tool call. */
	toolCallId: string;
	/** Invalidate just this tool execution component for redraw. */
	invalidate: () => void;
	/** Previously returned component for this render slot, if any. */
	lastComponent: Component | undefined;
	/** Shared renderer state for this tool row. Initialized by tool-execution.ts. */
	state: TState;
	/** Working directory for this tool execution. */
	cwd: string;
	/** Whether the tool execution has started. */
	executionStarted: boolean;
	/** Whether the tool call arguments are complete. */
	argsComplete: boolean;
	/** Whether the tool result is partial/streaming. */
	isPartial: boolean;
	/** Whether the result view is expanded. */
	expanded: boolean;
	/** Whether the current result is an error. */
	isError: boolean;
	/**
	 * Milliseconds the tool's execution took, from the final result; `undefined` while it runs, when it did not run, or
	 * for results stored before durations were recorded.
	 */
	durationMs: number | undefined;
	/** Horizontal padding configured by the outputPad setting. Renderers with `renderShell: "self"` apply it themselves. */
	outputPad: number;
}

/**
 * How a tool draws itself, without executing it. Subset of pi ToolDefinition
 * (renderShell/renderCall/renderResult); typebox schemas and execute are not needed here.
 */
export interface ToolRenderers {
	/** "default" — standard ToolExecutionComponent frame; "self" — the tool draws itself. */
	renderShell?: "default" | "self";
	/** Custom rendering for tool call display. */
	renderCall?: (args: any, theme: Theme, context: ToolRenderContext<any, any>) => Component;
	/** Custom rendering for tool result display. */
	renderResult?: (
		result: ToolResultLike<any>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: ToolRenderContext<any, any>,
	) => Component;
}
