// MIT License, Copyright (c) 2025 Mario Zechner
// Vendored from earendil-works/pi (packages/coding-agent/src/core/slash-commands.ts), adapted for vanrel.
//
// Adaptation: APP_NAME from ../../paths.ts (A4, pi config.ts not ported); registry trimmed to
// the recon interactive-vendor §4 commands (stripped: /tree /scoped-models /import /share /bug
// /changelog /fork /clone /trust /reload); /export kept as a jsonl session copy (recon §4).
// SlashCommandSource/SlashCommandInfo dropped — extension machinery (SourceInfo/
// resource-loader not vendored). Added the "!" bash command.

import { APP_NAME } from "../../paths.ts";

export interface BuiltinSlashCommand {
	name: string;
	description: string;
	argumentHint?: string;
}

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
	{ name: "settings", description: "Open settings menu" },
	{ name: "model", description: "Select model (opens selector UI)", argumentHint: "<provider/model>" },
	{ name: "thinking", description: "Set thinking level", argumentHint: "<level>" },
	{ name: "compact", description: "Manually compact the session context" },
	{ name: "resume", description: "Resume a different session" },
	{ name: "new", description: "Start a new session" },
	{ name: "name", description: "Set session display name" },
	{ name: "session", description: "Show session info and stats" },
	{ name: "export", description: "Export session as a .jsonl copy", argumentHint: "[output.jsonl]" },
	{ name: "copy", description: "Copy last agent message to clipboard" },
	{ name: "hotkeys", description: "Show all keyboard shortcuts" },
	{ name: "login", description: "Configure provider authentication", argumentHint: "<provider>" },
	{ name: "logout", description: "Remove provider authentication" },
	{ name: "quit", description: `Quit ${APP_NAME}` },
	{
		name: "!",
		description: "Run a bash command (!! prefix excludes the output from context)",
		argumentHint: "<command>",
	},
];
