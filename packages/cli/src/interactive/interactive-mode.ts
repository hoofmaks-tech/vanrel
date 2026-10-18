// MIT License, Copyright (c) 2025 Mario Zechner
// Vendored from earendil-works/pi (packages/coding-agent/src/modes/interactive/interactive-mode.ts), adapted for vanrel.
//
// Main adaptation (recon interactive-vendor §3.3): Pi runtimeHost/AgentSession (66 members, §3.2) →
// InteractiveHost (./host.ts, the only runtime interface; DO NOT change). Mapping:
// session.prompt → host.prompt (user persist inside the host); session.steer/followUp →
// host.agent.steer/followUp + local persist via host.session.appendUser; abort → host.agent.abort;
// modelRuntime/model/cycleModel → A1 ModelFacade (./model-facade.ts) over host.router + auth
// re-resolve from host.paths.authFile; compaction statuses → host.subscribeSession
// compaction_start/end events; auto_retry → auto_retry_start; bash → host.executeBash;
// settings → host.settings (A3);
// /export → a copy of the session JSONL file (linear model; Pi core/session-export.ts not ported).
//
// STRIPPED (recon §4): /bug /share /import /fork /clone /tree /trust /reload /changelog
// /arminsayshi /dementedelves /llama /debug, install-telemetry, version-check,
// package-update-check, changelog-hint, cache-miss/cache-warming notices,
// Anthropic-subscription warning, Radius login + MCP offer,
// image paste + PNG transcoder (R2: no Image in @vanrel/tui), model-catalog-refresh (static
// catalog), external-editor, scoped-models, the whole extension subsystem (UI context, widgets,
// custom editor/footer/header, shortcuts, custom entry/message renderers, skill commands,
// prompt templates), loaded-resources listing, project trust.
//
// R5: no process.exit anywhere — all exit paths (quit, Ctrl+C×2, Ctrl+D, SIGINT/SIGTERM/SIGHUP,
// fatal, uncaughtCrash, dead terminal) go through shutdown() → host.close(reason) → code
// returned from run().
//
// Session switch (/resume, /new): InteractiveHost has no switchSession/newSession (linear model,
// runtime is wired per session). Implemented via InteractiveRunResult.switchSession —
// run() returns the request, the integrator (run.ts) rebuilds the runtime and re-enters
// (recon §5 item 7).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import * as path from "node:path";
import type { AgentMessage, ThinkingLevel } from "@vanrel/agent";
import type { AssistantMessage, TextContent } from "@vanrel/ai";
import {
	AuthFlowError,
	type AuthProvider,
	type AuthProviderId,
	builtinAuthProviders,
	FileCredentialStore,
	getSupportedThinkingLevels,
	type Model,
	resolveAuth,
} from "@vanrel/ai";
import { estimateContextTokens } from "@vanrel/ai/utils/estimate";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	type Component,
	Container,
	fuzzyFilter,
	isViewportTUI,
	Markdown,
	type MarkdownTheme,
	renderVanrelLogo,
	type ScrollView,
	type SlashCommand,
	Spacer,
	setCapabilityOverrides,
	setKeybindings,
	type Terminal,
	Text,
	TruncatedText,
	type TUI,
	TuiAltScreen,
	TuiMainScreen,
	type TuiMainScreenRenderState,
} from "@vanrel/tui";
import {
	DEFAULT_THINKING_LEVEL,
	type InteractiveFullscreenExitOutput,
	type InteractiveTuiMode,
	THINKING_LEVEL_OPTIONS,
} from "../config.ts";
import { APP_NAME } from "../paths.ts";
import { type SessionEntry, type SessionInfo, SessionManager } from "../session.ts";
import type { TruncationResult } from "../tools/truncate.ts";
import { VANREL_VERSION } from "../wiring.ts";
import { createChatViewport } from "./chat-viewport.ts";
import { AssistantMessageComponent } from "./components/assistant-message.ts";
import { BashExecutionComponent } from "./components/bash-execution.ts";
import { CompactionSummaryMessageComponent } from "./components/compaction-summary-message.ts";
import { CustomEditor } from "./components/custom-editor.ts";
import { DynamicBorder } from "./components/dynamic-border.ts";
import {
	FooterComponent,
	type FooterContextUsage,
	type FooterSession,
	type FooterSessionState,
	formatTokens,
} from "./components/footer.ts";
import { keyDisplayText, keyHint, keyText, rawKeyHint } from "./components/keybinding-hints.ts";
import { LoginDialogComponent } from "./components/login-dialog.ts";
import type { MarkdownTransformer } from "./components/markdown-transform.ts";
import { createMermaidMarkdownTransformer } from "./components/mermaid.ts";
import { ModelSelectorComponent } from "./components/model-selector.ts";
import {
	type AuthSelectorProvider,
	formatAuthSelectorProviderType,
	OAuthSelectorComponent,
} from "./components/oauth-selector.ts";
import { SessionSelectorComponent } from "./components/session-selector.ts";
import { SettingsSelectorComponent } from "./components/settings-selector.ts";
import { SelectSubmenu } from "./components/settings-submenu.ts";
import {
	CompactionStatusIndicator,
	type StatusIndicator,
	WorkingStatusIndicator,
} from "./components/status-indicator.ts";
import { ThemedText } from "./components/themed-text.ts";
import { ThinkingSelectorComponent } from "./components/thinking-selector.ts";
import { ToolExecutionComponent } from "./components/tool-execution.ts";
import { UserMessageComponent } from "./components/user-message.ts";
import { FooterDataProvider } from "./core/footer-data-provider.ts";
import { type AppKeybinding, KeybindingsManager } from "./core/keybindings.ts";
import { convertToLlm, createCompactionSummaryMessage } from "./core/messages.ts";
import { withBuiltInRenderers } from "./core/renderers/index.ts";
import { BUILTIN_SLASH_COMMANDS } from "./core/slash-commands.ts";
import { addUsageToTotals, createUsageTotals, getUsageCostBreakdown } from "./core/usage-totals.ts";
import type { BashResult, InteractiveHost, InteractiveSessionEvent } from "./host.ts";
import { DefaultModelFacade, type ModelFacade } from "./model-facade.ts";
import { getModelSearchText } from "./model-search.ts";
import { ProgramStatusReporter } from "./program-status-reporter.ts";
import { getEditorTheme, getMarkdownTheme, onThemeChange, theme } from "./theme/theme.ts";
import { InteractiveThemeController } from "./theme/theme-controller.ts";
import { createInteractiveTui, createInteractiveTuiReference } from "./tui-renderer.ts";
import { copyToClipboard, readClipboardFilePaths, readClipboardText } from "./utils/clipboard.ts";
import { killTrackedDetachedChildren } from "./utils/shell.ts";
import { loadAllHighlightLanguages } from "./utils/syntax-highlight.ts";

export { createInteractiveTui, createInteractiveTuiReference } from "./tui-renderer.ts";

// =========================================================================
// Local types and helpers
// =========================================================================

/** Internal marker: shutdown completed, the main loop may exit. Never leaves the module. */
class ShutdownRequestedError extends Error {
	constructor() {
		super("shutdown requested");
		this.name = "ShutdownRequestedError";
	}
}

interface QueuedMessage {
	text: string;
	mode: "steer" | "followUp";
}

// EIO: tty reads/ioctls from an orphaned background process group, or writes after hangup.
// ENOTTY: the tty was revoked (macOS) and stdin is no longer a terminal.
const DEAD_TERMINAL_ERROR_CODES = new Set(["EIO", "EPIPE", "ENOTCONN", "ENOTTY"]);

function isDeadTerminalError(error: unknown): boolean {
	if (!error || typeof error !== "object" || !("code" in error)) {
		return false;
	}
	const code = (error as NodeJS.ErrnoException).code;
	return code !== undefined && DEAD_TERMINAL_ERROR_CODES.has(code);
}

function quoteIfNeeded(value: string): string {
	if (value.length > 0 && !/[^a-zA-Z0-9_\-./~:@]/.test(value)) {
		return value;
	}
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Hint for resuming the session after exit (vanrel CLI: `--session <id>`, §4.6). */
export function formatResumeCommand(session: SessionManager): string | undefined {
	if (!process.stdout.isTTY) return undefined;
	if (!session.isPersisted()) return undefined;
	const sessionFile = session.getSessionFile();
	if (!sessionFile || !existsSync(sessionFile)) return undefined;
	return `${APP_NAME} --session ${quoteIfNeeded(session.getSessionId())}`;
}

function createFuzzyAutocompleteItems<T>(
	items: T[],
	prefix: string,
	getSearchText: (item: T) => string,
	toAutocompleteItem: (item: T) => AutocompleteItem,
): AutocompleteItem[] | null {
	const filtered = fuzzyFilter(items, prefix, getSearchText);
	if (filtered.length === 0) return null;
	return filtered.map(toAutocompleteItem);
}

// --- /login argument completion (port of Pi helpers; the Radius branch is stripped) ---

type LoginProviderCompletionOption = {
	id: string;
	name: string;
	authTypes: AuthSelectorProvider["authType"][];
	subscription?: boolean;
};

const AUTH_TYPE_ORDER = { oauth: 0, api_key: 1 } satisfies Record<AuthSelectorProvider["authType"], number>;

function getLoginProviderCompletionOptions(
	providerOptions: readonly AuthSelectorProvider[],
): LoginProviderCompletionOption[] {
	const byId = new Map<string, LoginProviderCompletionOption>();
	for (const provider of providerOptions) {
		const existing = byId.get(provider.id);
		if (existing) {
			if (!existing.authTypes.includes(provider.authType)) {
				existing.authTypes.push(provider.authType);
				existing.authTypes.sort((a, b) => AUTH_TYPE_ORDER[a] - AUTH_TYPE_ORDER[b]);
			}
			continue;
		}
		byId.set(provider.id, {
			id: provider.id,
			name: provider.name,
			authTypes: [provider.authType],
			subscription: provider.subscription,
		});
	}
	return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function getLoginProviderSearchText(provider: LoginProviderCompletionOption): string {
	const authTypes = provider.authTypes
		.map((authType) => `${authType} ${formatAuthSelectorProviderType(authType, provider.subscription)}`)
		.join(" ");
	return `${provider.id} ${provider.name} ${authTypes}`;
}

function formatLoginProviderCompletionDescription(provider: LoginProviderCompletionOption): string {
	const authTypes = provider.authTypes
		.map((authType) => formatAuthSelectorProviderType(authType, provider.subscription))
		.join("/");
	return provider.name === provider.id ? authTypes : `${provider.name} · ${authTypes}`;
}

/** Options for InteractiveMode initialization. */
export interface InteractiveModeOptions {
	/** Initial message to send on startup. */
	initialMessage?: string;
	/** Additional messages to send after the initial message. */
	initialMessages?: string[];
	/** Force verbose startup (overrides quietStartup setting). */
	verbose?: boolean;
	/** TUI layout mode; default — settings.tuiMode. */
	tuiMode?: InteractiveTuiMode;
	/** Initial interactive theme setting for this invocation. */
	initialThemeSetting?: string;
	/** Terminal implementation. Defaults to the current process terminal. */
	terminal?: Terminal;
}

/**
 * run() result (R5: instead of process.exit). code — exit code for cli.ts
 * (0 — user exit, 1 — error/fatal, 130 — SIGINT); switchSession — a session-switch request
 * from /resume //new: the integrator closes the runtime (already done via host.close) and
 * rebuilds it with the new session.
 */
export interface InteractiveRunResult {
	code: number;
	switchSession?: { kind: "new" } | { kind: "resume"; sessionId: string };
}

export class InteractiveMode {
	private readonly host: InteractiveHost;
	private renderer: TuiMainScreen | TuiAltScreen;
	private ui: TUI;
	private mainScreenRenderState: TuiMainScreenRenderState | undefined;
	private headerContainer: Container;
	private chatContainer: Container;
	private documentContainer: Container;
	private transcriptScrollView: ScrollView | undefined;
	private fullscreenLayoutRoot: Component | undefined;
	private pendingMessagesContainer: Container;
	private statusContainer: Container;
	private readonly editor: CustomEditor;
	private editorContainer: Container;
	private activeSelectorToken?: object;
	private activeSelectorDispose?: () => void;
	private footer: FooterComponent;
	private footerContainer: Container;
	private footerDataProvider: FooterDataProvider;
	private readonly footerSessionState: FooterSessionState = {};
	private keybindings: KeybindingsManager;
	private readonly version = VANREL_VERSION;
	private isInitialized = false;
	private onInputCallback?: (text: string) => void;
	private pendingInputReject?: (error: Error) => void;
	private pendingUserInputs: string[] = [];
	private activeStatusIndicator: StatusIndicator | undefined = undefined;
	private readonly defaultWorkingMessage = "Working";
	private readonly hiddenThinkingLabel = "Thinking...";

	private lastSigintTime = 0;
	private lastEscapeTime = 0;

	// Status line tracking (for mutating immediately-sequential status updates)
	private lastStatusSpacer: Spacer | undefined = undefined;
	private lastStatusText: ThemedText | undefined = undefined;
	private lastStatusMessage = "";

	// Streaming message tracking
	private streamingComponent: AssistantMessageComponent | undefined = undefined;
	private streamingMessage: AssistantMessage | undefined = undefined;

	// Tool execution tracking: toolCallId -> component
	private pendingTools = new Map<string, ToolExecutionComponent>();

	// Tool output expansion state
	private toolOutputExpanded = false;

	// Thinking block visibility state
	private hideThinkingBlock = false;
	private outputPad = 1;
	private readonly mermaidMarkdownTransformer: MarkdownTransformer = createMermaidMarkdownTransformer({
		getMode: () => this.host.settings.get("mermaidMode"),
		theme,
	});

	// A1: model facade (built in init after auth re-resolve; undefined on failure → /model degrades)
	private modelFacade: ModelFacade | undefined;
	private authProviders: AuthProvider[] = [];
	private currentModel: Model<any> | undefined;
	/** Last ref passed to facade.set (provider/id | alias); used by cycleModel. */
	private currentRef: string | undefined;

	// Agent event subscription
	private unsubscribe?: () => void;
	private signalCleanupHandlers: Array<() => void> = [];

	// Bash mode state (text starts with !)
	private isBashMode = false;
	private pendingBashComponents: BashExecutionComponent[] = [];
	private bashRunning = false;

	// Compaction state (host does not expose isCompacting — tracked via events)
	private compacting = false;
	private compactionQueuedMessages: QueuedMessage[] = [];

	// Messages queued into the agent by this TUI session (steer/followUp).
	// Agent has no queue reads for display — tracked locally.
	private queuedMessages: QueuedMessage[] = [];

	// Shutdown state (R5: return a code, no process.exit)
	private isShuttingDown = false;
	private suspended = false;
	private finishRun?: (result: InteractiveRunResult) => void;
	private pendingSwitch: InteractiveRunResult["switchSession"];

	/** Reports working, blocked, done, and error states to terminals that support OSC 7501. */
	private readonly programStatus = new ProgramStatusReporter(
		() => this.ui.terminal,
		() => this.host.session.getSessionName(),
	);

	private readonly onRightClickPaste = (): void => {
		void this.handleRightClickPaste();
	};

	private readonly options: InteractiveModeOptions & { tuiMode: InteractiveTuiMode };
	private themeController: InteractiveThemeController;

	constructor(host: InteractiveHost, options: InteractiveModeOptions = {}) {
		this.host = host;
		const settings = host.settings;
		setCapabilityOverrides(settings.get("terminalCapabilityOverrides"));
		const tuiMode = options.tuiMode ?? settings.get("tuiMode");
		this.options = { ...options, tuiMode };
		this.renderer = createInteractiveTui({
			tuiMode,
			showHardwareCursor: settings.get("showHardwareCursor"),
			logDirectory: host.paths.home,
			terminal: options.terminal,
			onRightClickPaste: this.onRightClickPaste,
			fullscreenCopyOnSelect: settings.get("fullscreenCopyOnSelect"),
			fullscreenWheelScrollLines: settings.get("fullscreenWheelScrollLines"),
		});
		this.ui = createInteractiveTuiReference(() => this.renderer);
		this.ui.setClearOnShrink(settings.get("clearOnShrink"));
		this.headerContainer = new Container();
		this.chatContainer = new Container();
		this.documentContainer = new Container();
		this.documentContainer.addChild(this.headerContainer);
		this.documentContainer.addChild(this.chatContainer);
		this.pendingMessagesContainer = new Container();
		this.statusContainer = new Container();
		this.keybindings = KeybindingsManager.create(host.paths.home, host.log);
		setKeybindings(this.keybindings);
		this.editor = new CustomEditor(this.ui, getEditorTheme(), this.keybindings, {
			paddingX: settings.get("editorPaddingX"),
			autocompleteMaxVisible: settings.get("autocompleteMaxVisible"),
			embedWorkingStatus: true,
		});
		this.editorContainer = new Container();
		this.editorContainer.addChild(this.editor);
		this.footerDataProvider = new FooterDataProvider(host.session.getCwd(), {
			getAvailableProviderCount: () => this.modelFacade?.availableProviderCount() ?? 0,
			log: host.log,
		});
		const footerSession: FooterSession = {
			sessionManager: host.session,
			state: this.footerSessionState,
			getContextUsage: () => this.getContextUsage(),
		};
		this.footer = new FooterComponent(footerSession, this.footerDataProvider);
		// auto-compaction lives in wiring (HistoryCompactor); no TUI toggle (settings strip, recon §4).
		this.footer.setAutoCompactEnabled(true);
		this.footerContainer = new Container();
		this.footerContainer.addChild(this.footer);

		this.hideThinkingBlock = settings.get("hideThinkingBlock");
		this.outputPad = settings.get("outputPad");

		this.themeController = new InteractiveThemeController(this.ui, {
			settings,
			log: host.log,
			showError: (message) => this.showError(message),
			onChanged: () => this.updateEditorBorderColor(),
			initialThemeSetting: options.initialThemeSetting,
		});
	}

	// =========================================================================
	// Init / run (R5: run returns a code, no process.exit)
	// =========================================================================

	async init(): Promise<void> {
		if (this.isInitialized) return;

		this.registerSignalHandlers();
		await this.initModelFacade();

		// Keep one component tree and remount it when changing renderers.
		const settings = this.host.settings;
		const viewport = createChatViewport({
			document: this.documentContainer,
			pendingMessages: this.pendingMessagesContainer,
			status: this.statusContainer,
			editor: this.editorContainer,
			footer: this.footerContainer,
			scrollbar: settings.get("fullscreenScrollbar"),
			scrollbarTrackStyle: (text) => theme.fg("scrollbarTrack", text),
			scrollbarThumbStyle: (text) => theme.fg("scrollbarThumb", text),
		});
		this.transcriptScrollView = viewport.transcript;
		this.fullscreenLayoutRoot = viewport.root;
		this.mountInteractiveTui(this.renderer, [
			this.documentContainer,
			this.pendingMessagesContainer,
			this.statusContainer,
			this.editorContainer,
			this.footerContainer,
		]);

		this.setupKeyHandlers();
		this.setupEditorSubmitHandler();
		this.setupAutocompleteProvider();
		this.subscribeToSession();

		this.ui.setFocus(this.editor);
		this.ui.start();
		this.isInitialized = true;
		this.programStatus.report();

		this.themeController.applyFromSettings();
		// The header bakes theme colors into text, so build it once the terminal reported its colors.
		await this.themeController.waitForTerminalColors();

		this.buildHeader();
		this.ui.requestRender();

		// Render restored session (resume) — empty for a new session.
		this.renderInitialMessages();

		onThemeChange(() => {
			this.ui.invalidate();
			this.updateEditorBorderColor();
			this.ui.requestRender();
		});

		this.footerDataProvider.onBranchChange(() => {
			this.footer.invalidate();
			this.ui.requestRender();
		});

		this.updateTerminalTitle();

		// Flush the completed startup state before loading the remaining syntax grammars.
		this.ui.renderNow();
		void loadAllHighlightLanguages().then(
			() => {
				if (!this.isInitialized) return;
				this.ui.invalidate();
				this.ui.requestRender();
			},
			(error: unknown) => {
				this.host.log.warn("syntax highlighting init failed", { error: String(error) });
			},
		);
		this.host.log.info("interactive mode initialized", { tuiMode: this.options.tuiMode });
	}

	/**
	 * A1: ModelFacade on top of host.router. auth re-resolve from the same store as wiring
	 * (host does not expose ResolvedAuth; an extra auth.json read at startup, ~ms).
	 */
	private async initModelFacade(): Promise<void> {
		this.authProviders = builtinAuthProviders({ storePath: this.host.paths.authFile, log: this.host.log });
		try {
			const auth = await resolveAuth({
				storePath: this.host.paths.authFile,
				providers: this.authProviders,
				log: this.host.log,
			});
			this.currentModel = this.host.agent.state.model;
			this.footerSessionState.model = this.currentModel;
			this.footerSessionState.thinkingLevel = this.host.agent.state.thinkingLevel;
			this.modelFacade = new DefaultModelFacade({
				router: this.host.router,
				auth,
				log: this.host.log,
				initialModel: this.currentModel,
				onModelChange: this.onFacadeModelChange,
			});
		} catch (error) {
			this.host.log.warn("model facade unavailable (auth resolve failed)", { error: String(error) });
		}
	}

	private readonly onFacadeModelChange = (ref: string, model: Model<any>): void => {
		// host.setModel: router.route + requestedModel change in wiring + budget recompute (A0 contract).
		// RouteError propagates up into facade.set → shown in the UI.
		this.host.setModel(ref);
		this.currentModel = model;
		this.currentRef = ref;
		this.footerSessionState.model = model;
		this.host.agent.state.model = model;
		this.footer.invalidate();
		this.updateEditorBorderColor();
	};

	/** Re-resolve auth after /login //logout and rebuild the facade (router wiring holds a startup snapshot). */
	private async refreshModelFacade(): Promise<void> {
		try {
			const auth = await resolveAuth({
				storePath: this.host.paths.authFile,
				providers: this.authProviders,
				log: this.host.log,
			});
			this.modelFacade = new DefaultModelFacade({
				router: this.host.router,
				auth,
				log: this.host.log,
				initialModel: this.currentModel,
				onModelChange: this.onFacadeModelChange,
			});
			this.footer.invalidate();
			this.ui.requestRender();
		} catch (error) {
			this.host.log.warn("auth re-resolve failed", { error: String(error) });
		}
	}

	/**
	 * Run the interactive mode. Resolves with the exit result; never calls process.exit (R5).
	 */
	run(): Promise<InteractiveRunResult> {
		const finished = new Promise<InteractiveRunResult>((resolve) => {
			this.finishRun = resolve;
		});
		void this.mainLoop();
		return finished;
	}

	private async mainLoop(): Promise<void> {
		try {
			await this.init();
		} catch (error) {
			await this.fatalShutdown("Interactive init failed", error);
			return;
		}

		// tmux extended-keys check (self-contained, recon §4: kept optional)
		void this.checkTmuxKeyboardSetup().then(
			(warning) => {
				if (warning) this.showWarning(warning);
			},
			() => {},
		);

		const { initialMessage, initialMessages } = this.options;
		if (initialMessage) {
			try {
				await this.host.prompt(initialMessage);
			} catch (error: unknown) {
				this.showError(error instanceof Error ? error.message : "Unknown error occurred");
			}
		}
		for (const message of initialMessages ?? []) {
			try {
				await this.host.prompt(message);
			} catch (error: unknown) {
				this.showError(error instanceof Error ? error.message : "Unknown error occurred");
			}
		}

		// Main interactive loop
		while (true) {
			let userInput: string;
			try {
				userInput = await this.getUserInput();
			} catch (error) {
				if (error instanceof ShutdownRequestedError) return; // shutdown() already resolved finishRun
				throw error;
			}
			try {
				await this.host.prompt(userInput);
			} catch (error: unknown) {
				this.showError(error instanceof Error ? error.message : "Unknown error occurred");
			}
		}
	}

	private async checkTmuxKeyboardSetup(): Promise<string | undefined> {
		if (!process.env.TMUX) return undefined;

		const runTmuxShow = (option: string): Promise<string | undefined> => {
			return new Promise((resolve) => {
				const proc = spawn("tmux", ["show", "-gv", option], {
					stdio: ["ignore", "pipe", "ignore"],
				});
				let stdout = "";
				const timer = setTimeout(() => {
					proc.kill();
					resolve(undefined);
				}, 2000);

				proc.stdout?.on("data", (data) => {
					stdout += data.toString();
				});
				proc.on("error", () => {
					clearTimeout(timer);
					resolve(undefined);
				});
				proc.on("close", (code) => {
					clearTimeout(timer);
					resolve(code === 0 ? stdout.trim() : undefined);
				});
			});
		};

		const [extendedKeys, extendedKeysFormat] = await Promise.all([
			runTmuxShow("extended-keys"),
			runTmuxShow("extended-keys-format"),
		]);

		// If we couldn't query tmux (timeout, sandbox, etc.), don't warn
		if (extendedKeys === undefined) return undefined;

		if (extendedKeys !== "on" && extendedKeys !== "always") {
			return "tmux extended-keys is off. Modified Enter keys may not work. Add `set -g extended-keys on` to ~/.tmux.conf and restart tmux.";
		}

		if (extendedKeysFormat === "xterm") {
			return `tmux extended-keys-format is xterm. ${APP_NAME} works best with csi-u. Add \`set -g extended-keys-format csi-u\` to ~/.tmux.conf and restart tmux.`;
		}

		return undefined;
	}

	// =========================================================================
	// Layout / renderer switching
	// =========================================================================

	private mountInteractiveTui(tui: TuiMainScreen | TuiAltScreen, components: readonly Component[]): void {
		for (const component of components) tui.addChild(component);
		if (isViewportTUI(tui)) {
			if (!this.fullscreenLayoutRoot) throw new Error("Fullscreen layout is not initialized");
			tui.setLayoutRoot(this.fullscreenLayoutRoot);
		}
	}

	private stopInteractiveTui(fullscreenExitOutput: InteractiveFullscreenExitOutput): void {
		if (this.renderer.mode === "fullscreen" && fullscreenExitOutput === "transcript") {
			while (this.renderer.hasOverlayEntries) this.renderer.hideOverlay();
			this.switchTuiMode("regular", false, false);
			this.renderer.renderNow();
		}
		this.ui.stop({ preserveScreen: this.renderer.mode === "fullscreen" });
	}

	private switchTuiMode(mode: InteractiveTuiMode, restoreProgress = true, startRenderer = true): boolean {
		const previousUi = this.renderer;
		if (mode === previousUi.mode) return true;
		if (previousUi.hasOverlayEntries) return false;

		const components = [...previousUi.children];
		const focus = previousUi.getFocusedComponent();
		const terminal = previousUi.terminal;
		const showHardwareCursor = previousUi.getShowHardwareCursor();
		const clearOnShrink = previousUi.getClearOnShrink();
		if (previousUi instanceof TuiMainScreen) {
			this.mainScreenRenderState = previousUi.captureRenderState();
		}

		previousUi.stop({ preserveScreen: true });
		previousUi.setFocus(null);
		previousUi.clear();
		if (isViewportTUI(previousUi)) previousUi.setLayoutRoot(undefined);

		const settings = this.host.settings;
		const nextUi = createInteractiveTui({
			tuiMode: mode,
			showHardwareCursor,
			logDirectory: this.host.paths.home,
			terminal,
			onRightClickPaste: this.onRightClickPaste,
			fullscreenCopyOnSelect: settings.get("fullscreenCopyOnSelect"),
			fullscreenWheelScrollLines: settings.get("fullscreenWheelScrollLines"),
		});
		nextUi.setClearOnShrink(clearOnShrink);
		if (nextUi instanceof TuiMainScreen && this.mainScreenRenderState) {
			nextUi.restoreRenderState(this.mainScreenRenderState);
		}
		this.renderer = nextUi;
		this.options.tuiMode = mode;
		this.mountInteractiveTui(nextUi, components);
		nextUi.invalidate();
		nextUi.setFocus(focus);
		if (!startRenderer) return true;
		nextUi.start();
		this.themeController.rebindTui();
		if (restoreProgress && settings.get("showTerminalProgress") && this.host.agent.state.isStreaming) {
			terminal.setProgress(true);
		}
		return true;
	}

	private applyFullscreenScrollbarSetting(): void {
		this.transcriptScrollView?.setScrollbar(this.host.settings.get("fullscreenScrollbar"));
	}

	/** Re-read SettingsFacade and apply (called when /settings closes). */
	private applyRuntimeSettings(): void {
		const settings = this.host.settings;
		setCapabilityOverrides(settings.get("terminalCapabilityOverrides"));
		this.applyFullscreenScrollbarSetting();
		if (this.renderer instanceof TuiAltScreen) {
			this.renderer.setCopyOnSelect(settings.get("fullscreenCopyOnSelect"));
			this.renderer.setWheelScrollLines(settings.get("fullscreenWheelScrollLines"));
		}
		this.footerDataProvider.setCwd(this.host.session.getCwd());
		this.hideThinkingBlock = settings.get("hideThinkingBlock");
		this.updateThinkingBlockVisibility();
		this.outputPad = settings.get("outputPad");
		this.ui.setShowHardwareCursor(settings.get("showHardwareCursor"));
		const clearOnShrink = settings.get("clearOnShrink");
		this.ui.setClearOnShrink(clearOnShrink);
		if (!clearOnShrink && !this.activeStatusIndicator) {
			this.statusContainer.clear();
		}
		this.editor.setPaddingX(settings.get("editorPaddingX"));
		this.editor.setAutocompleteMaxVisible(settings.get("autocompleteMaxVisible"));
		// tuiMode is persisted by settings-selector immediately; the actual switch happens when the
		// selector closes (Pi switched via the onTuiModeChange callback; the A3 facade has no callbacks).
		const wantedMode = settings.get("tuiMode");
		if (wantedMode !== this.renderer.mode) {
			if (this.switchTuiMode(wantedMode)) {
				if (!this.activeStatusIndicator) this.statusContainer.clear();
				this.showStatus(`TUI mode: ${wantedMode}`);
			} else {
				this.showStatus("Close active overlays before changing TUI mode");
			}
		}
		this.updateTerminalTitle();
	}

	private updateTerminalTitle(): void {
		const cwdBasename = path.basename(this.host.session.getCwd());
		const sessionName = this.host.session.getSessionName();
		if (sessionName) {
			this.ui.terminal.setTitle(`${APP_NAME} - ${sessionName} - ${cwdBasename}`);
		} else {
			this.ui.terminal.setTitle(`${APP_NAME} - ${cwdBasename}`);
		}
	}

	// =========================================================================
	// Startup header (pi-logo → @vanrel/tui brand vanrel-logo, recon §2c/A4)
	// =========================================================================

	private getStartupExpansionState(): boolean {
		return this.options.verbose === true || this.toolOutputExpanded;
	}

	/** Startup header (logo, version, key hints). Hidden only by quietStartup: true. */
	private shouldShowStartupHeader(): boolean {
		return this.options.verbose === true || this.host.settings.get("quietStartup") !== true;
	}

	private buildHeader(): void {
		if (!this.shouldShowStartupHeader()) {
			this.headerContainer.addChild(new Text("", 0, 0));
			return;
		}
		const logoLines = renderVanrelLogo(this.ui.terminal.columns, this.ui.terminal.rows);
		const versionLine = theme.fg("dim", `v${this.version}`);
		const withLogo = (hints: string): string => {
			if (logoLines.length === 0) return `${theme.fg("accent", theme.bold(APP_NAME))} ${versionLine}\n${hints}`;
			return `${logoLines.join("\n")}\n${APP_NAME} ${versionLine}\n${hints}`;
		};

		const hint = (keybinding: AppKeybinding, description: string) => keyHint(keybinding, description);
		const expandedInstructions = () =>
			[
				hint("app.interrupt", "to interrupt"),
				hint("app.clear", "to clear"),
				rawKeyHint(`${keyText("app.clear")} twice`, "to exit"),
				hint("app.exit", "to exit (empty)"),
				hint("app.suspend", "to suspend"),
				keyHint("tui.editor.deleteToLineEnd", "to delete to end"),
				hint("app.thinking.cycle", "to cycle thinking level"),
				rawKeyHint(`${keyText("app.model.cycleForward")}/${keyText("app.model.cycleBackward")}`, "to cycle models"),
				hint("app.model.select", "to select model"),
				hint("app.tools.expand", "to expand tools"),
				hint("app.thinking.toggle", "to expand thinking"),
				rawKeyHint("/", "for commands"),
				rawKeyHint("!", "to run bash"),
				rawKeyHint("!!", "to run bash (no context)"),
				hint("app.message.followUp", "to queue follow-up"),
				hint("app.message.dequeue", "to edit all queued messages"),
				hint("app.clipboard.pasteImage", "to paste files or text from clipboard"),
				rawKeyHint("drop files", "to attach"),
			].join("\n");
		const compactInstructions = () =>
			[
				hint("app.interrupt", "interrupt"),
				rawKeyHint(`${keyText("app.clear")}/${keyText("app.exit")}`, "clear/exit"),
				rawKeyHint("/", "commands"),
				rawKeyHint("!", "bash"),
				hint("app.tools.expand", "more"),
			].join(theme.fg("muted", " · "));
		const onboarding = () => theme.fg("dim", "Type a message to start. /hotkeys lists all shortcuts.");

		const header = new ExpandableText(
			() => `${withLogo(compactInstructions())}\n${onboarding()}`,
			() => `${withLogo(expandedInstructions())}\n${onboarding()}`,
			this.getStartupExpansionState(),
			1,
			0,
		);
		this.builtInHeader = header;

		this.headerContainer.addChild(new Spacer(1));
		this.headerContainer.addChild(header);
		this.headerContainer.addChild(new Spacer(1));
	}

	private builtInHeader: ExpandableText | undefined;

	// =========================================================================
	// Key handlers
	// =========================================================================

	private setupKeyHandlers(): void {
		this.editor.onEscape = () => {
			if (this.host.agent.state.isStreaming) {
				this.restoreQueuedMessagesToEditor({ abort: true });
			} else if (this.bashRunning) {
				// W14: host.abortBash — AbortController of the current executeBash (VENDOR-GAP W13 closed).
				this.host.abortBash();
				this.showStatus("Bash command aborted");
			} else if (this.isBashMode) {
				this.editor.setText("");
				this.isBashMode = false;
				this.updateEditorBorderColor();
			} else if (!this.editor.getText().trim()) {
				const action = this.host.settings.get("doubleEscapeAction");
				if (action !== "none") {
					const now = Date.now();
					if (now - this.lastEscapeTime < 500) {
						// fork/tree are stripped (recon §4) — the action is unavailable.
						this.showStatus(`Double-escape action "${action}" is not available in ${APP_NAME}`);
						this.lastEscapeTime = 0;
					} else {
						this.lastEscapeTime = now;
					}
				}
			}
		};

		this.editor.onAction("app.clear", () => this.handleCtrlC());
		this.editor.onCtrlD = () => this.handleCtrlD();
		this.editor.onAction("app.suspend", () => this.handleCtrlZ());
		this.editor.onAction("app.thinking.cycle", () => this.cycleThinkingLevel());
		this.editor.onAction("app.model.cycleForward", () => this.cycleModel("forward"));
		this.editor.onAction("app.model.cycleBackward", () => this.cycleModel("backward"));
		this.editor.onAction("app.model.select", () => this.showModelSelector());
		this.editor.onAction("app.tools.expand", () => this.toggleToolOutputExpansion());
		this.editor.onAction("app.thinking.toggle", () => this.toggleThinkingBlockVisibility());
		this.editor.onAction(
			"app.message.copy",
			() => void this.handleCopyCommand({ flashConfirmation: true, preferSelection: true }),
		);
		this.editor.onAction("app.message.followUp", () => this.handleFollowUp());
		this.editor.onAction("app.message.dequeue", () => this.handleDequeue());
		this.editor.onAction("app.session.new", () => void this.requestSessionSwitch({ kind: "new" }));
		this.editor.onAction("app.session.resume", () => this.showSessionSelector());
		this.editor.onAction("app.clipboard.pasteImage", () => void this.handleClipboardPaste());

		this.editor.onChange = (text: string) => {
			const wasBashMode = this.isBashMode;
			this.isBashMode = text.trimStart().startsWith("!");
			if (wasBashMode !== this.isBashMode) {
				this.updateEditorBorderColor();
			}
		};
	}

	private async handleRightClickPaste(): Promise<void> {
		const target = this.renderer.getFocusedComponent();
		const handleInput = target?.handleInput;
		if (!target || !handleInput) return;
		try {
			const text = await readClipboardText();
			if (!text || this.renderer.getFocusedComponent() !== target) return;
			handleInput.call(target, `\x1b[200~${text}\x1b[201~`);
			this.ui.requestRender();
		} catch (error) {
			this.host.log.debug("right-click paste failed", { error: String(error) });
		}
	}

	/** Clipboard paste: copied file paths go in as paths, plain text as text. Image paste stripped (R2). */
	private async handleClipboardPaste(): Promise<void> {
		try {
			const filePaths = await readClipboardFilePaths();
			if (filePaths) {
				if (filePaths.some((filePath) => /\p{Cc}/u.test(filePath))) {
					throw new Error("Clipboard file path contains control characters");
				}
				const paths = this.isBashMode ? filePaths.map(quoteIfNeeded).join(" ") : filePaths.join("\n");
				this.editor.insertTextAtCursor(paths);
				this.ui.requestRender();
				return;
			}

			const text = await readClipboardText();
			if (text) {
				this.editor.insertTextAtCursor(text);
				this.ui.requestRender();
			}
		} catch (error) {
			this.showError(`Failed to paste from clipboard: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private setupEditorSubmitHandler(): void {
		this.editor.onSubmit = async (text: string) => {
			text = text.trim();
			if (!text) return;

			// Slash commands (recon §4: remaining 14 + /export jsonl + !/!! bash)
			if (text === "/settings") {
				this.showSettingsSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/model" || text.startsWith("/model ")) {
				const searchTerm = text.startsWith("/model ") ? text.slice(7).trim() : undefined;
				this.editor.setText("");
				this.handleModelCommand(searchTerm);
				return;
			}
			if (text === "/thinking" || text.startsWith("/thinking ")) {
				const searchTerm = text.startsWith("/thinking ") ? text.slice(10).trim() : undefined;
				this.editor.setText("");
				this.handleThinkingCommand(searchTerm);
				return;
			}
			if (text === "/compact" || text.startsWith("/compact ")) {
				const customInstructions = text.startsWith("/compact ") ? text.slice(9).trim() : undefined;
				this.editor.setText("");
				await this.handleCompactCommand(customInstructions);
				return;
			}
			if (text === "/resume") {
				this.showSessionSelector();
				this.editor.setText("");
				return;
			}
			if (text === "/new") {
				this.editor.setText("");
				await this.requestSessionSwitch({ kind: "new" });
				return;
			}
			if (text === "/name" || text.startsWith("/name ")) {
				this.handleNameCommand(text);
				this.editor.setText("");
				return;
			}
			if (text === "/session") {
				this.handleSessionCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/copy") {
				await this.handleCopyCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/hotkeys") {
				this.handleHotkeysCommand();
				this.editor.setText("");
				return;
			}
			if (text === "/login" || text.startsWith("/login ")) {
				const providerRef = text.startsWith("/login ") ? text.slice(7).trim() : undefined;
				this.editor.setText("");
				await this.handleLoginCommand(providerRef);
				return;
			}
			if (text === "/logout") {
				this.editor.setText("");
				await this.handleLogoutCommand();
				return;
			}
			if (text === "/export" || text.startsWith("/export ")) {
				this.editor.setText("");
				await this.handleExportCommand(text);
				return;
			}
			if (text === "/quit") {
				this.editor.setText("");
				await this.shutdown(0, "user_exit");
				return;
			}

			// Handle bash command (! for normal, !! for excluded from context)
			if (text.startsWith("!")) {
				const isExcluded = text.startsWith("!!");
				const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
				if (command) {
					if (this.bashRunning) {
						this.showWarning("A bash command is already running. Wait for it to finish.");
						this.editor.setText(text);
						return;
					}
					this.editor.addToHistory(text);
					this.editor.setText("");
					await this.handleBashCommand(command, isExcluded);
					this.isBashMode = false;
					this.updateEditorBorderColor();
					return;
				}
			}

			// Queue input during compaction
			if (this.compacting) {
				this.queueCompactionMessage(text, "steer");
				return;
			}

			// If streaming, queue as steering message (agent.prompt throws on an active run)
			if (this.host.agent.state.isStreaming) {
				this.editor.addToHistory(text);
				this.editor.setText("");
				this.queueToAgent(text, "steer");
				return;
			}

			// Normal message submission: move pending bash components to chat first
			this.flushPendingBashComponents();

			if (this.onInputCallback) {
				this.onInputCallback(text);
			} else {
				this.pendingUserInputs.push(text);
			}
			this.editor.addToHistory(text);
		};
	}

	private handleCtrlC(): void {
		const now = Date.now();
		if (now - this.lastSigintTime < 500) {
			void this.shutdown(0, "user_exit");
		} else {
			this.clearEditor();
			this.lastSigintTime = now;
		}
	}

	private handleCtrlD(): void {
		// Only called when editor is empty (enforced by CustomEditor)
		void this.shutdown(0, "user_exit");
	}

	private handleCtrlZ(): void {
		if (process.platform === "win32") {
			this.showStatus("Suspend to background is not supported on Windows");
			return;
		}

		// Keep the event loop alive while suspended. Without this, stopping the TUI
		// can leave Node with no ref'ed handles, causing the process to exit on fg
		// before the SIGCONT handler gets a chance to restore the terminal.
		const suspendKeepAlive = setInterval(() => {}, 2 ** 30);

		// Ignore SIGINT while suspended so Ctrl+C in the terminal does not
		// kill the backgrounded process. The suspended flag is also checked by
		// the process-level SIGINT handler (registerSignalHandlers).
		this.suspended = true;

		// Set up handler to restore TUI when resumed
		process.once("SIGCONT", () => {
			clearInterval(suspendKeepAlive);
			this.suspended = false;
			this.ui.start();
			this.ui.requestRender(true);
		});

		try {
			// Stop the TUI (restore terminal to normal mode)
			this.ui.stop();

			// Send SIGTSTP to process group (pid=0 means all processes in group)
			process.kill(0, "SIGTSTP");
		} catch (error) {
			clearInterval(suspendKeepAlive);
			this.suspended = false;
			this.showError(`Suspend failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async handleFollowUp(): Promise<void> {
		const text = (this.editor.getExpandedText() ?? this.editor.getText()).trim();
		if (!text) return;

		// Queue input during compaction
		if (this.compacting) {
			this.queueCompactionMessage(text, "followUp");
			return;
		}

		// Alt+Enter queues a follow-up message (waits until agent finishes)
		if (this.host.agent.state.isStreaming) {
			this.editor.addToHistory(text);
			this.editor.setText("");
			this.queueToAgent(text, "followUp");
		} else if (this.editor.onSubmit) {
			// If not streaming, Alt+Enter acts like regular Enter
			this.editor.setText("");
			this.editor.onSubmit(text);
		}
	}

	private handleDequeue(): void {
		const restored = this.restoreQueuedMessagesToEditor();
		if (restored === 0) {
			this.showStatus("No queued messages to restore");
		} else {
			this.showStatus(`Restored ${restored} queued message${restored > 1 ? "s" : ""} to editor`);
		}
	}

	// =========================================================================
	// Agent/session events (host.subscribeSession, recon §3.3)
	// =========================================================================

	private subscribeToSession(): void {
		this.unsubscribe = this.host.subscribeSession((event) => {
			try {
				this.handleEvent(event);
			} catch (error) {
				this.host.log.error("event handler failed", {
					type: event.type,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		});
	}

	private handleEvent(event: InteractiveSessionEvent): void {
		this.footer.invalidate();
		this.programStatus.handleEvent(event);

		switch (event.type) {
			case "agent_start":
				this.pendingTools.clear();
				break;

			case "turn_start":
				if (this.host.settings.get("showTerminalProgress")) {
					this.ui.terminal.setProgress(true);
				}
				if (this.activeStatusIndicator?.kind !== "working") {
					this.showWorkingStatusIndicator();
				}
				this.ui.requestRender();
				break;

			case "session_info_changed":
				this.updateTerminalTitle();
				this.footer.invalidate();
				this.ui.requestRender();
				break;

			case "message_start":
				if (event.message.role === "user") {
					const text = this.getUserMessageText(event.message);
					const queuedIndex = this.queuedMessages.findIndex((queued) => queued.text === text);
					if (queuedIndex !== -1) this.queuedMessages.splice(queuedIndex, 1);
					this.addMessageToChat(event.message);
					this.updatePendingMessagesDisplay();
					this.ui.requestRender();
				} else if (event.message.role === "assistant") {
					this.streamingComponent = new AssistantMessageComponent(
						undefined,
						this.hideThinkingBlock,
						this.getMarkdownThemeWithSettings(),
						this.hiddenThinkingLabel,
						this.outputPad,
						this.getMarkdownTransformers(),
					);
					this.streamingMessage = event.message as AssistantMessage;
					this.chatContainer.addChild(this.streamingComponent);
					this.streamingComponent.updateContent(this.streamingMessage, true);
					this.ui.requestRender();
				}
				break;

			case "message_update":
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingMessage = event.message as AssistantMessage;
					this.streamingComponent.updateContent(this.streamingMessage, true);

					for (const content of this.streamingMessage.content) {
						if (content.type === "toolCall") {
							if (!this.pendingTools.has(content.id)) {
								const component = new ToolExecutionComponent(
									content.name,
									content.id,
									content.arguments,
									{ outputPad: this.outputPad },
									withBuiltInRenderers(content.name, undefined),
									this.ui,
									this.host.session.getCwd(),
								);
								component.setExpanded(this.toolOutputExpanded);
								this.chatContainer.addChild(component);
								this.pendingTools.set(content.id, component);
							} else {
								this.pendingTools.get(content.id)?.updateArgs(content.arguments);
							}
						}
					}
					this.ui.requestRender();
				}
				break;

			case "message_end": {
				if (event.message.role !== "assistant" || !this.streamingComponent) break;
				const message = event.message as AssistantMessage;
				this.streamingMessage = message;
				if (message.stopReason === "aborted" && !message.errorMessage) {
					message.errorMessage = "Operation aborted";
				}
				this.streamingComponent.updateContent(message, false);

				if (message.stopReason === "aborted" || message.stopReason === "error") {
					const errorMessage = message.errorMessage || "Error";
					for (const [, component] of this.pendingTools.entries()) {
						component.updateResult({
							content: [{ type: "text", text: errorMessage }],
							isError: true,
						});
					}
					this.pendingTools.clear();
				} else {
					// Args are now complete - trigger diff computation for edit tools
					for (const [, component] of this.pendingTools.entries()) {
						component.setArgsComplete();
					}
				}
				this.streamingComponent = undefined;
				this.streamingMessage = undefined;
				this.footer.invalidate();
				this.ui.requestRender();
				break;
			}

			case "bash_execution_update":
				// The bash execution callback (host.executeBash onUpdate) handles TUI output rendering.
				break;

			case "tool_execution_start": {
				let component = this.pendingTools.get(event.toolCallId);
				if (!component) {
					component = new ToolExecutionComponent(
						event.toolName,
						event.toolCallId,
						event.args,
						{ outputPad: this.outputPad },
						withBuiltInRenderers(event.toolName, undefined),
						this.ui,
						this.host.session.getCwd(),
					);
					component.setExpanded(this.toolOutputExpanded);
					this.chatContainer.addChild(component);
					this.pendingTools.set(event.toolCallId, component);
				}
				component.markExecutionStarted();
				this.ui.requestRender();
				break;
			}

			case "tool_execution_update": {
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.partialResult, isError: false }, true);
					this.ui.requestRender();
				}
				break;
			}

			case "tool_execution_end": {
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.result, isError: event.isError, durationMs: event.durationMs });
					this.pendingTools.delete(event.toolCallId);
					this.ui.requestRender();
				}
				break;
			}

			case "agent_end":
				if (this.host.settings.get("showTerminalProgress")) {
					this.ui.terminal.setProgress(false);
				}
				this.clearStatusIndicator("working");
				if (this.streamingComponent) {
					this.chatContainer.removeChild(this.streamingComponent);
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
				}
				this.pendingTools.clear();
				this.ui.requestRender();
				break;

			case "compaction_start": {
				this.compacting = true;
				if (this.host.settings.get("showTerminalProgress")) {
					this.ui.terminal.setProgress(true);
				}
				// host.abortCompaction exists (W14), but the Pi Escape swap is not ported — the W13 UI decision is kept.
				const colorFn = (text: string) =>
					(this.editor.borderColor ?? theme.getThinkingBorderColor(this.host.agent.state.thinkingLevel || "off"))(
						text,
					);
				this.showStatusIndicator(new CompactionStatusIndicator(this.ui, event.reason, colorFn));
				this.ui.requestRender();
				break;
			}

			case "compaction_end": {
				this.compacting = false;
				if (this.host.settings.get("showTerminalProgress")) {
					this.ui.terminal.setProgress(false);
				}
				this.clearStatusIndicator("compaction");
				// Threshold compaction runs mid-turn: turn_start already fired and will not repeat,
				// so the Working indicator is restored here while the agent is still streaming.
				if (this.host.agent.state.isStreaming && this.activeStatusIndicator?.kind !== "working") {
					this.showWorkingStatusIndicator();
				}
				if (event.errorMessage) {
					this.showError(event.errorMessage);
				} else if (event.result?.compacted) {
					this.chatContainer.addChild(new Spacer(1));
					if (event.result.summary) {
						this.addMessageToChat(
							createCompactionSummaryMessage(
								event.result.summary,
								event.result.tokensBefore,
								new Date().toISOString(),
							),
						);
					} else {
						this.chatContainer.addChild(
							new ThemedText(
								() =>
									theme.fg(
										"dim",
										`Context compacted (${formatTokens(event.result?.tokensBefore ?? 0)} → ${formatTokens(event.result?.tokensAfter ?? 0)} tokens)`,
									),
								1,
								0,
							),
						);
					}
					this.footer.invalidate();
				}
				void this.flushCompactionQueue();
				this.ui.requestRender();
				break;
			}
		}
	}

	// =========================================================================
	// Message rendering
	// =========================================================================

	/** Extract text content from a user message */
	private getUserMessageText(message: AgentMessage): string {
		if (message.role !== "user") return "";
		const textBlocks =
			typeof message.content === "string"
				? [{ type: "text", text: message.content }]
				: message.content.filter((c: { type: string }) => c.type === "text");
		return textBlocks.map((c) => (c as TextContent).text).join("");
	}

	/**
	 * Show a status message in the chat.
	 *
	 * If multiple status messages are emitted back-to-back (without anything else being added to the chat),
	 * we update the previous status line instead of appending new ones to avoid log spam.
	 */
	private showStatus(message: string): void {
		const children = this.chatContainer.children;
		const last = children.length > 0 ? children[children.length - 1] : undefined;
		const secondLast = children.length > 1 ? children[children.length - 2] : undefined;

		if (last && secondLast && last === this.lastStatusText && secondLast === this.lastStatusSpacer) {
			this.lastStatusMessage = message;
			this.lastStatusText.invalidate();
			this.ui.requestRender();
			return;
		}

		const spacer = new Spacer(1);
		this.lastStatusMessage = message;
		const text = new ThemedText(() => theme.fg("dim", this.lastStatusMessage), 1, 0);
		this.chatContainer.addChild(spacer);
		this.chatContainer.addChild(text);
		this.lastStatusSpacer = spacer;
		this.lastStatusText = text;
		this.ui.requestRender();
	}

	private addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void {
		switch (message.role) {
			case "bashExecution": {
				const component = new BashExecutionComponent(
					message.command,
					this.ui,
					message.excludeFromContext,
					this.outputPad,
				);
				if (message.output) {
					component.appendOutput(message.output);
				}
				component.setComplete(
					message.exitCode,
					message.cancelled,
					message.truncated ? ({ truncated: true, content: message.output } as TruncationResult) : undefined,
					message.fullOutputPath,
				);
				this.chatContainer.addChild(component);
				break;
			}
			case "custom": {
				// Extension messages are stripped (recon §4); appendCustomEntry (A2) remains the persistence hook.
				break;
			}
			case "compactionSummary": {
				this.chatContainer.addChild(new Spacer(1));
				const component = new CompactionSummaryMessageComponent(
					message,
					this.getMarkdownThemeWithSettings(),
					this.outputPad,
				);
				component.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(component);
				break;
			}
			case "system":
				break;
			case "user": {
				const textContent = this.getUserMessageText(message);
				if (textContent) {
					if (this.chatContainer.children.length > 0) {
						this.chatContainer.addChild(new Spacer(1));
					}
					this.chatContainer.addChild(
						new UserMessageComponent(
							textContent,
							this.getMarkdownThemeWithSettings(),
							this.outputPad,
							this.getMarkdownTransformers(),
						),
					);
					if (options?.populateHistory) {
						this.editor.addToHistory(textContent);
					}
				}
				break;
			}
			case "assistant": {
				this.chatContainer.addChild(
					new AssistantMessageComponent(
						message,
						this.hideThinkingBlock,
						this.getMarkdownThemeWithSettings(),
						this.hiddenThinkingLabel,
						this.outputPad,
						this.getMarkdownTransformers(),
					),
				);
				break;
			}
			case "toolResult": {
				// Tool results are rendered inline with tool calls, handled separately
				break;
			}
			default: {
				const _exhaustive: never = message;
				this.host.log.warn("unknown message role", { role: (_exhaustive as { role: string }).role });
			}
		}
	}

	/**
	 * Render persisted session entries to chat (initial render after resume).
	 * Vanrel linear model (A2): user/assistant/tool_result entries; compaction entries
	 * do not store a summary — an aggregated status at the end (same as Pi).
	 */
	private renderSessionEntries(entries: readonly SessionEntry[], options: { populateHistory?: boolean } = {}): void {
		// Selection coordinates point into the transcript being replaced (pi #9311).
		if (this.renderer instanceof TuiAltScreen) this.renderer.resetTextSelection();
		this.pendingTools.clear();
		const renderedPendingTools = new Map<string, ToolExecutionComponent>();

		for (const entry of entries) {
			if (entry.type === "user") {
				if (entry.content) {
					if (this.chatContainer.children.length > 0) {
						this.chatContainer.addChild(new Spacer(1));
					}
					this.chatContainer.addChild(
						new UserMessageComponent(
							entry.content,
							this.getMarkdownThemeWithSettings(),
							this.outputPad,
							this.getMarkdownTransformers(),
						),
					);
					if (options.populateHistory) {
						this.editor.addToHistory(entry.content);
					}
				}
				continue;
			}
			if (entry.type === "assistant") {
				const message = entry.message;
				this.chatContainer.addChild(
					new AssistantMessageComponent(
						message,
						this.hideThinkingBlock,
						this.getMarkdownThemeWithSettings(),
						this.hiddenThinkingLabel,
						this.outputPad,
						this.getMarkdownTransformers(),
					),
				);
				for (const content of message.content) {
					if (content.type === "toolCall") {
						const component = new ToolExecutionComponent(
							content.name,
							content.id,
							content.arguments,
							{ outputPad: this.outputPad },
							withBuiltInRenderers(content.name, undefined),
							this.ui,
							this.host.session.getCwd(),
						);
						component.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(component);
						if (message.stopReason === "aborted" || message.stopReason === "error") {
							component.updateResult({
								content: [{ type: "text", text: message.errorMessage || "Error" }],
								isError: true,
							});
						} else {
							renderedPendingTools.set(content.id, component);
						}
					}
				}
				continue;
			}
			if (entry.type === "tool_result") {
				const component = renderedPendingTools.get(entry.message.toolCallId);
				if (component) {
					component.updateResult({ content: entry.message.content, isError: entry.message.isError });
					renderedPendingTools.delete(entry.message.toolCallId);
				}
			}
			// compaction / session_info / custom: no inline render
		}

		for (const [toolCallId, component] of renderedPendingTools) {
			this.pendingTools.set(toolCallId, component);
		}
		this.ui.requestRender();
	}

	renderInitialMessages(): void {
		const entries = this.host.session.getEntries();
		this.renderSessionEntries(entries, { populateHistory: true });
		this.footer.invalidate();
		this.updateEditorBorderColor();

		// Show compaction info if session was compacted
		const compactionCount = entries.filter((entry) => entry.type === "compaction").length;
		if (compactionCount > 0) {
			const times = compactionCount === 1 ? "1 time" : `${compactionCount} times`;
			this.showStatus(`Session compacted ${times}`);
		}
	}

	async getUserInput(): Promise<string> {
		const queuedInput = this.pendingUserInputs.shift();
		if (queuedInput !== undefined) {
			return queuedInput;
		}

		return new Promise((resolve, reject) => {
			this.onInputCallback = (text: string) => {
				this.onInputCallback = undefined;
				this.pendingInputReject = undefined;
				resolve(text);
			};
			this.pendingInputReject = reject;
		});
	}

	// =========================================================================
	// Status indicators
	// =========================================================================

	private showStatusIndicator(indicator: StatusIndicator): void {
		this.activeStatusIndicator?.dispose();
		this.activeStatusIndicator = indicator;
		this.statusContainer.clear();
		// CustomEditor with embedWorkingStatus: render the indicator inside the editor frame.
		this.editor.setWorkingStatusIndicator(indicator);
		this.ui.requestRender();
	}

	private clearStatusIndicator(kind?: StatusIndicator["kind"]): void {
		if (kind && this.activeStatusIndicator?.kind !== kind) {
			return;
		}
		this.activeStatusIndicator?.dispose();
		this.activeStatusIndicator = undefined;
		this.statusContainer.clear();
		this.editor.setWorkingStatusIndicator(undefined);
		this.ui.requestRender();
	}

	private showWorkingStatusIndicator(): void {
		const colorFn = (text: string) =>
			(this.editor.borderColor ?? theme.getThinkingBorderColor(this.host.agent.state.thinkingLevel || "off"))(text);
		this.showStatusIndicator(new WorkingStatusIndicator(this.ui, this.defaultWorkingMessage, undefined, colorFn));
	}

	// =========================================================================
	// Queues (steer/followUp + compaction queue)
	// =========================================================================

	private updatePendingMessagesDisplay(): void {
		this.pendingMessagesContainer.clear();
		const steering = [
			...this.queuedMessages.filter((message) => message.mode === "steer").map((message) => message.text),
			...this.compactionQueuedMessages.filter((message) => message.mode === "steer").map((message) => message.text),
		];
		const followUp = [
			...this.queuedMessages.filter((message) => message.mode === "followUp").map((message) => message.text),
			...this.compactionQueuedMessages
				.filter((message) => message.mode === "followUp")
				.map((message) => message.text),
		];
		if (steering.length > 0 || followUp.length > 0) {
			this.pendingMessagesContainer.addChild(new Spacer(1));
			for (const message of steering) {
				this.pendingMessagesContainer.addChild(new TruncatedText(theme.fg("dim", `Steering: ${message}`), 1, 0));
			}
			for (const message of followUp) {
				this.pendingMessagesContainer.addChild(new TruncatedText(theme.fg("dim", `Follow-up: ${message}`), 1, 0));
			}
			const dequeueHint = keyDisplayText("app.message.dequeue");
			this.pendingMessagesContainer.addChild(
				new TruncatedText(theme.fg("dim", `↳ ${dequeueHint} to edit all queued messages`), 1, 0),
			);
		}
	}

	/** Steer/followUp into Agent + persist user entry (host.prompt does this only for the prompt path). */
	private queueToAgent(text: string, mode: "steer" | "followUp"): void {
		const message: AgentMessage = { role: "user", content: text, timestamp: Date.now() };
		if (mode === "steer") {
			this.host.agent.steer(message);
		} else {
			this.host.agent.followUp(message);
		}
		void this.host.session.appendUser(text).catch((error: unknown) => {
			this.host.log.warn("session persist failed (queued user message)", { error: String(error) });
		});
		this.queuedMessages.push({ text, mode });
		this.updatePendingMessagesDisplay();
		this.ui.requestRender();
	}

	private restoreQueuedMessagesToEditor(options?: { abort?: boolean; currentText?: string }): number {
		this.host.agent.clearAllQueues();
		const texts = [
			...this.queuedMessages.map((message) => message.text),
			...this.compactionQueuedMessages.map((message) => message.text),
		];
		this.queuedMessages = [];
		this.compactionQueuedMessages = [];
		if (texts.length === 0) {
			this.updatePendingMessagesDisplay();
			if (options?.abort) {
				this.host.agent.abort();
			}
			return 0;
		}
		const queuedText = texts.join("\n\n");
		const currentText = options?.currentText ?? this.editor.getText();
		const combinedText = [queuedText, currentText].filter((text) => text.trim()).join("\n\n");
		this.editor.setText(combinedText);
		this.updatePendingMessagesDisplay();
		if (options?.abort) {
			this.host.agent.abort();
		}
		return texts.length;
	}

	private queueCompactionMessage(text: string, mode: "steer" | "followUp"): void {
		this.compactionQueuedMessages.push({ text, mode });
		this.editor.addToHistory(text);
		this.editor.setText("");
		this.updatePendingMessagesDisplay();
		this.showStatus("Queued message for after compaction");
	}

	private async flushCompactionQueue(): Promise<void> {
		if (this.compactionQueuedMessages.length === 0) {
			return;
		}

		const queuedMessages = [...this.compactionQueuedMessages];
		this.compactionQueuedMessages = [];
		this.updatePendingMessagesDisplay();

		for (const message of queuedMessages) {
			try {
				// The run may have restarted (auto-retry): active run → steer/followUp, idle → prompt.
				if (this.host.agent.state.isStreaming) {
					this.queueToAgent(message.text, message.mode);
				} else {
					await this.host.prompt(message.text);
				}
			} catch (error) {
				this.showError(`Failed to send queued message: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	/** Move pending bash components from pending area to chat */
	private flushPendingBashComponents(): void {
		for (const component of this.pendingBashComponents) {
			this.pendingMessagesContainer.removeChild(component);
			this.chatContainer.addChild(component);
		}
		this.pendingBashComponents = [];
	}

	// =========================================================================
	// Selectors
	// =========================================================================

	private disposeActiveSelector(): void {
		const dispose = this.activeSelectorDispose;
		this.activeSelectorToken = undefined;
		this.activeSelectorDispose = undefined;
		dispose?.();
	}

	/**
	 * Shows a selector component in place of the editor.
	 * @param create Factory that receives a `done` callback and returns the component and focus target
	 */
	private showSelector(
		create: (done: () => void) => { component: Component; focus: Component; dispose?: () => void },
	): void {
		const token = {};
		let dispose: (() => void) | undefined;
		const done = () => {
			dispose?.();
			if (this.activeSelectorToken !== token) return;
			this.activeSelectorToken = undefined;
			this.activeSelectorDispose = undefined;
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
		};
		const created = create(done);
		dispose = created.dispose;
		this.disposeActiveSelector();
		this.activeSelectorToken = token;
		this.activeSelectorDispose = dispose;
		this.editorContainer.clear();
		this.editorContainer.addChild(created.component);
		this.ui.setFocus(created.focus);
		this.ui.requestRender();
	}

	private showSettingsSelector(): void {
		this.showSelector((done) => {
			const selector = new SettingsSelectorComponent(
				this.host.settings,
				this.themeController,
				() => {
					done();
					// Settings-selector persists via A3 without callbacks — apply on close.
					this.applyRuntimeSettings();
					this.ui.requestRender();
				},
				this.host.log,
			);
			return { component: selector, focus: selector.getSettingsList() };
		});
	}

	private getAvailableThinkingLevels(): ThinkingLevel[] {
		const model = this.currentModel;
		if (!model) return [...THINKING_LEVEL_OPTIONS];
		return getSupportedThinkingLevels(model);
	}

	private handleThinkingCommand(searchTerm?: string): void {
		const availableLevels = this.getAvailableThinkingLevels();
		if (!searchTerm) {
			this.showThinkingSelector();
			return;
		}

		const normalized = searchTerm.trim().toLowerCase();
		const level = availableLevels.find((candidate) => candidate.toLowerCase() === normalized);
		if (!level) {
			this.showError(`Unknown thinking level "${searchTerm}". Available levels: ${availableLevels.join(", ")}.`);
			return;
		}

		this.selectThinkingLevel(level, false);
	}

	private selectThinkingLevel(level: ThinkingLevel, persist: boolean): void {
		try {
			this.host.setThinkingLevel(level);
			this.footerSessionState.thinkingLevel = level;
			if (persist) {
				void this.host.settings.set("defaultThinkingLevel", level).catch((error: unknown) => {
					this.host.log.warn("settings: persist failed", { key: "defaultThinkingLevel", error: String(error) });
				});
			}
			this.footer.invalidate();
			this.updateEditorBorderColor();
			this.showStatus(persist ? `Default thinking level: ${level}` : `Thinking level: ${level}`);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private showThinkingSelector(): void {
		this.showSelector((done) => {
			const selectLevel = (level: ThinkingLevel, persist: boolean) => {
				this.selectThinkingLevel(level, persist);
				done();
			};
			const selector = new ThinkingSelectorComponent(
				this.host.agent.state.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
				this.getAvailableThinkingLevels(),
				(level) => selectLevel(level, false),
				() => {
					done();
					this.ui.requestRender();
				},
				(level) => selectLevel(level, true),
				this.host.settings.get("defaultThinkingLevel") ?? DEFAULT_THINKING_LEVEL,
			);
			return { component: selector, focus: selector };
		});
	}

	private handleModelCommand(searchTerm?: string): void {
		const facade = this.modelFacade;
		if (!facade) {
			this.showError("Model list is unavailable (auth not resolved)");
			return;
		}
		if (!searchTerm) {
			this.showModelSelector();
			return;
		}

		try {
			// Exact ref ("provider/id") or alias ("default"/"cheap"): validation inside the facade.
			facade.set(searchTerm);
			this.showStatus(`Model: ${this.currentModel?.id ?? searchTerm}`);
		} catch {
			// RouteError → fuzzy search in the selector (same as Pi on an inexact match).
			this.showModelSelector(searchTerm);
		}
	}

	private showModelSelector(initialSearchInput?: string): void {
		const facade = this.modelFacade;
		if (!facade) {
			this.showError("Model list is unavailable (auth not resolved)");
			return;
		}
		this.showSelector((done) => {
			const selector = new ModelSelectorComponent(
				this.ui,
				facade,
				(selection) => {
					try {
						facade.set(`${selection.provider}/${selection.id}`);
						done();
						this.showStatus(`Model: ${selection.id}`);
					} catch (error) {
						done();
						this.showError(error instanceof Error ? error.message : String(error));
					}
				},
				() => {
					done();
					this.ui.requestRender();
				},
				initialSearchInput,
			);
			return { component: selector, focus: selector };
		});
	}

	/** R6: cycling over the list of available models (Pi aliases/scope are stripped). */
	private cycleModel(direction: "forward" | "backward"): void {
		const facade = this.modelFacade;
		if (!facade) {
			this.showError("Model list is unavailable (auth not resolved)");
			return;
		}
		const models = facade.listAvailable();
		if (models.length <= 1) {
			this.showStatus("Only one model available");
			return;
		}
		const refs = models.map((model) => `${model.provider}/${model.id}`);
		let index = this.currentRef ? refs.indexOf(this.currentRef) : -1;
		if (index === -1) {
			index = models.findIndex((model) => model.id === this.currentModel?.id);
		}
		const step = direction === "forward" ? 1 : -1;
		const next = models[(Math.max(index, 0) + step + models.length) % models.length];
		try {
			facade.set(`${next.provider}/${next.id}`);
			this.showStatus(`Switched to ${next.name || next.id} (${next.provider}/${next.id})`);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	private cycleThinkingLevel(): void {
		const levels = this.getAvailableThinkingLevels();
		const current = this.host.agent.state.thinkingLevel;
		const index = levels.indexOf(current);
		if (levels.length <= 1) {
			this.showStatus("Current model does not support thinking");
			return;
		}
		this.selectThinkingLevel(levels[(index + 1) % levels.length], false);
	}

	private showSessionSelector(): void {
		this.showSelector((done) => {
			const sessionsLoader = async (): Promise<SessionInfo[]> => {
				const sessions: SessionInfo[] = [];
				for await (const info of SessionManager.list(this.host.session.getSessionDir(), this.host.log)) {
					sessions.push(info);
				}
				return sessions;
			};
			const selector = new SessionSelectorComponent(
				sessionsLoader,
				(sessionPath) => {
					done();
					this.requestResumeSession(sessionPath);
				},
				() => {
					done();
					this.ui.requestRender();
				},
				() => this.ui.requestRender(),
				// Renaming another session is not supported: A2 SessionManager does not open foreign files for writing.
				{ showRenameHint: false },
				this.host.session.getSessionFile(),
			);
			return { component: selector, focus: selector };
		});
	}

	/**
	 * /resume: host has no switchSession (runtime per-session) — exit with a session-switch
	 * request in InteractiveRunResult; run.ts rebuilds the runtime (recon §5 item 7).
	 */
	private requestResumeSession(sessionPath: string): void {
		const sessionId = path.basename(sessionPath).replace(/\.jsonl$/, "");
		if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId)) {
			this.showError(`Not a ${APP_NAME} session file: ${sessionPath}`);
			return;
		}
		this.showStatus(`Switching to session ${sessionId}...`);
		void this.requestSessionSwitch({ kind: "resume", sessionId });
	}

	private async requestSessionSwitch(
		switchSession: NonNullable<InteractiveRunResult["switchSession"]>,
	): Promise<void> {
		this.host.log.info("session switch requested", { switchSession });
		this.pendingSwitch = switchSession;
		await this.shutdown(0, "completed");
	}

	// =========================================================================
	// Login / logout (oauth-selector/login-dialog → provider.login, recon §3.3)
	// =========================================================================

	private async handleLoginCommand(providerRef?: string): Promise<void> {
		const options = this.modelFacade?.loginProviderOptions() ?? [];
		if (!providerRef) {
			this.showLoginProviderSelector(options);
			return;
		}

		const normalized = providerRef.trim().toLowerCase();
		const matches = options.filter(
			(provider) => provider.id.toLowerCase() === normalized || provider.name.toLowerCase() === normalized,
		);
		if (matches.length === 1) {
			await this.startProviderLogin(matches[0].id as AuthProviderId);
			return;
		}

		this.showLoginProviderSelector(options, providerRef);
	}

	private showLoginProviderSelector(options: AuthSelectorProvider[], initialSearchInput?: string): void {
		if (options.length === 0) {
			this.showStatus("No login providers available.");
			return;
		}

		this.showSelector((done) => {
			const selector = new OAuthSelectorComponent(
				"login",
				options,
				(providerId) => {
					done();
					void this.startProviderLogin(providerId as AuthProviderId);
				},
				() => {
					done();
					this.ui.requestRender();
				},
				initialSearchInput,
			);
			return { component: selector, focus: selector };
		});
	}

	private async startProviderLogin(providerId: AuthProviderId): Promise<void> {
		const provider = this.authProviders.find((candidate) => candidate.id === providerId);
		if (!provider?.login) {
			this.showError(`Provider ${providerId} has no interactive login flow`);
			return;
		}
		let flow: "loopback" | "paste-code" = "loopback";
		if (provider.supportsPasteCode) {
			const choice = await this.showLoginFlowChoice(providerId);
			if (!choice) return;
			flow = choice;
		}
		await this.showLoginDialog(provider, flow);
	}

	/** OAuth flow choice: loopback (browser) or paste-code (headless/SSH, W6 LoginOptions.flow). */
	private showLoginFlowChoice(providerId: AuthProviderId): Promise<"loopback" | "paste-code" | undefined> {
		const providerName = this.providerDisplayName(providerId);
		return new Promise((resolve) => {
			this.showSelector((done) => {
				const submenu = new SelectSubmenu(
					`Login to ${providerName}`,
					"Browser login opens a local callback server; paste-code is for headless/SSH sessions.",
					[
						{ value: "loopback", label: "Sign in with browser" },
						{ value: "paste-code", label: "Paste authorization code" },
					],
					"loopback",
					(value) => {
						done();
						resolve(value === "paste-code" ? "paste-code" : "loopback");
					},
					() => {
						done();
						resolve(undefined);
					},
				);
				return { component: submenu, focus: submenu };
			});
		});
	}

	private providerDisplayName(providerId: string): string {
		return this.modelFacade?.loginProviderOptions().find((option) => option.id === providerId)?.name ?? providerId;
	}

	private async showLoginDialog(provider: AuthProvider, flow: "loopback" | "paste-code"): Promise<void> {
		// startProviderLogin guarantees login exists; bind for local narrowing (login? in the type).
		const login = provider.login?.bind(provider);
		if (!login) {
			this.showError(`Provider ${provider.id} has no interactive login flow`);
			return;
		}
		const providerName = this.providerDisplayName(provider.id);
		const dialog = new LoginDialogComponent(this.ui, provider.id, () => {}, providerName);
		this.disposeActiveSelector();
		this.editorContainer.clear();
		this.editorContainer.addChild(dialog);
		this.ui.setFocus(dialog);
		this.programStatus.setBlocked("login", { kind: "auth", message: `Log in to ${providerName}` });
		this.ui.requestRender();

		const restoreEditor = () => {
			this.editorContainer.clear();
			this.editorContainer.addChild(this.editor);
			this.ui.setFocus(this.editor);
			this.ui.requestRender();
		};

		try {
			await login({
				signal: dialog.signal,
				flow,
				onAuthUrl: (url) => dialog.showAuth(url),
				promptCode: (prompt, signal) =>
					this.raceWithSignal(dialog.showPrompt(prompt.message, prompt.placeholder), signal),
			});
			restoreEditor();
			await this.refreshModelFacade();
			this.host.log.info("login completed", { provider: provider.id, flow });
			this.showStatus(
				`Logged in to ${providerName}. Credentials saved to ${this.host.paths.authFile}. ` +
					`Restart ${APP_NAME} to route requests to ${provider.id}.`,
			);
		} catch (error: unknown) {
			restoreEditor();
			if (error instanceof AuthFlowError && error.reason === "user-cancel") {
				this.showStatus("Login cancelled");
			} else {
				const message = error instanceof Error ? error.message : String(error);
				this.host.log.warn("login failed", { provider: provider.id, error: message });
				this.showError(`Failed to login to ${providerName}: ${message}`);
			}
		} finally {
			this.programStatus.setBlocked("login", undefined);
		}
	}

	private raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
		if (!signal) return promise;
		if (signal.aborted) return Promise.reject(new Error("Login cancelled"));
		return new Promise<T>((resolve, reject) => {
			const onAbort = () => reject(new Error("Login cancelled"));
			signal.addEventListener("abort", onAbort, { once: true });
			promise.then(
				(value) => {
					signal.removeEventListener("abort", onAbort);
					resolve(value);
				},
				(error: unknown) => {
					signal.removeEventListener("abort", onAbort);
					reject(error instanceof Error ? error : new Error(String(error)));
				},
			);
		});
	}

	private async handleLogoutCommand(): Promise<void> {
		const store = new FileCredentialStore({ path: this.host.paths.authFile, log: this.host.log });
		let stored: readonly { providerId: string; type: string }[];
		try {
			stored = await store.list();
		} catch (error) {
			this.showError(`Could not read stored credentials: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		if (stored.length === 0) {
			this.showStatus(
				"No stored credentials to remove. /logout only removes credentials saved by /login; environment variables and config are unchanged.",
			);
			return;
		}

		const options: AuthSelectorProvider[] = stored
			.map((info) => ({
				id: info.providerId,
				name: this.providerDisplayName(info.providerId),
				authType: "oauth" as const,
				status: { type: "oauth" as const, source: "stored credential" },
			}))
			.sort((a, b) => a.name.localeCompare(b.name));

		this.showSelector((done) => {
			const selector = new OAuthSelectorComponent(
				"logout",
				options,
				(providerId) => {
					done();
					void (async () => {
						try {
							await store.delete(providerId);
							await this.refreshModelFacade();
							this.host.log.info("logout completed", { provider: providerId });
							this.showStatus(
								`Removed stored credential for ${this.providerDisplayName(providerId)}. ` +
									`The running session keeps its in-memory credential until restart.`,
							);
						} catch (error: unknown) {
							this.showError(`Logout failed: ${error instanceof Error ? error.message : String(error)}`);
						}
					})();
				},
				() => {
					done();
					this.ui.requestRender();
				},
			);
			return { component: selector, focus: selector };
		});
	}

	// =========================================================================
	// Command handlers
	// =========================================================================

	/** /export: jsonl copy of the session file only (linear model; Pi HTML export stripped, recon §4). */
	private async handleExportCommand(text: string): Promise<void> {
		const outputPath = this.getPathCommandArgument(text, "/export");
		const source = this.host.session.getSessionFile();
		const target =
			outputPath ??
			`vanrel-session-${this.host.session.getSessionId()}-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
		if (!target.endsWith(".jsonl")) {
			this.showError("Export target must be a .jsonl file (HTML export is not supported)");
			return;
		}
		try {
			const resolved = path.resolve(this.host.session.getCwd(), target);
			await mkdir(path.dirname(resolved), { recursive: true });
			await copyFile(source, resolved);
			this.host.log.info("session exported", { source, target: resolved });
			this.showStatus(`Session exported to: ${resolved}`);
		} catch (error: unknown) {
			this.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	}

	private getPathCommandArgument(text: string, command: "/export"): string | undefined {
		if (text === command) {
			return undefined;
		}
		if (!text.startsWith(`${command} `)) {
			return undefined;
		}

		const argsString = text.slice(command.length + 1).trimStart();
		if (!argsString) {
			return undefined;
		}

		const firstChar = argsString[0];
		if (firstChar === '"' || firstChar === "'") {
			const closingQuoteIndex = argsString.indexOf(firstChar, 1);
			if (closingQuoteIndex < 0) {
				return undefined;
			}
			return argsString.slice(1, closingQuoteIndex);
		}

		const firstWhitespaceIndex = argsString.search(/\s/);
		if (firstWhitespaceIndex < 0) {
			return argsString;
		}
		return argsString.slice(0, firstWhitespaceIndex);
	}

	private async handleCopyCommand(
		options: { flashConfirmation?: boolean; preferSelection?: boolean } = {},
	): Promise<void> {
		if (
			options.preferSelection &&
			this.renderer instanceof TuiAltScreen &&
			!this.renderer.getCopyOnSelect() &&
			this.renderer.hasActiveSelection()
		) {
			await this.renderer.copyActiveSelectionToClipboard();
			return;
		}

		const text = this.getLastAssistantText();
		if (!text) {
			this.showError("No agent messages to copy yet.");
			return;
		}

		try {
			await copyToClipboard(text);
			if (options.flashConfirmation && this.renderer instanceof TuiAltScreen) {
				this.renderer.flash("Copied!");
			} else {
				this.showStatus("Copied last agent message to clipboard");
			}
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		}
	}

	/** session.getLastAssistantText from Pi — local equivalent over agent.state.messages. */
	private getLastAssistantText(): string | undefined {
		const messages = this.host.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (message.role !== "assistant") continue;
			const text = (message as AssistantMessage).content
				.filter((content): content is TextContent => content.type === "text")
				.map((content) => content.text)
				.join("\n")
				.trim();
			if (text) return text;
		}
		return undefined;
	}

	private handleNameCommand(text: string): void {
		const name = text.replace(/^\/name\s*/, "").trim();
		if (!name) {
			const currentName = this.host.session.getSessionName();
			if (currentName) {
				this.chatContainer.addChild(new Spacer(1));
				this.chatContainer.addChild(new ThemedText(() => theme.fg("dim", `Session name: ${currentName}`), 1, 0));
			} else {
				this.showWarning("Usage: /name <name>");
			}
			this.ui.requestRender();
			return;
		}

		void this.host.session.setSessionName(name).then(
			() => {
				this.chatContainer.addChild(new Spacer(1));
				this.chatContainer.addChild(new ThemedText(() => theme.fg("dim", `Session name set: ${name}`), 1, 0));
				this.updateTerminalTitle();
				this.footer.invalidate();
				this.ui.requestRender();
			},
			(error: unknown) => {
				this.showError(`Failed to set session name: ${error instanceof Error ? error.message : String(error)}`);
			},
		);
	}

	private handleSessionCommand(): void {
		const session = this.host.session;
		const stats = this.host.stats;
		const entries = session.getEntries();
		const sessionName = session.getSessionName();

		const totals = createUsageTotals();
		let userMessages = 0;
		let assistantMessages = 0;
		let toolCalls = 0;
		let toolResults = 0;
		for (const entry of entries) {
			if (entry.type === "user") {
				userMessages++;
			} else if (entry.type === "assistant") {
				assistantMessages++;
				addUsageToTotals(totals, entry.message.usage);
				for (const content of entry.message.content) {
					if (content.type === "toolCall") toolCalls++;
				}
			} else if (entry.type === "tool_result") {
				toolResults++;
				if (entry.message.usage) addUsageToTotals(totals, entry.message.usage);
			}
		}
		const usageBreakdown = getUsageCostBreakdown(entries);

		// Snapshot the stats; the text is built on demand so it follows theme changes.
		const renderInfo = (): string => {
			let info = `${theme.bold("Session Info")}\n\n`;
			if (sessionName) {
				info += `${theme.fg("dim", "Name:")} ${sessionName}\n`;
			}
			info += `${theme.fg("dim", "File:")} ${session.getSessionFile()}\n`;
			info += `${theme.fg("dim", "ID:")} ${session.getSessionId()}\n\n`;
			info += `${theme.bold("Messages")}\n`;
			info += `${theme.fg("dim", "Total:")} ${entries.length}\n`;
			info += `${theme.fg("dim", "User:")} ${userMessages}\n`;
			info += `${theme.fg("dim", "Assistant:")} ${assistantMessages}\n`;
			info += `${theme.fg("dim", "Tools:")} ${toolCalls} calls, ${toolResults} results\n\n`;
			info += `${theme.bold("Tokens")}\n`;
			// "Input" is the full prompt volume: cached (served from cache) + uncached.
			const { input, cacheRead, cacheWrite } = totals;
			const promptTokens = input + cacheRead + cacheWrite;
			info += `${theme.fg("dim", "Input:")} ${promptTokens.toLocaleString()}\n`;
			if (promptTokens > 0 && (cacheRead > 0 || cacheWrite > 0)) {
				const hitRate = theme.fg("dim", `(${((cacheRead / promptTokens) * 100).toFixed(1)}%)`);
				info += `  ${theme.fg("dim", "Cached:")} ${cacheRead.toLocaleString()} ${hitRate}\n`;
				const written =
					cacheWrite > 0 ? ` ${theme.fg("dim", `(${cacheWrite.toLocaleString()} written to cache)`)}` : "";
				info += `  ${theme.fg("dim", "Uncached:")} ${(input + cacheWrite).toLocaleString()}${written}\n`;
			}
			info += `${theme.fg("dim", "Output:")} ${totals.output.toLocaleString()}\n`;
			info += `${theme.fg("dim", "Total:")} ${(promptTokens + totals.output).toLocaleString()}\n`;
			info += `\n${theme.bold("Session")}\n`;
			info += `${theme.fg("dim", "Turns:")} ${stats.turns}\n`;
			info += `${theme.fg("dim", "LLM requests:")} ${stats.llmRequests}\n`;

			if (totals.cost > 0) {
				info += `\n${theme.bold("Cost")}\n`;
				info += `${theme.fg("dim", "Total:")} $${totals.cost.toFixed(3)}`;
				const selectedModelKey = this.currentModel ? `${this.currentModel.provider}/${this.currentModel.id}` : "";
				if (usageBreakdown.length > 1 || usageBreakdown[0]?.key !== selectedModelKey) {
					for (const breakdownEntry of usageBreakdown) {
						info += `\n  ${theme.fg("dim", `${breakdownEntry.key}:`)} $${breakdownEntry.cost.toFixed(3)} ${theme.fg("dim", `(${formatTokens(breakdownEntry.tokens)} tokens)`)}`;
					}
				}
			}
			return info;
		};

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new ThemedText(renderInfo, 1, 0));
		this.ui.requestRender();
	}

	private handleHotkeysCommand(): void {
		const keyDisplay = (action: Parameters<typeof keyDisplayText>[0]): string => keyDisplayText(action);

		// Navigation keybindings
		const cursorUp = keyDisplay("tui.editor.cursorUp");
		const cursorDown = keyDisplay("tui.editor.cursorDown");
		const cursorLeft = keyDisplay("tui.editor.cursorLeft");
		const cursorRight = keyDisplay("tui.editor.cursorRight");
		const cursorWordLeft = keyDisplay("tui.editor.cursorWordLeft");
		const cursorWordRight = keyDisplay("tui.editor.cursorWordRight");
		const cursorLineStart = keyDisplay("tui.editor.cursorLineStart");
		const cursorLineEnd = keyDisplay("tui.editor.cursorLineEnd");
		const jumpForward = keyDisplay("tui.editor.jumpForward");
		const jumpBackward = keyDisplay("tui.editor.jumpBackward");
		const pageUp = keyDisplay("tui.editor.pageUp");
		const pageDown = keyDisplay("tui.editor.pageDown");

		// Editing keybindings
		const submit = keyDisplay("tui.input.submit");
		const newLine = keyDisplay("tui.input.newLine");
		const deleteWordBackward = keyDisplay("tui.editor.deleteWordBackward");
		const deleteWordForward = keyDisplay("tui.editor.deleteWordForward");
		const deleteToLineStart = keyDisplay("tui.editor.deleteToLineStart");
		const deleteToLineEnd = keyDisplay("tui.editor.deleteToLineEnd");
		const yank = keyDisplay("tui.editor.yank");
		const yankPop = keyDisplay("tui.editor.yankPop");
		const undo = keyDisplay("tui.editor.undo");
		const tab = keyDisplay("tui.input.tab");

		// App keybindings
		const interrupt = keyDisplay("app.interrupt");
		const clear = keyDisplay("app.clear");
		const exit = keyDisplay("app.exit");
		const suspend = keyDisplay("app.suspend");
		const cycleThinking = keyDisplay("app.thinking.cycle");
		const cycleModelForward = keyDisplay("app.model.cycleForward");
		const cycleModelBackward = keyDisplay("app.model.cycleBackward");
		const selectModel = keyDisplay("app.model.select");
		const expandTools = keyDisplay("app.tools.expand");
		const toggleThinking = keyDisplay("app.thinking.toggle");
		const copyMessage = keyDisplay("app.message.copy");
		const followUp = keyDisplay("app.message.followUp");
		const dequeue = keyDisplay("app.message.dequeue");
		const paste = keyDisplay("app.clipboard.pasteImage");

		const hotkeys = `
**Navigation**
| Key | Action |
|-----|--------|
| \`${cursorUp}\` / \`${cursorDown}\` / \`${cursorLeft}\` / \`${cursorRight}\` | Move cursor / browse history |
| \`${cursorWordLeft}\` / \`${cursorWordRight}\` | Move by word |
| \`${cursorLineStart}\` | Start of line |
| \`${cursorLineEnd}\` | End of line |
| \`${jumpForward}\` | Jump forward to character |
| \`${jumpBackward}\` | Jump backward to character |
| \`${pageUp}\` / \`${pageDown}\` | Scroll by page |

**Editing**
| Key | Action |
|-----|--------|
| \`${submit}\` | Send message |
| \`${newLine}\` | New line${process.platform === "win32" ? " (Ctrl+Enter on Windows Terminal)" : ""} |
| \`${deleteWordBackward}\` | Delete word backwards |
| \`${deleteWordForward}\` | Delete word forwards |
| \`${deleteToLineStart}\` | Delete to start of line |
| \`${deleteToLineEnd}\` | Delete to end of line |
| \`${yank}\` | Paste the most-recently-deleted text |
| \`${yankPop}\` | Cycle through the deleted text after pasting |
| \`${undo}\` | Undo |

**Other**
| Key | Action |
|-----|--------|
| \`${tab}\` | Path completion / accept autocomplete |
| \`${interrupt}\` | Cancel autocomplete / abort streaming |
| \`${clear}\` | Clear editor (first) / exit (second) |
| \`${exit}\` | Exit (when editor is empty) |
| \`${suspend}\` | Suspend to background |
| \`${cycleThinking}\` | Cycle thinking level |
| \`${cycleModelForward}\` / \`${cycleModelBackward}\` | Cycle models |
| \`${selectModel}\` | Open model selector |
| \`${expandTools}\` | Toggle tool output expansion |
| \`${toggleThinking}\` | Toggle thinking block visibility |
| \`${copyMessage}\` | Copy selection or last assistant message |
| \`${followUp}\` | Queue follow-up message |
| \`${dequeue}\` | Restore queued messages |
| \`${paste}\` | Paste files or text from clipboard |
| \`/\` | Slash commands |
| \`!\` | Run bash command |
| \`!!\` | Run bash command (excluded from context) |
`;

		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new DynamicBorder());
		this.chatContainer.addChild(new ThemedText(() => theme.bold(theme.fg("accent", "Keyboard Shortcuts")), 1, 0));
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new Markdown(hotkeys.trim(), 1, 1, this.getMarkdownThemeWithSettings()));
		this.chatContainer.addChild(new DynamicBorder());
		this.ui.requestRender();
	}

	private async handleCompactCommand(customInstructions?: string): Promise<void> {
		this.clearStatusIndicator();

		try {
			await this.host.compact(customInstructions);
		} catch {
			// The error arrives as a compaction_end event — no need to duplicate it.
			this.host.log.debug("compact rejected", {});
		}
	}

	private async handleBashCommand(command: string, excludeFromContext = false): Promise<void> {
		this.bashRunning = true;
		const component = new BashExecutionComponent(command, this.ui, excludeFromContext, this.outputPad);

		if (this.host.agent.state.isStreaming) {
			// Show in pending area when agent is streaming
			this.pendingMessagesContainer.addChild(component);
			this.pendingBashComponents.push(component);
		} else {
			// Show in chat immediately when agent is idle
			this.chatContainer.addChild(component);
		}
		this.ui.requestRender();
		this.host.log.debug("bash execution started", { command, excludeFromContext });

		try {
			const result: BashResult = await this.host.executeBash(command, excludeFromContext, (chunk) => {
				component.appendOutput(chunk);
				this.ui.requestRender();
			});

			component.setComplete(
				result.exitCode,
				result.cancelled,
				result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
				result.fullOutputPath,
			);
		} catch (error) {
			component.setComplete(undefined, false);
			this.showError(`Bash command failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		} finally {
			this.bashRunning = false;
			this.ui.requestRender();
		}
	}

	// =========================================================================
	// UI helpers
	// =========================================================================

	clearEditor(): void {
		this.editor.setText("");
		this.ui.requestRender();
	}

	showError(errorMessage: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new ThemedText(() => theme.fg("error", `Error: ${errorMessage}`), this.outputPad, 0));
		this.ui.requestRender();
	}

	showWarning(warningMessage: string): void {
		this.chatContainer.addChild(new Spacer(1));
		this.chatContainer.addChild(new ThemedText(() => theme.fg("warning", `Warning: ${warningMessage}`), 1, 0));
		this.ui.requestRender();
	}

	private toggleToolOutputExpansion(): void {
		this.setToolsExpanded(!this.toolOutputExpanded);
	}

	private setToolsExpanded(expanded: boolean): void {
		if (expanded === this.toolOutputExpanded) return;

		this.toolOutputExpanded = expanded;
		if (this.builtInHeader) {
			this.builtInHeader.setExpanded(expanded);
		}
		for (const child of this.chatContainer.children) {
			if (isExpandable(child)) {
				child.setExpanded(expanded);
			}
		}
		this.showStatus(`Tool output: ${expanded ? "expanded" : "collapsed"}`);
	}

	/** Update rendered assistant messages without rebuilding live tool components. */
	private updateThinkingBlockVisibility(): void {
		for (const child of this.chatContainer.children) {
			if (child instanceof AssistantMessageComponent) {
				child.setHideThinkingBlock(this.hideThinkingBlock);
			}
		}
		this.ui.requestRender();
	}

	private toggleThinkingBlockVisibility(): void {
		this.hideThinkingBlock = !this.hideThinkingBlock;
		void this.host.settings.set("hideThinkingBlock", this.hideThinkingBlock).catch((error: unknown) => {
			this.host.log.warn("settings: persist failed", { key: "hideThinkingBlock", error: String(error) });
		});
		this.updateThinkingBlockVisibility();
		this.showStatus(`Thinking blocks: ${this.hideThinkingBlock ? "hidden" : "visible"}`);
	}

	private updateEditorBorderColor(): void {
		if (this.isBashMode) {
			this.editor.borderColor = theme.getBashModeBorderColor();
		} else {
			const level = this.host.agent.state.thinkingLevel || "off";
			this.editor.borderColor = theme.getThinkingBorderColor(level);
		}
		this.activeStatusIndicator?.invalidate();
		this.ui.requestRender();
	}

	private getMarkdownThemeWithSettings(): MarkdownTheme {
		return {
			...getMarkdownTheme(),
			codeBlockIndent: this.host.settings.get("codeBlockIndent"),
		};
	}

	private getMarkdownTransformers(): MarkdownTransformer[] {
		return [this.mermaidMarkdownTransformer];
	}

	/** FooterContextUsage from agent.state.messages + the current model (wiring computeBudget unavailable). */
	private getContextUsage(): FooterContextUsage | undefined {
		const model = this.currentModel;
		if (!model) return undefined;
		try {
			const tokens = estimateContextTokens(convertToLlm(this.host.agent.state.messages)).tokens;
			const contextWindow = model.contextWindow;
			return {
				tokens,
				contextWindow,
				percent: contextWindow > 0 ? (tokens / contextWindow) * 100 : null,
			};
		} catch (error) {
			this.host.log.debug("context usage estimate failed", { error: String(error) });
			return undefined;
		}
	}

	private createBaseAutocompleteProvider(): AutocompleteProvider {
		const slashCommands: SlashCommand[] = BUILTIN_SLASH_COMMANDS.map((command) => ({
			name: command.name,
			description: command.description,
			...(command.argumentHint && { argumentHint: command.argumentHint }),
		}));

		const modelCommand = slashCommands.find((command) => command.name === "model");
		if (modelCommand) {
			modelCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
				const models = this.modelFacade?.listAvailable() ?? [];
				if (models.length === 0) return null;
				return createFuzzyAutocompleteItems(models, prefix, getModelSearchText, (item) => ({
					value: `${item.provider}/${item.id}`,
					label: item.id,
					description: item.provider,
				}));
			};
		}

		const thinkingCommand = slashCommands.find((command) => command.name === "thinking");
		if (thinkingCommand) {
			thinkingCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null =>
				createFuzzyAutocompleteItems(
					this.getAvailableThinkingLevels(),
					prefix,
					(level) => level,
					(level) => ({ value: level, label: level }),
				);
		}

		const loginCommand = slashCommands.find((command) => command.name === "login");
		if (loginCommand) {
			loginCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
				const providers = getLoginProviderCompletionOptions(this.modelFacade?.loginProviderOptions() ?? []);
				return createFuzzyAutocompleteItems(providers, prefix, getLoginProviderSearchText, (provider) => ({
					value: provider.id,
					label: provider.id,
					description: formatLoginProviderCompletionDescription(provider),
				}));
			};
		}

		// fdPath: null — fd/rg auto-download stripped (recon §6 R8); the built-in file walk remains.
		return new CombinedAutocompleteProvider(slashCommands, this.host.session.getCwd(), null);
	}

	private setupAutocompleteProvider(): void {
		this.editor.setAutocompleteProvider(this.createBaseAutocompleteProvider());
	}

	// =========================================================================
	// Shutdown (R5: all paths → code from run(), no process.exit)
	// =========================================================================

	/**
	 * Graceful shutdown: abort the active run, drain input, stop the TUI, host.close(reason),
	 * resume hint, resolve run() with the code. Idempotent.
	 */
	private async shutdown(code: number, reason: "user_exit" | "error" | "completed"): Promise<void> {
		if (this.isShuttingDown) return;
		this.isShuttingDown = true;
		this.host.log.info("interactive shutdown", { code, reason });

		try {
			this.themeController.disableAutoSync();
		} catch (error) {
			this.host.log.debug("theme controller shutdown failed", { error: String(error) });
		}
		// Stop the active run before close (host.close does not touch the agent).
		try {
			this.host.agent.abort();
		} catch (error) {
			this.host.log.debug("agent abort on shutdown failed", { error: String(error) });
		}
		// Drain any in-flight Kitty key release events before stopping (guards against escape
		// sequences leaking into the parent shell over a slow SSH link).
		try {
			if (this.isInitialized) await this.ui.terminal.drainInput(1000);
		} catch (error) {
			this.host.log.debug("terminal input drain failed", { error: String(error) });
		}

		try {
			this.stop();
		} catch (error) {
			this.host.log.warn("TUI stop failed during shutdown", { error: String(error) });
		}

		try {
			await this.host.close(reason);
		} catch (error) {
			this.host.log.error("host close failed", { error: String(error) });
		}

		if (code === 0) {
			const resumeCommand = formatResumeCommand(this.host.session);
			if (resumeCommand) {
				try {
					process.stdout.write(`To resume this session: ${resumeCommand}\n`);
				} catch (error) {
					// m13: a sync throw (ERR_STREAM_DESTROYED) must not skip
					// rejectPendingInput/finishRun below — otherwise the exit code is distorted.
					this.host.log.warn("failed to write resume hint", { error: String(error) });
				}
			}
		}

		this.rejectPendingInput();
		this.finishRun?.({ code, switchSession: this.pendingSwitch });
	}

	/** Fatal inside init/loop: log + trace record + graceful exit with code 1. */
	private async fatalShutdown(prefix: string, error: unknown): Promise<void> {
		const message = error instanceof Error ? error.message : String(error);
		this.host.log.error(prefix, { error: message, stack: error instanceof Error ? error.stack : undefined });
		try {
			this.host.recorder.record("error", { scope: "interactive", message: `${prefix}: ${message}`, fatal: true });
		} catch {
			// the recorder does not throw by contract; guard just in case
		}
		try {
			if (this.isInitialized) this.showError(`${prefix}: ${message}`);
		} catch {
			// the TUI may be in any state
		}
		await this.shutdown(1, "error");
	}

	/**
	 * M1: dispose-equivalent of stop() without terminal writes. Crash paths (uncaughtCrash,
	 * emergencyTerminalExit) must release watchers/timers/listeners — otherwise ref'd
	 * handles (fs.watch/watchFile in footerDataProvider, Loader status intervals,
	 * the themeController color-scheme listener) keep the event loop alive and the process
	 * hangs after the crash. Every step is best-effort: the crash path must not die on a
	 * dispose exception.
	 */
	private releaseNonTuiResources(): void {
		const steps: Array<readonly [string, () => void]> = [
			["disposeActiveSelector", () => this.disposeActiveSelector()],
			["clearStatusIndicator", () => this.clearStatusIndicator()],
			["themeController.dispose", () => this.themeController.dispose()],
			["footer.dispose", () => this.footer.dispose()],
			["footerDataProvider.dispose", () => this.footerDataProvider.dispose()],
			[
				"unsubscribe",
				() => {
					this.unsubscribe?.();
					this.unsubscribe = undefined;
				},
			],
		];
		for (const [name, step] of steps) {
			try {
				step();
			} catch (error) {
				this.host.log.debug("crash cleanup step failed", { step: name, error: String(error) });
			}
		}
	}

	/**
	 * Dead terminal (EIO/ENOTTY/...): nothing to restore, tty writes would raise a new EIO.
	 * No stopInteractiveTui — only log, trace record, resource dispose (M1), close,
	 * resolve run() with code 1 (Pi did process.exit(129)).
	 */
	private emergencyTerminalExit(): void {
		if (this.isShuttingDown) {
			// m14: graceful shutdown already in flight — do not preempt it with an early
			// finishRun({code:1}), otherwise run() returns before the in-flight host.close
			// completes (tap T5 lost). Record only.
			this.host.log.error("terminal lost during shutdown");
			try {
				this.host.recorder.record("error", {
					scope: "interactive",
					message: "terminal lost during shutdown",
					fatal: true,
				});
			} catch {
				// the recorder does not throw by contract
			}
			return;
		}
		this.isShuttingDown = true;
		this.unregisterSignalHandlers();
		killTrackedDetachedChildren();
		this.host.log.error("terminal lost, emergency exit");
		try {
			this.host.recorder.record("error", { scope: "interactive", message: "terminal lost", fatal: true });
		} catch {
			// the recorder does not throw by contract
		}
		this.releaseNonTuiResources();
		this.rejectPendingInput();
		void this.host
			.close("error")
			.catch((error: unknown) => {
				this.host.log.error("host close failed after terminal loss", { error: String(error) });
			})
			.finally(() => {
				this.finishRun?.({ code: 1, switchSession: this.pendingSwitch });
			});
	}

	/**
	 * Last-resort handler for uncaught exceptions. The TUI puts stdin into raw
	 * mode and hides the cursor; without this handler, an uncaught throw tears down
	 * the process while leaving the terminal in raw mode.
	 * R5: instead of process.exit(1) — log + trace + stop + close + resolve run() with code 1.
	 */
	private uncaughtCrash(error: Error): void {
		// A dead terminal is not a vanrel crash. Do not try to restore it or record it.
		if (isDeadTerminalError(error)) {
			this.emergencyTerminalExit();
			return;
		}
		if (this.isShuttingDown) {
			// Graceful shutdown already in flight: do not preempt it with code 1 — otherwise run()
			// returns before host.close completes (tap T5 lost). Record the crash only.
			this.host.log.error("uncaught exception during shutdown", { error: error.message, stack: error.stack });
			try {
				this.host.recorder.record("error", { scope: "interactive", message: error.message, fatal: true });
			} catch {
				// the recorder does not throw by contract
			}
			return;
		}
		this.isShuttingDown = true;
		try {
			this.unregisterSignalHandlers();
		} catch {
			// cleanup best-effort
		}
		try {
			killTrackedDetachedChildren();
		} catch {
			// cleanup best-effort
		}
		this.host.log.error("uncaught exception in interactive mode", {
			error: error.message,
			stack: error.stack,
		});
		try {
			this.host.recorder.record("error", { scope: "interactive", message: error.message, fatal: true });
		} catch {
			// the recorder does not throw by contract
		}
		try {
			// M1: full stop() (not only ui.stop) — footer/footerDataProvider/themeController
			// dispose, unsubscribe, watchers; otherwise ref'd handles keep the event loop alive
			// after the crash.
			this.stop();
		} catch {
			// terminal restore best-effort
		}
		// Safety net: if stop() died midway, resources are still released (idempotent).
		this.releaseNonTuiResources();
		this.rejectPendingInput();
		void this.host
			.close("error")
			.catch((closeError: unknown) => {
				this.host.log.error("host close failed after crash", { error: String(closeError) });
			})
			.finally(() => {
				this.finishRun?.({ code: 1, switchSession: this.pendingSwitch });
			});
	}

	private rejectPendingInput(): void {
		const reject = this.pendingInputReject;
		this.pendingInputReject = undefined;
		this.onInputCallback = undefined;
		reject?.(new ShutdownRequestedError());
	}

	private registerSignalHandlers(): void {
		this.unregisterSignalHandlers();

		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void this.shutdown(0, "user_exit");
			};
			process.prependListener(signal, handler);
			this.signalCleanupHandlers.push(() => process.off(signal, handler));
		}

		// In TUI raw mode Ctrl+C arrives as a key (app.clear). A process-level SIGINT is external
		// (kill -INT): graceful exit with code 130. Ignored while suspended (Ctrl+Z).
		const sigintHandler = () => {
			if (this.suspended || this.isShuttingDown) return;
			void this.shutdown(130, "user_exit");
		};
		process.prependListener("SIGINT", sigintHandler);
		this.signalCleanupHandlers.push(() => process.off("SIGINT", sigintHandler));

		const terminalErrorHandler = (error: Error) => {
			if (isDeadTerminalError(error)) {
				this.emergencyTerminalExit();
				return;
			}
			throw error;
		};
		// stdin needs the handler too: once the terminal is gone, reads and setRawMode
		// fail with EIO (orphaned background process group) or ENOTTY (revoked tty).
		// Node emits these as stream errors, which are uncaught without a listener.
		for (const stream of [process.stdin, process.stdout, process.stderr]) {
			stream.on("error", terminalErrorHandler);
			this.signalCleanupHandlers.push(() => stream.off("error", terminalErrorHandler));
		}

		// Restore the terminal before the process dies on any uncaught throw.
		const uncaughtExceptionHandler = (error: Error) => this.uncaughtCrash(error);
		process.prependListener("uncaughtException", uncaughtExceptionHandler);
		this.signalCleanupHandlers.push(() => process.off("uncaughtException", uncaughtExceptionHandler));
	}

	private unregisterSignalHandlers(): void {
		for (const cleanup of this.signalCleanupHandlers) {
			cleanup();
		}
		this.signalCleanupHandlers = [];
	}

	stop(fullscreenExitOutput: InteractiveFullscreenExitOutput = this.host.settings.get("fullscreenExitOutput")): void {
		this.disposeActiveSelector();
		if (this.host.settings.get("showTerminalProgress")) {
			this.ui.terminal.setProgress(false);
		}
		this.clearStatusIndicator();
		try {
			// m12: dispose (not only disableAutoSync) — unsubscribes the terminal color-scheme listener.
			this.themeController.dispose();
		} catch (error) {
			this.host.log.debug("theme controller shutdown failed", { error: String(error) });
		}
		this.footer.dispose();
		this.footerDataProvider.dispose();
		if (this.unsubscribe) {
			this.unsubscribe();
			this.unsubscribe = undefined;
		}
		if (this.isInitialized) {
			this.stopInteractiveTui(fullscreenExitOutput);
			this.isInitialized = false;
		}
		this.unregisterSignalHandlers();
	}
}

/** Interface for components that can be expanded/collapsed */
interface Expandable {
	setExpanded(expanded: boolean): void;
}

function isExpandable(obj: unknown): obj is Expandable {
	return typeof obj === "object" && obj !== null && "setExpanded" in obj && typeof obj.setExpanded === "function";
}

class ExpandableText extends ThemedText implements Expandable {
	private readonly state: { expanded: boolean };

	constructor(
		getCollapsedText: () => string,
		getExpandedText: () => string,
		expanded = false,
		paddingX = 0,
		paddingY = 0,
	) {
		const state = { expanded };
		super(() => (state.expanded ? getExpandedText() : getCollapsedText()), paddingX, paddingY);
		this.state = state;
	}

	setExpanded(expanded: boolean): void {
		this.state.expanded = expanded;
		this.invalidate();
	}
}
