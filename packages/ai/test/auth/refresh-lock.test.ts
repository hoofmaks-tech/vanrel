import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthLockError } from "../../src/auth/errors.ts";
import { FileCredentialStore } from "../../src/auth/file-credential-store.ts";
import type { Credential } from "../../src/auth/gateway-types.ts";
import { AnthropicAuthProvider } from "../../src/auth/providers/anthropic.ts";

let dir: string;
let storePath: string;
let lockPath: string;
let store: FileCredentialStore;
let provider: AnthropicAuthProvider;
const NOW = 1_900_000_000_000;

/** expired credential (expiresAt − now < 5 min → needsRefresh true) */
function expiredCred(refreshToken = "rt-old"): Credential {
	return {
		provider: "anthropic",
		type: "oauth",
		accessToken: "at-old",
		refreshToken,
		expiresAt: NOW + 60_000,
		source: { kind: "external-file", path: join(dir, ".claude", ".credentials.json") },
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "vanrel-lock-"));
	storePath = join(dir, "auth.json");
	lockPath = `${storePath}.lock`;
	// store — real clock (lock deadline/poll run on wall-clock),
	// provider — injected NOW (needsRefresh/expiresAt are deterministic).
	store = new FileCredentialStore({ path: storePath, lockTimeoutMs: 400 });
	provider = new AnthropicAuthProvider(store, { homeDir: dir, env: () => undefined, now: () => NOW });
});

afterEach(async () => {
	vi.unstubAllGlobals();
	await rm(dir, { recursive: true, force: true });
});

describe("refresh lockfile (§5.7)", () => {
	it("two concurrent refreshes → exactly one HTTP; rotation persisted before unlock", async () => {
		let fetchCalls = 0;
		let lockHeldDuringHttp = false;
		let rotatedPersistedDuringHttp = true;
		vi.stubGlobal("fetch", async () => {
			fetchCalls++;
			// During HTTP: the lock is held, the rotated token is NOT on disk yet.
			lockHeldDuringHttp = await stat(lockPath).then(
				() => true,
				() => false,
			);
			const disk = await readFile(storePath, "utf8").catch(() => "");
			rotatedPersistedDuringHttp = disk.includes("rt-rotated");
			await new Promise((r) => setTimeout(r, 30));
			return jsonResponse({ access_token: "at-new", refresh_token: "rt-rotated", expires_in: 3600 });
		});

		const [r1, r2] = await Promise.all([provider.refresh(expiredCred()), provider.refresh(expiredCred())]);
		expect(fetchCalls).toBe(1); // post-lock double-check of the second: needsRefresh already false
		expect(r1.accessToken).toBe("at-new");
		expect(r2.accessToken).toBe("at-new");
		expect(lockHeldDuringHttp).toBe(true);
		expect(rotatedPersistedDuringHttp).toBe(false);

		// After unlock: rotation on disk, lock released.
		const disk = JSON.parse(await readFile(storePath, "utf8")) as {
			credentials: { anthropic: { refreshToken: string; accessToken: string } };
		};
		expect(disk.credentials.anthropic.refreshToken).toBe("rt-rotated");
		expect(disk.credentials.anthropic.accessToken).toBe("at-new");
		await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("lock held longer than timeoutMs → AuthLockError", async () => {
		await writeFile(lockPath, "{}");
		vi.stubGlobal("fetch", async () => {
			throw new Error("must not be called");
		});
		await expect(provider.refresh(expiredCred())).rejects.toBeInstanceOf(AuthLockError);
		await expect(provider.refresh(expiredCred())).rejects.toMatchObject({ name: "AuthLockError", kind: "auth-lock" });
	});

	it("stale lock (mtime > 60s) is removed, refresh proceeds", async () => {
		await writeFile(lockPath, "{}");
		const old = new Date(Date.now() - 61_000); // older than staleMs=60s (§5.7)
		await utimes(lockPath, old, old);
		vi.stubGlobal("fetch", async () =>
			jsonResponse({ access_token: "at-stale-win", refresh_token: "rt-stale", expires_in: 3600 }),
		);
		const result = await provider.refresh(expiredCred());
		expect(result.accessToken).toBe("at-stale-win");
		await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("fresh credential in store under lock → no HTTP performed (double-check)", async () => {
		await store.modifyGateway("anthropic", async () => ({
			...expiredCred("rt-fresh"),
			accessToken: "at-fresh",
			expiresAt: NOW + 3600_000, // fresh: refresh not needed
		}));
		vi.stubGlobal("fetch", async () => {
			throw new Error("must not be called");
		});
		const result = await provider.refresh(expiredCred());
		expect(result.accessToken).toBe("at-fresh"); // the store is authoritative over the passed cred
	});
});
