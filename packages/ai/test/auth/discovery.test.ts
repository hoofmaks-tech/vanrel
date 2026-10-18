import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileCredentialStore } from "../../src/auth/file-credential-store.ts";
import type { Credential } from "../../src/auth/gateway-types.ts";
import { AgyAuthProvider } from "../../src/auth/providers/agy.ts";
import { AnthropicAuthProvider } from "../../src/auth/providers/anthropic.ts";
import { CodexAuthProvider } from "../../src/auth/providers/codex.ts";
import { builtinAuthProviders, resolveAuth } from "../../src/auth/resolve-auth.ts";

const NOW = 1_900_000_000_000;
let dir: string;
let store: FileCredentialStore;
const noEnv = () => undefined;

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (payload: Record<string, unknown>) => `${b64({ alg: "none", typ: "JWT" })}.${b64(payload)}.sig`;

/** Fixture §5.2: ~/.claude/.credentials.json (claudeAiOauth wrapper) */
async function fixtureClaude(home: string, wrapped = true, refreshExpiresAt = NOW + 12 * 3600_000): Promise<string> {
	const body = {
		accessToken: "claude-access",
		refreshToken: "claude-refresh",
		expiresAt: NOW + 3600_000,
		refreshTokenExpiresAt: refreshExpiresAt,
		scopes: ["user:profile", "user:inference"],
		subscriptionType: "pro",
	};
	const path = join(home, ".claude", ".credentials.json");
	await mkdir(join(home, ".claude"), { recursive: true });
	await writeFile(path, JSON.stringify(wrapped ? { claudeAiOauth: body } : body));
	return path;
}

/** Fixture §5.3: ~/.gemini/oauth_creds.json (google-auth-library Credentials) */
async function fixtureGemini(home: string): Promise<string> {
	const path = join(home, ".gemini", "oauth_creds.json");
	await mkdir(join(home, ".gemini"), { recursive: true });
	await writeFile(
		path,
		JSON.stringify({
			access_token: "gemini-access",
			refresh_token: "gemini-refresh",
			scope: "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email",
			token_type: "Bearer",
			id_token: "gemini-id",
			expiry_date: NOW + 3600_000,
		}),
	);
	return path;
}

/** Fixture §5.4: $CODEX_HOME/auth.json */
async function fixtureCodex(
	home: string,
	authMode: string | null = "chatgpt",
	accountId: string | null = "acct-file",
): Promise<string> {
	const path = join(home, ".codex", "auth.json");
	await mkdir(join(home, ".codex"), { recursive: true });
	await writeFile(
		path,
		JSON.stringify({
			auth_mode: authMode,
			OPENAI_API_KEY: authMode === "apikey" ? "sk-paid-key" : null,
			tokens: {
				id_token: jwt({
					"https://api.openai.com/auth": { chatgpt_plan_type: "plus", chatgpt_account_id: "acct-jwt" },
				}),
				access_token: jwt({
					"https://api.openai.com/auth": { chatgpt_account_id: "acct-jwt" },
					exp: Math.floor((NOW + 3600_000) / 1000),
				}),
				refresh_token: "codex-refresh",
				account_id: accountId,
			},
			last_refresh: "2026-10-18T00:00:00Z",
		}),
	);
	return path;
}

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "vanrel-discovery-"));
	store = new FileCredentialStore({ path: join(dir, ".vanrel", "auth.json") });
});

afterEach(async () => {
	vi.unstubAllGlobals();
	await rm(dir, { recursive: true, force: true });
});

describe("discovery: anthropic (§5.2, §5.6)", () => {
	it("wrapped claudeAiOauth form (R-2) is parsed fully", async () => {
		const path = await fixtureClaude(dir);
		const p = new AnthropicAuthProvider(store, { homeDir: dir, env: noEnv, now: () => NOW });
		const cred = await p.discover();
		expect(cred).toMatchObject({
			provider: "anthropic",
			accessToken: "claude-access",
			refreshToken: "claude-refresh",
			expiresAt: NOW + 3600_000,
			refreshExpiresAt: NOW + 12 * 3600_000,
			scopes: ["user:profile", "user:inference"],
			extra: { subscriptionType: "pro" },
			source: { kind: "external-file", path },
		});
	});

	it("flat form (R-2) is also accepted", async () => {
		await fixtureClaude(dir, false);
		const p = new AnthropicAuthProvider(store, { homeDir: dir, env: noEnv, now: () => NOW });
		expect((await p.discover())?.accessToken).toBe("claude-access");
	});

	it("expired refreshTokenExpiresAt → null (provider skipped, §5.2)", async () => {
		await fixtureClaude(dir, true, NOW - 1000);
		const p = new AnthropicAuthProvider(store, { homeDir: dir, env: noEnv, now: () => NOW });
		expect(await p.discover()).toBeNull();
	});

	it("CLAUDE_CONFIG_DIR overrides the directory", async () => {
		const custom = join(dir, "claude-config");
		await fixtureClaude(custom);
		const p = new AnthropicAuthProvider(store, {
			homeDir: dir,
			env: (n) => (n === "CLAUDE_CONFIG_DIR" ? join(custom, ".claude") : undefined),
			now: () => NOW,
		});
		expect((await p.discover())?.refreshToken).toBe("claude-refresh");
	});

	it("env CLAUDE_CODE_OAUTH_TOKEN → setup-token (no refresh, far-future expiresAt)", async () => {
		const p = new AnthropicAuthProvider(store, {
			homeDir: dir,
			env: (n) => (n === "CLAUDE_CODE_OAUTH_TOKEN" ? "setup-tok" : undefined),
			now: () => NOW,
		});
		const cred = await p.discover();
		expect(cred).toMatchObject({
			accessToken: "setup-tok",
			source: { kind: "env", name: "CLAUDE_CODE_OAUTH_TOKEN" },
			extra: { setupToken: true },
		});
		expect(p.needsRefresh(cred!)).toBe(false);
	});

	it("profiles-dir: off by default; on → lexicographic iteration (R-4)", async () => {
		const profiles = join(dir, ".claude", "profiles");
		await mkdir(join(profiles, "b-work"), { recursive: true });
		await mkdir(join(profiles, "a-home"), { recursive: true });
		// no main file — profiles only
		await writeFile(
			join(profiles, "b-work", ".credentials.json"),
			JSON.stringify({ claudeAiOauth: { accessToken: "b", refreshToken: "rb", expiresAt: NOW + 3600_000 } }),
		);
		await writeFile(
			join(profiles, "a-home", ".credentials.json"),
			JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "ra", expiresAt: NOW + 3600_000 } }),
		);

		const off = new AnthropicAuthProvider(store, { homeDir: dir, env: noEnv, now: () => NOW });
		expect(await off.discover()).toBeNull(); // disabled by default

		const on = new AnthropicAuthProvider(store, {
			homeDir: dir,
			env: noEnv,
			now: () => NOW,
			config: { claudeProfilesDir: true },
		});
		expect((await on.discover())?.accessToken).toBe("a"); // lexicographically first
	});
});

describe("discovery: agy (§5.3, §5.6)", () => {
	it("oauth_creds.json → Credential (snake_case mapping)", async () => {
		const path = await fixtureGemini(dir);
		const p = new AgyAuthProvider(store, { homeDir: dir, env: noEnv, now: () => NOW });
		const cred = await p.discover();
		expect(cred).toMatchObject({
			provider: "agy",
			accessToken: "gemini-access",
			refreshToken: "gemini-refresh",
			expiresAt: NOW + 3600_000,
			idToken: "gemini-id",
			source: { kind: "external-file", path },
		});
		expect(cred?.scopes).toContain("https://www.googleapis.com/auth/cloud-platform");
	});

	it("ADC: GOOGLE_APPLICATION_CREDENTIALS service_account → JWT-bearer material", async () => {
		const adcPath = join(dir, "adc.json");
		await writeFile(
			adcPath,
			JSON.stringify({ type: "service_account", client_email: "svc@x.iam", private_key: "-----KEY-----" }),
		);
		const p = new AgyAuthProvider(store, {
			homeDir: dir,
			env: (n) => (n === "GOOGLE_APPLICATION_CREDENTIALS" ? adcPath : undefined),
			now: () => NOW,
		});
		const cred = await p.discover();
		expect(cred).toMatchObject({
			provider: "agy",
			expiresAt: 0,
			source: { kind: "env", name: "GOOGLE_APPLICATION_CREDENTIALS" },
		});
		expect((cred?.extra?.adc as Record<string, unknown>)?.kind).toBe("service_account");
	});

	it("no file and no env → null", async () => {
		const p = new AgyAuthProvider(store, { homeDir: dir, env: noEnv, now: () => NOW });
		expect(await p.discover()).toBeNull();
	});
});

describe("discovery: codex (§5.4, §5.6)", () => {
	it("chatgpt mode: full parsing, planType from id_token claim", async () => {
		const path = await fixtureCodex(dir);
		const p = new CodexAuthProvider(store, { homeDir: dir, env: noEnv, now: () => NOW });
		const cred = await p.discover();
		expect(cred).toMatchObject({
			provider: "codex",
			accessToken: expect.any(String),
			refreshToken: "codex-refresh",
			accountId: "acct-file",
			expiresAt: NOW + 3600_000,
			extra: { planType: "plus", lastRefresh: "2026-10-18T00:00:00Z" },
			source: { kind: "external-file", path },
		});
	});

	it("account_id: null → fallback to JWT claim chatgpt_account_id", async () => {
		await fixtureCodex(dir, "chatgpt", null);
		const p = new CodexAuthProvider(store, { homeDir: dir, env: noEnv, now: () => NOW });
		expect((await p.discover())?.accountId).toBe("acct-jwt");
	});

	it("auth_mode apikey → null (subscription-only, §5.8); CODEX_HOME is honored", async () => {
		const codexDir = join(dir, "custom-codex-home");
		await mkdir(codexDir, { recursive: true });
		await writeFile(
			join(codexDir, "auth.json"),
			JSON.stringify({ auth_mode: "apikey", tokens: { access_token: "x", refresh_token: "y" } }),
		);
		const p = new CodexAuthProvider(store, {
			homeDir: dir,
			env: (n) => (n === "CODEX_HOME" ? codexDir : undefined),
			now: () => NOW,
		});
		expect(await p.discover()).toBeNull();
	});

	it("auth_mode null → null", async () => {
		await fixtureCodex(dir, null);
		const p = new CodexAuthProvider(store, { homeDir: dir, env: noEnv, now: () => NOW });
		expect(await p.discover()).toBeNull();
	});
});

describe("discovery order + resolveAuth (§5.6, §4.2.2)", () => {
	it("vanrel-store wins over external files", async () => {
		await fixtureClaude(dir);
		await store.modifyGateway("anthropic", async () => ({
			provider: "anthropic",
			type: "oauth",
			accessToken: "store-wins",
			refreshToken: "sr",
			expiresAt: NOW + 3600_000,
			source: { kind: "vanrel-store", path: store.path },
		}));
		const p = new AnthropicAuthProvider(store, { homeDir: dir, env: noEnv, now: () => NOW });
		expect((await p.discover())?.accessToken).toBe("store-wins");
	});

	it("adoptExternal=false → vanrel-store only", async () => {
		await fixtureClaude(dir);
		const p = new AnthropicAuthProvider(store, { homeDir: dir, env: noEnv, now: () => NOW, adoptExternal: false });
		expect(await p.discover()).toBeNull();
	});

	it("resolveAuth: expired external → refresh (mocked fetch) → persist; skipped is not silent", async () => {
		// external claude with an EXPIRED access token but a live refresh token
		const body = {
			claudeAiOauth: {
				accessToken: "old-access",
				refreshToken: "old-refresh",
				expiresAt: NOW + 1000, // < 5 min → refresh
				refreshTokenExpiresAt: NOW + 12 * 3600_000,
			},
		};
		await mkdir(join(dir, ".claude"), { recursive: true });
		await writeFile(join(dir, ".claude", ".credentials.json"), JSON.stringify(body));
		let fetchCalls = 0;
		vi.stubGlobal("fetch", async () => {
			fetchCalls++;
			return new Response(
				JSON.stringify({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600 }),
				{
					status: 200,
				},
			);
		});

		const providers = builtinAuthProviders({
			storePath: store.path,
			homeDir: dir,
			env: noEnv,
			now: () => NOW,
		});
		const resolved = await resolveAuth({ storePath: store.path, providers, now: () => NOW });
		expect(fetchCalls).toBe(1);
		expect(resolved.byProvider.get("anthropic")?.accessToken).toBe("fresh-access");
		// copy-on-refresh: the credential landed in vanrel-store (§5.6)
		expect((await store.readGateway("anthropic"))?.refreshToken).toBe("fresh-refresh");
		// agy/codex absent → skipped with reasons (I5)
		expect(resolved.byProvider.has("agy")).toBe(false);
		expect(resolved.skipped.map((s) => s.provider).sort()).toEqual(["agy", "codex"]);
	});

	it("resolveAuth: refresh fails (revoked) → provider skipped with a reason", async () => {
		await fixtureClaude(dir, true);
		vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 }));
		const expiredStore = new FileCredentialStore({ path: store.path });
		await expiredStore.modifyGateway("anthropic", async () => ({
			provider: "anthropic",
			type: "oauth",
			accessToken: "a",
			refreshToken: "r",
			expiresAt: NOW + 1000,
			source: { kind: "vanrel-store", path: store.path },
		}));
		const providers = builtinAuthProviders({ storePath: store.path, homeDir: dir, env: noEnv, now: () => NOW });
		const resolved = await resolveAuth({ storePath: store.path, providers, now: () => NOW });
		expect(resolved.byProvider.has("anthropic")).toBe(false);
		expect(resolved.skipped.find((s) => s.provider === "anthropic")?.reason).toContain("refresh failed");
	});
});

describe("toRequestAuth (§5.1)", () => {
	it("headers and baseUrl per provider", () => {
		const cred: Credential = {
			provider: "anthropic",
			type: "oauth",
			accessToken: "tok",
			refreshToken: "r",
			expiresAt: 1,
			accountId: "acc-9",
			source: { kind: "login-flow" },
		};
		const a = new AnthropicAuthProvider(store, { env: noEnv }).toRequestAuth(cred);
		expect(a).toEqual({
			headers: { authorization: "Bearer tok", "anthropic-beta": "oauth-2025-04-20" },
			baseUrl: "https://api.anthropic.com",
		});
		const g = new AgyAuthProvider(store, { env: noEnv }).toRequestAuth(cred);
		expect(g).toEqual({ headers: { authorization: "Bearer tok" }, baseUrl: "https://cloudcode-pa.googleapis.com" });
		const c = new CodexAuthProvider(store, { env: noEnv }).toRequestAuth(cred);
		expect(c).toEqual({
			headers: { authorization: "Bearer tok", "chatgpt-account-id": "acc-9" },
			baseUrl: "https://chatgpt.com/backend-api/codex",
		});
	});
});
