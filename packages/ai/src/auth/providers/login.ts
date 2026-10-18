/**
 * Shared skeleton of the interactive browser login (§4.2.1 login): loopback callback
 * server → onAuthUrl → wait → exchange → persist into FileCredentialStore.
 * Error contract: AuthFlowError (user-cancel | timeout | exchange-failure);
 * persist errors are AuthLockError (rethrown as is). No unchecked
 * types escape to the outside.
 */

import type { Logger } from "@vanrel/telemetry";
import { AuthFlowError, AuthLockError } from "../errors.ts";
import type { FileCredentialStore } from "../file-credential-store.ts";
import type { AuthProviderId, Credential } from "../gateway-types.ts";
import { GATEWAY_NOOP_LOGGER } from "../gateway-types.ts";
import type { OAuthCallbackServer } from "../oauth/callback-server.ts";

export const LOGIN_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

export interface BrowserLoginSpec {
	provider: AuthProviderId;
	/** Canonical redirect_uri (for exchange); matches the actual listener. */
	startServer: () => Promise<OAuthCallbackServer<string>>;
	buildAuthUrl: (redirectUri: string) => string;
	/** code → Credential (before persist); signal here is a plain abort, without lock cancellation. */
	exchange: (code: string, redirectUri: string) => Promise<Credential>;
	store: FileCredentialStore;
	signal?: AbortSignal;
	onAuthUrl?: (url: string) => void;
	log?: Logger;
}

/** Maps login-flow errors to the §4.2.1 contract (AuthFlowError/AuthLockError are rethrown as is). */
export function mapLoginError(
	provider: AuthProviderId,
	error: unknown,
	signal?: AbortSignal,
): AuthFlowError | AuthLockError {
	if (error instanceof AuthFlowError || error instanceof AuthLockError) return error;
	const message = error instanceof Error ? error.message : String(error);
	if (signal?.aborted || /cancelled|canceled|aborted/i.test(message)) {
		return new AuthFlowError(provider, "user-cancel", `${provider} login cancelled`);
	}
	if (/timed out|timeout/i.test(message)) {
		return new AuthFlowError(provider, "timeout", `${provider} login timed out`);
	}
	return new AuthFlowError(provider, "exchange-failure", `${provider} login failed: ${message}`);
}

export async function runBrowserLogin(spec: BrowserLoginSpec): Promise<Credential> {
	const log = spec.log ?? GATEWAY_NOOP_LOGGER;
	let server: OAuthCallbackServer<string>;
	try {
		server = await spec.startServer();
	} catch (error) {
		throw mapLoginError(spec.provider, error, spec.signal);
	}
	try {
		spec.onAuthUrl?.(spec.buildAuthUrl(server.redirectUri));
		log.info("login flow started", { provider: spec.provider, redirectUri: server.redirectUri });
		const code = await server.wait();
		if (code === undefined) throw new AuthFlowError(spec.provider, "user-cancel", `${spec.provider} login cancelled`);
		const cred = await spec.exchange(code, server.redirectUri);
		// persist BEFORE return; AuthLockError is rethrown unwrapped (§4.2.1).
		const stored = await spec.store.modifyGateway(spec.provider, async () => ({
			...cred,
			source: { kind: "login-flow" },
		}));
		log.info("login flow persisted", { provider: spec.provider, path: spec.store.path });
		return stored ?? cred;
	} catch (error) {
		throw mapLoginError(spec.provider, error, spec.signal);
	} finally {
		server.close();
	}
}
