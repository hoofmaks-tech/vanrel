const DEFAULT_PLACEHOLDER = "Ask anything...";
const MAX_PLACEHOLDER_WIDTH = 75;
const GRAY = "\x1b[90m";
const INVERSE_ON = "\x1b[7m";
const INVERSE_OFF = "\x1b[27m";
const RESET = "\x1b[0m";

/**
 * Minimal empty-input prompt: placeholder text (gray, clamped to the 75-column input width) with a
 * fake cursor (\x1b[7m inverse) on its first character.
 */
export function renderPlaceholder(text: string = DEFAULT_PLACEHOLDER): string {
	const value = text.slice(0, MAX_PLACEHOLDER_WIDTH);
	if (value.length === 0) return "";
	return `${GRAY}${INVERSE_ON}${value[0]}${INVERSE_OFF}${value.slice(1)}${RESET}`;
}
