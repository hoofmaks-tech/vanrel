/**
 * Shared provider primitives: tolerant reading of foreign JSON (§8.2 — retry on
 * races with foreign tmp+rename writes), JWT decode, HTTP helpers. Foreign files
 * are STRICTLY read-only; no requests to paid key-based APIs (§5.8: variables like
 * ANTHROPIC_/OPENAI_/GEMINI_API_KEY are neither read nor used here).
 */

import { readFile } from "node:fs/promises";
import type { Logger } from "@vanrel/telemetry";
import { GATEWAY_NOOP_LOGGER } from "../gateway-types.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface ReadExternalOptions {
	log?: Logger;
	/** Total attempts (first read + retries on JSON parse error). Default 3 (§8.2: retry 2×). */
	attempts?: number;
	retryDelayMs?: number; // default 100
}

/**
 * Reads and parses a foreign JSON read-only. ENOENT → undefined (silent).
 * JSON parse error → retry with a pause (race with a foreign atomic write); on
 * repeated failure — undefined + DEBUG (§8.2). Other read errors → undefined + WARN.
 */
export async function readExternalJson(path: string, options?: ReadExternalOptions): Promise<unknown> {
	const log = options?.log ?? GATEWAY_NOOP_LOGGER;
	const attempts = options?.attempts ?? 3;
	const delay = options?.retryDelayMs ?? 100;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		let raw: string;
		try {
			raw = await readFile(path, "utf8");
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") return undefined;
			log.warn("external credential file unreadable", { path, error: String(error) });
			return undefined;
		}
		try {
			return JSON.parse(raw) as unknown;
		} catch (error) {
			if (attempt < attempts) {
				log.debug("external credential file parse failed, retrying", { path, attempt, error: String(error) });
				await sleep(delay);
				continue;
			}
			log.debug("external credential file parse failed, skipping", { path, attempts, error: String(error) });
			return undefined;
		}
	}
	return undefined;
}

/** base64url-safe decode of a JWT payload; null on any invalidity (tolerant parser). */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;
		const payload = parts[1] ?? "";
		const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
		const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
		return JSON.parse(atob(padded)) as Record<string, unknown>;
	} catch {
		return null;
	}
}

/** Claim object by name (codex: "https://api.openai.com/auth"); null if missing/not an object. */
export function jwtClaim(payload: Record<string, unknown> | null, name: string): Record<string, unknown> | null {
	const value = payload?.[name];
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** Numeric exp claim of a JWT in ms epoch; null if absent. */
export function jwtExpiresAtMs(token: string): number | null {
	const exp = decodeJwtPayload(token)?.exp;
	return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
}

export interface TokenHttpResponse {
	status: number;
	bodyText: string;
	json: Record<string, unknown> | null;
}

/**
 * POST to a token endpoint via globalThis.fetch (late binding → tests
 * intercept globalThis.fetch). Never retries on its own — retries/classification
 * are the provider's job. The response body is always read (for §8 R-3 ERROR logs).
 */
export async function postTokenEndpoint(
	url: string,
	body: { json: Record<string, unknown> } | { form: Record<string, string> },
	signal: AbortSignal,
): Promise<TokenHttpResponse> {
	const init: RequestInit =
		"json" in body
			? {
					method: "POST",
					headers: { "Content-Type": "application/json", Accept: "application/json" },
					body: JSON.stringify(body.json),
					signal,
				}
			: {
					method: "POST",
					headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
					body: new URLSearchParams(body.form).toString(),
					signal,
				};
	const response = await fetch(url, init);
	const bodyText = await response.text().catch(() => "");
	let json: Record<string, unknown> | null = null;
	try {
		const parsed = JSON.parse(bodyText) as unknown;
		if (typeof parsed === "object" && parsed !== null) json = parsed as Record<string, unknown>;
	} catch {
		// non-JSON token endpoint response — classified by the caller via status/bodyText
	}
	return { status: response.status, bodyText, json };
}

/** OAuth error code from the body ({error:"invalid_grant"} or {error:{code:"…"}}); null if absent. */
export function oauthErrorCode(json: Record<string, unknown> | null): string | null {
	const error = json?.error;
	if (typeof error === "string") return error;
	if (typeof error === "object" && error !== null) {
		const code = (error as Record<string, unknown>).code;
		if (typeof code === "string") return code;
	}
	return null;
}
