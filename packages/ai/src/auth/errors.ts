/**
 * Auth-layer errors of the Subscription Auth Gateway.
 * All extend Error: stack and instanceof work, `this.name` is set explicitly
 * (erasableSyntaxOnly → no parameter properties, fields declared separately).
 */

import type { AuthProviderId } from "./gateway-types.ts";

/** §5.7: lockfile wait timeout (10s) — refresh is serialized, waiting further is not allowed. */
export class AuthLockError extends Error {
	readonly kind = "auth-lock";
	constructor(message: string) {
		super(message);
		this.name = "AuthLockError";
	}
}

export type AuthFlowErrorReason = "user-cancel" | "timeout" | "exchange-failure" | "revoked";

/** Interactive login and refresh: the only checked flow error type (§4.2.1). */
export class AuthFlowError extends Error {
	readonly kind = "auth-flow";
	readonly provider: AuthProviderId;
	readonly reason: AuthFlowErrorReason;
	constructor(provider: AuthProviderId, reason: AuthFlowErrorReason, message: string) {
		super(message);
		this.name = "AuthFlowError";
		this.provider = provider;
		this.reason = reason;
	}
}

export type RouteErrorReason =
	| { kind: "quota"; provider: AuthProviderId; retryAfterMs: number | null }
	| { kind: "auth"; provider: AuthProviderId; permanent: boolean; message: string }
	| { kind: "transient"; provider: AuthProviderId; message: string };

/** The only routing error (§4.2.4). */
export class RouteError extends Error {
	readonly reason: RouteErrorReason;
	constructor(reason: RouteErrorReason) {
		super(`${reason.kind}: ${reason.provider}${"message" in reason ? ` — ${reason.message}` : ""}`);
		this.name = "RouteError";
		this.reason = reason;
	}
}
