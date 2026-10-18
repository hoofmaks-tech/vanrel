// MIT License, Copyright (c) 2025 Mario Zechner
// Vendored from earendil-works/pi (packages/coding-agent/src/core/tools/renderers/index.ts), adapted for vanrel.
//
// Adaptation: vanrel built-in tool set (read/bash/edit/write/grep/glob/ls, W9);
// pi powershell not vendored, pi find → glob. extensions/types.ts → ./types.ts.

import { createShellRenderers } from "./bash.ts";
import { editRenderers } from "./edit.ts";
import { globRenderers } from "./glob.ts";
import { grepRenderers } from "./grep.ts";
import { lsRenderers } from "./ls.ts";
import { readRenderers } from "./read.ts";
import type { ToolRenderers } from "./types.ts";
import { writeRenderers } from "./write.ts";

export type { ToolRenderers };
export type { ToolRenderContext, ToolRenderResultOptions, ToolResultContent, ToolResultLike } from "./types.ts";

/** Names of vanrel built-in tools (packages/cli/src/tools/index.ts, W9). */
export type BuiltinToolName = "read" | "bash" | "edit" | "write" | "grep" | "glob" | "ls";

export {
	createShellRenderers,
	editRenderers,
	globRenderers,
	grepRenderers,
	lsRenderers,
	readRenderers,
	writeRenderers,
};

/** Renderers for every built-in tool, keyed by tool name. */
export function createAllToolRenderers(): Record<BuiltinToolName, ToolRenderers> {
	return {
		read: readRenderers,
		bash: createShellRenderers("$"),
		edit: editRenderers,
		write: writeRenderers,
		grep: grepRenderers,
		glob: globRenderers,
		ls: lsRenderers,
	};
}

/**
 * Merge built-in renderers into a tool definition that does not supply its own.
 *
 * `ToolExecutionComponent` used to do this lookup itself, which forced every presentation to import
 * the tool implementations. Callers do it now, so a process that renders can import renderers alone.
 */
export function withBuiltInRenderers<TDefinition extends ToolRenderers>(
	toolName: string,
	definition: TDefinition | undefined,
): TDefinition | ToolRenderers | undefined {
	const builtIn = createAllToolRenderers()[toolName as BuiltinToolName];
	if (!definition) return builtIn;
	if (!builtIn) return definition;
	return {
		...definition,
		renderCall: definition.renderCall ?? builtIn.renderCall,
		renderResult: definition.renderResult ?? builtIn.renderResult,
	};
}
