/**
 * codex (OpenAI Codex, ChatGPT subscription) — §5.1/§5.4.
 * Discovery (§5.6): vanrel-store → $CODEX_HOME/auth.json (default ~/.codex/auth.json,
 * read-only, ONLY auth_mode:"chatgpt"; key mode — skip with INFO, §5.8 subscription-only).
 * Refresh: JSON grant + refresh_reason; response is a partial update; codex-rs error
 * classification: expired/reused/invalidated + 401/invalid_grant → permanent.
 * Token-exchange grant (openai-api-key) is NOT performed: the key is neither stored nor used (§5.4).
 */

import { randomBytes } from "node:crypto";
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
import {
	decodeJwtPayload,
	jwtClaim,
	jwtExpiresAtMs,
	oauthErrorCode,
	postTokenEndpoint,
	readExternalJson,
} from "./shared.ts";

const AUTH_BASE_URL = "https://auth.openai.com";
const AUTHORIZE_URL = `${AUTH_BASE_URL}/oauth/authorize`;
const DEFAULT_TOKEN_URL = `${AUTH_BASE_URL}/oauth/token`;
const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const SCOPES = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const UPSTREAM_BASE_URL = "https://chatgpt.com/backend-api/codex";
const CALLBACK_PATH = "/auth/callback";
const CALLBACK_PORTS = [1455, 1457] as const; // DEFAULT_PORT → FALLBACK_PORT (§5.4)
/** Paste-code flow (recon §4.3): fixed redirect registered with OpenAI; NO server is started —
    the browser shows a broken page, the URL is copied from the address bar. */
const MANUAL_REDIRECT_URI = `http://localhost:1455${CALLBACK_PATH}`;
const JWT_AUTH_CLAIM = "https://api.openai.com/auth";
const JWT_PROFILE_CLAIM = "https://api.openai.com/profile";
/** codex-rs: permanent on these codes / 401 / invalid_grant (reuse = rotation race). */
const PERMANENT_REFRESH_ERRORS = new Set([
	"refresh_token_expired",
	"refresh_token_reused",
	"refresh_token_invalidated",
	"invalid_grant",
]);

export class CodexAuthProvider implements AuthProvider {
	readonly id = "codex" as const;
	readonly supportsPasteCode = true;
	private readonly store: FileCredentialStore;
	private readonly homeDir: () => string;
	private readonly env: (name: string) => string | undefined;
	private readonly adoptExternal: boolean;
	private readonly now: () => number;
	private readonly log: Logger;

	constructor(store: FileCredentialStore, options?: GatewayProviderOptions) {
		this.store = store;
		this.homeDir = () => options?.homeDir ?? homedir();
		this.env = options?.env ?? ((name) => process.env[name]);
		this.adoptExternal = options?.adoptExternal ?? true;
		this.now = options?.now ?? Date.now;
		this.log = options?.log ?? GATEWAY_NOOP_LOGGER;
	}

	private tokenUrl(): string {
		return this.env("CODEX_REFRESH_TOKEN_URL_OVERRIDE") ?? this.env("CODEX_TOKEN_URL_OVERRIDE") ?? DEFAULT_TOKEN_URL;
	}

	private clientId(): string {
		return this.env("CODEX_APP_SERVER_LOGIN_CLIENT_ID") ?? DEFAULT_CLIENT_ID;
	}

	async discover(): Promise<Credential | null> {
		// 1) vanrel-store
		const stored = await this.store.readGateway(this.id);
		if (stored) return stored;
		if (!this.adoptExternal) return null;

		// 2) $CODEX_HOME/auth.json (default ~/.codex/auth.json), read-only
		const codexHome = this.env("CODEX_HOME") ?? join(this.homeDir(), ".codex");
		const authPath = join(codexHome, "auth.json");
		const data = await readExternalJson(authPath, { log: this.log });
		if (typeof data !== "object" || data === null) return null;
		const file = data as Record<string, unknown>;
		// Only auth_mode "chatgpt"; "apikey"/null → skip (subscription-only, invariant 2).
		if (file.auth_mode !== "chatgpt") {
			this.log.info("codex auth.json is not chatgpt-mode, skipping", {
				path: authPath,
				authMode: file.auth_mode ?? null,
			});
			return null;
		}
		const tokens =
			typeof file.tokens === "object" && file.tokens !== null ? (file.tokens as Record<string, unknown>) : null;
		if (!tokens || typeof tokens.access_token !== "string" || typeof tokens.refresh_token !== "string") {
			this.log.debug("codex auth.json missing tokens, skipping", { path: authPath });
			return null;
		}
		const accessToken = tokens.access_token;
		const idToken = typeof tokens.id_token === "string" ? tokens.id_token : undefined;
		// accountId: the tokens.account_id field, otherwise the JWT claim (§5.4).
		const authClaims = jwtClaim(decodeJwtPayload(accessToken), JWT_AUTH_CLAIM);
		const accountId =
			(typeof tokens.account_id === "string" && tokens.account_id.length > 0 ? tokens.account_id : null) ??
			(typeof authClaims?.chatgpt_account_id === "string" ? authClaims.chatgpt_account_id : undefined);
		const idClaims = jwtClaim(decodeJwtPayload(idToken ?? ""), JWT_AUTH_CLAIM) ?? authClaims;
		const planType = typeof idClaims?.chatgpt_plan_type === "string" ? idClaims.chatgpt_plan_type : undefined;
		const cred: Credential = {
			provider: this.id,
			type: "oauth",
			accessToken,
			refreshToken: tokens.refresh_token,
			// The file does not store expiry — derive it from the JWT exp of access_token (UNVERIFIED-tolerant: missing → 0).
			expiresAt: jwtExpiresAtMs(accessToken) ?? 0,
			source: { kind: "external-file", path: authPath },
		};
		if (accountId) cred.accountId = accountId;
		if (idToken) cred.idToken = idToken;
		const extra: Record<string, unknown> = {};
		if (planType) extra.planType = planType;
		if (typeof file.last_refresh === "string") extra.lastRefresh = file.last_refresh;
		const email = jwtClaim(decodeJwtPayload(idToken ?? ""), JWT_PROFILE_CLAIM)?.email;
		if (typeof email === "string") extra.email = email;
		if (Object.keys(extra).length > 0) cred.extra = extra;
		return cred;
	}

	needsRefresh(cred: Credential, now?: number): boolean {
		return cred.expiresAt - (now ?? this.now()) < DEFAULT_OAUTH_MINIMUM_VALIDITY_MS;
	}

	toRequestAuth(cred: Credential): { headers: Record<string, string>; baseUrl: string } {
		const headers: Record<string, string> = { authorization: `Bearer ${cred.accessToken}` };
		if (cred.accountId) headers["chatgpt-account-id"] = cred.accountId;
		return { headers, baseUrl: UPSTREAM_BASE_URL };
	}

	async refresh(cred: Credential, signal?: AbortSignal): Promise<Credential> {
		const result = await this.store.modifyGateway(
			this.id,
			async (current) => {
				const effective = current ?? cred; // §5.7 double-check: the store is authoritative
				if (!this.needsRefresh(effective)) {
					this.log.debug("codex refresh skipped (fresh credential under lock)", { source: effective.source.kind });
					return undefined;
				}
				return await this.doRefresh(effective);
			},
			{ signal },
		);
		return result ?? cred;
	}

	private async doRefresh(cred: Credential): Promise<Credential> {
		const response = await postTokenEndpoint(
			this.tokenUrl(),
			{
				json: {
					client_id: this.clientId(),
					grant_type: "refresh_token",
					refresh_token: cred.refreshToken,
					refresh_reason: "background",
				},
			},
			AbortSignal.timeout(15_000),
		).catch((error) => {
			throw new AuthFlowError(this.id, "exchange-failure", `codex refresh network error: ${String(error)}`);
		});

		const errorCode = oauthErrorCode(response.json);
		if (response.status === 401 || (errorCode !== null && PERMANENT_REFRESH_ERRORS.has(errorCode))) {
			// refresh_token_reused — indicator of a rotation race; permanent → explicit re-login (§8.2).
			throw new AuthFlowError(
				this.id,
				"revoked",
				`codex refresh permanently rejected (${response.status}${errorCode ? ` ${errorCode}` : ""}): ${response.bodyText}`,
			);
		}
		if (response.status < 200 || response.status >= 300 || !response.json) {
			throw new AuthFlowError(
				this.id,
				"exchange-failure",
				`codex refresh failed (${response.status}): ${response.bodyText}`,
			);
		}
		// Partial update: missing fields are preserved from the current credential (§5.4).
		const json = response.json;
		const accessToken = typeof json.access_token === "string" ? json.access_token : cred.accessToken;
		const expiresIn = json.expires_in;
		const next: Credential = {
			...cred,
			accessToken,
			refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : cred.refreshToken,
			expiresAt:
				typeof expiresIn === "number"
					? this.now() + expiresIn * 1000
					: (jwtExpiresAtMs(accessToken) ?? cred.expiresAt),
			source: { kind: "vanrel-store", path: this.store.path },
			extra: { ...cred.extra, lastRefresh: new Date(this.now()).toISOString() },
		};
		if (typeof json.id_token === "string") next.idToken = json.id_token;
		const claims = jwtClaim(decodeJwtPayload(accessToken), JWT_AUTH_CLAIM);
		if (typeof claims?.chatgpt_account_id === "string") next.accountId = claims.chatgpt_account_id;
		this.log.info("codex token refreshed", { rotated: typeof json.refresh_token === "string" });
		return next;
	}

	private buildAuthorizeUrl(redirectUri: string, challenge: string, state: string): string {
		const params = new URLSearchParams({
			response_type: "code",
			client_id: this.clientId(),
			redirect_uri: redirectUri,
			scope: SCOPES,
			code_challenge: challenge,
			code_challenge_method: "S256",
			state,
			id_token_add_organizations: "true",
			codex_cli_simplified_flow: "true",
			originator: "codex_cli_rs",
		});
		return `${AUTHORIZE_URL}?${params.toString()}`;
	}

	/** code → Credential (form POST); shared by loopback and paste-code. */
	private async exchangeCode(code: string, redirectUri: string, verifier: string): Promise<Credential> {
		const response = await postTokenEndpoint(
			this.env("CODEX_TOKEN_URL_OVERRIDE") ?? DEFAULT_TOKEN_URL,
			{
				form: {
					grant_type: "authorization_code",
					client_id: this.clientId(),
					code,
					code_verifier: verifier,
					redirect_uri: redirectUri,
				},
			},
			AbortSignal.timeout(15_000),
		).catch((error) => {
			throw new AuthFlowError(this.id, "exchange-failure", `codex exchange network error: ${String(error)}`);
		});
		if (response.status < 200 || response.status >= 300 || !response.json) {
			throw new AuthFlowError(
				this.id,
				"exchange-failure",
				`codex exchange failed (${response.status}): ${response.bodyText}`,
			);
		}
		const json = response.json;
		if (typeof json.access_token !== "string" || typeof json.refresh_token !== "string") {
			throw new AuthFlowError(this.id, "exchange-failure", `codex exchange malformed: ${response.bodyText}`);
		}
		const claims = jwtClaim(decodeJwtPayload(json.access_token), JWT_AUTH_CLAIM);
		const planType = jwtClaim(
			decodeJwtPayload(typeof json.id_token === "string" ? json.id_token : ""),
			JWT_AUTH_CLAIM,
		)?.chatgpt_plan_type;
		const cred: Credential = {
			provider: this.id,
			type: "oauth",
			accessToken: json.access_token,
			refreshToken: json.refresh_token,
			expiresAt:
				typeof json.expires_in === "number"
					? this.now() + json.expires_in * 1000
					: (jwtExpiresAtMs(json.access_token) ?? this.now() + 3600_000),
			source: { kind: "login-flow" },
		};
		if (typeof claims?.chatgpt_account_id === "string") cred.accountId = claims.chatgpt_account_id;
		if (typeof json.id_token === "string") cred.idToken = json.id_token;
		if (typeof planType === "string") cred.extra = { planType };
		// Token-exchange grant (requested_token=openai-api-key) is deliberately not performed (§5.4).
		return cred;
	}

	async login(options?: LoginOptions): Promise<Credential> {
		const { verifier, challenge } = await generatePKCE();
		const state = randomBytes(16).toString("hex");
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
					url: this.buildAuthorizeUrl(MANUAL_REDIRECT_URI, challenge, state),
					instructions:
						"Complete login in your browser. After sign-in the browser redirects to a localhost address that will fail to load — copy the full URL from the address bar and paste it here (or just the code).",
					placeholder: `${MANUAL_REDIRECT_URI}?code=...&state=...`,
				}),
				complete: async (input) => {
					const parsed = parseAuthorizationInput(input);
					if (parsed.state && parsed.state !== state) {
						throw new AuthFlowError(this.id, "exchange-failure", "codex login state mismatch");
					}
					if (!parsed.code) {
						throw new AuthFlowError(this.id, "exchange-failure", "codex login: missing authorization code");
					}
					return this.exchangeCode(parsed.code, MANUAL_REDIRECT_URI, verifier);
				},
			});
		}
		return runBrowserLogin({
			provider: this.id,
			store: this.store,
			signal,
			onAuthUrl: options?.onAuthUrl,
			log: this.log,
			// §5.4: 1455 busy → GET /cancel to the foreign server → retry 1455 → 1457 → error.
			startServer: async () => {
				const start = (port: number) =>
					startOAuthCallbackServer({
						providerName: "OpenAI",
						host: "127.0.0.1",
						port,
						path: CALLBACK_PATH,
						state,
						complete: async (code) => code,
						signal,
						timeoutMs: LOGIN_CALLBACK_TIMEOUT_MS,
					});
				try {
					return await start(CALLBACK_PORTS[0]);
				} catch (firstError) {
					this.log.warn("codex login port 1455 busy, cancelling stale server", { error: String(firstError) });
					await fetch(`http://127.0.0.1:${CALLBACK_PORTS[0]}/cancel`).catch(() => undefined);
					try {
						return await start(CALLBACK_PORTS[0]);
					} catch {
						try {
							return await start(CALLBACK_PORTS[1]);
						} catch (lastError) {
							throw new AuthFlowError(
								this.id,
								"exchange-failure",
								`codex login callback ports ${CALLBACK_PORTS.join("/")} unavailable: ${String(lastError)}`,
							);
						}
					}
				}
			},
			buildAuthUrl: (redirectUri) => this.buildAuthorizeUrl(redirectUri, challenge, state),
			exchange: async (code, redirectUri) => this.exchangeCode(code, redirectUri, verifier),
		});
	}
}
