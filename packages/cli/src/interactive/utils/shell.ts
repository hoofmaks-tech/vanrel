// MIT License, Copyright (c) 2025 Mario Zechner
// Vendored from earendil-works/pi (packages/coding-agent/src/utils/), adapted for vanrel.

/**
 * Detached child processes must be tracked so they can be killed on parent
 * shutdown signals (SIGHUP/SIGTERM).
 */
const trackedDetachedChildPids = new Set<number>();

export function trackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.add(pid);
}

export function untrackDetachedChildPid(pid: number): void {
	trackedDetachedChildPids.delete(pid);
}

export function killTrackedDetachedChildren(): void {
	for (const pid of trackedDetachedChildPids) {
		killProcessTree(pid);
	}
	trackedDetachedChildPids.clear();
}

/**
 * Kill a process and all its children.
 * Posix-only: the win32 taskkill branch and pi's shell resolution helpers
 * (getShellConfig/getShellEnv/getPowerShellConfig, getBinDir-dependent) are not vendored.
 */
export function killProcessTree(pid: number): void {
	// Use SIGKILL on Unix/Linux/Mac
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		// Fallback to killing just the child if process group kill fails
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Process already dead
		}
	}
}
