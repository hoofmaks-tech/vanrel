/**
 * ProviderRouter — failover per §4.2.4: quota → recordExhaustion + next
 * provider; auth/permanent → excluded until the end of the session; transient →
 * backoff [1000,4000,15000] → same provider. The only hard availability
 * criterion is QuotaLedger.available (§4.2.3).
 */

import type { Logger } from "@vanrel/telemetry";
import { RouteError } from "./errors.ts";
import type {
	AuthProviderId,
	ResolvedAuth,
	RoutedTarget,
	RouteRequest,
	RoutingPolicy,
	UsageRecord,
} from "./gateway-types.ts";
import { AUTH_PROVIDER_IDS, GATEWAY_NOOP_LOGGER } from "./gateway-types.ts";
import type { QuotaLedger } from "./quota-ledger.ts";

/** Default aliases → ids from the vendored model catalog (src/providers/*.models.ts). */
export const DEFAULT_MODEL_ALIASES: Record<string, Partial<Record<AuthProviderId, string>>> = {
	default: { anthropic: "claude-sonnet-5-5", agy: "gemini-4-argon", codex: "gpt-6.1-sol" },
	cheap: { anthropic: "claude-haiku-5-5", agy: "gemini-3.8-flash", codex: "gpt-6-luna" },
};

const DEFAULT_TRANSIENT_BACKOFF_MS = [1000, 4000, 15000];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class ProviderRouter {
	private readonly auth: ResolvedAuth;
	private readonly quota: QuotaLedger;
	private readonly order: AuthProviderId[];
	private readonly modelAliases: Record<string, Partial<Record<AuthProviderId, string>>>;
	private readonly backoff: number[];
	private readonly log: Logger;
	/** auth/permanent: excluded until the end of the session (§4.2.4). */
	private readonly excluded = new Set<AuthProviderId>();
	private readonly attempts = new Map<AuthProviderId, number>();

	constructor(deps: { auth: ResolvedAuth; quota: QuotaLedger; policy?: Partial<RoutingPolicy>; log?: Logger }) {
		this.auth = deps.auth;
		this.quota = deps.quota;
		this.order = deps.policy?.order ?? [...AUTH_PROVIDER_IDS];
		this.modelAliases = deps.policy?.modelAliases ?? DEFAULT_MODEL_ALIASES;
		this.backoff = deps.policy?.transientBackoffMs ?? DEFAULT_TRANSIENT_BACKOFF_MS;
		this.log = deps.log ?? GATEWAY_NOOP_LOGGER;
	}

	private resolveModel(requested: string, provider: AuthProviderId): string | undefined {
		const alias = this.modelAliases[requested];
		if (alias === undefined) return requested; // explicit model id — used as is
		return alias[provider] ?? this.modelAliases.default?.[provider];
	}

	/** First provider from order with credential + quota.available(); none → RouteError quota. */
	route(req: RouteRequest): RoutedTarget {
		req.signal?.throwIfAborted();
		const requested = req.model ?? "default";
		const blocked: { provider: AuthProviderId; retryAfterMs: number | null }[] = [];
		for (const provider of this.order) {
			if (this.excluded.has(provider)) continue;
			const credential = this.auth.byProvider.get(provider);
			if (!credential) continue;
			const model = this.resolveModel(requested, provider);
			if (model === undefined) continue;
			if (!this.quota.available(provider)) {
				blocked.push({ provider, retryAfterMs: this.retryAfterMs(provider) });
				continue;
			}
			return { provider, model, credential, attempt: this.attempts.get(provider) ?? 0 };
		}
		const first = blocked[0];
		const reason = {
			kind: "quota" as const,
			provider: first?.provider ?? this.order[0] ?? "anthropic",
			retryAfterMs: first?.retryAfterMs ?? null,
		};
		this.log.warn("router: no provider available", { reason, skipped: this.auth.skipped });
		throw new RouteError(reason);
	}

	private retryAfterMs(provider: AuthProviderId): number | null {
		const state = this.quota.peek(provider)[0];
		if (state?.blockedUntil == null) return null;
		return Math.max(0, state.blockedUntil - Date.now());
	}

	/** → quota.record; resets the provider's transient counter. */
	async reportSuccess(t: RoutedTarget, usage: UsageRecord): Promise<void> {
		this.attempts.delete(t.provider);
		await this.quota.record(usage);
	}

	async reportFailure(t: RoutedTarget, err: RouteError): Promise<void> {
		const reason = err.reason;
		switch (reason.kind) {
			case "quota": {
				this.attempts.delete(t.provider);
				const blockedUntil = reason.retryAfterMs != null ? Date.now() + reason.retryAfterMs : null;
				this.log.info("router: quota exhausted, failover", {
					provider: t.provider,
					retryAfterMs: reason.retryAfterMs,
				});
				await this.quota.recordExhaustion(t.provider, blockedUntil);
				return;
			}
			case "auth": {
				if (reason.permanent) {
					this.excluded.add(t.provider);
					this.attempts.delete(t.provider);
					this.log.warn("router: provider excluded for session (permanent auth)", {
						provider: t.provider,
						message: reason.message,
					});
					return;
				}
				// non-permanent auth → treated as transient: backoff, same provider
				await this.transientBackoff(t.provider, reason.message);
				return;
			}
			case "transient": {
				await this.transientBackoff(t.provider, reason.message);
				return;
			}
		}
	}

	private async transientBackoff(provider: AuthProviderId, message: string): Promise<void> {
		const attempt = this.attempts.get(provider) ?? 0;
		const delay =
			this.backoff[Math.min(attempt, this.backoff.length - 1)] ?? this.backoff[this.backoff.length - 1] ?? 1000;
		this.attempts.set(provider, attempt + 1);
		this.log.info("router: transient failure, backoff", {
			provider,
			attempt: attempt + 1,
			backoffMs: delay,
			message,
		});
		await sleep(delay);
	}
}
