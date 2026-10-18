// MIT License, Copyright (c) 2025 Mario Zechner
// Vendored from earendil-works/pi (packages/coding-agent/src/modes/interactive/components/dynamic-border.ts), adapted for vanrel.
//
// Adaptation: @earendil-works/pi-tui → @vanrel/tui; theme → ../theme/theme.ts.

import type { Component } from "@vanrel/tui";
import { theme } from "../theme/theme.ts";

/**
 * Dynamic border component that adjusts to viewport width.
 *
 * Note: When used from extensions loaded via jiti, the global `theme` may be undefined
 * because jiti creates a separate module cache. Always pass an explicit color
 * function when using DynamicBorder in components exported for extension use.
 */
export class DynamicBorder implements Component {
	private color: (str: string) => string;

	constructor(color: (str: string) => string = (str) => theme.fg("border", str)) {
		this.color = color;
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): string[] {
		return [this.color("─".repeat(Math.max(1, width)))];
	}
}
