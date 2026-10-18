import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthFlowError, AuthLockError } from "../../src/auth/errors.ts";
import { FileCredentialStore } from "../../src/auth/file-credential-store.ts";
import type { Credential, LoginOptions } from "../../src/auth/gateway-types.ts";
import { withFileLock } from "../../src/auth/lockfile.ts";
import { AgyAuthProvider } from "../../src/auth/providers/agy.ts";
import { AnthropicAuthProvider } from "../../src/auth/providers/anthropic.ts";
import { CodexAuthProvider } from "../../src/auth/providers/codex.ts";
import { parseAuthorizationInput, runManualCodeLogin } from "../../src/auth/providers/manual-login.ts";

const NOW = 1_900_000_000_000;
let dir: string;
let store: FileCredentialStore;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "vanrel-manual-"));
	store = new FileCredentialStore({ path: join(dir, "auth.json") });
});

afterEach(async () => {
	vi.unstubAllGlobals();
	await rm(dir, { recursive: true, force: true });
});

const jsonResponse = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (payload: Record<string, unknown>) => `${b64({ alg: "none", typ: "JWT" })}.${b64(payload)}.sig`;

/** LoginOptions harness: captures the auth URL (onAuthUrl fires before promptCode) and serves answers in order. */
function loginHarness(answer: (authUrl: string) => string) {
	const harness = {
		authUrl: "",
		prompts: [] as string[],
		options(): LoginOptions {
			return {
				flow: "paste-code",
				onAuthUrl: (url) => {
					harness.authUrl = url;
				},
				promptCode: async (prompt) => {
					harness.prompts.push(prompt.message);
					return answer(harness.authUrl);
				},
			};
		},
	};
	return harness;
}

describe("parseAuthorizationInput (1:1 port from pi)", () => {
	it("full URL with code+state", () => {
		expect(parseAuthorizationInput("http://localhost:1455/auth/callback?code=abc&state=xyz")).toEqual({
			code: "abc",
			state: "xyz",
		});
	});

	it("code#state", () => {
		expect(parseAuthorizationInput("abc#xyz")).toEqual({ code: "abc", state: "xyz" });
	});

	it("code=...&state=...", () => {
		expect(parseAuthorizationInput("code=abc&state=xyz")).toEqual({ code: "abc", state: "xyz" });
	});

	it("bare code (with surrounding whitespace)", () => {
		expect(parseAuthorizationInput("  abc  ")).toEqual({ code: "abc" });
	});

	it("empty string → {}", () => {
		expect(parseAuthorizationInput("")).toEqual({});
		expect(parseAuthorizationInput("   ")).toEqual({});
	});

	it("garbage → {code: garbage}", () => {
		expect(parseAuthorizationInput("zzz-not-a-url")).toEqual({ code: "zzz-not-a-url" });
	});
});

describe("runManualCodeLogin (shared skeleton)", () => {
	const buildAuthUrl = () => ({ url: "https://example.test/auth", instructions: "do it", placeholder: "code" });
	const fakeCred: Credential = {
		provider: "codex",
		type: "oauth",
		accessToken: "at",
		refreshToken: "rt",
		expiresAt: NOW + 3600_000,
		source: { kind: "login-flow" },
	};

	it("flow without promptCode → AuthFlowError(user-cancel) immediately, complete not called", async () => {
		const complete = vi.fn(async () => fakeCred);
		const err = await runManualCodeLogin({ provider: "codex", buildAuthUrl, complete, store }).catch(
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(AuthFlowError);
		expect((err as AuthFlowError).reason).toBe("user-cancel");
		expect(complete).not.toHaveBeenCalled();
	});

	it("abort before the prompt → AuthFlowError(user-cancel)", async () => {
		const signal = AbortSignal.abort();
		const promptCode = vi.fn(async () => "code");
		const err = await runManualCodeLogin({
			provider: "codex",
			buildAuthUrl,
			complete: async () => fakeCred,
			promptCode,
			store,
			signal,
		}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(AuthFlowError);
		expect((err as AuthFlowError).reason).toBe("user-cancel");
		expect(promptCode).not.toHaveBeenCalled();
	});

	it("persist before return: credential readable from store, return has source login-flow", async () => {
		const cred = await runManualCodeLogin({
			provider: "codex",
			buildAuthUrl,
			complete: async () => fakeCred,
			promptCode: async () => "good-code",
			store,
		});
		expect(cred.source.kind).toBe("login-flow");
		const stored = await store.readGateway("codex");
		expect(stored?.accessToken).toBe("at");
		expect(stored?.source).toEqual({ kind: "vanrel-store", path: store.path });
	});

	it("store error → AuthLockError rethrown", async () => {
		const blocking = new FileCredentialStore({ path: store.path, lockTimeoutMs: 100 });
		await withFileLock(store.lockPath, async () => {
			const err = await runManualCodeLogin({
				provider: "codex",
				buildAuthUrl,
				complete: async () => fakeCred,
				promptCode: async () => "good-code",
				store: blocking,
			}).catch((e: unknown) => e);
			expect(err).toBeInstanceOf(AuthLockError);
		});
	});

	it("empty/unparsable input → local re-prompt up to 3 times, complete called once", async () => {
		const answers = ["", "   ", "good-code"];
		const prompts: string[] = [];
		const complete = vi.fn(async (input: string) => {
			expect(input).toBe("good-code");
			return fakeCred;
		});
		await runManualCodeLogin({
			provider: "codex",
			buildAuthUrl,
			complete,
			promptCode: async (prompt) => {
				prompts.push(prompt.message);
				return answers.shift() ?? "";
			},
			store,
		});
		expect(prompts).toHaveLength(3);
		expect(complete).toHaveBeenCalledTimes(1);
	});

	it("3 unparsable inputs → AuthFlowError(user-cancel), complete not called, no network", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const complete = vi.fn(async () => fakeCred);
		const err = await runManualCodeLogin({
			provider: "codex",
			buildAuthUrl,
			complete,
			promptCode: async () => "###", // split("#") → code "" → unparsable
			store,
		}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(AuthFlowError);
		expect((err as AuthFlowError).reason).toBe("user-cancel");
		expect(complete).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("exchange error in complete — single shot: AuthFlowError(exchange-failure) without re-prompt", async () => {
		let prompts = 0;
		const err = await runManualCodeLogin({
			provider: "codex",
			buildAuthUrl,
			complete: async () => {
				throw new AuthFlowError("codex", "exchange-failure", "boom");
			},
			promptCode: async () => {
				prompts++;
				return "good-code";
			},
			store,
		}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(AuthFlowError);
		expect((err as AuthFlowError).reason).toBe("exchange-failure");
		expect(prompts).toBe(1);
	});
});

describe("anthropic paste-code", () => {
	const provider = () => new AnthropicAuthProvider(store, { homeDir: dir, env: () => undefined, now: () => NOW });
	const stateFromUrl = (url: string) => new URL(url).searchParams.get("state") ?? "";

	it("supportsPasteCode = true", () => {
		expect(provider().supportsPasteCode).toBe(true);
	});

	it("success: Credential fields, copy-code redirect_uri, code_verifier; persisted to store", async () => {
		const bodies: Record<string, unknown>[] = [];
		vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
			bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return jsonResponse({ access_token: "at-1", refresh_token: "rt-1", expires_in: 7200 });
		});
		const harness = loginHarness((url) => `testcode#${stateFromUrl(url)}`);
		const cred = await provider().login(harness.options());
		expect(cred.accessToken).toBe("at-1");
		expect(cred.refreshToken).toBe("rt-1");
		expect(cred.expiresAt).toBe(NOW + 7200_000);
		expect(cred.refreshExpiresAt).toBe(NOW + 24 * 3600_000);
		expect(cred.extra?.tokenEndpoint).toBe("https://platform.claude.com/v1/oauth/token");
		expect(bodies).toHaveLength(1);
		expect(bodies[0]).toMatchObject({
			grant_type: "authorization_code",
			client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
			code: "testcode",
			redirect_uri: "https://platform.claude.com/oauth/code/callback",
		});
		expect(typeof bodies[0]?.code_verifier).toBe("string");
		expect(harness.authUrl).toContain(encodeURIComponent("https://platform.claude.com/oauth/code/callback"));
		expect((await store.readGateway("anthropic"))?.accessToken).toBe("at-1");
	});

	it("400 invalid_grant → AuthFlowError(exchange-failure)", async () => {
		vi.stubGlobal("fetch", async () => jsonResponse({ error: "invalid_grant" }, 400));
		const harness = loginHarness((url) => `code#${stateFromUrl(url)}`);
		const err = await provider()
			.login(harness.options())
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(AuthFlowError);
		expect((err as AuthFlowError).reason).toBe("exchange-failure");
	});

	it("first candidate 404 → second 200 → success, endpoint cached", async () => {
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (url: string | URL | Request) => {
			urls.push(String(url));
			if (String(url).includes("platform.claude.com")) return jsonResponse({ error: "not_found" }, 404);
			return jsonResponse({ access_token: "at-2", refresh_token: "rt-2", expires_in: 7200 });
		});
		const harness = loginHarness((url) => `code#${stateFromUrl(url)}`);
		const cred = await provider().login(harness.options());
		expect(urls).toEqual([
			"https://platform.claude.com/v1/oauth/token",
			"https://console.anthropic.com/v1/oauth/token",
		]);
		expect(cred.extra?.tokenEndpoint).toBe("https://console.anthropic.com/v1/oauth/token");
	});

	it("malformed response (no refresh_token) → exchange-failure", async () => {
		vi.stubGlobal("fetch", async () => jsonResponse({ access_token: "at-x", expires_in: 7200 }));
		const harness = loginHarness((url) => `code#${stateFromUrl(url)}`);
		const err = await provider()
			.login(harness.options())
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(AuthFlowError);
		expect((err as AuthFlowError).reason).toBe("exchange-failure");
	});

	it("state mismatch → exchange-failure, fetch NOT called", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const harness = loginHarness(() => "code#wrong-state");
		const err = await provider()
			.login(harness.options())
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(AuthFlowError);
		expect((err as AuthFlowError).reason).toBe("exchange-failure");
		expect(String((err as AuthFlowError).message)).toContain("state mismatch");
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("paste-code flow without promptCode → AuthFlowError(user-cancel)", async () => {
		const err = await provider()
			.login({ flow: "paste-code" })
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(AuthFlowError);
		expect((err as AuthFlowError).reason).toBe("user-cancel");
	});
});

describe("codex paste-code", () => {
	const provider = () => new CodexAuthProvider(store, { homeDir: dir, env: () => undefined, now: () => NOW });
	const JWT_AUTH_CLAIM = "https://api.openai.com/auth";
	const accessJwt = jwt({ [JWT_AUTH_CLAIM]: { chatgpt_account_id: "acc-123" } });

	it("supportsPasteCode = true", () => {
		expect(provider().supportsPasteCode).toBe(true);
	});

	it("success: full redirect URL → accountId from JWT, redirect_uri fixed localhost:1455", async () => {
		const bodies: string[] = [];
		vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
			bodies.push(String(init?.body));
			return jsonResponse({ access_token: accessJwt, refresh_token: "rt-c", expires_in: 3600, id_token: "idt" });
		});
		const harness = loginHarness((url) => {
			const state = new URL(url).searchParams.get("state") ?? "";
			return `http://localhost:1455/auth/callback?code=cdx-code&state=${state}`;
		});
		const cred = await provider().login(harness.options());
		expect(cred.accountId).toBe("acc-123");
		expect(cred.idToken).toBe("idt");
		expect(cred.expiresAt).toBe(NOW + 3600_000);
		const params = new URLSearchParams(bodies[0]);
		expect(params.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
		expect(params.get("code")).toBe("cdx-code");
		expect(params.get("code_verifier")).toBeTruthy();
		expect(params.get("grant_type")).toBe("authorization_code");
		expect((await store.readGateway("codex"))?.accountId).toBe("acc-123");
	});

	it("missing id_token — ok", async () => {
		vi.stubGlobal("fetch", async () =>
			jsonResponse({ access_token: accessJwt, refresh_token: "rt-c", expires_in: 3600 }),
		);
		const harness = loginHarness((url) => `bare-code#${new URL(url).searchParams.get("state") ?? ""}`);
		const cred = await provider().login(harness.options());
		expect(cred.accessToken).toBe(accessJwt);
		expect(cred.idToken).toBeUndefined();
	});

	it("400 → exchange-failure", async () => {
		vi.stubGlobal("fetch", async () => jsonResponse({ error: "invalid_grant" }, 400));
		const harness = loginHarness((url) => `code#${new URL(url).searchParams.get("state") ?? ""}`);
		const err = await provider()
			.login(harness.options())
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(AuthFlowError);
		expect((err as AuthFlowError).reason).toBe("exchange-failure");
	});

	it("state mismatch → exchange-failure, fetch NOT called", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const harness = loginHarness(() => "http://localhost:1455/auth/callback?code=x&state=wrong");
		const err = await provider()
			.login(harness.options())
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(AuthFlowError);
		expect((err as AuthFlowError).reason).toBe("exchange-failure");
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe("agy paste-code", () => {
	const provider = () => new AgyAuthProvider(store, { homeDir: dir, env: () => undefined, now: () => NOW });

	it("supportsPasteCode = true", () => {
		expect(provider().supportsPasteCode).toBe(true);
	});

	it("success: form contains code_verifier+client_secret, redirect_uri authcode; scope/id_token in Credential", async () => {
		const bodies: string[] = [];
		vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
			expect(String(url)).toBe("https://oauth2.googleapis.com/token");
			bodies.push(String(init?.body));
			return jsonResponse({
				access_token: "ga-1",
				refresh_token: "gr-1",
				expires_in: 3600,
				scope: "scope-a scope-b",
				id_token: "gidt",
			});
		});
		const harness = loginHarness(() => "4/0Afake-code");
		const cred = await provider().login(harness.options());
		expect(cred.accessToken).toBe("ga-1");
		expect(cred.refreshToken).toBe("gr-1");
		expect(cred.expiresAt).toBe(NOW + 3600_000);
		expect(cred.scopes).toEqual(["scope-a", "scope-b"]);
		expect(cred.idToken).toBe("gidt");
		const params = new URLSearchParams(bodies[0]);
		expect(params.get("redirect_uri")).toBe("https://codeassist.google.com/authcode");
		expect(params.get("code")).toBe("4/0Afake-code");
		expect(params.get("client_secret")).toBeTruthy();
		expect(params.get("code_verifier")).toBeTruthy(); // difference from the web flow
		expect(params.get("grant_type")).toBe("authorization_code");
		expect(harness.authUrl).toContain(encodeURIComponent("https://codeassist.google.com/authcode"));
		expect(harness.authUrl).toContain("code_challenge=");
		expect((await store.readGateway("agy"))?.accessToken).toBe("ga-1");
	});

	it("no refresh_token in response → exchange-failure", async () => {
		vi.stubGlobal("fetch", async () => jsonResponse({ access_token: "ga-x", expires_in: 3600 }));
		const harness = loginHarness(() => "code-only");
		const err = await provider()
			.login(harness.options())
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(AuthFlowError);
		expect((err as AuthFlowError).reason).toBe("exchange-failure");
	});

	it("400 → exchange-failure", async () => {
		vi.stubGlobal("fetch", async () => jsonResponse({ error: "invalid_grant" }, 400));
		const harness = loginHarness(() => "code-only");
		const err = await provider()
			.login(harness.options())
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(AuthFlowError);
		expect((err as AuthFlowError).reason).toBe("exchange-failure");
	});
});
