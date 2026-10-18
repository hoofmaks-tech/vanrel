/**
 * Splash (§4.5): logo + hint bar + footer + placeholder on interactive start in a TTY.
 * Suppressed outside a TTY or with --no-splash. Pure assembly (tested with mocked cols/rows).
 */
import { renderHintBar, renderPlaceholder, renderSplashFooter, renderVanrelLogo } from "@vanrel/tui";

export interface SplashInput {
	cols: number;
	rows: number;
	cwd: string;
}

/** Splash screen lines; [] means the splash is suppressed by logo breakpoints (§4.5). */
export function buildSplashLines(input: SplashInput): string[] {
	const logo = renderVanrelLogo(input.cols, input.rows);
	if (logo.length === 0) return [];
	return [
		...logo,
		"",
		renderHintBar(input.cols),
		renderSplashFooter({ cwd: input.cwd, width: input.cols }),
		"",
		renderPlaceholder(),
	];
}

/** Interactive TTY without --no-splash (§4.6). */
export function shouldShowSplash(options: { noSplash: boolean; isTty: boolean }): boolean {
	return options.isTty && !options.noSplash;
}
