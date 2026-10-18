/**
 * ~/.vanrel/config.json (§5.6, §4.4): preferred provider order, auth tuning, qc.enabled (default false in M8).
 * The interactive section (A3, recon interactive-vendor §3.3): TUI mode settings.
 * Tolerant parsing: a broken/missing file → defaults + WARN (I5: no silence).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ThinkingLevel } from "@vanrel/agent";
import { AUTH_PROVIDER_IDS, type AuthProviderId } from "@vanrel/ai";
import type { Logger } from "@vanrel/telemetry";
import type { TerminalCapabilities } from "@vanrel/tui";

export interface CliConfig {
	/** Provider order for routing (default ["anthropic","agy","codex"], §5.6). */
	preferred?: AuthProviderId[];
	auth?: { claudeProfilesDir?: boolean; geminiEndpoints?: string[] };
	qc?: { enabled?: boolean; checks?: string[] };
	/** A3: interactive TUI mode settings (keys — recon §3.3). */
	interactive?: InteractiveConfig;
	/** MCP servers (recon mcp-wiring §3.1): same shape as pi (`mcpServers` in mcp.json). */
	mcpServers?: Record<string, McpServerConfig>;
}

// --- MCP (recon mcp-wiring §3.1) ---

interface McpServerConfigBase {
	/** false — the entry stays in the config, but the server is not started. Default true. */
	enabled?: boolean;
	/** Request timeout in seconds (>0); progress notifications reset the timer. Default 60. */
	timeout?: number;
	description?: string;
}

export interface McpStdioServerConfig extends McpServerConfigBase {
	type?: "stdio";
	command: string;
	args?: string[];
	/** Values may reference environment variables `${NAME}`; `!cmd` is not supported. */
	env?: Record<string, string>;
	/** A relative path is resolved against the session cwd. */
	cwd?: string;
}

export interface McpHttpServerConfig extends McpServerConfigBase {
	type?: "http";
	url: string;
	/** Values may reference environment variables `${NAME}`; `!cmd` is not supported. */
	headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

// --- A3 (recon §3.3): interactive section ---

export type InteractiveTuiMode = "regular" | "fullscreen";
export type InteractiveFullscreenScrollbar = "auto" | "always" | "hidden";
export type InteractiveFullscreenExitOutput = "transcript" | "resume-hint";
export type InteractiveMermaidMode = "off" | "final" | "streaming";
/** Pi default is "tree"; tree/fork are stripped (recon §4), so the vanrel default is "none". */
export type InteractiveDoubleEscapeAction = "fork" | "tree" | "none";

export interface InteractiveConfig {
	theme?: string;
	tuiMode?: InteractiveTuiMode;
	quietStartup?: boolean | "header";
	outputPad?: 0 | 1;
	hideThinkingBlock?: boolean;
	editorPaddingX?: number;
	autocompleteMaxVisible?: number;
	showHardwareCursor?: boolean;
	clearOnShrink?: boolean;
	fullscreenScrollbar?: InteractiveFullscreenScrollbar;
	fullscreenCopyOnSelect?: boolean;
	/** "auto" or a number of lines per wheel event (clamped to 1..100, like Pi). */
	fullscreenWheelScrollLines?: number | "auto";
	fullscreenExitOutput?: InteractiveFullscreenExitOutput;
	doubleEscapeAction?: InteractiveDoubleEscapeAction;
	defaultThinkingLevel?: ThinkingLevel;
	mermaidMode?: InteractiveMermaidMode;
	codeBlockIndent?: string;
	terminalCapabilityOverrides?: Partial<TerminalCapabilities>;
	showTerminalProgress?: boolean;
}

/** Kept in sync with ThinkingLevel in @vanrel/agent (recon §2b: defaults.ts here). */
export const THINKING_LEVEL_OPTIONS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

/**
 * Defaults of the interactive section. Deviations from Pi SETTINGS_DEFAULTS:
 * theme — Pi has undefined (autodetect), we set an explicit "dark" (Pi theme.ts fallback);
 * doubleEscapeAction — "none" instead of "tree" (tree/fork are stripped, recon §4).
 */
export const INTERACTIVE_DEFAULTS: Required<InteractiveConfig> = {
	theme: "dark",
	tuiMode: "fullscreen",
	quietStartup: false,
	outputPad: 1,
	hideThinkingBlock: false,
	editorPaddingX: 0,
	autocompleteMaxVisible: 5,
	showHardwareCursor: false,
	clearOnShrink: false,
	fullscreenScrollbar: "auto",
	fullscreenCopyOnSelect: true,
	fullscreenWheelScrollLines: "auto",
	fullscreenExitOutput: "transcript",
	doubleEscapeAction: "none",
	defaultThinkingLevel: DEFAULT_THINKING_LEVEL,
	mermaidMode: "streaming",
	codeBlockIndent: "  ",
	terminalCapabilityOverrides: {},
	showTerminalProgress: false,
};

export type InteractiveSetting = keyof InteractiveConfig;

/**
 * A3 SettingsFacade (recon §3.3): typed access to the interactive section
 * with INTERACTIVE_DEFAULTS applied + persist to config.json.
 */
export interface SettingsFacade {
	get<K extends InteractiveSetting>(key: K): Required<InteractiveConfig>[K];
	set<K extends InteractiveSetting>(key: K, value: InteractiveConfig[K]): Promise<void>;
}

/**
 * W14: SettingsFacade factory. Seed is the already-parsed interactive section of CliConfig
 * (sync get without re-reading the file); set() does a read-modify-write of config.json,
 * foreign sections are preserved. A persist failure → WARN, the UI is not crashed
 * (settings-selector contract).
 */
export function createSettingsFacade(configPath: string, log: Logger, seed?: InteractiveConfig): SettingsFacade {
	let current: InteractiveConfig = { ...seed };
	return {
		get<K extends InteractiveSetting>(key: K): Required<InteractiveConfig>[K] {
			return ({ ...INTERACTIVE_DEFAULTS, ...current } as Required<InteractiveConfig>)[key];
		},
		async set<K extends InteractiveSetting>(key: K, value: InteractiveConfig[K]): Promise<void> {
			current = { ...current, [key]: value };
			try {
				let root: Record<string, unknown> = {};
				try {
					const parsed: unknown = JSON.parse(await readFile(configPath, "utf8"));
					if (isRecord(parsed)) root = parsed;
				} catch {
					// missing/broken config.json — overwrite only our own section
				}
				const interactive = isRecord(root.interactive) ? root.interactive : {};
				root.interactive = { ...interactive, [key]: value };
				await mkdir(dirname(configPath), { recursive: true });
				await writeFile(configPath, `${JSON.stringify(root, null, 2)}\n`, "utf8");
			} catch (error) {
				log.warn("settings: persist failed", {
					key,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePreferred(value: unknown, log: Logger): AuthProviderId[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const out: AuthProviderId[] = [];
	for (const item of value) {
		if (typeof item === "string" && (AUTH_PROVIDER_IDS as readonly string[]).includes(item)) {
			out.push(item as AuthProviderId);
		} else {
			log.warn("config: ignoring unknown preferred provider", { value: item });
		}
	}
	return out.length > 0 ? out : undefined;
}

function parseCapabilityOverrides(value: unknown, log: Logger): Partial<TerminalCapabilities> | undefined {
	if (!isRecord(value)) {
		log.warn("config: ignoring invalid interactive value", { key: "terminalCapabilityOverrides", value });
		return undefined;
	}
	const out: Partial<TerminalCapabilities> = {};
	for (const key of ["trueColor", "hyperlinks"] as const) {
		const item = value[key];
		if (item === undefined) continue;
		if (typeof item === "boolean") out[key] = item;
		else
			log.warn("config: ignoring invalid interactive value", {
				key: `terminalCapabilityOverrides.${key}`,
				value: item,
			});
	}
	return out;
}

/** Tolerant parsing of the interactive section: invalid values → WARN + key skipped (default). */
function parseInteractive(value: unknown, log: Logger): InteractiveConfig | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		log.warn("config: interactive section must be an object, defaults applied");
		return undefined;
	}
	const invalid = (key: string): void => {
		log.warn("config: ignoring invalid interactive value", { key, value: value[key] });
	};
	const out: InteractiveConfig = {};
	if (value.theme !== undefined) {
		if (typeof value.theme === "string") out.theme = value.theme;
		else invalid("theme");
	}
	if (value.tuiMode !== undefined) {
		if (value.tuiMode === "regular" || value.tuiMode === "fullscreen") out.tuiMode = value.tuiMode;
		else invalid("tuiMode");
	}
	if (value.quietStartup !== undefined) {
		if (typeof value.quietStartup === "boolean" || value.quietStartup === "header")
			out.quietStartup = value.quietStartup;
		else invalid("quietStartup");
	}
	if (value.outputPad !== undefined) {
		if (value.outputPad === 0 || value.outputPad === 1) out.outputPad = value.outputPad;
		else invalid("outputPad");
	}
	if (value.hideThinkingBlock !== undefined) {
		if (typeof value.hideThinkingBlock === "boolean") out.hideThinkingBlock = value.hideThinkingBlock;
		else invalid("hideThinkingBlock");
	}
	if (value.editorPaddingX !== undefined) {
		if (typeof value.editorPaddingX === "number" && Number.isFinite(value.editorPaddingX))
			out.editorPaddingX = value.editorPaddingX;
		else invalid("editorPaddingX");
	}
	if (value.autocompleteMaxVisible !== undefined) {
		if (typeof value.autocompleteMaxVisible === "number" && Number.isFinite(value.autocompleteMaxVisible))
			out.autocompleteMaxVisible = value.autocompleteMaxVisible;
		else invalid("autocompleteMaxVisible");
	}
	if (value.showHardwareCursor !== undefined) {
		if (typeof value.showHardwareCursor === "boolean") out.showHardwareCursor = value.showHardwareCursor;
		else invalid("showHardwareCursor");
	}
	if (value.clearOnShrink !== undefined) {
		if (typeof value.clearOnShrink === "boolean") out.clearOnShrink = value.clearOnShrink;
		else invalid("clearOnShrink");
	}
	if (value.fullscreenScrollbar !== undefined) {
		if (
			value.fullscreenScrollbar === "auto" ||
			value.fullscreenScrollbar === "always" ||
			value.fullscreenScrollbar === "hidden"
		)
			out.fullscreenScrollbar = value.fullscreenScrollbar;
		else invalid("fullscreenScrollbar");
	}
	if (value.fullscreenCopyOnSelect !== undefined) {
		if (typeof value.fullscreenCopyOnSelect === "boolean") out.fullscreenCopyOnSelect = value.fullscreenCopyOnSelect;
		else invalid("fullscreenCopyOnSelect");
	}
	if (value.fullscreenWheelScrollLines !== undefined) {
		const lines = value.fullscreenWheelScrollLines;
		if (lines === "auto") out.fullscreenWheelScrollLines = "auto";
		else if (typeof lines === "number" && Number.isFinite(lines))
			out.fullscreenWheelScrollLines = Math.min(100, Math.max(1, Math.round(lines)));
		else invalid("fullscreenWheelScrollLines");
	}
	if (value.fullscreenExitOutput !== undefined) {
		if (value.fullscreenExitOutput === "transcript" || value.fullscreenExitOutput === "resume-hint")
			out.fullscreenExitOutput = value.fullscreenExitOutput;
		else invalid("fullscreenExitOutput");
	}
	if (value.doubleEscapeAction !== undefined) {
		if (
			value.doubleEscapeAction === "fork" ||
			value.doubleEscapeAction === "tree" ||
			value.doubleEscapeAction === "none"
		)
			out.doubleEscapeAction = value.doubleEscapeAction;
		else invalid("doubleEscapeAction");
	}
	if (value.defaultThinkingLevel !== undefined) {
		if (
			typeof value.defaultThinkingLevel === "string" &&
			(THINKING_LEVEL_OPTIONS as readonly string[]).includes(value.defaultThinkingLevel)
		)
			out.defaultThinkingLevel = value.defaultThinkingLevel as ThinkingLevel;
		else invalid("defaultThinkingLevel");
	}
	if (value.mermaidMode !== undefined) {
		if (value.mermaidMode === "off" || value.mermaidMode === "final" || value.mermaidMode === "streaming")
			out.mermaidMode = value.mermaidMode;
		else invalid("mermaidMode");
	}
	if (value.codeBlockIndent !== undefined) {
		if (typeof value.codeBlockIndent === "string") out.codeBlockIndent = value.codeBlockIndent;
		else invalid("codeBlockIndent");
	}
	if (value.terminalCapabilityOverrides !== undefined) {
		const overrides = parseCapabilityOverrides(value.terminalCapabilityOverrides, log);
		if (overrides) out.terminalCapabilityOverrides = overrides;
	}
	if (value.showTerminalProgress !== undefined) {
		if (typeof value.showTerminalProgress === "boolean") out.showTerminalProgress = value.showTerminalProgress;
		else invalid("showTerminalProgress");
	}
	return out;
}

// --- MCP parsing (recon mcp-wiring §3.1): tolerant, in the style of parseInteractive ---

/** Server name — like pi (§1.1): goes into the tool name `mcp__<server>__<tool>`. */
const MCP_SERVER_NAME = /^[A-Za-z0-9_-]+$/;
/** Supported interpolation: only `${VAR}` (bare `$VAR` stays a literal — a difference from pi). */
const MCP_ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Substitutes `${VAR}` from process.env; the first unresolvable variable → { missing }. */
function interpolateMcpValue(template: string): { value: string } | { missing: string } {
	let missing: string | undefined;
	const value = template.replace(MCP_ENV_REF, (_all, name: string) => {
		const resolved = process.env[name];
		if (resolved === undefined) {
			missing ??= name;
			return "";
		}
		return resolved;
	});
	return missing === undefined ? { value } : { missing };
}

/**
 * env/headers: string record with `${VAR}` interpolation. Returns null on error
 * (the whole server is skipped — pi throws from resolveConfigValueOrThrow, we don't crash the session).
 */
function parseMcpStringRecord(
	value: unknown,
	server: string,
	field: "env" | "headers",
	log: Logger,
): Record<string, string> | undefined | null {
	if (value === undefined) return undefined;
	if (!isRecord(value) || !Object.values(value).every((entry) => typeof entry === "string")) {
		log.warn("config: skipping MCP server", { name: server, reason: `${field} must map names to strings` });
		return null;
	}
	const out: Record<string, string> = {};
	for (const [key, template] of Object.entries(value as Record<string, string>)) {
		// `!cmd` (exec from config) is not supported — unnecessary surface (recon §6).
		if (template.startsWith("!")) {
			log.warn("config: skipping MCP server", {
				name: server,
				reason: `${field}.${key}: "!cmd" command values are unsupported`,
			});
			return null;
		}
		const resolved = interpolateMcpValue(template);
		if ("missing" in resolved) {
			log.warn("config: skipping MCP server", {
				name: server,
				reason: `${field}.${key}: environment variable ${resolved.missing} is not set`,
			});
			return null;
		}
		out[key] = resolved.value;
	}
	return out;
}

/** Invalid server → WARN with the name + skip; the rest are started. */
function parseMcpServer(name: string, raw: unknown, log: Logger): McpServerConfig | undefined {
	const warn = (reason: string): undefined => {
		log.warn("config: skipping MCP server", { name, reason });
		return undefined;
	};
	if (!MCP_SERVER_NAME.test(name)) return warn(`invalid server name (use letters, digits, "_" and "-")`);
	if (!isRecord(raw)) return warn("entry must be an object");
	const type = raw.type;
	if (type === "sse") return warn("legacy SSE transport is not supported; use the streamable HTTP url");
	if (type !== undefined && type !== "stdio" && type !== "http" && type !== "streamable-http") {
		return warn(`unknown type (want "stdio" or "http")`);
	}

	const base: McpServerConfigBase = {};
	if (raw.enabled !== undefined) {
		if (typeof raw.enabled !== "boolean") return warn("enabled must be a boolean");
		base.enabled = raw.enabled;
	}
	if (raw.timeout !== undefined) {
		if (typeof raw.timeout !== "number" || !Number.isFinite(raw.timeout) || raw.timeout <= 0) {
			return warn("timeout must be a positive number of seconds");
		}
		base.timeout = raw.timeout;
	}
	if (raw.description !== undefined) {
		if (typeof raw.description !== "string") return warn("description must be a string");
		base.description = raw.description;
	}

	if (typeof raw.url === "string" && (type === undefined || type === "http" || type === "streamable-http")) {
		if (!URL.canParse(raw.url) || !/^https?:$/.test(new URL(raw.url).protocol)) {
			return warn("url must be an http or https URL");
		}
		const headers = parseMcpStringRecord(raw.headers, name, "headers", log);
		if (headers === null) return undefined;
		const config: McpHttpServerConfig = { ...base, url: raw.url };
		if (type !== undefined) config.type = "http";
		if (headers !== undefined) config.headers = headers;
		return config;
	}
	if (typeof raw.command === "string" && (type === undefined || type === "stdio")) {
		if (raw.args !== undefined && !(Array.isArray(raw.args) && raw.args.every((arg) => typeof arg === "string"))) {
			return warn("args must be an array of strings");
		}
		if (raw.cwd !== undefined && typeof raw.cwd !== "string") return warn("cwd must be a string");
		const env = parseMcpStringRecord(raw.env, name, "env", log);
		if (env === null) return undefined;
		const config: McpStdioServerConfig = { ...base, command: raw.command };
		if (type !== undefined) config.type = "stdio";
		if (raw.args !== undefined) config.args = raw.args as string[];
		if (env !== undefined) config.env = env;
		if (raw.cwd !== undefined) config.cwd = raw.cwd as string;
		return config;
	}
	return warn(`needs either "command" (stdio) or "url" (streamable HTTP)`);
}

/** Invalid section → WARN + whole section ignored. */
function parseMcpServers(value: unknown, log: Logger): Record<string, McpServerConfig> | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) {
		log.warn("config: mcpServers must be an object, section ignored");
		return undefined;
	}
	const out: Record<string, McpServerConfig> = {};
	for (const [name, raw] of Object.entries(value)) {
		const parsed = parseMcpServer(name, raw, log);
		if (parsed) out[name] = parsed;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

export async function loadConfig(path: string, log: Logger): Promise<CliConfig> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch {
		return {}; // a missing config is normal; defaults apply
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		log.warn("config: invalid JSON, defaults applied", { path, error: String(error) });
		return {};
	}
	if (!isRecord(parsed)) {
		log.warn("config: top level must be an object, defaults applied", { path });
		return {};
	}
	const config: CliConfig = {};
	const preferred = parsePreferred(parsed.preferred, log);
	if (preferred) config.preferred = preferred;
	if (isRecord(parsed.auth)) {
		config.auth = {};
		if (typeof parsed.auth.claudeProfilesDir === "boolean")
			config.auth.claudeProfilesDir = parsed.auth.claudeProfilesDir;
		if (Array.isArray(parsed.auth.geminiEndpoints)) {
			config.auth.geminiEndpoints = parsed.auth.geminiEndpoints.filter((e): e is string => typeof e === "string");
		}
	}
	if (isRecord(parsed.qc)) {
		config.qc = {};
		if (typeof parsed.qc.enabled === "boolean") config.qc.enabled = parsed.qc.enabled;
		if (Array.isArray(parsed.qc.checks))
			config.qc.checks = parsed.qc.checks.filter((c): c is string => typeof c === "string");
	}
	const interactive = parseInteractive(parsed.interactive, log);
	if (interactive) config.interactive = interactive;
	const mcpServers = parseMcpServers(parsed.mcpServers, log);
	if (mcpServers) config.mcpServers = mcpServers;
	return config;
}
