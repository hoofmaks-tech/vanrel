/**
 * Public surface of the Subscription Auth Gateway (M4,.
 * The vendored pi-ai auth layer (./types.ts, ./credential-store.ts, ./resolve.ts,
 * ./oauth/*) is unchanged; this layer is built alongside/on top of it.
 */

export { AuthFlowError, type AuthFlowErrorReason, AuthLockError, RouteError, type RouteErrorReason } from "./errors.ts";
export { FileCredentialStore, type FileCredentialStoreOptions } from "./file-credential-store.ts";
export {
	AUTH_PROVIDER_IDS,
	type AuthGatewayConfig,
	type AuthProvider,
	type AuthProviderId,
	type Credential,
	type CredentialSource,
	DEFAULT_OAUTH_MINIMUM_VALIDITY_MS,
	GATEWAY_NOOP_LOGGER,
	type GatewayProviderOptions,
	type LoginOptions,
	type ProviderQuotaState,
	type QuotaLedgerOptions,
	type ResolveAuthOptions,
	type ResolvedAuth,
	type RoutedTarget,
	type RouteRequest,
	type RoutingPolicy,
	type UsageProbe,
	type UsageRecord,
} from "./gateway-types.ts";
export { type FileLockOptions, withFileLock } from "./lockfile.ts";
export { AgyAuthProvider, DEFAULT_GEMINI_ENDPOINTS } from "./providers/agy.ts";
export { AnthropicAuthProvider } from "./providers/anthropic.ts";
export { CodexAuthProvider } from "./providers/codex.ts";
export {
	MANUAL_CODE_MAX_ATTEMPTS,
	type ManualLoginSpec,
	parseAuthorizationInput,
	runManualCodeLogin,
} from "./providers/manual-login.ts";
export { QuotaLedger } from "./quota-ledger.ts";
export { builtinAuthProviders, resolveAuth } from "./resolve-auth.ts";
export { DEFAULT_MODEL_ALIASES, ProviderRouter } from "./router.ts";
