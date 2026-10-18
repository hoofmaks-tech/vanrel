/**
 * Routed StreamFn (§3.1, §4.2.4): on every LLM request — ProviderRouter.route() →
 * credential.toRequestAuth (headers+baseUrl, §5.1) → catalog model → pi-ai api module
 * (anthropic-messages / google-generative-ai / openai-codex-responses).
 *
 * Taps: T1 llm_request via onPayload (full raw body + budgetContext, §4.1.1),
 * T2 llm_response on the stream's done/error events (full message + usage + durationMs).
 * Failover: done → router.reportSuccess(usage); error → classify → router.reportFailure.
 *
 * StreamFn contract (pi-agent-core): the function does NOT throw — failures are encoded as an error event.
 */

import type { StreamFn } from "@vanrel/agent";
import type {
	AssistantMessageEventStream,
	AuthProvider,
	AuthProviderId,
	Model,
	ProviderRouter,
	ResolvedAuth,
	RoutedTarget,
	RouteError,
	SimpleStreamOptions,
	TranscriptContext,
	Usage,
} from "@vanrel/ai";
import {
	AUTH_PROVIDER_IDS,
	createAssistantMessageEventStream,
	normalizeContext,
	RouteError as RouteErrorClass,
} from "@vanrel/ai";
import { streamSimple as streamAnthropic } from "@vanrel/ai/api/anthropic-messages";
import { streamSimple as streamGemini } from "@vanrel/ai/api/google-generative-ai";
import { streamSimple as streamCodex } from "@vanrel/ai/api/openai-codex-responses";
import { getBuiltinModels } from "@vanrel/ai/providers/all";
import { estimateContextTokens } from "@vanrel/ai/utils/estimate";
import type { ContextBudget } from "@vanrel/context";
import type { FlightRecorder, Logger } from "@vanrel/telemetry";

/** Auth provider (§4.2.1) → provider id in the pi-ai model catalog. Exported for the A1 ModelFacade. */
export const CATALOG_PROVIDER = { anthropic: "anthropic", agy: "google", codex: "openai-codex" } as const;

/** Unified streamSimple signature of the api modules (the generic per-api call is unified here). */
type ApiStreamSimple = (
	model: Model<any>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

function apiStreamFor(catalogApi: string): ApiStreamSimple | undefined {
	// The catalog guarantees model.api ↔ provider api module correspondence (§5.1); the cast is safe.
	switch (catalogApi) {
		case "anthropic-messages":
			return streamAnthropic as ApiStreamSimple;
		case "google-generative-ai":
			return streamGemini as ApiStreamSimple;
		case "openai-codex-responses":
			return streamCodex as ApiStreamSimple;
		default:
			return undefined;
	}
}

export function findCatalogModel(provider: AuthProviderId, modelId: string): Model<any> | undefined {
	return getBuiltinModels(CATALOG_PROVIDER[provider]).find((m) => m.id === modelId);
}

/**
 * W14: shared model ref resolver ("provider/id" | alias | bare catalog id) → {provider, catalog Model}.
 * All refusals are RouteError (§3.3 contract: propagated up). Consumers: A1 ModelFacade and wiring.setModel.
 * NB: the router's request-time routing follows policy.order (no pinning to a provider — VENDOR-GAP W12c).
 */
export function resolveModelRef(
	ref: string,
	router: ProviderRouter,
	auth: ResolvedAuth,
): { provider: AuthProviderId; model: Model<any> } {
	const trimmed = ref.trim();
	const slash = trimmed.indexOf("/");
	if (slash > 0) {
		// Explicit "provider/id": validate provider + credential + catalog.
		const providerRaw = trimmed.slice(0, slash);
		const modelId = trimmed.slice(slash + 1);
		const fallbackProvider = auth.byProvider.keys().next().value ?? ("anthropic" as AuthProviderId);
		if (!(AUTH_PROVIDER_IDS as readonly string[]).includes(providerRaw) || modelId === "") {
			throw new RouteErrorClass({
				kind: "transient",
				provider: fallbackProvider,
				message: `invalid model ref: ${ref}`,
			});
		}
		const provider = providerRaw as AuthProviderId;
		if (!auth.byProvider.has(provider)) {
			throw new RouteErrorClass({ kind: "auth", provider, permanent: false, message: `not logged in: ${provider}` });
		}
		const model = findCatalogModel(provider, modelId);
		if (!model) {
			throw new RouteErrorClass({
				kind: "transient",
				provider,
				message: `model not in catalog: ${provider}/${modelId}`,
			});
		}
		return { provider, model };
	}
	// Alias ("default"/"cheap" from DEFAULT_MODEL_ALIASES) or bare catalog id: routed by the router.
	if (trimmed === "") {
		throw new RouteErrorClass({ kind: "transient", provider: "anthropic", message: "empty model ref" });
	}
	const target = router.route({ model: trimmed }); // RouteError propagates up
	const model = findCatalogModel(target.provider, target.model);
	if (!model) {
		throw new RouteErrorClass({
			kind: "transient",
			provider: target.provider,
			message: `model not in catalog: ${target.provider}/${target.model}`,
		});
	}
	return { provider: target.provider, model };
}

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function errorAssistantMessage(provider: string, model: string, api: string, message: string) {
	return {
		role: "assistant" as const,
		content: [],
		api,
		provider,
		model,
		usage: ZERO_USAGE,
		stopReason: "error" as const,
		errorMessage: message,
		timestamp: Date.now(),
	};
}

/** Provider failure classification for the router (§4.2.4): 429/quota → quota; 401/403 → auth permanent; anything else → transient. */
export function classifyStreamFailure(provider: AuthProviderId, message: string): RouteError {
	const lower = message.toLowerCase();
	const retryAfter = /retry[- ]?after[:\s]+(\d+)/i.exec(message);
	if (/\b429\b|rate.?limit|quota|insufficient/.test(lower)) {
		return new RouteErrorClass({
			kind: "quota",
			provider,
			retryAfterMs: retryAfter ? Number.parseInt(retryAfter[1]!, 10) * 1000 : null,
		});
	}
	if (/\b401\b|\b403\b|unauthorized|forbidden|invalid.{0,20}token|expired/.test(lower)) {
		return new RouteErrorClass({ kind: "auth", provider, permanent: true, message });
	}
	return new RouteErrorClass({ kind: "transient", provider, message });
}

export interface RoutedStreamDeps {
	router: ProviderRouter;
	providers: ReadonlyMap<AuthProviderId, AuthProvider>;
	/** CLI-requested model: alias ("default"|"cheap") or explicit catalog id. */
	requestedModel: string;
	/** Recomputed budget of the current request (requestMaxTokens → max_tokens, §6.1). */
	budget: () => ContextBudget;
	recorder: FlightRecorder;
	sessionId: string;
	log: Logger;
	/** Usage accounting for session_end stats (T5). */
	onUsage?: (usage: { input: number; output: number }) => void;
	/** The actual model choice (for subsequent budgets/logs). */
	onRouted?: (provider: AuthProviderId, model: Model<any>) => void;
}

export function createRoutedStreamFn(deps: RoutedStreamDeps): StreamFn {
	const { router, providers, recorder, log } = deps;
	return (_ignored, context, options) => {
		const out = createAssistantMessageEventStream();
		const startedAt = Date.now();
		void (async () => {
			let target: RoutedTarget;
			try {
				target = router.route({ model: deps.requestedModel, signal: options?.signal });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log.error("routing failed", { error: message });
				out.push({
					type: "error",
					reason: "error",
					error: errorAssistantMessage("router", deps.requestedModel, "unknown", message),
				});
				out.end();
				return;
			}
			const provider = providers.get(target.provider);
			const catalogModel = findCatalogModel(target.provider, target.model);
			const apiStream = catalogModel && apiStreamFor(catalogModel.api);
			if (!provider || !catalogModel || !apiStream) {
				const message = `no runtime mapping for ${target.provider}/${target.model}`;
				log.error("routing failed", { error: message });
				out.push({
					type: "error",
					reason: "error",
					error: errorAssistantMessage(target.provider, target.model, "unknown", message),
				});
				out.end();
				return;
			}
			const requestAuth = provider.toRequestAuth(target.credential);
			// Upstream baseUrl comes from the auth layer (§5.1: anthropic api.anthropic.com, agy Code Assist cascade, codex backend-api/codex)
			const effectiveModel: Model<any> = { ...catalogModel, baseUrl: requestAuth.baseUrl };
			deps.onRouted?.(target.provider, effectiveModel);
			const budget = deps.budget();
			const inner = apiStream(effectiveModel, context, {
				...options,
				apiKey: target.credential.accessToken,
				headers: { ...requestAuth.headers, ...options?.headers },
				maxTokens: budget.requestMaxTokens,
				sessionId: deps.sessionId,
				onPayload: async (payload, model) => {
					// Tap T1: FULL raw request body (disk, 0 tokens in context).
					recorder.record("llm_request", {
						provider: target.provider,
						model: target.model,
						baseUrl: requestAuth.baseUrl,
						request: payload,
						budgetContext: {
							W: budget.W,
							S: budget.S,
							T: budget.T,
							H: estimateContextTokens(context.messages).tokens,
							R: budget.R,
							U: budget.U,
						},
					});
					return options?.onPayload?.(payload, model);
				},
			});
			try {
				for await (const event of inner) {
					out.push(event);
					if (event.type === "done") {
						const usage = event.message.usage;
						await router.reportSuccess(target, {
							ts: Date.now(),
							provider: target.provider,
							model: target.model,
							inputTokens: usage.input,
							outputTokens: usage.output,
						});
						deps.onUsage?.({ input: usage.input, output: usage.output });
						// Tap T2: full raw response + usage.
						recorder.record("llm_response", {
							provider: target.provider,
							model: target.model,
							stopReason: event.message.stopReason,
							usage: {
								input: usage.input,
								output: usage.output,
								cacheRead: usage.cacheRead,
								cacheWrite: usage.cacheWrite,
								reasoning: usage.reasoning,
							},
							message: event.message,
							durationMs: event.message.durationMs ?? Date.now() - startedAt,
						});
					} else if (event.type === "error") {
						const message = event.error.errorMessage ?? "unknown provider error";
						await router.reportFailure(target, classifyStreamFailure(target.provider, message));
						recorder.record("llm_response", {
							provider: target.provider,
							model: target.model,
							stopReason: event.error.stopReason,
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							message: event.error,
							durationMs: Date.now() - startedAt,
						});
					}
				}
			} catch (error) {
				// Defensive perimeter: the api module must encode failures as events; if it still throws — error event.
				const message = error instanceof Error ? error.message : String(error);
				log.error("stream threw outside protocol", { provider: target.provider, error: message });
				await router.reportFailure(target, classifyStreamFailure(target.provider, message));
				out.push({
					type: "error",
					reason: "error",
					error: errorAssistantMessage(target.provider, target.model, effectiveModel.api, message),
				});
			}
			out.end();
		})();
		return out;
	};
}

/** One-shot call for summarize (§4.3.3): "cheap" alias, response text. Throws on failure (compactor fallback). */
export async function summarizeText(deps: RoutedStreamDeps, transcript: string, signal?: AbortSignal): Promise<string> {
	const streamFn = createRoutedStreamFn({ ...deps, requestedModel: "cheap" });
	const context = normalizeContext({
		messages: [
			{
				role: "user",
				content: `Summarize this conversation transcript concisely, preserving decisions, file paths, and open tasks:\n\n${transcript}`,
				timestamp: Date.now(),
			},
		],
	});
	// StreamFn requires a Model argument, but our streamFn ignores it (it routes itself) — pass a dummy.
	const stream = await streamFn({} as Model<any>, context, { signal });
	let text = "";
	for await (const event of stream) {
		if (event.type === "text_delta") text += event.delta;
		if (event.type === "error") throw new Error(event.error.errorMessage ?? "summarize failed");
	}
	if (text === "") throw new Error("summarize returned empty text");
	return text;
}
