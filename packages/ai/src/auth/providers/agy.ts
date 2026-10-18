/**
 * agy (Antigravity / Gemini CLI) — §5.1/§5.3.
 * Discovery (§5.6): vanrel-store → ~/.gemini/oauth_creds.json (read-only) →
 * env GOOGLE_APPLICATION_CREDENTIALS (ADC; service_account JWT-bearer ~80 LOC
 * without google-auth-library, authorized_user — standard refresh grant).
 * The Antigravity path = the same Gemini OAuth credentials + Code Assist upstream (R-6).
 */

import { sign as cryptoSign, randomBytes } from "node:crypto";
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
import { oauthErrorCode, postTokenEndpoint, readExternalJson } from "./shared.ts";

const CLIENT_ID = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com";
// Public "installed application" secret from gemini-cli (§5.1) — not a paid key.
const CLIENT_SECRET = "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";
const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
].join(" ");
const CALLBACK_PATH = "/oauth2callback";
/** Paste-code flow (recon §4.3): hosted authcode page of Google (NOT the dead OOB), no server is started. */
const MANUAL_REDIRECT_URI = "https://codeassist.google.com/authcode";

/** R-6: Code Assist endpoint cascade; 403/404 → next (M8 transport). */
export const DEFAULT_GEMINI_ENDPOINTS = [
	"https://cloudcode-pa.googleapis.com",
	"https://autopush-cloudcode-pa.sandbox.googleapis.com",
] as const;

type AdcMaterial =
	| { kind: "service_account"; clientEmail: string; privateKey: string; tokenUri: string }
	| { kind: "authorized_user"; clientId: string; clientSecret: string; refreshToken: string };

function base64url(input: string | Buffer): string {
	return Buffer.from(input).toString("base64url");
}

export class AgyAuthProvider implements AuthProvider {
	readonly id = "agy" as const;
	readonly supportsPasteCode = true;
	private readonly store: FileCredentialStore;
	private readonly homeDir: () => string;
	private readonly env: (name: string) => string | undefined;
	private readonly endpoints: string[];
	private readonly adoptExternal: boolean;
	private readonly now: () => number;
	private readonly log: Logger;

	constructor(store: FileCredentialStore, options?: GatewayProviderOptions) {
		this.store = store;
		this.homeDir = () => options?.homeDir ?? homedir();
		this.env = options?.env ?? ((name) => process.env[name]);
		this.endpoints = options?.config?.geminiEndpoints ?? [...DEFAULT_GEMINI_ENDPOINTS];
		this.adoptExternal = options?.adoptExternal ?? true;
		this.now = options?.now ?? Date.now;
		this.log = options?.log ?? GATEWAY_NOOP_LOGGER;
	}

	async discover(): Promise<Credential | null> {
		// 1) vanrel-store
		const stored = await this.store.readGateway(this.id);
		if (stored) return stored;
		if (!this.adoptExternal) return null;

		// 2) ~/.gemini/oauth_creds.json (read-only, google-auth-library Credentials)
		const credsPath = join(this.homeDir(), ".gemini", "oauth_creds.json");
		const creds = await readExternalJson(credsPath, { log: this.log });
		if (typeof creds === "object" && creds !== null) {
			const c = creds as Record<string, unknown>;
			if (typeof c.access_token === "string" && typeof c.refresh_token === "string") {
				const cred: Credential = {
					provider: this.id,
					type: "oauth",
					accessToken: c.access_token,
					refreshToken: c.refresh_token,
					expiresAt: typeof c.expiry_date === "number" ? c.expiry_date : 0,
					source: { kind: "external-file", path: credsPath },
				};
				if (typeof c.scope === "string") cred.scopes = c.scope.split(" ").filter(Boolean);
				if (typeof c.id_token === "string") cred.idToken = c.id_token;
				return cred;
			}
			this.log.debug("agy oauth_creds.json unrecognized shape, skipping", {
				path: credsPath,
				keys: Object.keys(c),
			});
		}

		// 3) env GOOGLE_APPLICATION_CREDENTIALS (ADC)
		const adcPath = this.env("GOOGLE_APPLICATION_CREDENTIALS");
		if (adcPath) {
			const adc = await readExternalJson(adcPath, { log: this.log });
			const cred = this.credentialFromAdc(adc, adcPath);
			if (cred) return cred;
		}
		return null;
	}

	/** ADC JSON → Credential (type service_account / authorized_user; anything else → skip). */
	private credentialFromAdc(data: unknown, path: string): Credential | null {
		if (typeof data !== "object" || data === null) return null;
		const adc = data as Record<string, unknown>;
		if (
			adc.type === "service_account" &&
			typeof adc.client_email === "string" &&
			typeof adc.private_key === "string"
		) {
			return {
				provider: this.id,
				type: "oauth",
				accessToken: "", // empty → immediate JWT-bearer exchange on the first refresh
				refreshToken: "",
				expiresAt: 0,
				source: { kind: "env", name: "GOOGLE_APPLICATION_CREDENTIALS" },
				extra: {
					adc: {
						kind: "service_account",
						clientEmail: adc.client_email,
						privateKey: adc.private_key,
						tokenUri: typeof adc.token_uri === "string" ? adc.token_uri : TOKEN_URL,
					} satisfies AdcMaterial,
				},
			};
		}
		if (
			adc.type === "authorized_user" &&
			typeof adc.client_id === "string" &&
			typeof adc.client_secret === "string" &&
			typeof adc.refresh_token === "string"
		) {
			return {
				provider: this.id,
				type: "oauth",
				accessToken: "",
				refreshToken: adc.refresh_token,
				expiresAt: 0,
				source: { kind: "env", name: "GOOGLE_APPLICATION_CREDENTIALS" },
				extra: {
					adc: {
						kind: "authorized_user",
						clientId: adc.client_id,
						clientSecret: adc.client_secret,
						refreshToken: adc.refresh_token,
					} satisfies AdcMaterial,
				},
			};
		}
		this.log.debug("ADC file unsupported type, skipping", { path, type: adc.type });
		return null;
	}

	needsRefresh(cred: Credential, now?: number): boolean {
		return cred.expiresAt - (now ?? this.now()) < DEFAULT_OAUTH_MINIMUM_VALIDITY_MS;
	}

	toRequestAuth(cred: Credential): { headers: Record<string, string>; baseUrl: string } {
		return {
			headers: { authorization: `Bearer ${cred.accessToken}` },
			baseUrl: this.endpoints[0] ?? DEFAULT_GEMINI_ENDPOINTS[0],
		};
	}

	async refresh(cred: Credential, signal?: AbortSignal): Promise<Credential> {
		const result = await this.store.modifyGateway(
			this.id,
			async (current) => {
				const effective = current ?? cred; // §5.7 double-check: the store is authoritative
				if (!this.needsRefresh(effective)) {
					this.log.debug("agy refresh skipped (fresh credential under lock)", {
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

	private async doRefresh(cred: Credential): Promise<Credential> {
		const adc = cred.extra?.adc as AdcMaterial | undefined;
		const response =
			adc?.kind === "service_account"
				? await postTokenEndpoint(
						adc.tokenUri,
						{
							form: {
								grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
								assertion: this.createJwtBearer(adc),
							},
						},
						AbortSignal.timeout(15_000),
					).catch((error) => {
						throw new AuthFlowError(
							this.id,
							"exchange-failure",
							`agy ADC jwt-bearer exchange network error: ${String(error)}`,
						);
					})
				: await postTokenEndpoint(
						TOKEN_URL,
						{
							form: {
								client_id: adc?.kind === "authorized_user" ? adc.clientId : CLIENT_ID,
								client_secret: adc?.kind === "authorized_user" ? adc.clientSecret : CLIENT_SECRET,
								grant_type: "refresh_token",
								refresh_token: adc?.kind === "authorized_user" ? adc.refreshToken : cred.refreshToken,
							},
						},
						AbortSignal.timeout(15_000),
					).catch((error) => {
						throw new AuthFlowError(this.id, "exchange-failure", `agy refresh network error: ${String(error)}`);
					});

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
				`agy refresh rejected (${response.status}${errorCode ? ` ${errorCode}` : ""}): ${response.bodyText}`,
			);
		}
		if (response.status < 200 || response.status >= 300 || !response.json) {
			throw new AuthFlowError(
				this.id,
				"exchange-failure",
				`agy refresh failed (${response.status}): ${response.bodyText}`,
			);
		}
		const json = response.json;
		if (typeof json.access_token !== "string" || typeof json.expires_in !== "number") {
			throw new AuthFlowError(this.id, "exchange-failure", `agy refresh malformed response: ${response.bodyText}`);
		}
		const next: Credential = {
			...cred,
			accessToken: json.access_token,
			expiresAt: this.now() + json.expires_in * 1000,
			source: { kind: "vanrel-store", path: this.store.path },
		};
		// Google usually does NOT rotate refresh_token; if one is sent — persist it (§5.7).
		if (typeof json.refresh_token === "string") next.refreshToken = json.refresh_token;
		if (typeof json.scope === "string") next.scopes = json.scope.split(" ").filter(Boolean);
		if (typeof json.id_token === "string") next.idToken = json.id_token;
		this.log.info("agy token refreshed", { adc: adc?.kind ?? "oauth_creds" });
		return next;
	}

	/** Minimal JWT-bearer (RS256) for service_account ADC — §5.3, without google-auth-library. */
	private createJwtBearer(adc: Extract<AdcMaterial, { kind: "service_account" }>): string {
		const nowSec = Math.floor(this.now() / 1000);
		const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
		const payload = base64url(
			JSON.stringify({ iss: adc.clientEmail, scope: SCOPES, aud: adc.tokenUri, iat: nowSec, exp: nowSec + 3600 }),
		);
		const signature = cryptoSign("RSA-SHA256", Buffer.from(`${header}.${payload}`), adc.privateKey);
		return `${header}.${payload}.${base64url(signature)}`;
	}

	/** code → Credential (form POST, client_secret required); shared by loopback and paste-code.
	    codeVerifier — only for the user-code headless flow (web flow without PKCE, §5.1). */
	private async exchangeCode(code: string, redirectUri: string, codeVerifier?: string): Promise<Credential> {
		const form: Record<string, string> = {
			code,
			client_id: CLIENT_ID,
			client_secret: CLIENT_SECRET,
			redirect_uri: redirectUri,
			grant_type: "authorization_code",
		};
		if (codeVerifier) form.code_verifier = codeVerifier;
		const response = await postTokenEndpoint(TOKEN_URL, { form }, AbortSignal.timeout(15_000)).catch((error) => {
			throw new AuthFlowError(this.id, "exchange-failure", `agy exchange network error: ${String(error)}`);
		});
		if (response.status < 200 || response.status >= 300 || !response.json) {
			throw new AuthFlowError(
				this.id,
				"exchange-failure",
				`agy exchange failed (${response.status}): ${response.bodyText}`,
			);
		}
		const json = response.json;
		if (typeof json.access_token !== "string" || typeof json.expires_in !== "number") {
			throw new AuthFlowError(this.id, "exchange-failure", `agy exchange malformed: ${response.bodyText}`);
		}
		if (typeof json.refresh_token !== "string") {
			throw new AuthFlowError(this.id, "exchange-failure", "agy exchange returned no refresh_token");
		}
		const cred: Credential = {
			provider: this.id,
			type: "oauth",
			accessToken: json.access_token,
			refreshToken: json.refresh_token,
			expiresAt: this.now() + json.expires_in * 1000,
			source: { kind: "login-flow" },
		};
		if (typeof json.scope === "string") cred.scopes = json.scope.split(" ").filter(Boolean);
		if (typeof json.id_token === "string") cred.idToken = json.id_token;
		return cred;
	}

	async login(options?: LoginOptions): Promise<Credential> {
		const state = randomBytes(16).toString("hex");
		const signal = options?.signal;
		if (options?.flow === "paste-code") {
			// gemini-cli user-code flow: PKCE (S256) + client_secret + hosted authcode page (recon §4.3).
			const { verifier, challenge } = await generatePKCE();
			const manualState = randomBytes(32).toString("hex");
			return runManualCodeLogin({
				provider: this.id,
				store: this.store,
				signal,
				onAuthUrl: options.onAuthUrl,
				promptCode: options.promptCode,
				log: this.log,
				buildAuthUrl: () => {
					const params = new URLSearchParams({
						client_id: CLIENT_ID,
						redirect_uri: MANUAL_REDIRECT_URI,
						response_type: "code",
						scope: SCOPES,
						access_type: "offline",
						state: manualState,
						code_challenge: challenge,
						code_challenge_method: "S256",
					});
					return {
						url: `${AUTHORIZE_URL}?${params.toString()}`,
						instructions:
							"Complete login in your browser, then copy the authorization code shown on the page and paste it here.",
						placeholder: "authorization code",
					};
				},
				complete: async (input) => {
					const code = parseAuthorizationInput(input).code;
					if (!code) {
						throw new AuthFlowError(this.id, "exchange-failure", "agy login: missing authorization code");
					}
					return this.exchangeCode(code, MANUAL_REDIRECT_URI, verifier);
				},
			});
		}
		return runBrowserLogin({
			provider: this.id,
			store: this.store,
			signal,
			onAuthUrl: options?.onAuthUrl,
			log: this.log,
			startServer: () => {
				const portEnv = this.env("OAUTH_CALLBACK_PORT");
				const port = portEnv ? Number.parseInt(portEnv, 10) : 0;
				return startOAuthCallbackServer({
					providerName: "Google",
					host: this.env("OAUTH_CALLBACK_HOST") || "127.0.0.1",
					port: Number.isFinite(port) ? port : 0,
					path: CALLBACK_PATH,
					state,
					complete: async (code) => code,
					signal,
					timeoutMs: LOGIN_CALLBACK_TIMEOUT_MS,
				});
			},
			// Web-flow WITHOUT PKCE (§5.1); PKCE — only for the user-code headless flow.
			buildAuthUrl: (redirectUri) => {
				const params = new URLSearchParams({
					client_id: CLIENT_ID,
					redirect_uri: redirectUri,
					response_type: "code",
					scope: SCOPES,
					access_type: "offline",
					prompt: "consent",
					state,
				});
				return `${AUTHORIZE_URL}?${params.toString()}`;
			},
			exchange: async (code, redirectUri) => this.exchangeCode(code, redirectUri),
		});
	}
}
