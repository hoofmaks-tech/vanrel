import { backgroundAnsi, foregroundAnsi, rgbColor } from "../colors.ts";

export const VANREL_BRAND = { orange: "#FF7A00", shadow: "#782A0A" } as const;

const ORANGE = rgbColor(0xff, 0x7a, 0x00);
const SHADOW = rgbColor(0x78, 0x2a, 0x0a);
const FG: Record<FilledPixel, string> = {
	"#": foregroundAnsi(ORANGE, "truecolor"),
	".": foregroundAnsi(SHADOW, "truecolor"),
};
const BG: Record<FilledPixel, string> = {
	"#": backgroundAnsi(ORANGE, "truecolor"),
	".": backgroundAnsi(SHADOW, "truecolor"),
};
const RESET = "\x1b[0m";

type FilledPixel = "#" | ".";
type Pixel = FilledPixel | " ";

/**
 * Pixel grid extracted from vanrel-legacy/assets/vanrel-logo.svg: viewBox 174x42, 6px cells, 28 rects
 * rasterized to 29x7. "#" = orange #FF7A00, "." = shadow #782A0A, " " = empty. Row 6 is empty padding
 * so that 7 pixel rows pack into 4 terminal rows as pairs (0,1), (2,3), (4,5), (6,∅).
 */
const LOGO_GRID: readonly string[] = [
	"                         #",
	"#  # #### ###  #### #### #",
	"#  #  ..# #  # #  # #  # #",
	"#..# #### #..# #... #### #",
	"#..# #..# #..# #    #..  #..",
	" ##  #### #..# #    #### ###",
	"",
];

const LOGO_WIDTH = 29;
const WORDMARK_MIN_WIDTH = 12;
const MIN_ROWS = 8;

function pixelAt(row: number, col: number): Pixel {
	const cell = LOGO_GRID[row]?.[col];
	return cell === "#" || cell === "." ? cell : " ";
}

/**
 * One terminal line from two pixel rows. Top pixel → fg of "▀", bottom → bg; both filled with the same
 * color → "█"; only bottom filled → "▄"; both empty → space. Trailing spaces are trimmed.
 */
function renderHalfBlockLine(topRow: number, bottomRow: number): string {
	let out = "";
	let runKey = "";
	let runPrefix = "";
	let runGlyphs = "";
	const flush = (): void => {
		if (runGlyphs.length === 0) return;
		out += runKey === "" ? runGlyphs : `${runPrefix}${runGlyphs}${RESET}`;
	};
	for (let col = 0; col < LOGO_WIDTH; col++) {
		const top = pixelAt(topRow, col);
		const bottom = pixelAt(bottomRow, col);
		let glyph: string;
		let key: string;
		let prefix: string;
		if (top === " ") {
			if (bottom === " ") {
				glyph = " ";
				key = "";
				prefix = "";
			} else {
				glyph = "▄";
				key = `fg${bottom}`;
				prefix = FG[bottom];
			}
		} else if (bottom === " ") {
			glyph = "▀";
			key = `fg${top}`;
			prefix = FG[top];
		} else if (top === bottom) {
			glyph = "█";
			key = `fg${top}`;
			prefix = FG[top];
		} else {
			glyph = "▀";
			key = `fg${top}bg${bottom}`;
			prefix = FG[top] + BG[bottom];
		}
		if (key !== runKey) {
			flush();
			runKey = key;
			runPrefix = prefix;
			runGlyphs = "";
		}
		runGlyphs += glyph;
	}
	flush();
	return out.trimEnd();
}

/**
 * Pixel logo as 4 half-block terminal lines. Breakpoints:
 *   width >= 29 and rows >= 8 → full logo;
 *   12 <= width < 29 (and rows >= 8) → text wordmark "vanrel" (1 line, orange);
 *   width < 12 or rows < 8 → [] (splash suppressed).
 * rows is the available terminal height; default Infinity (CLI passes process.stdout.rows).
 */
export function renderVanrelLogo(width: number, rows: number = Number.POSITIVE_INFINITY): string[] {
	if (width < WORDMARK_MIN_WIDTH || rows < MIN_ROWS) return [];
	if (width < LOGO_WIDTH) return [`${FG["#"]}vanrel${RESET}`];
	return [renderHalfBlockLine(0, 1), renderHalfBlockLine(2, 3), renderHalfBlockLine(4, 5), renderHalfBlockLine(6, 7)];
}
