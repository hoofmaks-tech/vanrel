const HINTS = [
	{ key: "tab", label: "agents" },
	{ key: "ctrl+p", label: "commands" },
	{ key: "ctrl+c", label: "exit" },
] as const;

const BOLD = "\x1b[1m";
const GRAY = "\x1b[90m";
const RESET = "\x1b[0m";
const COMPACT_WIDTH = 60;

/**
 * Keyboard hint bar. Full: "tab agents   ctrl+p commands   ctrl+c exit" (3-space separator);
 * width < 60 → compact "tab ctrl+p ctrl+c". Key is bold (\x1b[1m), label gray (\x1b[90m).
 */
export function renderHintBar(width: number): string {
	if (width < COMPACT_WIDTH) {
		return HINTS.map((hint) => `${BOLD}${hint.key}${RESET}`).join(" ");
	}
	return HINTS.map((hint) => `${BOLD}${hint.key}${RESET} ${GRAY}${hint.label}${RESET}`).join("   ");
}
