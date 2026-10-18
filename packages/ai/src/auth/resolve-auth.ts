/**
 * resolveAuth (§4.2.2): discovery of all providers in preferred order, refresh
 * when needed (§5.7 inside provider.refresh), result — ResolvedAuth.
 * Copying an external credential into vanrel-store happens only on the first
 * refresh (copy-on-refresh, §5.6); until written, foreign files are strictly read-only.
 *
 * §5.8 (explicit ban on paid API keys): this module does NOT read
 * ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY or similar variables;
 * subscription OAuth is the only credential source. (allowlist comment of the ban)
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Logger } from "@vanrel/telemetry";
import { FileCredentialStore } from "./file-credential-store.ts";
import type {
	AuthGatewayConfig,
	AuthProvider,
	AuthProviderId,
	Credential,
	GatewayProviderOptions,
	ResolveAuthOptions,
	ResolvedAuth,
} from "./gateway-types.ts";
import { AUTH_PROVIDER_IDS, GATEWAY_NOOP_LOGGER } from "./gateway-types.ts";
import { AgyAuthProvider } from "./providers/agy.ts";
import { AnthropicAuthProvider } from "./providers/anthropic.ts";
import { CodexAuthProvider } from "./providers/codex.ts";

interface VanrelConfig {
	preferred?: AuthProviderId[];
	auth?: AuthGatewayConfig;
}

/** ~/.vanrel/config.json (next to the store): best-effort, invalid → default + WARN. */
async function loadConfig(storePath: string, log: Logger): Promise<VanrelConfig> {
	const path = join(dirname(storePath), "config.json");
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		return {}; // no file — defaults
	}
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const config: VanrelConfig = {};
		if (Array.isArray(parsed.preferred)) {
			const preferred = parsed.preferred.filter((p): p is AuthProviderId =>
				(AUTH_PROVIDER_IDS as readonly string[]).includes(p as string),
			);
			if (preferred.length > 0) config.preferred = preferred;
		}
		const auth =
			typeof parsed.auth === "object" && parsed.auth !== null ? (parsed.auth as Record<string, unknown>) : null;
		if (auth) {
			config.auth = {};
			if (typeof auth.claudeProfilesDir === "boolean") config.auth.claudeProfilesDir = auth.claudeProfilesDir;
			const gemini =
				typeof auth.gemini === "object" && auth.gemini !== null ? (auth.gemini as Record<string, unknown>) : null;
			if (Array.isArray(gemini?.endpoints)) {
				config.auth.geminiEndpoints = gemini.endpoints.filter((e): e is string => typeof e === "string");
			}
		}
		return config;
	} catch (error) {
		log.warn("vanrel config unreadable, using defaults", { path, error: String(error) });
		return {};
	}
}

/** The three builtin providers of §5.1 over a shared FileCredentialStore (one lockfile). */
export function builtinAuthProviders(options?: GatewayProviderOptions): AuthProvider[] {
	const store = new FileCredentialStore({
		path: options?.storePath,
		now: options?.now,
		log: options?.log,
		lockTimeoutMs: options?.lockTimeoutMs,
		lockStaleMs: options?.lockStaleMs,
	});
	return [
		new AnthropicAuthProvider(store, options),
		new AgyAuthProvider(store, options),
		new CodexAuthProvider(store, options),
	];
}

export async function resolveAuth(options?: ResolveAuthOptions): Promise<ResolvedAuth> {
	const log = options?.log ?? GATEWAY_NOOP_LOGGER;
	const now = options?.now ?? Date.now;
	const storePath = options?.storePath ?? join(homedir(), ".vanrel", "auth.json");
	const config = await loadConfig(storePath, log);
	const adoptExternal = options?.adoptExternal ?? true;
	const providers =
		options?.providers ??
		builtinAuthProviders({ storePath, config: config.auth, adoptExternal, now: options?.now, log });
	const byId = new Map(providers.map((p) => [p.id, p]));
	const preferred = [...new Set(options?.preferred ?? config.preferred ?? [...AUTH_PROVIDER_IDS])];

	const byProvider = new Map<AuthProviderId, Credential>();
	const skipped: { provider: AuthProviderId; reason: string }[] = [];
	for (const id of preferred) {
		const provider = byId.get(id);
		if (!provider) {
			skipped.push({ provider: id, reason: "no such auth provider" });
			continue;
		}
		let cred: Credential | null;
		try {
			cred = await provider.discover();
		} catch (error) {
			skipped.push({
				provider: id,
				reason: `discover failed: ${error instanceof Error ? error.message : String(error)}`,
			});
			continue;
		}
		if (!cred) {
			skipped.push({ provider: id, reason: "no credential discovered" });
			continue;
		}
		if (provider.needsRefresh(cred, now())) {
			try {
				cred = await provider.refresh(cred);
			} catch (error) {
				skipped.push({
					provider: id,
					reason: `refresh failed: ${error instanceof Error ? error.message : String(error)}`,
				});
				continue;
			}
		}
		byProvider.set(id, cred);
	}
	log.info("auth resolved", {
		available: [...byProvider.keys()],
		skipped: skipped.map((s) => `${s.provider}: ${s.reason}`),
	});
	return { byProvider, skipped };
}
