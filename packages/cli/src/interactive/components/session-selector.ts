// MIT License, Copyright (c) 2025 Mario Zechner
// Vendored from earendil-works/pi (packages/coding-agent/src/modes/interactive/components/session-selector.ts), adapted for vanrel.
//
// Adaptation: SessionInfo/SessionsLoader — A2 SessionManager (../../session.ts,
// static list() → linear model). Stripped (recon §4/R3): tree mode
// (buildSessionTree/flattenSessionTree, parentSessionPath — vanrel has linear append-only
// JSONL), SortMode "threaded", current/all scope by cwd (session cwd is not persisted —
// VENDOR-GAP), progressive loading (SessionListProgress) and AbortController cancel
// (list() is local and fast; replaced by a generation counter), onExit (dead callback in Pi),
// KeybindingsManager parameter (the global getKeybindings() from @vanrel/tui is used).
// Deletion: trash CLI → unlink fallback — same as Pi.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import * as os from "node:os";
import {
	type Component,
	Container,
	type Focusable,
	getKeybindings,
	Input,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@vanrel/tui";
import type { SessionInfo } from "../../session.ts";
import { theme } from "../theme/theme.ts";
import { canonicalizePath as _canonicalizePath } from "../utils/paths.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, keyText } from "./keybinding-hints.ts";
import { filterAndSortSessions, type NameFilter, type SortMode } from "./session-selector-search.ts";

function shortenPath(path: string): string {
	const home = os.homedir();
	if (!path) return path;
	if (path.startsWith(home)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

function formatSessionDate(date: Date): string {
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMs / 3600000);
	const diffDays = Math.floor(diffMs / 86400000);

	if (diffMins < 1) return "now";
	if (diffMins < 60) return `${diffMins}m`;
	if (diffHours < 24) return `${diffHours}h`;
	if (diffDays < 7) return `${diffDays}d`;
	if (diffDays < 30) return `${Math.floor(diffDays / 7)}w`;
	if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo`;
	return `${Math.floor(diffDays / 365)}y`;
}

function canonicalizePath(path: string | undefined): string | undefined {
	if (!path) return path;
	return _canonicalizePath(path);
}

class SessionSelectorHeader implements Component {
	private sortMode: SortMode;
	private nameFilter: NameFilter;
	private requestRender: () => void;
	private loading = false;
	private showPath = false;
	private confirmingDeletePath: string | null = null;
	private statusMessage: { type: "info" | "error"; message: string } | null = null;
	private statusTimeout: ReturnType<typeof setTimeout> | null = null;
	private showRenameHint = false;

	constructor(sortMode: SortMode, nameFilter: NameFilter, requestRender: () => void) {
		this.sortMode = sortMode;
		this.nameFilter = nameFilter;
		this.requestRender = requestRender;
	}

	setSortMode(sortMode: SortMode): void {
		this.sortMode = sortMode;
	}

	setNameFilter(nameFilter: NameFilter): void {
		this.nameFilter = nameFilter;
	}

	setLoading(loading: boolean): void {
		this.loading = loading;
	}

	setShowPath(showPath: boolean): void {
		this.showPath = showPath;
	}

	setShowRenameHint(show: boolean): void {
		this.showRenameHint = show;
	}

	setConfirmingDeletePath(path: string | null): void {
		this.confirmingDeletePath = path;
	}

	private clearStatusTimeout(): void {
		if (!this.statusTimeout) return;
		clearTimeout(this.statusTimeout);
		this.statusTimeout = null;
	}

	setStatusMessage(msg: { type: "info" | "error"; message: string } | null, autoHideMs?: number): void {
		this.clearStatusTimeout();
		this.statusMessage = msg;
		if (!msg || !autoHideMs) return;

		this.statusTimeout = setTimeout(() => {
			this.statusMessage = null;
			this.statusTimeout = null;
			this.requestRender();
		}, autoHideMs);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const leftText = theme.bold("Resume Session");

		const sortLabel = this.sortMode === "recent" ? "Recent" : "Fuzzy";
		const sortText = theme.fg("muted", "Sort: ") + theme.fg("accent", sortLabel);

		const nameLabel = this.nameFilter === "all" ? "All" : "Named";
		const nameText = theme.fg("muted", "Name: ") + theme.fg("accent", nameLabel);

		const loadingText = this.loading ? `${theme.fg("accent", "Loading…")}  ` : "";
		const rightText = truncateToWidth(`${loadingText}${nameText}  ${sortText}`, width, "");
		const availableLeft = Math.max(0, width - visibleWidth(rightText) - 1);
		const left = truncateToWidth(leftText, availableLeft, "");
		const spacing = Math.max(0, width - visibleWidth(left) - visibleWidth(rightText));

		// Build hint lines - changes based on state (all branches truncate to width)
		let hintLine1: string;
		let hintLine2: string;
		if (this.confirmingDeletePath !== null) {
			const confirmHint = `Delete session? ${keyHint("tui.select.confirm", "confirm")} · ${keyHint("tui.select.cancel", "cancel")}`;
			hintLine1 = theme.fg("error", truncateToWidth(confirmHint, width, "…"));
			hintLine2 = "";
		} else if (this.statusMessage) {
			const color = this.statusMessage.type === "error" ? "error" : "accent";
			hintLine1 = theme.fg(color, truncateToWidth(this.statusMessage.message, width, "…"));
			hintLine2 = "";
		} else {
			const pathState = this.showPath ? "(on)" : "(off)";
			const sep = theme.fg("muted", " · ");
			const hint1 = theme.fg("muted", 're:<pattern> regex · "phrase" exact');
			const hint2Parts = [
				keyHint("app.session.toggleSort", "sort"),
				keyHint("app.session.toggleNamedFilter", "named"),
				keyHint("app.session.delete", "delete"),
				keyHint("app.session.togglePath", `path ${pathState}`),
			];
			if (this.showRenameHint) {
				hint2Parts.push(keyHint("app.session.rename", "rename"));
			}
			const hint2 = hint2Parts.join(sep);
			hintLine1 = truncateToWidth(hint1, width, "…");
			hintLine2 = truncateToWidth(hint2, width, "…");
		}

		return [`${left}${" ".repeat(spacing)}${rightText}`, hintLine1, hintLine2];
	}
}

/**
 * Custom session list component with multi-line items and search
 */
class SessionList implements Component, Focusable {
	public getSelectedSessionPath(): string | undefined {
		const selected = this.filteredSessions[this.selectedIndex];
		return selected?.filePath;
	}
	private allSessions: SessionInfo[] = [];
	private filteredSessions: SessionInfo[] = [];
	private selectedIndex: number = 0;
	private selectionTouched = false;
	private searchInput: Input;
	private sortMode: SortMode = "recent";
	private nameFilter: NameFilter = "all";
	private showPath = false;
	private confirmingDeletePath: string | null = null;
	private currentSessionCanonicalPath?: string;
	public onSelect?: (sessionPath: string) => void;
	public onCancel?: () => void;
	public onToggleSort?: () => void;
	public onToggleNameFilter?: () => void;
	public onTogglePath?: (showPath: boolean) => void;
	public onDeleteConfirmationChange?: (path: string | null) => void;
	public onDeleteSession?: (sessionPath: string) => Promise<void>;
	public onRenameSession?: (sessionPath: string) => void;
	public onError?: (message: string) => void;
	private maxVisible: number = 10; // Max sessions visible (one line each)

	// Focusable implementation - propagate to searchInput for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(sessions: SessionInfo[], sortMode: SortMode, nameFilter: NameFilter, currentSessionFilePath?: string) {
		this.allSessions = sessions;
		this.filteredSessions = [];
		this.searchInput = new Input();
		this.sortMode = sortMode;
		this.nameFilter = nameFilter;
		this.currentSessionCanonicalPath = canonicalizePath(currentSessionFilePath);
		this.filterSessions("");

		// Handle Enter in search input - select current item
		this.searchInput.onSubmit = () => {
			if (this.filteredSessions[this.selectedIndex]) {
				const selected = this.filteredSessions[this.selectedIndex];
				if (this.onSelect) {
					this.onSelect(selected.filePath);
				}
			}
		};
	}

	setSortMode(sortMode: SortMode): void {
		this.sortMode = sortMode;
		this.filterSessions(this.searchInput.getValue());
	}

	setNameFilter(nameFilter: NameFilter): void {
		this.nameFilter = nameFilter;
		this.filterSessions(this.searchInput.getValue());
	}

	setSessions(sessions: SessionInfo[]): void {
		const selectedPath = this.selectionTouched ? this.getSelectedSessionPath() : undefined;
		this.allSessions = sessions;
		this.filterSessions(this.searchInput.getValue());
		if (!this.selectionTouched) {
			this.selectedIndex = 0;
		} else if (selectedPath) {
			const selectedIndex = this.filteredSessions.findIndex((session) => session.filePath === selectedPath);
			if (selectedIndex >= 0) this.selectedIndex = selectedIndex;
		}
	}

	private filterSessions(query: string): void {
		// Linear model (A2): flat list, recent = list() order (mtime desc).
		this.filteredSessions = filterAndSortSessions(this.allSessions, query, this.sortMode, this.nameFilter);
		this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.filteredSessions.length - 1));
	}

	private setConfirmingDeletePath(path: string | null): void {
		this.confirmingDeletePath = path;
		this.onDeleteConfirmationChange?.(path);
	}

	private startDeleteConfirmationForSelectedSession(): void {
		const selected = this.filteredSessions[this.selectedIndex];
		if (!selected) return;

		// Prevent deleting current session
		if (this.isCurrentSessionPath(selected.filePath)) {
			this.onError?.("Cannot delete the currently active session");
			return;
		}

		this.setConfirmingDeletePath(selected.filePath);
	}

	private isCurrentSessionPath(path: string): boolean {
		if (!this.currentSessionCanonicalPath) return false;
		return (canonicalizePath(path) ?? path) === this.currentSessionCanonicalPath;
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines: string[] = [];

		// Render search input
		lines.push(...this.searchInput.render(width));
		lines.push(""); // Blank line after search

		if (this.filteredSessions.length === 0) {
			let emptyMessage: string;
			if (this.nameFilter === "named") {
				const toggleKey = keyText("app.session.toggleNamedFilter");
				emptyMessage = `  No named sessions found. Press ${toggleKey} to show all.`;
			} else {
				emptyMessage = "  No sessions found";
			}
			lines.push(theme.fg("muted", truncateToWidth(emptyMessage, width, "…")));
			return lines;
		}

		// Calculate visible range with scrolling
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredSessions.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredSessions.length);

		// Render visible sessions (one line each)
		for (let i = startIndex; i < endIndex; i++) {
			const session = this.filteredSessions[i]!;
			const isSelected = i === this.selectedIndex;
			const isConfirmingDelete = session.filePath === this.confirmingDeletePath;
			const isCurrent = this.isCurrentSessionPath(session.filePath);

			// Session display text (name or first message)
			const hasName = !!session.name;
			const displayText = session.name ?? session.firstUserMessage ?? "";
			const normalizedMessage = displayText.replace(/[\x00-\x1f\x7f]/g, " ").trim();

			// Right side: entry count and age
			const age = formatSessionDate(new Date(session.mtime));
			const entryCount = String(session.entryCount);
			let rightPart = `${entryCount} ${age}`;
			if (this.showPath) {
				rightPart = `${shortenPath(session.filePath)} ${rightPart}`;
			}

			// Cursor
			const cursor = isSelected ? theme.fg("accent", "› ") : "  ";

			// Calculate available width for message
			const rightWidth = visibleWidth(rightPart) + 2; // +2 for spacing
			const availableForMsg = width - 2 - rightWidth; // -2 for cursor

			const truncatedMsg = truncateToWidth(normalizedMessage, Math.max(10, availableForMsg), "…");

			// Style message
			let messageColor: "error" | "warning" | "accent" | null = null;
			if (isConfirmingDelete) {
				messageColor = "error";
			} else if (isCurrent) {
				messageColor = "accent";
			} else if (hasName) {
				messageColor = "warning";
			}
			let styledMsg = messageColor ? theme.fg(messageColor, truncatedMsg) : truncatedMsg;
			if (isSelected) {
				styledMsg = theme.bold(styledMsg);
			}

			// Build line
			const leftPart = cursor + styledMsg;
			const leftWidth = visibleWidth(leftPart);
			const spacing = Math.max(1, width - leftWidth - visibleWidth(rightPart));
			const styledRight = theme.fg(isConfirmingDelete ? "error" : "dim", rightPart);

			let line = leftPart + " ".repeat(spacing) + styledRight;
			if (isSelected) {
				line = theme.bg("selectedBg", line);
			}
			lines.push(truncateToWidth(line, width));
		}

		// Add scroll indicator if needed
		if (startIndex > 0 || endIndex < this.filteredSessions.length) {
			const scrollText = `  (${this.selectedIndex + 1}/${this.filteredSessions.length})`;
			const scrollInfo = theme.fg("muted", truncateToWidth(scrollText, width, ""));
			lines.push(scrollInfo);
		}

		return lines;
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();

		// Handle delete confirmation state first - intercept all keys
		if (this.confirmingDeletePath !== null) {
			if (kb.matches(keyData, "tui.select.confirm")) {
				const pathToDelete = this.confirmingDeletePath;
				this.setConfirmingDeletePath(null);
				void this.onDeleteSession?.(pathToDelete);
				return;
			}
			if (kb.matches(keyData, "tui.select.cancel")) {
				this.setConfirmingDeletePath(null);
				return;
			}
			// Ignore all other keys while confirming
			return;
		}

		if (kb.matches(keyData, "app.session.toggleSort")) {
			this.onToggleSort?.();
			return;
		}

		if (kb.matches(keyData, "app.session.toggleNamedFilter")) {
			this.onToggleNameFilter?.();
			return;
		}

		// Toggle path display
		if (kb.matches(keyData, "app.session.togglePath")) {
			this.showPath = !this.showPath;
			this.onTogglePath?.(this.showPath);
			return;
		}

		// Initiate delete confirmation (useful on terminals that don't distinguish Ctrl+Backspace from Backspace)
		if (kb.matches(keyData, "app.session.delete")) {
			this.startDeleteConfirmationForSelectedSession();
			return;
		}

		// Rename selected session
		if (kb.matches(keyData, "app.session.rename")) {
			const selected = this.filteredSessions[this.selectedIndex];
			if (selected) {
				this.onRenameSession?.(selected.filePath);
			}
			return;
		}

		// Ctrl+Backspace: non-invasive convenience alias for delete
		// Only triggers deletion when the query is empty; otherwise it is forwarded to the input
		if (kb.matches(keyData, "app.session.deleteNoninvasive")) {
			if (this.searchInput.getValue().length > 0) {
				this.searchInput.handleInput(keyData);
				this.filterSessions(this.searchInput.getValue());
				return;
			}

			this.startDeleteConfirmationForSelectedSession();
			return;
		}

		this.selectionTouched = true;
		// Up arrow
		if (kb.matches(keyData, "tui.select.up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		}
		// Down arrow
		else if (kb.matches(keyData, "tui.select.down")) {
			this.selectedIndex = Math.min(this.filteredSessions.length - 1, this.selectedIndex + 1);
		}
		// Page up - jump up by maxVisible items
		else if (kb.matches(keyData, "tui.select.pageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - this.maxVisible);
		}
		// Page down - jump down by maxVisible items
		else if (kb.matches(keyData, "tui.select.pageDown")) {
			this.selectedIndex = Math.min(this.filteredSessions.length - 1, this.selectedIndex + this.maxVisible);
		}
		// Enter
		else if (kb.matches(keyData, "tui.select.confirm")) {
			const selected = this.filteredSessions[this.selectedIndex];
			if (selected && this.onSelect) {
				this.onSelect(selected.filePath);
			}
		}
		// Escape - cancel
		else if (kb.matches(keyData, "tui.select.cancel")) {
			if (this.onCancel) {
				this.onCancel();
			}
		}
		// Pass everything else to search input
		else {
			this.searchInput.handleInput(keyData);
			this.filterSessions(this.searchInput.getValue());
		}
	}
}

/** A2: session list loading (wrapper over SessionManager.list, injected by the host). */
type SessionsLoader = () => Promise<SessionInfo[]>;

/**
 * Delete a session file, trying the `trash` CLI first, then falling back to unlink
 */
async function deleteSessionFile(
	sessionPath: string,
): Promise<{ ok: boolean; method: "trash" | "unlink"; error?: string }> {
	// Try `trash` first (if installed)
	const trashArgs = sessionPath.startsWith("-") ? ["--", sessionPath] : [sessionPath];
	const trashResult = spawnSync("trash", trashArgs, { encoding: "utf-8" });

	const getTrashErrorHint = (): string | null => {
		const parts: string[] = [];
		if (trashResult.error) {
			parts.push(trashResult.error.message);
		}
		const stderr = trashResult.stderr?.trim();
		if (stderr) {
			parts.push(stderr.split("\n")[0] ?? stderr);
		}
		if (parts.length === 0) return null;
		return `trash: ${parts.join(" · ").slice(0, 200)}`;
	};

	// If trash reports success, or the file is gone afterwards, treat it as successful
	if (trashResult.status === 0 || !existsSync(sessionPath)) {
		return { ok: true, method: "trash" };
	}

	// Fallback to permanent deletion
	try {
		await unlink(sessionPath);
		return { ok: true, method: "unlink" };
	} catch (err) {
		const unlinkError = err instanceof Error ? err.message : String(err);
		const trashErrorHint = getTrashErrorHint();
		const error = trashErrorHint ? `${unlinkError} (${trashErrorHint})` : unlinkError;
		return { ok: false, method: "unlink", error };
	}
}

/**
 * Component that renders a session selector
 */
export class SessionSelectorComponent extends Container implements Focusable {
	handleInput(data: string): void {
		if (this.mode === "rename") {
			const kb = getKeybindings();
			if (kb.matches(data, "tui.select.cancel")) {
				this.exitRenameMode();
				return;
			}
			this.renameInput.handleInput(data);
			return;
		}

		this.sessionList.handleInput(data);
	}

	private canRename = true;
	private sessionList: SessionList;
	private header: SessionSelectorHeader;
	private sortMode: SortMode = "recent";
	private nameFilter: NameFilter = "all";
	private sessions: SessionInfo[] | null = null;
	private sessionsLoader: SessionsLoader;
	private requestRender: () => void;
	private renameSession?: (sessionPath: string, currentName: string | undefined) => Promise<void>;
	/** Generation counter instead of AbortController (A2 list() takes no signal). */
	private loadGeneration = 0;
	private loading = false;

	private mode: "list" | "rename" = "list";
	private renameInput = new Input();
	private renameTargetPath: string | null = null;

	// Focusable implementation - propagate to sessionList for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.sessionList.focused = value;
		this.renameInput.focused = value;
		if (value && this.mode === "rename") {
			this.renameInput.focused = true;
		}
	}

	private buildBaseLayout(content: Component, options?: { showHeader?: boolean }): void {
		this.clear();
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
		this.addChild(new Spacer(1));
		if (options?.showHeader ?? true) {
			this.addChild(this.header);
			this.addChild(new Spacer(1));
		}
		this.addChild(content);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
	}

	constructor(
		sessionsLoader: SessionsLoader,
		onSelect: (sessionPath: string) => void,
		onCancel: () => void,
		requestRender: () => void,
		options?: {
			renameSession?: (sessionPath: string, currentName: string | undefined) => Promise<void>;
			showRenameHint?: boolean;
		},
		currentSessionFilePath?: string,
	) {
		super();
		this.sessionsLoader = sessionsLoader;
		this.requestRender = requestRender;
		this.header = new SessionSelectorHeader(this.sortMode, this.nameFilter, this.requestRender);
		const renameSession = options?.renameSession;
		this.renameSession = renameSession;
		this.canRename = !!renameSession;
		this.header.setShowRenameHint(options?.showRenameHint ?? this.canRename);

		// Create session list (starts empty, will be populated after load)
		this.sessionList = new SessionList([], this.sortMode, this.nameFilter, currentSessionFilePath);

		this.buildBaseLayout(this.sessionList);

		this.renameInput.onSubmit = (value) => {
			void this.confirmRename(value);
		};

		// Ensure header status timeouts are cleared when leaving the selector
		const clearStatusMessage = () => this.header.setStatusMessage(null);
		this.sessionList.onSelect = (sessionPath) => {
			clearStatusMessage();
			this.loadGeneration++; // invalidate in-flight load
			onSelect(sessionPath);
		};
		this.sessionList.onCancel = () => {
			clearStatusMessage();
			this.loadGeneration++;
			onCancel();
		};
		this.sessionList.onToggleSort = () => this.toggleSortMode();
		this.sessionList.onToggleNameFilter = () => this.toggleNameFilter();
		this.sessionList.onRenameSession = (sessionPath) => {
			if (!renameSession) return;
			if (this.loading) return;

			const session = (this.sessions ?? []).find((s) => s.filePath === sessionPath);
			this.enterRenameMode(sessionPath, session?.name);
		};

		// Sync list events to header
		this.sessionList.onTogglePath = (showPath) => {
			this.header.setShowPath(showPath);
			this.requestRender();
		};
		this.sessionList.onDeleteConfirmationChange = (path) => {
			this.header.setConfirmingDeletePath(path);
			this.requestRender();
		};
		this.sessionList.onError = (msg) => {
			this.header.setStatusMessage({ type: "error", message: msg }, 3000);
			this.requestRender();
		};

		// Handle session deletion
		this.sessionList.onDeleteSession = async (sessionPath: string) => {
			const result = await deleteSessionFile(sessionPath);

			if (result.ok) {
				if (this.sessions) {
					this.sessions = this.sessions.filter((s) => s.filePath !== sessionPath);
				}

				this.sessionList.setSessions(this.sessions ?? []);

				const msg = result.method === "trash" ? "Session moved to trash" : "Session deleted";
				this.header.setStatusMessage({ type: "info", message: msg }, 2000);
				await this.reloadSessions();
			} else {
				const errorMessage = result.error ?? "Unknown error";
				this.header.setStatusMessage({ type: "error", message: `Failed to delete: ${errorMessage}` }, 3000);
			}

			this.requestRender();
		};

		// Start loading sessions immediately
		void this.loadSessions();
	}

	private enterRenameMode(sessionPath: string, currentName: string | undefined): void {
		this.mode = "rename";
		this.renameTargetPath = sessionPath;
		this.renameInput.setValue(currentName ?? "");
		this.renameInput.focused = true;

		const panel = new Container();
		panel.addChild(new Text(theme.bold("Rename Session"), 1, 0));
		panel.addChild(new Spacer(1));
		panel.addChild(this.renameInput);
		panel.addChild(new Spacer(1));
		panel.addChild(
			new Text(
				theme.fg("muted", `${keyText("tui.select.confirm")} to save · ${keyText("tui.select.cancel")} to cancel`),
				1,
				0,
			),
		);

		this.buildBaseLayout(panel, { showHeader: false });
		this.requestRender();
	}

	private exitRenameMode(): void {
		this.mode = "list";
		this.renameTargetPath = null;

		this.buildBaseLayout(this.sessionList);

		this.requestRender();
	}

	private async confirmRename(value: string): Promise<void> {
		const next = value.trim();
		if (!next) return;
		const target = this.renameTargetPath;
		if (!target) {
			this.exitRenameMode();
			return;
		}

		// Find current name for callback
		const renameSession = this.renameSession;
		if (!renameSession) {
			this.exitRenameMode();
			return;
		}

		try {
			await renameSession(target, next);
			await this.reloadSessions();
		} finally {
			this.exitRenameMode();
		}
	}

	private async loadSessions(): Promise<void> {
		const generation = ++this.loadGeneration;
		this.loading = true;
		this.header.setLoading(true);
		this.requestRender();

		try {
			const sessions = await this.sessionsLoader();
			if (generation !== this.loadGeneration) return; // stale load

			this.sessions = sessions;
			this.loading = false;
			this.header.setLoading(false);
			this.sessionList.setSessions(sessions);
			this.requestRender();
		} catch (err) {
			if (generation !== this.loadGeneration) return;
			this.loading = false;

			const message = err instanceof Error ? err.message : String(err);
			this.header.setLoading(false);
			this.header.setStatusMessage({ type: "error", message: `Failed to load sessions: ${message}` }, 4000);
			this.sessionList.setSessions([]);
			this.requestRender();
		}
	}

	private toggleSortMode(): void {
		// Cycle: recent -> relevance -> recent (threaded stripped — linear model)
		this.sortMode = this.sortMode === "recent" ? "relevance" : "recent";
		this.header.setSortMode(this.sortMode);
		this.sessionList.setSortMode(this.sortMode);
		this.requestRender();
	}

	private toggleNameFilter(): void {
		this.nameFilter = this.nameFilter === "all" ? "named" : "all";
		this.header.setNameFilter(this.nameFilter);
		this.sessionList.setNameFilter(this.nameFilter);
		this.requestRender();
	}

	private async reloadSessions(): Promise<void> {
		this.sessions = null;
		await this.loadSessions();
	}

	getSessionList(): SessionList {
		return this.sessionList;
	}
}
