// Vendored from pi-tui terminal-image.ts with image protocol (kitty/iterm2)
// support stripped; only truecolor/hyperlink capability detection remains.
import { execSync } from "node:child_process";
import type { TerminalColorMode } from "./colors.ts";

export interface TerminalCapabilities {
	trueColor: boolean;
	hyperlinks: boolean;
}

let cachedCapabilities: TerminalCapabilities | null = null;
let capabilityOverrides: Partial<TerminalCapabilities> = {};

/**
 * Checks whether the attached tmux client forwards OSC 8 hyperlinks to the
 * outer terminal. tmux only re-emits them when its `client_termfeatures` lists
 * `hyperlinks`, and strips them otherwise. On any error fallbacks `false`.
 */
function probeTmuxHyperlinks(): boolean {
	try {
		const termfeatures = execSync("tmux display-message -p '#{client_termfeatures}'", {
			encoding: "utf8",
			timeout: 250,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return termfeatures
			.split(",")
			.map((feature) => feature.trim())
			.includes("hyperlinks");
	} catch {
		return false;
	}
}

function detectCapabilitiesFromEnvironment(tmuxForwardsHyperlink: () => boolean): TerminalCapabilities {
	const termProgram = process.env.TERM_PROGRAM?.toLowerCase() || "";
	const terminalEmulator = process.env.TERMINAL_EMULATOR?.toLowerCase() || "";
	const term = process.env.TERM?.toLowerCase() || "";
	const colorTerm = process.env.COLORTERM?.toLowerCase() || "";
	const hasTrueColorHint = colorTerm === "truecolor" || colorTerm === "24bit" || term.endsWith("-direct");
	const isWindowsConsole = process.platform === "win32";

	// Emit OSC 8 hyperlinks only when tmux confirms it forwards.
	if (process.env.TMUX || term.startsWith("tmux")) {
		return { trueColor: hasTrueColorHint, hyperlinks: tmuxForwardsHyperlink() };
	}

	// screen does not forward OSC 8 hyperlinks, so keep them off there.
	if (term.startsWith("screen")) {
		return { trueColor: hasTrueColorHint, hyperlinks: false };
	}

	if (termProgram === "herdr") {
		return { trueColor: hasTrueColorHint, hyperlinks: true };
	}

	if (process.env.KITTY_WINDOW_ID || termProgram === "kitty") {
		return { trueColor: true, hyperlinks: true };
	}

	if (termProgram === "ghostty" || term.includes("ghostty") || process.env.GHOSTTY_RESOURCES_DIR) {
		return { trueColor: true, hyperlinks: true };
	}

	if (process.env.WEZTERM_PANE || termProgram === "wezterm") {
		return { trueColor: true, hyperlinks: true };
	}

	if (termProgram === "warpterminal" || process.env.WARP_SESSION_ID || process.env.WARP_TERMINAL_SESSION_UUID) {
		return { trueColor: true, hyperlinks: true };
	}

	if (process.env.ITERM_SESSION_ID || termProgram === "iterm.app") {
		return { trueColor: true, hyperlinks: true };
	}

	if (process.env.WT_SESSION) {
		return { trueColor: true, hyperlinks: true };
	}

	if (termProgram === "alacritty" || termProgram === "vscode" || termProgram === "zed") {
		return { trueColor: true, hyperlinks: true };
	}

	if (terminalEmulator === "jetbrains-jediterm") {
		return { trueColor: true, hyperlinks: false };
	}

	// Windows Terminal does not always set WT_SESSION, for example when it hosts
	// a cmd.exe launched directly from Win+R. Modern Windows consoles support
	// truecolor; keep hyperlinks off unless we positively detected support above.
	if (isWindowsConsole) {
		return { trueColor: true, hyperlinks: false };
	}

	// Unknown terminal: be conservative. OSC 8 is rendered invisibly as "just
	// text" on terminals that swallow it, which means the URL disappears from
	// the rendered output. Default to the legacy `text (url)` behavior unless we
	// have positively identified a hyperlink-capable terminal above.
	return { trueColor: hasTrueColorHint, hyperlinks: false };
}

function parseBooleanCapabilityOverride(value: string | undefined): boolean | undefined {
	return value === "1" ? true : value === "0" ? false : undefined;
}

export function detectCapabilities(tmuxForwardsHyperlink: () => boolean = probeTmuxHyperlinks): TerminalCapabilities {
	const hyperlinks = parseBooleanCapabilityOverride(process.env.PI_HYPERLINKS);
	const detected = detectCapabilitiesFromEnvironment(
		hyperlinks === undefined ? tmuxForwardsHyperlink : () => hyperlinks,
	);
	const trueColor = parseBooleanCapabilityOverride(process.env.PI_TRUE_COLOR);
	return {
		...detected,
		...(trueColor !== undefined ? { trueColor } : {}),
		...(hyperlinks !== undefined ? { hyperlinks } : {}),
	};
}

export function getCapabilities(): TerminalCapabilities {
	if (!cachedCapabilities) {
		const hyperlinks = capabilityOverrides.hyperlinks;
		cachedCapabilities = {
			...detectCapabilities(hyperlinks === undefined ? undefined : () => hyperlinks),
			...capabilityOverrides,
		};
	}
	return cachedCapabilities;
}

export function getTerminalColorMode(capabilities: TerminalCapabilities = getCapabilities()): TerminalColorMode {
	return capabilities.trueColor ? "truecolor" : "256color";
}

export function resetCapabilitiesCache(): void {
	cachedCapabilities = null;
}

/** Override selected auto-detected capabilities. */
export function setCapabilityOverrides(overrides: Partial<TerminalCapabilities>): void {
	if (
		capabilityOverrides.trueColor === overrides.trueColor &&
		capabilityOverrides.hyperlinks === overrides.hyperlinks
	) {
		return;
	}
	capabilityOverrides = { ...overrides };
	cachedCapabilities = null;
}

/** Override the cached capabilities. Useful in tests to exercise both code paths. */
export function setCapabilities(caps: TerminalCapabilities): void {
	cachedCapabilities = caps;
}

/**
 * Wraps text in an OSC 8 hyperlink escape sequence. Supported by most modern terminals
 * (Ghostty, Kitty, WezTerm, iTerm2, VSCode, and others).
 * In terminals that do not support OSC 8, the escape sequences are ignored
 * and only the plain text is displayed.
 *
 * @param text - The visible text to display
 * @param url - The URL to link to
 */
export function hyperlink(text: string, url: string): string {
	return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}
