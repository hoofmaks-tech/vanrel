/**
 * Subscription Auth Gateway types.
 * The `Credential`/`AuthProvider` names here are the §4.2.1 contract; the vendored
 * pi-ai `Credential` (union ApiKeyCredential|OAuthCredential) lives in ./types.ts and
 * does not intersect with this layer (disambiguated via alias in the main index.ts).
 */

import type { Logger } from "@vanrel/telemetry";

export type AuthProviderId = "anthropic" | "agy" | "codex";

export const AUTH_PROVIDER_IDS: readonly AuthProviderId[] = ["anthropic", "agy", "codex"];

export type CredentialSource =
	| { kind: "vanrel-store"; path: string } // ~/.vanrel/auth.json (our only write target)
	| { kind: "external-file"; path: string } // ~/.claude/.credentials.json, ~/.gemini/oauth_creds.json, ~/.codex/auth.json — READ-ONLY adopt
	| { kind: "env"; name: string } // CLAUDE_CODE_OAUTH_TOKEN, GOOGLE_APPLICATION_CREDENTIALS
	| { kind: "login-flow" }; // interactive login of this session

export interface Credential {
	provider: AuthProviderId;
	type: "oauth";
	accessToken: string;
	refreshToken: string;
	expiresAt: number; // ms epoch; access-token TTL
	refreshExpiresAt?: number; // anthropic: ~24h from login (§5.2)
	scopes?: string[];
	accountId?: string; // codex: chatgpt_account_id from JWT claim
	idToken?: string; // codex: raw id_token
	source: CredentialSource;
	extra?: Record<string, unknown>; // provider-specific data (subscriptionType, planType, tokenEndpoint, …)
}

/** Interactive login options (§4.2.1). flow default "loopback" — behavior without flow is unchanged. */
export interface LoginOptions {
	signal?: AbortSignal;
	onAuthUrl?: (url: string) => void;
	/** "loopback" — local callback server (default); "paste-code" — manual code entry (headless/SSH). */
	flow?: "loopback" | "paste-code";
	/** Required with flow="paste-code"; without it — AuthFlowError(provider, "user-cancel") immediately. */
	promptCode?: (prompt: { message: string; placeholder?: string }, signal: AbortSignal) => Promise<string>;
}

export interface AuthProvider {
	readonly id: AuthProviderId;
	/** true = "paste-code" flow supported (runManualCodeLogin); true for all builtins. */
	readonly supportsPasteCode: boolean;
	/** Credential discovery: vanrel-store → env → external files (in §5.6 order).
	    Read-only for foreign files. null = provider unavailable on this machine. */
	discover(): Promise<Credential | null>;
	/** Refresh under lockfile with double-check (§5.7). Refresh-token rotation: the new token
	    is persisted BEFORE the lock is released. signal cancels only the lock wait, not the refresh itself. */
	refresh(cred: Credential, signal?: AbortSignal): Promise<Credential>;
	/** Threshold: expiresAt − now < 5 min (DEFAULT_OAUTH_MINIMUM_VALIDITY_MS from pi-ai). */
	needsRefresh(cred: Credential, now?: number): boolean;
	/** Mapping to transport: headers + upstream baseUrl (§5.x per provider). */
	toRequestAuth(cred: Credential): { headers: Record<string, string>; baseUrl: string };
	/** Interactive login (PKCE loopback / paste-code). Error contract: AuthFlowError
	    (user-cancel | timeout | exchange-failure); on persist error — AuthLockError. */
	login?(options?: LoginOptions): Promise<Credential>;
}

/** §4.2.1: access-token validity threshold (pi-ai DEFAULT_OAUTH_MINIMUM_VALIDITY_MS). */
export const DEFAULT_OAUTH_MINIMUM_VALIDITY_MS = 5 * 60 * 1000;

/** Provider-independent construction options for builtin providers. */
export interface AuthGatewayConfig {
	/** §8 R-4: ~/.claude/profiles/<name>/.credentials.json — UNVERIFIED, disabled by default. */
	claudeProfilesDir?: boolean;
	/** §8 R-6: Code Assist endpoint cascade for agy; 403/404 → next. */
	geminiEndpoints?: string[];
}

/** Options for builtinAuthProviders(); homeDir/env/fetchFn injections are for tests (tempdir, mocks). */
export interface GatewayProviderOptions {
	storePath?: string; // default ~/.vanrel/auth.json
	homeDir?: string; // default os.homedir()
	env?: (name: string) => string | undefined; // default process.env
	config?: AuthGatewayConfig; // from ~/.vanrel/config.json → auth.*
	adoptExternal?: boolean; // default true; false = vanrel-store only (§4.2.2)
	now?: () => number;
	log?: Logger;
	lockTimeoutMs?: number; // §5.7 default 10_000
	lockStaleMs?: number; // §5.7 default 60_000
}

/* ---------- QuotaLedger (§4.2.3) ---------- */

export interface UsageRecord {
	ts: number;
	provider: AuthProviderId;
	model: string;
	inputTokens: number;
	outputTokens: number;
}

export interface UsageProbe {
	// anthropic /api/oauth/usage; fields UNVERIFIED (§8 R-5) → all optional
	ts: number;
	fiveHourUtilization?: number; // 0..1
	weeklyUtilization?: number; // 0..1
	fiveHourResetsAt?: number;
	weeklyResetsAt?: number;
}

export interface ProviderQuotaState {
	provider: AuthProviderId;
	window: { start: number; requests: number; inputTokens: number; outputTokens: number };
	blockedUntil: number | null; // from 429 Retry-After or probe.resetsAt
	lastProbe?: UsageProbe;
}

export interface QuotaLedgerOptions {
	filePath?: string; // default ~/.vanrel/quota.json
	windowMs?: number; // default 5 * 3600_000
	retainMs?: number; // default 7 * 24 * 3600_000 (anthropic weekly window), older — pruned
	now?: () => number;
	log?: Logger;
}

/* ---------- ProviderRouter (§4.2.4) ---------- */

export interface RouteRequest {
	model?: string; // alias ("default" | "cheap" | explicit model id)
	signal?: AbortSignal;
}

export interface RoutedTarget {
	provider: AuthProviderId;
	model: string; // concrete id from the catalog
	credential: Credential;
	attempt: number; // 0 = primary choice
}

export interface RoutingPolicy {
	order: AuthProviderId[]; // default from ResolveAuthOptions.preferred
	modelAliases: Record<string, Partial<Record<AuthProviderId, string>>>; // "default" → per-provider model id
	transientBackoffMs?: number[]; // default [1000, 4000, 15000]
}

/* ---------- resolveAuth (§4.2.2) ---------- */

export interface ResolveAuthOptions {
	storePath?: string; // default ~/.vanrel/auth.json
	providers?: AuthProvider[]; // default: builtinAuthProviders() (§5)
	preferred?: AuthProviderId[]; // from ~/.vanrel/config.json; default ["anthropic","agy","codex"]
	adoptExternal?: boolean; // default true; false = vanrel-store only
	now?: () => number;
	log?: Logger;
}

export interface ResolvedAuth {
	byProvider: Map<AuthProviderId, Credential>; // only valid ones (after refresh if needed)
	skipped: { provider: AuthProviderId; reason: string }[]; // for the status command, not silent (I5)
}

/** Local NOOP (Logger type is import type per contract, no telemetry runtime import). */
export const GATEWAY_NOOP_LOGGER: Logger = Object.freeze({
	debug: (): void => {},
	info: (): void => {},
	warn: (): void => {},
	error: (): void => {},
});
