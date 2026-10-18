// MIT License, Copyright (c) 2025 Mario Zechner
// Vendored from earendil-works/pi (packages/coding-agent/src/core/key-id-schema.ts), adapted for vanrel.
//
// Adaptation: @earendil-works/pi-tui → @vanrel/tui; no logic changes.

import { Key, type KeyId } from "@vanrel/tui";
import { type TSchemaOptions, Type } from "typebox";

const modifiers = ["ctrl", "shift", "alt", "super"] as const;
const baseKeyPattern = `(?:[a-z0-9]|${Object.values(Key)
	.flatMap((value) => (typeof value === "string" ? [value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")] : []))
	.join("|")})`;
const duplicateModifierPattern = modifiers.map((modifier) => `${modifier}\\+.*${modifier}\\+`).join("|");

export const KeyIdSchema = Type.Unsafe<KeyId>(
	Type.String({
		pattern: `^(?!.*(?:${duplicateModifierPattern}))(?:(?:${modifiers.join("|")})\\+){0,4}${baseKeyPattern}$`,
		description: "Key identifier with optional ctrl, shift, alt, or super modifiers.",
	}),
);

export function keybindingValueSchema(options?: TSchemaOptions) {
	return Type.Union([KeyIdSchema, Type.Array(KeyIdSchema)], options);
}

export const KeybindingValueSchema = keybindingValueSchema();
