/**
 * anthropic (Claude Code) — §5.1/§5.2.
 * Discovery (§5.6): vanrel-store → env CLAUDE_CODE_OAUTH_TOKEN →
 * ~/.claude/.credentials.json ($CLAUDE_CONFIG_DIR) → profiles-dir (R-4, off by default).
 * Refresh: candidate list of token endpoints (R-1) with caching of the working one in
 * extra.tokenEndpoint; refresh-token rotation is persisted before unlock (§5.7).
 */

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@vanrel/telemetry";
import { AuthFlowError } from "../errors.ts";
import type { FileCredentialStore } from "../file-credential-store.ts";
import type { AuthProvider, Credential, GatewayProviderOptions, LoginOptions } from "../gateway-types.ts";
import { DEFAULT_OAUTH_MINIMUM_VALIDITY_MS, GATEWAY_NOOP_LOGGER } from "../gateway-types.ts";
import { startOAuthCallbackServer } from "../oauth/callback-server.ts";
import { generatePKCE } from "../oauth/pkce.ts";
import { LOGIN_CALLBACK_TIMEOUT_MS, runBrowserLogin } from "./login.ts";
import { parseAuthorizationInput, runManualCodeLogin } from "./manual-login.ts";
import { oauthErrorCode, postTokenEndpoint, readExternalJson, type TokenHttpResponse } from "./shared.ts";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const CALLBACK_HOST = "127.0.0.1";
const CALLBACK_PORT = 53692;
const CALLBACK_PATH = "/callback";
/** Paste-code flow (recon §4.3): hosted copy-code page of Anthropic, no server is started. */
const COPY_CODE_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
/** §5.1 verified subset of scopes (R-3: the UNVERIFIED tail is not requested). */
const SCOPES = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers";
const UPSTREAM_BASE_URL = "https://api.anthropic.com";
const OAUTH_BETA_HEADER = "oauth-2025-04-20";
/** §5.2: refresh-token lives ~24h from login. */
const REFRESH_TTL_MS = 24 * 3600_000;
/** env setup-token: annual, no refresh — marked with a far-future expiresAt (§5.2). */
const SETUP_TOKEN_TTL_MS = 365 * 24 * 3600_000;

/** R-1: exact token endpoint UNVERIFIED → candidate list, the working one is cached. */
const TOKEN_ENDPOINT_CANDIDATES = [
	"https://platform.claude.com/v1/oauth/token",
	"https://console.anthropic.com/v1/oauth/token",
] as const;

export class AnthropicAuthProvider implements AuthProvider {
	readonly id = "anthropic" as const;
	readonly supportsPasteCode = true;
	private readonly store: FileCredentialStore;
	private readonly homeDir: () => string;
	private readonly env: (name: string) => string | undefined;
	private readonly profilesDirEnabled: boolean;
	private readonly adoptExternal: boolean;
	private readonly now: () => number;
	private readonly log: Logger;

	constructor(store: FileCredentialStore, options?: GatewayProviderOptions) {
		this.store = store;
		this.homeDir = () => options?.homeDir ?? homedir();
		this.env = options?.env ?? ((name) => process.env[name]);
		this.profilesDirEnabled = options?.config?.claudeProfilesDir === true;
		this.adoptExternal = options?.adoptExternal ?? true;
		this.now = options?.now ?? Date.now;
		this.log = options?.log ?? GATEWAY_NOOP_LOGGER;
	}

	private claudeDir(): string {
		return this.env("CLAUDE_CONFIG_DIR") ?? join(this.homeDir(), ".claude");
	}

	async discover(): Promise<Credential | null> {
		// 1) vanrel-store
		const stored = await this.store.readGateway(this.id);
		if (stored) {
			if (this.refreshTokenExpired(stored)) {
				this.log.info("anthropic refresh token expired, provider skipped", {
					refreshExpiresAt: stored.refreshExpiresAt,
				});
				return null;
			}
			return stored;
		}
		if (!this.adoptExternal) return null;

		// 2) env CLAUDE_CODE_OAUTH_TOKEN (annual setup-token, no refresh)
		const setupToken = this.env("CLAUDE_CODE_OAUTH_TOKEN");
		if (setupToken) {
			return {
				provider: this.id,
				type: "oauth",
				accessToken: setupToken,
				refreshToken: "",
				expiresAt: this.now() + SETUP_TOKEN_TTL_MS,
				source: { kind: "env", name: "CLAUDE_CODE_OAUTH_TOKEN" },
				extra: { setupToken: true },
			};
		}

		// 3) ~/.claude/.credentials.json (read-only)
		const direct = await this.readClaudeCredentialsFile(join(this.claudeDir(), ".credentials.json"));
		if (direct) return direct;

		// 4) R-4: profiles-dir — UNVERIFIED, off by default; iteration is lexicographic
		if (this.profilesDirEnabled) {
			const profilesDir = join(this.claudeDir(), "profiles");
			let entries: string[];
			try {
				entries = await readdir(profilesDir);
			} catch {
				entries = []; // missing directory — silent skip (DEBUG)
				this.log.debug("claude profiles dir absent, skipping", { profilesDir });
			}
			for (const name of entries.sort()) {
				const cred = await this.readClaudeCredentialsFile(join(profilesDir, name, ".credentials.json"));
				if (cred) return cred;
			}
		}
		return null;
	}

	private refreshTokenExpired(cred: Credential): boolean {
		return typeof cred.refreshExpiresAt === "number" && cred.refreshExpiresAt < this.now();
	}

	/** R-2: the parser accepts both the wrapped (claudeAiOauth) and the flat forms. */
	private async readClaudeCredentialsFile(path: string): Promise<Credential | null> {
		const data = await readExternalJson(path, { log: this.log });
		if (typeof data !== "object" || data === null) return null;
		const top = data as Record<string, unknown>;
		const inner =
			typeof top.claudeAiOauth === "object" && top.claudeAiOauth !== null
				? (top.claudeAiOauth as Record<string, unknown>)
				: top;
		const accessToken = inner.accessToken;
		const refreshToken = inner.refreshToken;
		const expiresAt = inner.expiresAt;
		if (typeof accessToken !== "string" || typeof refreshToken !== "string" || typeof expiresAt !== "number") {
			this.log.debug("claude credentials file unrecognized shape, skipping", {
				path,
				topLevelKeys: Object.keys(top),
			});
			return null;
		}
		const cred: Credential = {
			provider: this.id,
			type: "oauth",
			accessToken,
			refreshToken,
			expiresAt,
			source: { kind: "external-file", path },
		};
		if (typeof inner.refreshTokenExpiresAt === "number") cred.refreshExpiresAt = inner.refreshTokenExpiresAt;
		if (Array.isArray(inner.scopes)) cred.scopes = inner.scopes.filter((s): s is string => typeof s === "string");
		const extra: Record<string, unknown> = {};
		if (typeof inner.subscriptionType === "string") extra.subscriptionType = inner.subscriptionType;
		if (Object.keys(extra).length > 0) cred.extra = extra;
		if (this.refreshTokenExpired(cred)) {
			this.log.info("anthropic external refresh token expired, skipping", { path });
			return null;
		}
		return cred;
	}

	needsRefresh(cred: Credential, now?: number): boolean {
		if (cred.extra?.setupToken === true) return false; // setup-token is never refreshed (§5.2)
		return cred.expiresAt - (now ?? this.now()) < DEFAULT_OAUTH_MINIMUM_VALIDITY_MS;
	}

	toRequestAuth(cred: Credential): { headers: Record<string, string>; baseUrl: string } {
		return {
			headers: { authorization: `Bearer ${cred.accessToken}`, "anthropic-beta": OAUTH_BETA_HEADER },
			baseUrl: UPSTREAM_BASE_URL,
		};
	}

	async refresh(cred: Credential, signal?: AbortSignal): Promise<Credential> {
		if (cred.extra?.setupToken === true) {
			throw new AuthFlowError(
				this.id,
				"revoked",
				"CLAUDE_CODE_OAUTH_TOKEN setup-token cannot be refreshed; re-login required",
			);
		}
		const result = await this.store.modifyGateway(
			this.id,
			async (current) => {
				// §5.7 item 3 post-lock double-check: the store is the authoritative source.
				const effective = current ?? cred;
				if (!this.needsRefresh(effective)) {
					this.log.debug("anthropic refresh skipped (fresh credential under lock)", {
						source: effective.source.kind,
					});
					return undefined;
				}
				return await this.doRefresh(effective);
			},
			{ signal },
		);
		return result ?? cred;
	}

	/** R-1: candidates in order: cached working one → default list. */
	private endpointCandidates(cred: Credential): string[] {
		const cached = cred.extra?.tokenEndpoint;
		const rest = TOKEN_ENDPOINT_CANDIDATES.filter((e) => e !== cached);
		return typeof cached === "string" ? [cached, ...rest] : [...TOKEN_ENDPOINT_CANDIDATES];
	}

	private async doRefresh(cred: Credential): Promise<Credential> {
		const failures: string[] = [];
		for (const endpoint of this.endpointCandidates(cred)) {
			let response: TokenHttpResponse;
			try {
				response = await postTokenEndpoint(
					endpoint,
					{ json: { grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: cred.refreshToken } },
					AbortSignal.timeout(15_000),
				);
			} catch (error) {
				// DNS/network/timeout → next candidate (R-1)
				failures.push(`${endpoint}: network ${String(error)}`);
				this.log.warn("anthropic token endpoint unreachable, trying next", { endpoint, error: String(error) });
				continue;
			}
			if (response.status === 404) {
				failures.push(`${endpoint}: 404`);
				this.log.warn("anthropic token endpoint 404, trying next", { endpoint });
				continue;
			}
			const errorCode = oauthErrorCode(response.json);
			if (
				response.status === 400 ||
				response.status === 401 ||
				response.status === 403 ||
				errorCode === "invalid_grant"
			) {
				throw new AuthFlowError(
					this.id,
					"revoked",
					`anthropic refresh rejected (${response.status}${errorCode ? ` ${errorCode}` : ""}): ${response.bodyText}`,
				);
			}
			if (response.status < 200 || response.status >= 300) {
				failures.push(`${endpoint}: http ${response.status}`);
				this.log.warn("anthropic token endpoint http error, trying next", { endpoint, status: response.status });
				continue;
			}
			const json = response.json;
			const accessToken = json?.access_token;
			const refreshToken = json?.refresh_token;
			const expiresIn = json?.expires_in;
			if (typeof accessToken !== "string" || typeof refreshToken !== "string" || typeof expiresIn !== "number") {
				throw new AuthFlowError(
					this.id,
					"exchange-failure",
					`anthropic refresh malformed response from ${endpoint}: ${response.bodyText}`,
				);
			}
			const next: Credential = {
				...cred,
				accessToken,
				refreshToken, // rotation (§5.2)
				expiresAt: this.now() + expiresIn * 1000,
				extra: { ...cred.extra, tokenEndpoint: endpoint }, // R-1: cache of the working endpoint
				source: { kind: "vanrel-store", path: this.store.path },
			};
			if (typeof json?.scope === "string") next.scopes = json.scope.split(" ").filter(Boolean);
			this.log.info("anthropic token refreshed", { endpoint });
			return next;
		}
		throw new AuthFlowError(
			this.id,
			"exchange-failure",
			`anthropic refresh failed on all token endpoints: ${failures.join("; ")}`,
		);
	}

	private buildAuthorizeUrl(redirectUri: string, challenge: string, verifier: string): string {
		const params = new URLSearchParams({
			code: "true",
			client_id: CLIENT_ID,
			response_type: "code",
			redirect_uri: redirectUri,
			scope: SCOPES,
			code_challenge: challenge,
			code_challenge_method: "S256",
			state: verifier,
		});
		return `${AUTHORIZE_URL}?${params.toString()}`;
	}

	/** code → Credential over the R-1 candidates; shared by loopback and paste-code. */
	private async exchangeCode(code: string, redirectUri: string, verifier: string, state: string): Promise<Credential> {
		const failures: string[] = [];
		for (const endpoint of TOKEN_ENDPOINT_CANDIDATES) {
			let response: TokenHttpResponse;
			try {
				response = await postTokenEndpoint(
					endpoint,
					{
						json: {
							grant_type: "authorization_code",
							client_id: CLIENT_ID,
							code,
							state,
							redirect_uri: redirectUri,
							code_verifier: verifier,
						},
					},
					AbortSignal.timeout(15_000),
				);
			} catch (error) {
				failures.push(`${endpoint}: network ${String(error)}`);
				continue;
			}
			if (response.status === 404) {
				failures.push(`${endpoint}: 404`);
				continue;
			}
			if (response.status < 200 || response.status >= 300 || !response.json) {
				throw new AuthFlowError(
					this.id,
					"exchange-failure",
					`anthropic code exchange failed (${response.status}): ${response.bodyText}`,
				);
			}
			const json = response.json;
			if (
				typeof json.access_token !== "string" ||
				typeof json.refresh_token !== "string" ||
				typeof json.expires_in !== "number"
			) {
				throw new AuthFlowError(this.id, "exchange-failure", `anthropic exchange malformed: ${response.bodyText}`);
			}
			return {
				provider: this.id,
				type: "oauth" as const,
				accessToken: json.access_token,
				refreshToken: json.refresh_token,
				expiresAt: this.now() + json.expires_in * 1000,
				refreshExpiresAt: this.now() + REFRESH_TTL_MS,
				source: { kind: "login-flow" as const },
				extra: { tokenEndpoint: endpoint },
			};
		}
		throw new AuthFlowError(
			this.id,
			"exchange-failure",
			`anthropic exchange failed on all endpoints: ${failures.join("; ")}`,
		);
	}

	async login(options?: LoginOptions): Promise<Credential> {
		const { verifier, challenge } = await generatePKCE();
		const signal = options?.signal;
		if (options?.flow === "paste-code") {
			return runManualCodeLogin({
				provider: this.id,
				store: this.store,
				signal,
				onAuthUrl: options.onAuthUrl,
				promptCode: options.promptCode,
				log: this.log,
				buildAuthUrl: () => ({
					url: this.buildAuthorizeUrl(COPY_CODE_REDIRECT_URI, challenge, verifier),
					instructions:
						"Complete login in your browser, then copy the code Anthropic shows after sign-in and paste it here.",
					placeholder: "code#state",
				}),
				complete: async (input) => {
					const parsed = parseAuthorizationInput(input);
					if (parsed.state && parsed.state !== verifier) {
						throw new AuthFlowError(this.id, "exchange-failure", "anthropic login state mismatch");
					}
					if (!parsed.code) {
						throw new AuthFlowError(this.id, "exchange-failure", "anthropic login: missing authorization code");
					}
					return this.exchangeCode(parsed.code, COPY_CODE_REDIRECT_URI, verifier, parsed.state ?? verifier);
				},
			});
		}
		return runBrowserLogin({
			provider: this.id,
			store: this.store,
			signal,
			onAuthUrl: options?.onAuthUrl,
			log: this.log,
			startServer: async () => {
				const start = (port: number) =>
					startOAuthCallbackServer({
						providerName: "Anthropic",
						host: CALLBACK_HOST,
						port,
						path: CALLBACK_PATH,
						redirectHost: "localhost",
						state: verifier,
						complete: async (code) => code,
						signal,
						timeoutMs: LOGIN_CALLBACK_TIMEOUT_MS,
					});
				return start(CALLBACK_PORT).catch(() => start(0)); // busy → free port (§5.1)
			},
			buildAuthUrl: (redirectUri) => this.buildAuthorizeUrl(redirectUri, challenge, verifier),
			exchange: async (code, redirectUri) => this.exchangeCode(code, redirectUri, verifier, verifier),
		});
	}
}
