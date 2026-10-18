/**
 * Manual (paste-code) login flow — the runBrowserLogin analog without a callback
 * server: buildAuthUrl → onAuthUrl → promptCode (≤3 local re-prompts without
 * network on empty/unparsable input) → complete (parse + state-check + exchange) →
 * persist via FileCredentialStore.modifyGateway BEFORE return.
 * Error contract: AuthFlowError (user-cancel | timeout | exchange-failure);
 * persist errors are AuthLockError (rethrown as is). No servers/ports
 * are started here — this is the headless/SSH path.
 */

import type { Logger } from "@vanrel/telemetry";
import { AuthFlowError } from "../errors.ts";
import type { FileCredentialStore } from "../file-credential-store.ts";
import type { AuthProviderId, Credential } from "../gateway-types.ts";
import { GATEWAY_NOOP_LOGGER } from "../gateway-types.ts";
import { mapLoginError } from "./login.ts";

/** Maximum local code-entry attempts (empty/unparsable — re-prompt without network). */
export const MANUAL_CODE_MAX_ATTEMPTS = 3;

// ---- begin pi port (MIT License, Copyright (c) 2025 Mario Zechner) ----
// 1:1 port from pi: py/packages/ai/src/auth/oauth/anthropic.ts and openai-codex.ts
// (the functions are identical in both files).
/** Accepts a full URL (?code&state), code#state, code=..., or a bare code. */
export function parseAuthorizationInput(input: string): { code?: string; state?: string } {
	const value = input.trim();
	if (!value) return {};

	try {
		const url = new URL(value);
		return {
			code: url.searchParams.get("code") ?? undefined,
			state: url.searchParams.get("state") ?? undefined,
		};
	} catch {
		// not a URL
	}

	if (value.includes("#")) {
		const [code, state] = value.split("#", 2);
		return { code, state };
	}

	if (value.includes("code=")) {
		const params = new URLSearchParams(value);
		return {
			code: params.get("code") ?? undefined,
			state: params.get("state") ?? undefined,
		};
	}

	return { code: value };
}
// ---- end pi port ----

export interface ManualLoginSpec {
	provider: AuthProviderId;
	/** Authorization URL + instructions + prompt placeholder (per-provider, recon §4.3). */
	buildAuthUrl: () => { url: string; instructions: string; placeholder: string };
	/** parse + state-check + exchange → Credential (before persist). State mismatch — AuthFlowError(exchange-failure) BEFORE fetch. */
	complete: (input: string, signal?: AbortSignal) => Promise<Credential>;
	/** Manual-entry prompt (from LoginOptions); without it — AuthFlowError(user-cancel) immediately. */
	promptCode?: (prompt: { message: string; placeholder?: string }, signal: AbortSignal) => Promise<string>;
	store: FileCredentialStore;
	signal?: AbortSignal;
	onAuthUrl?: (url: string) => void;
	log?: Logger;
}

export async function runManualCodeLogin(spec: ManualLoginSpec): Promise<Credential> {
	const log = spec.log ?? GATEWAY_NOOP_LOGGER;
	if (!spec.promptCode) {
		throw new AuthFlowError(
			spec.provider,
			"user-cancel",
			`${spec.provider} paste-code login requires a promptCode callback`,
		);
	}
	const signal = spec.signal ?? new AbortController().signal;
	if (signal.aborted) throw new AuthFlowError(spec.provider, "user-cancel", `${spec.provider} login cancelled`);
	const promptCode = spec.promptCode;
	const { url, instructions, placeholder } = spec.buildAuthUrl();
	spec.onAuthUrl?.(url);
	log.info("manual code login flow started", { provider: spec.provider });
	try {
		for (let attempt = 1; attempt <= MANUAL_CODE_MAX_ATTEMPTS; attempt++) {
			const message =
				attempt === 1
					? instructions
					: `${instructions}\n(no authorization code in the previous input — try again, attempt ${attempt}/${MANUAL_CODE_MAX_ATTEMPTS})`;
			const input = await promptCode({ message, placeholder }, signal);
			// Local validation without network: code cannot be extracted → re-prompt (recon §4.5 item 3).
			if (!parseAuthorizationInput(input).code) {
				log.info("manual code input unparsable, re-prompting", { provider: spec.provider, attempt });
				continue;
			}
			const cred = await spec.complete(input, signal);
			// persist BEFORE return; AuthLockError is rethrown unwrapped (§4.2.1).
			const stored = await spec.store.modifyGateway(spec.provider, async () => ({
				...cred,
				source: { kind: "login-flow" },
			}));
			log.info("manual code login persisted", { provider: spec.provider, path: spec.store.path });
			return stored ?? cred;
		}
		throw new AuthFlowError(
			spec.provider,
			"user-cancel",
			`${spec.provider} login: no authorization code after ${MANUAL_CODE_MAX_ATTEMPTS} attempts`,
		);
	} catch (error) {
		throw mapLoginError(spec.provider, error, signal);
	}
}
