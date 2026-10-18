import { homedir } from "node:os";
import { sep } from "node:path";

export interface SplashFooterOptions {
	cwd: string;
	branch?: string;
	width: number;
}

const GRAY = "\x1b[90m";
const RESET = "\x1b[0m";

/** Replace a leading $HOME with "~". */
export function abbreviateHome(path: string): string {
	const home = homedir();
	if (path === home) return "~";
	if (path.startsWith(home + sep)) return `~${path.slice(home.length)}`;
	return path;
}

/**
 * Right-side splash status: abbreviated cwd plus ":branch" when present, gray. Left-truncated
 * (rightmost columns kept) when it does not fit width.
 */
export function renderSplashFooter(options: SplashFooterOptions): string {
	let status = abbreviateHome(options.cwd);
	if (options.branch) status = `${status}:${options.branch}`;
	if (status.length > options.width) {
		status = options.width > 0 ? status.slice(status.length - options.width) : "";
	}
	return `${GRAY}${status}${RESET}`;
}
