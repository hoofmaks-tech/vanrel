/**
 * Lockfile protocol §5.7 (flock semantics on O_EXCL; native fs-ext is forbidden by I4).
 * Acquire: fs.open(path, "wx"); busy → poll 50ms + jitter; timeout 10s → AuthLockError.
 * Stale lock: mtime older than 60s → removal + WARN. Release: unlink in finally.
 */

import { mkdir, open, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { Logger } from "@vanrel/telemetry";
import { AuthLockError } from "./errors.ts";
import { GATEWAY_NOOP_LOGGER } from "./gateway-types.ts";

export interface FileLockOptions {
	/** Lock wait timeout, ms. Default 10_000 (§5.7). */
	timeoutMs?: number;
	/** A lock older than this age is considered stale and removed. Default 60_000 (§5.7). */
	staleMs?: number;
	/** Poll interval base, ms (+ jitter 0..pollMs). Default 50. */
	pollMs?: number;
	/** Cancels ONLY the lock wait; a held lock is released normally (§5.7 item 4). */
	signal?: AbortSignal;
	now?: () => number;
	log?: Logger;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function tryAcquire(lockPath: string, staleMs: number, now: number, log: Logger): Promise<boolean> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(lockPath, "wx");
		// Diagnostic payload (not a secret): who took the lock and when.
		await handle.writeFile(JSON.stringify({ pid: process.pid, ts: now }));
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	} finally {
		await handle?.close().catch(() => {});
	}
	// Lock is busy: stale check by mtime (crash of the previous process).
	try {
		const info = await stat(lockPath);
		if (now - info.mtimeMs > staleMs) {
			log.warn("auth lock stale, removing", { lockPath, ageMs: Math.round(now - info.mtimeMs), staleMs });
			await unlink(lockPath).catch((error: unknown) => {
				log.warn("auth lock stale unlink failed", { lockPath, error: String(error) });
			});
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		// ENOENT: lock already released between open and stat — the next iteration will acquire it.
	}
	return false;
}

/** Runs fn under the lockfile; release happens in finally (§5.7 item 6). */
export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>, options?: FileLockOptions): Promise<T> {
	const timeoutMs = options?.timeoutMs ?? 10_000;
	const staleMs = options?.staleMs ?? 60_000;
	const pollMs = options?.pollMs ?? 50;
	const now = options?.now ?? Date.now;
	const log = options?.log ?? GATEWAY_NOOP_LOGGER;
	const signal = options?.signal;

	// open(wx) fails with ENOENT when the parent directory is missing — create it upfront.
	await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
	const deadline = now() + timeoutMs;
	for (;;) {
		signal?.throwIfAborted();
		if (await tryAcquire(lockPath, staleMs, now(), log)) break;
		if (now() >= deadline) {
			throw new AuthLockError(`Timed out acquiring auth lock ${lockPath} after ${timeoutMs}ms`);
		}
		await sleep(pollMs + Math.floor(Math.random() * pollMs));
	}

	try {
		return await fn();
	} finally {
		try {
			await unlink(lockPath);
		} catch (error) {
			// §5.7 item 6: unlink error → WARN; the stale mechanism (60s) covers it.
			log.warn("auth lock release failed", { lockPath, error: String(error) });
		}
	}
}
