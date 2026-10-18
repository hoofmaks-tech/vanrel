/**
 * @vanrel/cli — vanrel binary (§4.6): args, session manager, builtin tools, wiring.
 * Programmatic entry point is runCli; sub-components are re-exported for tests.
 */
export {
	ArgsError,
	type CliCommand,
	EXIT_AUTH,
	EXIT_BUDGET,
	EXIT_ERROR,
	EXIT_OK,
	EXIT_SIGINT,
	parseArgs,
	USAGE,
} from "./args.ts";
export { runCli } from "./cli.ts";
export {
	type CliConfig,
	createSettingsFacade,
	DEFAULT_THINKING_LEVEL,
	INTERACTIVE_DEFAULTS,
	type InteractiveConfig,
	type InteractiveDoubleEscapeAction,
	type InteractiveFullscreenExitOutput,
	type InteractiveFullscreenScrollbar,
	type InteractiveMermaidMode,
	type InteractiveSetting,
	type InteractiveTuiMode,
	loadConfig,
	type McpHttpServerConfig,
	type McpServerConfig,
	type McpStdioServerConfig,
	type SettingsFacade,
	THINKING_LEVEL_OPTIONS,
} from "./config.ts";
export type { BashResult, InteractiveHost, InteractiveSessionEvent } from "./interactive/host.ts";
export { createInteractiveHost, type InteractiveHostOptions } from "./interactive/host-impl.ts";
export { createMcpRuntime, type McpRuntime, type McpRuntimeDeps, type McpToolDetails, mcpToolName } from "./mcp.ts";
export { APP_NAME, type VanrelPaths, vanrelPaths } from "./paths.ts";
export { type CliIo, runSession } from "./run.ts";
export { type SessionEntry, SessionError, type SessionInfo, SessionManager } from "./session.ts";
export { buildSplashLines, type SplashInput, shouldShowSplash } from "./splash.ts";
export {
	classifyStreamFailure,
	createRoutedStreamFn,
	findCatalogModel,
	type RoutedStreamDeps,
	resolveModelRef,
} from "./stream.ts";
export { type BuiltinToolsDeps, createBuiltinTools, type QcHooks } from "./tools.ts";
export {
	AuthUnavailableError,
	createSessionRuntime,
	type SessionCompactionEvent,
	type SessionRuntime,
	type SessionStats,
	VANREL_VERSION,
} from "./wiring.ts";
