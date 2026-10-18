import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import {
	renderHintBar,
	renderPlaceholder,
	renderSplashFooter,
	renderVanrelLogo,
	VANREL_BRAND,
} from "../../src/index.ts";

const FG_ORANGE = "\x1b[38;2;255;122;0m";
const FG_SHADOW = "\x1b[38;2;120;42;10m";
const BG_ORANGE = "\x1b[48;2;255;122;0m";
const BG_SHADOW = "\x1b[48;2;120;42;10m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GRAY = "\x1b[90m";

// Expected half-block rendering of the 29x7 pixel grid from vanrel-logo.svg (pairs (0,1), (2,3), (4,5), (6,∅)).
const LOGO_LINE_0 = `${FG_ORANGE}▄${RESET}  ${FG_ORANGE}▄${RESET} ${FG_ORANGE}▄▄▄▄${RESET} ${FG_ORANGE}▄▄▄${RESET}  ${FG_ORANGE}▄▄▄▄${RESET} ${FG_ORANGE}▄▄▄▄${RESET} ${FG_ORANGE}█${RESET}`;
const LOGO_LINE_1 =
	`${FG_ORANGE}█${RESET}${FG_SHADOW}▄▄${RESET}${FG_ORANGE}█${RESET} ${FG_ORANGE}▄${RESET}${FG_SHADOW}${BG_ORANGE}▀▀${RESET}${FG_ORANGE}█${RESET} ` +
	`${FG_ORANGE}█${RESET}${FG_SHADOW}▄▄${RESET}${FG_ORANGE}█${RESET} ${FG_ORANGE}█${RESET}${FG_SHADOW}▄▄${RESET}${FG_ORANGE}${BG_SHADOW}▀${RESET} ${FG_ORANGE}█▄▄█${RESET} ${FG_ORANGE}█${RESET}`;
const LOGO_LINE_2 =
	`${FG_ORANGE}▀${RESET}${FG_SHADOW}${BG_ORANGE}▀▀${RESET}${FG_ORANGE}▀${RESET} ${FG_ORANGE}█${RESET}${FG_SHADOW}${BG_ORANGE}▀▀${RESET}${FG_ORANGE}█${RESET} ` +
	`${FG_ORANGE}█${RESET}${FG_SHADOW}██${RESET}${FG_ORANGE}█${RESET} ${FG_ORANGE}█${RESET}    ${FG_ORANGE}█${RESET}${FG_SHADOW}${BG_ORANGE}▀▀${RESET}${FG_ORANGE}▄${RESET} ${FG_ORANGE}█${RESET}${FG_SHADOW}${BG_ORANGE}▀▀${RESET}`;

describe("renderVanrelLogo", () => {
	it("renders exactly 4 half-block lines at full size", () => {
		expect(renderVanrelLogo(80)).toEqual([LOGO_LINE_0, LOGO_LINE_1, LOGO_LINE_2, ""]);
	});

	it("renders full logo at the 29-column boundary", () => {
		expect(renderVanrelLogo(29)).toHaveLength(4);
	});

	it("contains the brand hex colors as truecolor ANSI parameters", () => {
		expect(VANREL_BRAND).toEqual({ orange: "#FF7A00", shadow: "#782A0A" });
		const joined = renderVanrelLogo(80).join("\n");
		expect(joined).toContain("38;2;255;122;0"); // #FF7A00 foreground
		expect(joined).toContain("38;2;120;42;10"); // #782A0A foreground
		expect(joined).toContain("48;2;255;122;0"); // #FF7A00 background
		expect(joined).toContain("48;2;120;42;10"); // #782A0A background
	});

	it("falls back to the orange wordmark for 12 <= width < 29", () => {
		const wordmark = `${FG_ORANGE}vanrel${RESET}`;
		expect(renderVanrelLogo(28)).toEqual([wordmark]);
		expect(renderVanrelLogo(12)).toEqual([wordmark]);
	});

	it("suppresses the splash below width 12 or when rows < 8", () => {
		expect(renderVanrelLogo(11)).toEqual([]);
		expect(renderVanrelLogo(0)).toEqual([]);
		expect(renderVanrelLogo(80, 7)).toEqual([]);
		expect(renderVanrelLogo(20, 7)).toEqual([]);
		expect(renderVanrelLogo(29, 8)).toHaveLength(4);
	});
});

describe("renderHintBar", () => {
	it("renders the full bar with 3-space separators, bold keys and gray labels", () => {
		const expected =
			`${BOLD}tab${RESET} ${GRAY}agents${RESET}   ` +
			`${BOLD}ctrl+p${RESET} ${GRAY}commands${RESET}   ` +
			`${BOLD}ctrl+c${RESET} ${GRAY}exit${RESET}`;
		expect(renderHintBar(80)).toBe(expected);
		expect(renderHintBar(60)).toBe(expected);
	});

	it("renders compact keys-only bar below width 60", () => {
		expect(renderHintBar(59)).toBe(`${BOLD}tab${RESET} ${BOLD}ctrl+p${RESET} ${BOLD}ctrl+c${RESET}`);
	});
});

describe("renderSplashFooter", () => {
	it("abbreviates $HOME with ~ and appends :branch", () => {
		expect(renderSplashFooter({ cwd: `${homedir()}/workspace`, branch: "main", width: 40 })).toBe(
			`${GRAY}~/workspace:main${RESET}`,
		);
	});

	it("renders the home directory itself as ~", () => {
		expect(renderSplashFooter({ cwd: homedir(), width: 40 })).toBe(`${GRAY}~${RESET}`);
	});

	it("keeps paths outside $HOME unchanged", () => {
		expect(renderSplashFooter({ cwd: "/var/log", width: 40 })).toBe(`${GRAY}/var/log${RESET}`);
	});

	it("left-truncates when the status does not fit", () => {
		expect(renderSplashFooter({ cwd: `${homedir()}/workspace/vanrel`, width: 8 })).toBe(`${GRAY}e/vanrel${RESET}`);
	});
});

describe("renderPlaceholder", () => {
	it("renders the default placeholder in gray with a fake cursor on the first character", () => {
		expect(renderPlaceholder()).toBe(`${GRAY}\x1b[7mA\x1b[27msk anything...${RESET}`);
	});

	it("renders custom text", () => {
		expect(renderPlaceholder("hello")).toBe(`${GRAY}\x1b[7mh\x1b[27mello${RESET}`);
	});

	it("clamps to the 75-column input width", () => {
		const rendered = renderPlaceholder("x".repeat(80));
		expect(rendered).toBe(`${GRAY}\x1b[7mx\x1b[27m${"x".repeat(74)}${RESET}`);
	});

	it("renders empty text as an empty string", () => {
		expect(renderPlaceholder("")).toBe("");
	});
});
