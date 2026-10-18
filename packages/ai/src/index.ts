export type { Static, TSchema } from "typebox";
export { Type } from "typebox";

// Core only, side-effect free: no generated catalogs, no provider factories,
// no api-registry, no OAuth implementations. Provider factories live under
// "@vanrel/ai/providers/*", API implementations under "@vanrel/ai/api/*".
export type { AnthropicEffort, AnthropicOptions, AnthropicThinkingDisplay } from "./api/anthropic-messages.ts";
export type { GoogleOptions } from "./api/google-generative-ai.ts";
export type { GoogleApiThinkingLevel, ResolvedGoogleThinkingLevel } from "./api/google-shared.ts";
export * from "./api/lazy.ts";
export type { OpenAICodexResponsesOptions, OpenAICodexWebSocketDebugStats } from "./api/openai-codex-responses.ts";
export type { OpenAIResponsesOptions } from "./api/openai-responses.ts";
export * from "./auth/context.ts";
export * from "./auth/credential-store.ts";
export * from "./auth/helpers.ts";
export type { Credential as SubscriptionCredential } from "./auth/index.ts";
// Subscription Auth Gateway (M4, §4.2/§5). The `Credential` name is taken by the
// vendored pi-ai type above → the gateway type is re-exported as SubscriptionCredential;
// the full layer is also available as a whole via the `authGateway` namespace.
export * as authGateway from "./auth/index.ts";
export {
	AgyAuthProvider,
	AnthropicAuthProvider,
	AUTH_PROVIDER_IDS,
	AuthFlowError,
	type AuthFlowErrorReason,
	type AuthGatewayConfig,
	AuthLockError,
	type AuthProvider,
	type AuthProviderId,
	builtinAuthProviders,
	CodexAuthProvider,
	type CredentialSource,
	DEFAULT_GEMINI_ENDPOINTS,
	DEFAULT_MODEL_ALIASES,
	DEFAULT_OAUTH_MINIMUM_VALIDITY_MS,
	FileCredentialStore,
	type FileCredentialStoreOptions,
	type FileLockOptions,
	GATEWAY_NOOP_LOGGER,
	type GatewayProviderOptions,
	type ProviderQuotaState,
	ProviderRouter,
	QuotaLedger,
	type QuotaLedgerOptions,
	type ResolveAuthOptions,
	type ResolvedAuth,
	type RoutedTarget,
	RouteError,
	type RouteErrorReason,
	type RouteRequest,
	type RoutingPolicy,
	resolveAuth,
	type UsageProbe,
	type UsageRecord,
	withFileLock,
} from "./auth/index.ts";
export * from "./auth/types.ts";
export type {
	OAuthAuthInfo,
	OAuthDeviceCodeInfo,
	OAuthLoginCallbacks,
	OAuthPrompt,
	OAuthSelectOption,
	OAuthSelectPrompt,
} from "./compat/extension-oauth-types.ts";
export * from "./models.ts";
export * from "./models-store.ts";
export * from "./providers/faux.ts";
export * from "./session-resources.ts";
export * from "./types.ts";
export * from "./utils/diagnostics.ts";
export * from "./utils/event-stream.ts";
export * from "./utils/json-parse.ts";
export * from "./utils/overflow.ts";
export * from "./utils/retry.ts";
export { contentText, getSystemMessageText, renderSystemMessageUpdate } from "./utils/text.ts";
export * from "./utils/transcript.ts";
export * from "./utils/typebox-helpers.ts";
export { uuidv7 } from "./utils/uuid.ts";
export * from "./utils/validation.ts";
