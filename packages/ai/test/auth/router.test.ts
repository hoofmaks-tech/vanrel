import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RouteError } from "../../src/auth/errors.ts";
import type { Credential, ResolvedAuth, RoutedTarget } from "../../src/auth/gateway-types.ts";
import { QuotaLedger } from "../../src/auth/quota-ledger.ts";
import { ProviderRouter } from "../../src/auth/router.ts";

let dir: string;
let quota: QuotaLedger;

function cred(provider: Credential["provider"]): Credential {
	return {
		provider,
		type: "oauth",
		accessToken: `at-${provider}`,
		refreshToken: `rt-${provider}`,
		expiresAt: Date.now() + 3600_000,
		source: { kind: "vanrel-store", path: "/tmp/x" },
	};
}

function authWith(...providers: Credential["provider"][]): ResolvedAuth {
	return {
		byProvider: new Map(providers.map((p) => [p, cred(p)])),
		skipped: [],
	};
}

function makeRouter(auth: ResolvedAuth, backoff: number[] = [1, 2, 4]): ProviderRouter {
	// real clock: router and ledger share wall-clock (the router spec constructor has no now)
	return new ProviderRouter({ auth, quota, policy: { transientBackoffMs: backoff } });
}

const usage = (provider: Credential["provider"]) => ({
	ts: Date.now(),
	provider,
	model: "m",
	inputTokens: 1,
	outputTokens: 1,
});

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "vanrel-router-"));
	quota = new QuotaLedger({ filePath: join(dir, "quota.json") });
	await quota.load();
});

afterEach(async () => {
	await quota.flush();
	await rm(dir, { recursive: true, force: true });
});

describe("ProviderRouter (§4.2.4)", () => {
	it("route: first from order with credential; aliases → concrete model ids", () => {
		const router = makeRouter(authWith("anthropic", "agy", "codex"));
		const t = router.route({ model: "default" });
		expect(t).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5", attempt: 0 });
		expect(router.route({ model: "cheap" }).model).toBe("claude-haiku-5-5");
		expect(router.route({ model: "claude-opus-5" }).model).toBe("claude-opus-5"); // explicit id
	});

	it("quota failover: anthropic exhausted → next provider", async () => {
		const router = makeRouter(authWith("anthropic", "agy"));
		const t = router.route({});
		await router.reportFailure(t, new RouteError({ kind: "quota", provider: "anthropic", retryAfterMs: 60_000 }));
		expect(quota.available("anthropic")).toBe(false);
		const t2 = router.route({});
		expect(t2.provider).toBe("agy");
		expect(t2.attempt).toBe(0);
	});

	it("all blocked → route() throws RouteError(kind quota) with retryAfterMs", async () => {
		const router = makeRouter(authWith("anthropic", "agy"));
		await router.reportFailure(
			router.route({}),
			new RouteError({ kind: "quota", provider: "anthropic", retryAfterMs: 30_000 }),
		);
		await router.reportFailure(
			router.route({}),
			new RouteError({ kind: "quota", provider: "agy", retryAfterMs: 60_000 }),
		);
		const err: unknown = await Promise.resolve()
			.then(() => router.route({}))
			.catch((e: unknown) => e);
		expect(err).toBeInstanceOf(RouteError);
		expect((err as RouteError).name).toBe("RouteError");
		const reason = (err as RouteError).reason;
		expect(reason.kind).toBe("quota");
		if (reason.kind === "quota") {
			expect(reason.provider).toBe("anthropic"); // first blocked provider from order
			expect(reason.retryAfterMs).toBeGreaterThan(0);
			expect(reason.retryAfterMs).toBeLessThanOrEqual(30_000);
		}
	});

	it("auth/permanent → provider is excluded until the end of the session", async () => {
		const router = makeRouter(authWith("anthropic", "agy"));
		await router.reportFailure(
			router.route({}),
			new RouteError({ kind: "auth", provider: "anthropic", permanent: true, message: "invalid_grant" }),
		);
		expect(quota.available("anthropic")).toBe(true); // not a quota block
		expect(router.route({}).provider).toBe("agy"); // but excluded
	});

	it("transient → backoff, then the same provider with attempt+1", async () => {
		const router = makeRouter(authWith("anthropic", "agy"));
		const t0 = router.route({});
		expect(t0.attempt).toBe(0);
		await router.reportFailure(t0, new RouteError({ kind: "transient", provider: "anthropic", message: "HTTP 500" }));
		const t1 = router.route({});
		expect(t1.provider).toBe("anthropic"); // same one, no failover
		expect(t1.attempt).toBe(1);
		await router.reportFailure(t1, new RouteError({ kind: "transient", provider: "anthropic", message: "HTTP 500" }));
		expect(router.route({}).attempt).toBe(2);
		await router.reportSuccess(router.route({}), usage("anthropic"));
		expect(router.route({}).attempt).toBe(0); // success resets
	});

	it("reportSuccess writes a UsageRecord to the ledger", async () => {
		const router = makeRouter(authWith("codex"));
		const t: RoutedTarget = router.route({ model: "default" });
		expect(t.model).toBe("gpt-6.1-sol");
		await router.reportSuccess(t, usage("codex"));
		expect(quota.peek("codex")[0]?.window.requests).toBe(1);
	});

	it("backoff cap: attempt > backoff.length → last element", async () => {
		const router = makeRouter(authWith("anthropic"), [1, 1]);
		for (let i = 0; i < 4; i++) {
			await router.reportFailure(
				router.route({}),
				new RouteError({ kind: "transient", provider: "anthropic", message: "x" }),
			);
		}
		expect(router.route({}).attempt).toBe(4);
	});
});
