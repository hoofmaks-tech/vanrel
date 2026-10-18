import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileCredentialStore } from "../../src/auth/file-credential-store.ts";
import type { Credential } from "../../src/auth/gateway-types.ts";

let dir: string;
let storePath: string;
let store: FileCredentialStore;

function cred(accessToken: string, refreshToken = "rt", expiresAt = Date.now() + 3600_000): Credential {
	return {
		provider: "anthropic",
		type: "oauth",
		accessToken,
		refreshToken,
		expiresAt,
		scopes: ["user:profile"],
		accountId: "acc-1",
		extra: { subscriptionType: "pro" },
		source: { kind: "external-file", path: "/foreign/.credentials.json" },
	};
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "vanrel-store-"));
	storePath = join(dir, "auth.json");
	store = new FileCredentialStore({ path: storePath });
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

describe("FileCredentialStore (§5.5)", () => {
	it("modify → tmp+rename: file is 0600, no tmp files remain, source is not persisted", async () => {
		await store.modifyGateway("anthropic", async () => cred("at-1"));
		const raw = JSON.parse(await readFile(storePath, "utf8")) as {
			v: number;
			credentials: Record<string, Record<string, unknown>>;
		};
		expect(raw.v).toBe(1);
		const entry = raw.credentials.anthropic;
		expect(entry?.accessToken).toBe("at-1");
		expect(entry?.provider).toBe("anthropic");
		expect("source" in (entry ?? {})).toBe(false); // §5.5: without source
		expect((await stat(storePath)).mode & 0o777).toBe(0o600);
		expect((await readdir(dir)).filter((f) => f.includes(".tmp."))).toEqual([]);
	});

	it("read-back: source is restored as vanrel-store, extra fields intact", async () => {
		await store.modifyGateway("anthropic", async () => cred("at-1"));
		const back = await store.readGateway("anthropic");
		expect(back?.accessToken).toBe("at-1");
		expect(back?.source).toEqual({ kind: "vanrel-store", path: storePath });
		expect(back?.extra).toEqual({ subscriptionType: "pro" });
		expect(back?.scopes).toEqual(["user:profile"]);
	});

	it("concurrent modify calls are serialized (in-process chain): both writes applied", async () => {
		const order: string[] = [];
		const p1 = store.modifyGateway("agy", async () => {
			order.push("a-in");
			await new Promise((r) => setTimeout(r, 50));
			order.push("a-out");
			return { ...cred("ga-1"), provider: "agy" };
		});
		const p2 = store.modifyGateway("agy", async (current) => {
			order.push("b-in");
			return current ? { ...current, accessToken: "ga-2" } : undefined;
		});
		const [r1, r2] = await Promise.all([p1, p2]);
		expect(r1?.accessToken).toBe("ga-1");
		expect(r2?.accessToken).toBe("ga-2"); // fn sees the result of the first write
		expect(order).toEqual(["a-in", "a-out", "b-in"]);
		expect((await store.readGateway("agy"))?.accessToken).toBe("ga-2");
	});

	it("pi-ai CredentialStore protocol: read/list/modify/delete with field mapping", async () => {
		await store.modify("codex", async () => ({
			type: "oauth",
			access: "ca-1",
			refresh: "cr-1",
			expires: 123,
			accountId: "acc-codex",
		}));
		const read = await store.read("codex");
		expect(read).toMatchObject({
			type: "oauth",
			access: "ca-1",
			refresh: "cr-1",
			expires: 123,
			accountId: "acc-codex",
		});
		// the gateway side sees the same credential
		const gw = await store.readGateway("codex");
		expect(gw).toMatchObject({ accessToken: "ca-1", refreshToken: "cr-1", expiresAt: 123, accountId: "acc-codex" });

		expect(await store.list()).toEqual([{ providerId: "codex", type: "oauth" }]);

		// modify returning undefined → no changes
		const unchanged = await store.modify("codex", async (current) => {
			expect(current?.access).toBe("ca-1");
			return undefined;
		});
		expect(unchanged?.access).toBe("ca-1");

		await store.delete("codex");
		expect(await store.read("codex")).toBeUndefined();
		expect(await store.list()).toEqual([]);
	});

	it("legacy provider id gemini → agy: on-the-fly mapping + WARN, persist writes the canonical key", async () => {
		const warnings: string[] = [];
		const legacyStore = new FileCredentialStore({
			path: storePath,
			log: {
				debug: () => {},
				info: () => {},
				error: () => {},
				warn: (message: string) => {
					warnings.push(message);
				},
			},
		});
		const { writeFile } = await import("node:fs/promises");
		await writeFile(
			storePath,
			JSON.stringify({
				v: 1,
				credentials: {
					gemini: {
						provider: "gemini",
						type: "oauth",
						accessToken: "legacy-at",
						refreshToken: "legacy-rt",
						expiresAt: Date.now() + 3600_000,
					},
				},
			}),
		);

		const back = await legacyStore.readGateway("agy");
		expect(back?.provider).toBe("agy");
		expect(back?.accessToken).toBe("legacy-at");
		expect(warnings.some((m) => m.includes("legacy provider id"))).toBe(true);

		// modify under the canonical key sees the legacy credential; persist drops the legacy key
		await legacyStore.modifyGateway("agy", async (current) =>
			current ? { ...current, accessToken: "migrated-at" } : undefined,
		);
		const raw = JSON.parse(await readFile(storePath, "utf8")) as {
			credentials: Record<string, { accessToken?: string; provider?: string }>;
		};
		expect(raw.credentials.agy?.accessToken).toBe("migrated-at");
		expect(raw.credentials.agy?.provider).toBe("agy");
		expect(raw.credentials.gemini).toBeUndefined();
	});

	it("reading a missing/corrupt file → undefined, does not throw", async () => {
		expect(await store.readGateway("anthropic")).toBeUndefined();
		const { writeFile } = await import("node:fs/promises");
		await writeFile(storePath, "not json{");
		expect(await store.readGateway("anthropic")).toBeUndefined();
	});
});
