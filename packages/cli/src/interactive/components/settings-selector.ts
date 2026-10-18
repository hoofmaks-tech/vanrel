// MIT License, Copyright (c) 2025 Mario Zechner
// Vendored from earendil-works/pi (packages/coding-agent/src/modes/interactive/components/settings-selector.ts), adapted for vanrel.
//
// Adaptation (recon §3.3 A3, ~500 LOC of 1009): pi SettingsManager (~139 getters) +
// SettingsConfig/SettingsCallbacks (35 callbacks) → A3 SettingsFacade (../../config.ts) —
// InteractiveConfig keys only. Stripped (recon §4): images group (no Image in
// @vanrel/tui), steering/follow-up modes, transport, share-destination, http-idle-timeout,
// cache-warming, cache-miss-notices, collapse-changelog, install-telemetry,
// default-project-trust, tree-filter-mode, warnings, per-model thinking overrides
// (no modelThinkingLevels in InteractiveConfig; replaced by the single
// defaultThinkingLevel key), skill-commands, autoCompact (lives in wiring, not in TUI settings).
// The Theme submenu works via InteractiveThemeController (../theme/, W10): preview without
// persist on navigation/cancel, setThemeSetting (apply+persist) on selection. SettingsFacade
// persist errors are logged (log parameter), the UI keeps running.

import type { ThinkingLevel } from "@vanrel/agent";
import { type Logger, NOOP_LOGGER } from "@vanrel/telemetry";
import { type Component, Container, type SelectItem, type SettingItem, SettingsList, Spacer, Text } from "@vanrel/tui";
import type {
	InteractiveConfig,
	InteractiveDoubleEscapeAction,
	InteractiveFullscreenExitOutput,
	InteractiveFullscreenScrollbar,
	InteractiveMermaidMode,
	InteractiveSetting,
	InteractiveTuiMode,
	SettingsFacade,
} from "../../config.ts";
import { THINKING_LEVEL_OPTIONS } from "../../config.ts";
import {
	getAvailableThemes,
	getSettingsListTheme,
	parseAutoThemeSetting,
	SYSTEM_THEME_NAME,
	type TerminalTheme,
	theme,
} from "../theme/theme.ts";
import type { InteractiveThemeController } from "../theme/theme-controller.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { SelectSubmenu } from "./settings-submenu.ts";

function themeItems(availableThemes: string[], currentTheme: string): SelectItem[] {
	return availableThemes.map((name) => ({
		value: name,
		label: `${name === currentTheme ? "✓ " : "  "}${name}`,
		...(name === SYSTEM_THEME_NAME ? { description: "Theme created from your terminal's colors" } : {}),
	}));
}

const AUTOMATIC_THEME_VALUE = "/";

/** The system theme comes first, then automatic mode, then the remaining themes. */
function singleModeThemeItems(availableThemes: string[], currentTheme: string): SelectItem[] {
	const items = themeItems(availableThemes, currentTheme);
	const systemIndex = items.findIndex((item) => item.value === SYSTEM_THEME_NAME);
	const system = systemIndex === -1 ? [] : items.splice(systemIndex, 1);
	return [
		...system,
		{
			value: AUTOMATIC_THEME_VALUE,
			label: "  automatic",
			description: "Use separate themes for light and dark terminal appearance",
		},
		...items,
	];
}

function preferredTheme(availableThemes: string[], preferred: string | undefined, fallback: string): string {
	if (preferred && availableThemes.includes(preferred)) return preferred;
	if (availableThemes.includes(fallback)) return fallback;
	return availableThemes[0] ?? fallback;
}

function defaultAutomaticThemes(
	currentThemeSetting: string,
	availableThemes: string[],
): { lightTheme: string; darkTheme: string } {
	const autoTheme = parseAutoThemeSetting(currentThemeSetting);
	if (autoTheme) return autoTheme;

	const currentFixedTheme = currentThemeSetting.includes("/") ? undefined : currentThemeSetting;
	const themeName = preferredTheme(availableThemes, currentFixedTheme, SYSTEM_THEME_NAME);
	return { lightTheme: themeName, darkTheme: themeName };
}

class ThemeSubmenu extends Container {
	private inputComponent: Component | undefined;
	private readonly themeController: InteractiveThemeController;
	private readonly availableThemes: string[];
	private readonly terminalTheme: TerminalTheme;
	private readonly onDone: (selectedValue?: string) => void;
	private readonly originalThemeSetting: string;
	private mode: "single" | "automatic";
	private singleTheme: string;
	private lightTheme: string;
	private darkTheme: string;

	constructor(
		currentThemeSetting: string,
		terminalTheme: TerminalTheme,
		availableThemes: string[],
		themeController: InteractiveThemeController,
		onDone: (selectedValue?: string) => void,
	) {
		super();
		this.themeController = themeController;
		this.availableThemes = availableThemes;
		this.terminalTheme = terminalTheme;
		this.onDone = onDone;
		this.originalThemeSetting = currentThemeSetting;
		const autoTheme = parseAutoThemeSetting(currentThemeSetting);
		const automaticThemes = defaultAutomaticThemes(currentThemeSetting, availableThemes);
		const fixedTheme = autoTheme || currentThemeSetting.includes("/") ? undefined : currentThemeSetting;
		this.mode = autoTheme ? "automatic" : "single";
		this.lightTheme = automaticThemes.lightTheme;
		this.darkTheme = automaticThemes.darkTheme;
		this.singleTheme = preferredTheme(
			availableThemes,
			fixedTheme ?? (autoTheme ? this.getActiveAutomaticTheme() : undefined),
			SYSTEM_THEME_NAME,
		);

		if (this.mode === "automatic") {
			this.showAutomaticMenu();
		} else {
			this.showSingleMenu();
		}
	}

	handleInput(data: string): void {
		this.inputComponent?.handleInput?.(data);
	}

	private setContent(renderComponent: Component, inputComponent: Component = renderComponent): void {
		this.clear();
		this.addChild(renderComponent);
		this.inputComponent = inputComponent;
	}

	private showSingleMenu(): void {
		this.mode = "single";
		const menu = new SelectSubmenu(
			"Theme",
			"Select a theme, or choose automatic to follow terminal appearance.",
			singleModeThemeItems(this.availableThemes, this.singleTheme),
			this.singleTheme,
			(value) => {
				if (value === AUTOMATIC_THEME_VALUE) {
					this.mode = "automatic";
					this.themeController.preview(this.getThemeSetting());
					this.showAutomaticMenu();
					return;
				}

				this.singleTheme = value;
				this.apply(value);
			},
			() => this.cancel(),
			(value) => {
				this.themeController.preview(value === AUTOMATIC_THEME_VALUE ? this.getAutomaticThemeSetting() : value);
			},
		);
		this.setContent(menu);
	}

	private showAutomaticMenu(): void {
		this.mode = "automatic";
		const content = new Container();
		content.addChild(new Text(theme.bold(theme.fg("accent", "Automatic Theme")), 0, 0));
		content.addChild(new Spacer(1));
		content.addChild(new Text(theme.fg("muted", "Choose themes for terminal light and dark appearance."), 0, 0));
		content.addChild(new Text(theme.fg("muted", "Light/dark detection requires terminal support."), 0, 0));
		content.addChild(new Spacer(1));

		const items: SettingItem[] = [
			{
				id: "light-theme",
				label: "Light theme",
				description: "Theme to use in automatic mode when the terminal is light",
				currentValue: this.lightTheme,
				submenu: (currentValue, done) =>
					this.createThemeSelect(
						"Light Theme",
						"Select the theme to use for light terminal appearance",
						currentValue,
						done,
						(value) => {
							this.lightTheme = value;
							this.themeController.preview(this.getThemeSetting());
							done(value);
						},
					),
			},
			{
				id: "dark-theme",
				label: "Dark theme",
				description: "Theme to use in automatic mode when the terminal is dark",
				currentValue: this.darkTheme,
				submenu: (currentValue, done) =>
					this.createThemeSelect(
						"Dark Theme",
						"Select the theme to use for dark terminal appearance",
						currentValue,
						done,
						(value) => {
							this.darkTheme = value;
							this.themeController.preview(this.getThemeSetting());
							done(value);
						},
					),
			},
			{
				id: "apply",
				label: "Apply",
				description: "Save and go back",
				currentValue: "save and go back",
				values: ["save and go back"],
			},
			{
				id: "single-mode",
				label: "Change mode",
				description: "Switch to one theme for light and dark",
				currentValue: "switch to single theme",
				values: ["switch to single theme"],
			},
		];

		const settingsList = new SettingsList(
			items,
			Math.min(items.length, 10),
			getSettingsListTheme(),
			(id) => {
				switch (id) {
					case "single-mode":
						this.mode = "single";
						this.singleTheme = this.getActiveAutomaticTheme();
						this.themeController.preview(this.singleTheme);
						this.showSingleMenu();
						break;
					case "apply":
						this.apply(this.getAutomaticThemeSetting());
						break;
				}
			},
			() => this.cancel(),
		);
		content.addChild(settingsList);
		this.setContent(content, settingsList);
	}

	private createThemeSelect(
		title: string,
		description: string,
		currentValue: string,
		done: (selectedValue?: string) => void,
		onSelect: (value: string) => void,
	): SelectSubmenu {
		return new SelectSubmenu(
			title,
			description,
			themeItems(this.availableThemes, currentValue),
			currentValue,
			onSelect,
			() => {
				this.themeController.preview(this.getThemeSetting());
				done();
			},
			(value) => this.themeController.preview(value),
		);
	}

	private getThemeSetting(): string {
		return this.mode === "automatic" ? this.getAutomaticThemeSetting() : this.singleTheme;
	}

	private getActiveAutomaticTheme(): string {
		return this.terminalTheme === "light" ? this.lightTheme : this.darkTheme;
	}

	private getAutomaticThemeSetting(): string {
		return `${this.lightTheme}/${this.darkTheme}`;
	}

	private apply(themeSetting: string): void {
		this.themeController.setThemeSetting(themeSetting);
		this.onDone(themeSetting);
	}

	private cancel(): void {
		this.themeController.preview(this.originalThemeSetting);
		this.onDone();
	}
}

/**
 * Main settings selector component (A3: InteractiveConfig keys, persist via SettingsFacade).
 */
export class SettingsSelectorComponent extends Container {
	private settingsList: SettingsList;
	private readonly settings: SettingsFacade;
	private readonly log: Logger;

	constructor(
		settings: SettingsFacade,
		themeController: InteractiveThemeController,
		onCancel: () => void,
		log: Logger = NOOP_LOGGER,
	) {
		super();
		this.settings = settings;
		this.log = log;

		const items: SettingItem[] = [
			{
				id: "show-hardware-cursor",
				label: "Show hardware cursor",
				description: "Use the terminal cursor instead of the drawn cursor",
				currentValue: settings.get("showHardwareCursor") ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "editor-padding",
				label: "Editor padding",
				description: "Horizontal padding for input editor (0-3)",
				currentValue: String(settings.get("editorPaddingX")),
				values: ["0", "1", "2", "3"],
			},
			{
				id: "output-padding",
				label: "Output padding",
				description: "Horizontal padding for messages, tool output, and command output",
				currentValue: String(settings.get("outputPad")),
				values: ["0", "1"],
			},
			{
				id: "autocomplete-max-visible",
				label: "Autocomplete max items",
				description: "Max visible items in autocomplete dropdown (3-20)",
				currentValue: String(settings.get("autocompleteMaxVisible")),
				values: ["3", "5", "7", "10", "15", "20"],
			},
			{
				id: "clear-on-shrink",
				label: "Clear on shrink",
				description: "Clear empty rows when content shrinks (may cause flicker)",
				currentValue: settings.get("clearOnShrink") ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "terminal-progress",
				label: "Terminal progress",
				description: "Show OSC 9;4 progress indicators in the terminal tab bar",
				currentValue: settings.get("showTerminalProgress") ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "hide-thinking",
				label: "Hide thinking",
				description: "Hide thinking blocks in assistant responses",
				currentValue: settings.get("hideThinkingBlock") ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "mermaid-rendering",
				label: "Mermaid diagrams",
				description: "Render Mermaid code blocks as Unicode diagrams",
				currentValue: settings.get("mermaidMode"),
				values: ["off", "final", "streaming"],
			},
			{
				id: "default-thinking-level",
				label: "Default thinking level",
				description: "Thinking level applied to new sessions (per-model overrides not supported)",
				currentValue: settings.get("defaultThinkingLevel"),
				values: [...THINKING_LEVEL_OPTIONS],
			},
			{
				id: "quiet-startup",
				label: "Quiet startup",
				description: "Disable verbose printing at startup (header: keep only the startup header)",
				currentValue: String(settings.get("quietStartup")),
				values: ["true", "header", "false"],
			},
			{
				id: "double-escape-action",
				label: "Double-escape action",
				description: "Action when pressing Escape twice with empty editor",
				currentValue: settings.get("doubleEscapeAction"),
				values: ["none"],
			},
			{
				id: "tui-mode",
				label: "TUI mode",
				description: "Interface layout; regular mode uses the terminal's normal scrollback",
				currentValue: settings.get("tuiMode"),
				values: ["regular", "fullscreen"],
			},
			{
				id: "fullscreen-exit-output",
				label: "Fullscreen exit output",
				description: "Print the transcript or only a session resume hint when exiting fullscreen mode",
				currentValue: settings.get("fullscreenExitOutput"),
				values: ["transcript", "resume-hint"],
			},
			{
				id: "fullscreen-scrollbar",
				label: "Fullscreen scrollbar",
				description: "Scrollbar behavior in fullscreen mode; has no effect in regular mode",
				currentValue: settings.get("fullscreenScrollbar"),
				values: ["auto", "always", "hidden"],
			},
			{
				id: "fullscreen-copy-on-select",
				label: "Fullscreen copy on select",
				description: "Automatically copy selected text in fullscreen mode; disable to copy selections with Ctrl+X",
				currentValue: settings.get("fullscreenCopyOnSelect") ? "true" : "false",
				values: ["true", "false"],
			},
			{
				id: "fullscreen-wheel-scroll-lines",
				label: "Fullscreen wheel scrolling",
				description:
					"Lines per mouse-wheel event in fullscreen mode; 'auto' speeds up fast wheel spins where the terminal does not",
				currentValue: String(settings.get("fullscreenWheelScrollLines")),
				values: [
					"auto",
					...[...new Set([1, 2, 3, 5, 10, settings.get("fullscreenWheelScrollLines")])]
						.filter((lines) => lines !== "auto")
						.sort((a, b) => a - b)
						.map(String),
				],
			},
			{
				id: "theme",
				label: "Theme",
				description: "Color theme for the interface",
				currentValue: themeController.getThemeSelection() ?? SYSTEM_THEME_NAME,
				submenu: (currentValue, done) =>
					new ThemeSubmenu(
						currentValue,
						themeController.getTerminalTheme(),
						getAvailableThemes(),
						themeController,
						done,
					),
			},
		];

		// Add borders
		this.addChild(new DynamicBorder());

		this.settingsList = new SettingsList(
			items,
			10,
			getSettingsListTheme(),
			(id, newValue) => {
				switch (id) {
					case "show-hardware-cursor":
						this.persist("showHardwareCursor", newValue === "true");
						break;
					case "editor-padding":
						this.persist("editorPaddingX", parseInt(newValue, 10));
						break;
					case "output-padding":
						this.persist("outputPad", newValue === "0" ? 0 : 1);
						break;
					case "autocomplete-max-visible":
						this.persist("autocompleteMaxVisible", parseInt(newValue, 10));
						break;
					case "clear-on-shrink":
						this.persist("clearOnShrink", newValue === "true");
						break;
					case "terminal-progress":
						this.persist("showTerminalProgress", newValue === "true");
						break;
					case "hide-thinking":
						this.persist("hideThinkingBlock", newValue === "true");
						break;
					case "mermaid-rendering":
						this.persist("mermaidMode", newValue as InteractiveMermaidMode);
						break;
					case "default-thinking-level":
						this.persist("defaultThinkingLevel", newValue as ThinkingLevel);
						break;
					case "quiet-startup":
						this.persist("quietStartup", newValue === "header" ? "header" : newValue === "true");
						break;
					case "double-escape-action":
						this.persist("doubleEscapeAction", newValue as InteractiveDoubleEscapeAction);
						break;
					case "tui-mode":
						this.persist("tuiMode", newValue as InteractiveTuiMode);
						break;
					case "fullscreen-exit-output":
						this.persist("fullscreenExitOutput", newValue as InteractiveFullscreenExitOutput);
						break;
					case "fullscreen-scrollbar":
						this.persist("fullscreenScrollbar", newValue as InteractiveFullscreenScrollbar);
						break;
					case "fullscreen-copy-on-select":
						this.persist("fullscreenCopyOnSelect", newValue === "true");
						break;
					case "fullscreen-wheel-scroll-lines":
						this.persist("fullscreenWheelScrollLines", newValue === "auto" ? "auto" : parseInt(newValue, 10));
						break;
					case "theme":
						// Already applied by ThemeSubmenu via themeController.setThemeSetting (persist inside).
						break;
				}
			},
			onCancel,
			{ enableSearch: true },
		);

		this.addChild(this.settingsList);
		this.addChild(new DynamicBorder());
	}

	/** Persist via A3; on failure — WARN, the UI keeps running with the in-memory value. */
	private persist<K extends InteractiveSetting>(key: K, value: InteractiveConfig[K]): void {
		void this.settings.set(key, value).then(undefined, (error: unknown) => {
			this.log.warn("settings: persist failed", { key, error: String(error) });
		});
	}

	getSettingsList(): SettingsList {
		return this.settingsList;
	}
}
