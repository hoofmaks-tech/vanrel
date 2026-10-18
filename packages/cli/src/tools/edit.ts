// MIT License, Copyright (c) 2025 Mario Zechner
// Vendored from https://github.com/earendil-works/pi (packages/coding-agent/src/core/tools/edit.ts).
// vanrel adaptation: AgentTool interface from @vanrel/agent (no ToolDefinition wrapper/renderers);
// QC integration (§3 recon): toWorktreePath right after resolveToCwd, afterEdit after the write,
// the whole read→apply→write block inside withFileMutationQueue; details.diff/patch/firstChangedLine
// are kept in all branches (tap T4).

import { constants } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AgentTool, AgentToolResult } from "@vanrel/agent";
import { type Static, Type } from "@vanrel/ai";
import { type BuiltinToolsDeps, type QcStatus, text } from "./common.ts";
import {
	applyEditsToNormalizedContent,
	detectLineEnding,
	type Edit,
	generateDiffString,
	generateUnifiedPatch,
	normalizeToLF,
	restoreLineEndings,
	splitBom,
} from "./edit-diff.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";

const replaceEditSchema = Type.Object({
	oldText: Type.String({
		description:
			"Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
	}),
	newText: Type.String({ description: "Replacement text for this targeted edit." }),
});

const editSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	edits: Type.Array(replaceEditSchema, {
		description:
			"One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
	}),
});

export type EditToolInput = Static<typeof editSchema>;
type LegacyEditToolInput = EditToolInput & {
	oldText?: unknown;
	newText?: unknown;
};

type SingleEditInput = { oldText: string; newText: string };

function isSingleEditInput(value: unknown): value is SingleEditInput {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return false;
	}

	const edit = value as Record<string, unknown>;
	return typeof edit.oldText === "string" && typeof edit.newText === "string";
}

export interface EditToolDetails {
	/** Display-oriented diff of the changes made */
	diff: string;
	/** Standard unified patch of the changes made */
	patch: string;
	/** Line number of the first change in the new file (for editor navigation) */
	firstChangedLine?: number;
	/** QC gate status (m17: minimal marker in the TUI; the model sees [qc:*] in the text). */
	qc?: QcStatus;
}

function prepareEditArguments(input: unknown): EditToolInput {
	if (!input || typeof input !== "object") {
		return input as EditToolInput;
	}

	const args = input as Record<string, unknown>;

	// Some models send edits as a JSON string instead of an array.
	// Others send a single edit object instead of a one-element edits array.
	if (typeof args.edits === "string") {
		try {
			const parsed = JSON.parse(args.edits);
			if (Array.isArray(parsed)) {
				args.edits = parsed;
			} else if (isSingleEditInput(parsed)) {
				args.edits = [parsed];
			}
		} catch {}
	} else if (isSingleEditInput(args.edits)) {
		args.edits = [args.edits];
	}

	const legacy = args as LegacyEditToolInput;
	if (typeof legacy.oldText !== "string" || typeof legacy.newText !== "string") {
		return args as EditToolInput;
	}

	const edits = Array.isArray(legacy.edits) ? [...legacy.edits] : [];
	edits.push({ oldText: legacy.oldText, newText: legacy.newText });
	const { oldText: _oldText, newText: _newText, ...rest } = legacy;
	return { ...rest, edits } as EditToolInput;
}

function validateEditInput(input: EditToolInput): { path: string; edits: Edit[] } {
	if (!Array.isArray(input.edits) || input.edits.length === 0) {
		throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
	}
	return { path: input.path, edits: input.edits };
}

export function buildEditTool(deps: BuiltinToolsDeps): AgentTool<any> {
	return {
		name: "edit",
		label: "Edit file",
		description:
			"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
		parameters: editSchema,
		prepareArguments: prepareEditArguments,
		execute: async (_id, rawParams, signal): Promise<AgentToolResult<any>> => {
			let input: { path: string; edits: Edit[] };
			try {
				input = validateEditInput(rawParams as EditToolInput);
			} catch (error) {
				return text(`edit failed: ${error instanceof Error ? error.message : String(error)}`, true);
			}
			const { path, edits } = input;
			const requested = resolveToCwd(path, deps.cwd);
			// QC point 1: map to the shadow worktree right after resolveToCwd (§3).
			const wtPath = deps.qc?.toWorktreePath(requested);
			const abs = deps.qc && wtPath ? wtPath : requested;
			if (deps.qc && !wtPath) deps.log?.warn("qc: path outside repoRoot, writing directly", { path: requested });
			try {
				return await withFileMutationQueue(abs, async () => {
					// Do not reject from an abort event listener here: that would release the
					// mutation queue while an in-flight filesystem operation may still finish.
					// Checking signal.aborted after each await observes the same aborts while
					// keeping the queue locked until the current operation has settled.
					const throwIfAborted = (): void => {
						if (signal?.aborted) throw new Error("Operation aborted");
					};

					throwIfAborted();
					await mkdir(dirname(abs), { recursive: true });

					// Check if file exists.
					try {
						await access(abs, constants.R_OK | constants.W_OK);
					} catch (error: unknown) {
						throwIfAborted();
						const errorMessage =
							error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
						throw new Error(`Could not edit file: ${path}. ${errorMessage}.`);
					}
					throwIfAborted();

					// Read the file.
					const rawContent = (await readFile(abs)).toString("utf-8");
					throwIfAborted();

					// Strip BOM before matching. The model will not include an invisible BOM in oldText.
					const { bom, text: content } = splitBom(rawContent);
					const originalEnding = detectLineEnding(content);
					const normalizedContent = normalizeToLF(content);
					const { baseContent, newContent } = applyEditsToNormalizedContent(normalizedContent, edits, path);
					throwIfAborted();

					const finalContent = bom + restoreLineEndings(newContent, originalEnding);
					await writeFile(abs, finalContent, "utf-8");
					throwIfAborted();

					const diffResult = generateDiffString(baseContent, newContent);
					const patch = generateUnifiedPatch(path, baseContent, newContent);
					const details: Record<string, unknown> = {
						diff: diffResult.diff,
						patch,
						firstChangedLine: diffResult.firstChangedLine,
					};

					// QC point 2: gate after the write (§3); the [qc:ok|gate-failed|abort] format is kept.
					// M5: terminate is propagated in AgentToolResult — the agent loop aborts the batch on
					// result.terminate===true, not on text. m17: qc status in details for the TUI.
					if (deps.qc && wtPath) {
						const qcResult = await deps.qc.afterEdit();
						const header = `edit staged in shadow worktree: ${abs}\n`;
						if (qcResult.terminate) {
							return text(`${header}[qc:abort] ${qcResult.report}`, true, { ...details, qc: "abort" }, true);
						}
						if (!qcResult.ok) {
							return text(`${header}[qc:gate-failed]\n${qcResult.report}`, true, {
								...details,
								qc: "gate-failed",
							});
						}
						return text(`${header}[qc:ok] ${qcResult.report}`, false, { ...details, qc: "ok" });
					}

					deps.log?.debug("edit", { path: abs, edits: edits.length });
					return text(`edit ok: ${requested}`, false, details);
				});
			} catch (error) {
				return text(`edit failed: ${error instanceof Error ? error.message : String(error)}`, true);
			}
		},
	};
}
