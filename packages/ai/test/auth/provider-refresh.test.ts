import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthFlowError } from "../../src/auth/errors.ts";
import { FileCredentialStore } from "../../src/auth/file-credential-store.ts";
import type { Credential } from "../../src/auth/gateway-types.ts";
import { AgyAuthProvider } from "../../src/auth/providers/agy.ts";
import { AnthropicAuthProvider } from "../../src/auth/providers/anthropic.ts";
import { CodexAuthProvider } from "../../src/auth/providers/codex.ts";

const NOW = 1_900_000_000_000;
let dir: string;
let store: FileCredentialStore;

function baseCred(provider: Credential["provider"], extra?: Record<string, unknown>): Credential {
	return {
		provider,
		type: "oauth",
		accessToken: "at-old",
		refreshToken: "rt-old",
		expiresAt: NOW + 60_000, // < 5 min → refresh
		source: { kind: "external-file", path: "/foreign" },
		...(extra ? { extra } : {}),
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (payload: Record<string, unknown>) => `${b64({ alg: "none", typ: "JWT" })}.${b64(payload)}.sig`;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "vanrel-refresh-"));
	store = new FileCredentialStore({ path: join(dir, "auth.json") });
});

afterEach(async () => {
	vi.unstubAllGlobals();
	await rm(dir, { recursive: true, force: true });
});

describe("anthropic refresh (R-1: candidate endpoints)", () => {
	it("404 on the first → second endpoint, the working one cached in extra.tokenEndpoint", async () => {
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (url: string | URL | Request) => {
			urls.push(String(url));
			if (String(url).includes("platform.claude.com")) return jsonResponse({ error: "not_found" }, 404);
			return jsonResponse({ access_token: "at-2", refresh_token: "rt-2", expires_in: 7200 });
		});
		const provider = new AnthropicAuthProvider(store, { homeDir: dir, env: () => undefined, now: () => NOW });
		const result = await provider.refresh(baseCred("anthropic"));
		expect(urls).toEqual([
			"https://platform.claude.com/v1/oauth/token",
			"https://console.anthropic.com/v1/oauth/token",
		]);
		expect(result.accessToken).toBe("at-2");
		expect(result.extra?.tokenEndpoint).toBe("https://console.anthropic.com/v1/oauth/token");
	});

	it("cached endpoint goes first", async () => {
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (url: string | URL | Request) => {
			urls.push(String(url));
			return jsonResponse({ access_token: "at-3", refresh_token: "rt-3", expires_in: 7200 });
		});
		const provider = new AnthropicAuthProvider(store, { homeDir: dir, env: () => undefined, now: () => NOW });
		const cred = baseCred("anthropic", { tokenEndpoint: "https://console.anthropic.com/v1/oauth/token" });
		await provider.refresh(cred);
		expect(urls).toEqual(["https://console.anthropic.com/v1/oauth/token"]);
	});

	it("invalid_grant → AuthFlowError(revoked) without fallback to the second endpoint", async () => {
		let calls = 0;
		vi.stubGlobal("fetch", async () => {
			calls++;
			return jsonResponse({ error: "invalid_grant" }, 400);
		});
		const provider = new AnthropicAuthProvider(store, { homeDir: dir, env: () => undefined, now: () => NOW });
		const err = await provider.refresh(baseCred("anthropic")).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(AuthFlowError);
		expect((err as AuthFlowError).reason).toBe("revoked");
		expect(calls).toBe(1);
	});

	it("setup-token: refresh → AuthFlowError(revoked, re-login required)", async () => {
		const provider = new AnthropicAuthProvider(store, { homeDir: dir, env: () => undefined, now: () => NOW });
		const cred = baseCred("anthropic", { setupToken: true });
		await expect(provider.refresh(cred)).rejects.toMatchObject({ name: "AuthFlowError", reason: "revoked" });
	});
});

describe("agy refresh", () => {
	it("standard grant; a returned refresh_token is persisted (rotation)", async () => {
		vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
			expect(String(url)).toBe("https://oauth2.googleapis.com/token");
			expect(String(init?.body)).toContain("grant_type=refresh_token");
			expect(String(init?.body)).toContain("refresh_token=rt-old");
			return jsonResponse({ access_token: "ga-new", expires_in: 3600, refresh_token: "gr-rotated" });
		});
		const provider = new AgyAuthProvider(store, { homeDir: dir, env: () => undefined, now: () => NOW });
		const result = await provider.refresh(baseCred("agy"));
		expect(result.accessToken).toBe("ga-new");
		expect(result.refreshToken).toBe("gr-rotated");
		expect(await store.readGateway("agy")).toMatchObject({ refreshToken: "gr-rotated" });
	});

	it("ADC service_account: JWT-bearer exchange (assertion signed with RS256)", async () => {
		// Test RSA key generated on the fly — no network, signature verified in the mock.
		const { generateKeyPairSync, verify } = await import("node:crypto");
		const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
		const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
		let assertion = "";
		vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
			const params = new URLSearchParams(String(init?.body));
			expect(params.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
			assertion = params.get("assertion") ?? "";
			return jsonResponse({ access_token: "adc-token", expires_in: 3600 });
		});
		const provider = new AgyAuthProvider(store, { homeDir: dir, env: () => undefined, now: () => NOW });
		const cred = baseCred("agy", {
			adc: {
				kind: "service_account",
				clientEmail: "svc@example.iam.gserviceaccount.com",
				privateKey,
				tokenUri: "https://oauth2.googleapis.com/token",
			},
		});
		const result = await provider.refresh(cred);
		expect(result.accessToken).toBe("adc-token");
		const [h, p, s] = assertion.split(".");
		expect(JSON.parse(Buffer.from(h ?? "", "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
		const payload = JSON.parse(Buffer.from(p ?? "", "base64url").toString()) as { iss: string; aud: string };
		expect(payload.iss).toBe("svc@example.iam.gserviceaccount.com");
		expect(verify("RSA-SHA256", Buffer.from(`${h}.${p}`), pair.publicKey, Buffer.from(s ?? "", "base64url"))).toBe(
			true,
		);
	});
});

describe("codex refresh (§5.4)", () => {
	it("partial update: missing fields are preserved; expiresAt from JWT", async () => {
		const newAccess = jwt({
			"https://api.openai.com/auth": { chatgpt_account_id: "acc-new" },
			exp: (NOW + 7200_000) / 1000,
		});
		vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			expect(body.grant_type).toBe("refresh_token");
			expect(body.refresh_reason).toBe("background");
			return jsonResponse({ access_token: newAccess }); // without refresh_token/expires_in
		});
		const provider = new CodexAuthProvider(store, { homeDir: dir, env: () => undefined, now: () => NOW });
		const result = await provider.refresh({ ...baseCred("codex"), accountId: "acc-old", idToken: "idt-old" });
		expect(result.refreshToken).toBe("rt-old"); // preserved
		expect(result.idToken).toBe("idt-old"); // preserved
		expect(result.accessToken).toBe(newAccess);
		expect(result.expiresAt).toBe(NOW + 7200_000); // from JWT exp
		expect(result.accountId).toBe("acc-new"); // recomputed from the new access_token
	});

	it("refresh_token_reused → permanent (AuthFlowError revoked), no retry storm", async () => {
		vi.stubGlobal("fetch", async () => jsonResponse({ error: "refresh_token_reused" }, 400));
		const provider = new CodexAuthProvider(store, { homeDir: dir, env: () => undefined, now: () => NOW });
		const err = await provider.refresh(baseCred("codex")).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(AuthFlowError);
		expect((err as AuthFlowError).reason).toBe("revoked");
	});

	it("HTTP 500 → transient (exchange-failure)", async () => {
		vi.stubGlobal("fetch", async () => jsonResponse({ error: "boom" }, 500));
		const provider = new CodexAuthProvider(store, { homeDir: dir, env: () => undefined, now: () => NOW });
		const err = await provider.refresh(baseCred("codex")).catch((e: unknown) => e);
		expect((err as AuthFlowError).reason).toBe("exchange-failure");
	});
});
