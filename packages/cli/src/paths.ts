/**
 * vanrel filesystem layout (I1): ~/.vanrel/{sessions,traces,spill,worktrees,themes}, auth.json, quota.json, config.json.
 * VANREL_HOME overrides the root (tests, isolated runs).
 * A4 (recon interactive-vendor §3.3): APP_NAME + themesDir for the TUI theme subsystem.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export const APP_NAME = "vanrel";

export interface VanrelPaths {
	home: string;
	sessions: string;
	traces: string;
	spill: string;
	worktrees: string;
	themesDir: string;
	authFile: string;
	quotaFile: string;
	configFile: string;
}

export function vanrelPaths(env: NodeJS.ProcessEnv = process.env): VanrelPaths {
	const home = env.VANREL_HOME ?? join(homedir(), `.${APP_NAME}`);
	return {
		home,
		sessions: join(home, "sessions"),
		traces: join(home, "traces"),
		spill: join(home, "spill"),
		worktrees: join(home, "worktrees"),
		themesDir: join(home, "themes"),
		authFile: join(home, "auth.json"),
		quotaFile: join(home, "quota.json"),
		configFile: join(home, "config.json"),
	};
}
