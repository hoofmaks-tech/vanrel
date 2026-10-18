// MIT License, Copyright (c) 2025 Mario Zechner
// Vendored from earendil-works/pi (packages/coding-agent/src/modes/interactive/components/mermaid.ts), adapted for vanrel.
//
// Adaptation: STUB. The original rendered mermaid diagrams to Unicode via the npm dep
// `grok-mermaid`, which is not vendored into vanrel. Mermaid blocks pass through as
// plain markdown code blocks (rendered as text). MermaidRenderingMode
// (Pi settings-manager) → InteractiveMermaidMode (../../config.ts, A3 SettingsFacade).
// TODO(vendor-gap): vendor grok-mermaid and restore the Unicode diagram render
//   (see .vanrel/recon/interactive-vendor.md §2b/R7), incl. off/final/streaming modes.

import type { InteractiveMermaidMode } from "../../config.ts";
import type { Theme } from "../theme/theme.ts";
import type { MarkdownTransformer } from "./markdown-transform.ts";

interface MermaidTransformerOptions {
	getMode: () => InteractiveMermaidMode;
	theme?: Theme;
}

/**
 * Stub: returns markdown unchanged, so mermaid code blocks render as plain text.
 * Kept for API compatibility with the original transformer pipeline.
 */
export function createMermaidMarkdownTransformer(_options: MermaidTransformerOptions): MarkdownTransformer {
	return (markdown) => markdown;
}
