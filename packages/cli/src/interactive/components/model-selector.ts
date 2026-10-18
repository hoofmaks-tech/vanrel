// MIT License, Copyright (c) 2025 Mario Zechner
// Vendored from earendil-works/pi (packages/coding-agent/src/modes/interactive/components/model-selector.ts), adapted for vanrel.
//
// Adaptation: pi ModelRuntime → A1 ModelFacade (../model-facade.ts, recon §3.3). Stripped
// (recon §4/R6): scoped models (Tab all/scoped — vanrel has aliases instead of scope),
// network catalog refresh (catalog is static — refreshModelCatalogs, refreshStatusMessage,
// dispose/abort), "set as default" (app.models.save — the default model is set via
// CLI/aliases, not from the TUI). onSelect returns {provider, id} — applied via
// host.setModel("provider/id").

import type { AuthProviderId } from "@vanrel/ai";
import { Container, type Focusable, fuzzyFilter, getKeybindings, Input, Spacer, Text, type TUI } from "@vanrel/tui";
import { CATALOG_PROVIDER } from "../../stream.ts";
import type { ModelFacade } from "../model-facade.ts";
import { getModelSelectorSearchText } from "../model-search.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyDisplayText } from "./keybinding-hints.ts";

/** Selection in the selector: auth-provider id + catalog model id (ref for ModelFacade.set). */
export interface ModelSelectorSelection {
	provider: AuthProviderId;
	id: string;
}

interface ModelItem extends ModelSelectorSelection {
	name: string;
}

/**
 * Component that renders a model selector with search
 */
export class ModelSelectorComponent extends Container implements Focusable {
	private searchInput: Input;

	// Focusable implementation - propagate to searchInput for IME cursor positioning
	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}
	private listContainer: Container;
	private allModels: ModelItem[] = [];
	private filteredModels: ModelItem[] = [];
	private selectedIndex: number = 0;
	private modelFacade: ModelFacade;
	private onSelectCallback: (selection: ModelSelectorSelection) => void;
	private onCancelCallback: () => void;
	private tui: TUI;

	constructor(
		tui: TUI,
		modelFacade: ModelFacade,
		onSelect: (selection: ModelSelectorSelection) => void,
		onCancel: () => void,
		initialSearchInput?: string,
	) {
		super();

		this.tui = tui;
		this.modelFacade = modelFacade;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		// Add top border
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		// Add hint about model filtering
		const hintText = "Only showing models from configured providers. Use /login to add providers.";
		this.addChild(new Text(theme.fg("warning", hintText), 0, 0));
		this.addChild(new Spacer(1));

		// Create search input
		this.searchInput = new Input();
		if (initialSearchInput) {
			this.searchInput.setValue(initialSearchInput);
		}
		this.searchInput.onSubmit = () => {
			// Enter on search input selects the first filtered item
			const selected = this.filteredModels[this.selectedIndex];
			if (selected) {
				this.handleSelect(selected);
			}
		};
		this.addChild(this.searchInput);

		this.addChild(new Spacer(1));

		// Create list container
		this.listContainer = new Container();
		this.addChild(this.listContainer);

		this.addChild(new Spacer(1));

		// Hint
		this.addChild(
			new Text(
				theme.fg(
					"dim",
					`  ${keyDisplayText("tui.select.confirm")} to select · ${keyDisplayText("tui.select.cancel")} to cancel`,
				),
				0,
				0,
			),
		);

		// Add bottom border
		this.addChild(new DynamicBorder());

		// Static catalog (A1): loading is synchronous, no background refresh.
		this.loadModels();
		if (initialSearchInput) this.filterModels(initialSearchInput);
		else this.updateList();
		this.tui.requestRender();
	}

	private isCurrent(item: ModelItem): boolean {
		const current = this.modelFacade.current();
		// Model.provider — catalog id ("google"/"openai-codex"), item.provider — AuthProviderId.
		return item.id === current.id && CATALOG_PROVIDER[item.provider] === current.provider;
	}

	private loadModels(): void {
		const models: ModelItem[] = this.modelFacade.listAvailable().map((model) => ({
			provider: model.provider,
			id: model.id,
			name: model.name,
		}));
		// Sort: current model first, then by provider.
		models.sort((a, b) => {
			const aIsCurrent = this.isCurrent(a);
			const bIsCurrent = this.isCurrent(b);
			if (aIsCurrent && !bIsCurrent) return -1;
			if (!aIsCurrent && bIsCurrent) return 1;
			return a.provider.localeCompare(b.provider);
		});
		this.allModels = models;
		this.filteredModels = models;
		const currentIndex = this.filteredModels.findIndex((item) => this.isCurrent(item));
		this.selectedIndex =
			currentIndex >= 0 ? currentIndex : Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
	}

	private filterModels(query: string): void {
		if (query) {
			this.filteredModels = fuzzyFilter(this.allModels, query, (item) =>
				getModelSelectorSearchText({ id: item.id, provider: item.provider, name: item.name }),
			);
		} else {
			this.filteredModels = this.allModels;
		}
		// When filtering by a query, move the selector to the top row so the best
		// match is highlighted. When the query is cleared, keep the current position
		// clamped to the (restored) list length.
		this.selectedIndex = query ? 0 : Math.min(this.selectedIndex, Math.max(0, this.filteredModels.length - 1));
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();

		const maxVisible = 10;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredModels.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredModels.length);

		// Show visible slice of filtered models
		for (let i = startIndex; i < endIndex; i++) {
			const item = this.filteredModels[i];
			if (!item) continue;

			const isSelected = i === this.selectedIndex;
			const isCurrent = this.isCurrent(item);

			const cursor = isSelected ? theme.fg("accent", "→ ") : "  ";
			const currentMarker = isCurrent ? theme.fg("accent", "✓ ") : "  ";
			const modelText = isSelected ? theme.fg("accent", item.id) : item.id;
			const providerBadge = theme.fg("muted", `[${item.provider}]`);
			const line = `${cursor}${currentMarker}${modelText} ${providerBadge}`;

			this.listContainer.addChild(new Text(line, 0, 0));
		}

		// Add scroll indicator if needed
		if (startIndex > 0 || endIndex < this.filteredModels.length) {
			const scrollInfo = theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredModels.length})`);
			this.listContainer.addChild(new Text(scrollInfo, 0, 0));
		}

		// Show "no results" if empty
		if (this.filteredModels.length === 0) {
			this.listContainer.addChild(new Text(theme.fg("muted", "  No matching models"), 0, 0));
		} else {
			const selected = this.filteredModels[this.selectedIndex];
			this.listContainer.addChild(new Spacer(1));
			this.listContainer.addChild(new Text(theme.fg("muted", `  Model Name: ${selected.name}`), 0, 0));
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		// Up arrow - wrap to bottom when at top
		if (kb.matches(keyData, "tui.select.up")) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = this.selectedIndex === 0 ? this.filteredModels.length - 1 : this.selectedIndex - 1;
			this.updateList();
		}
		// Down arrow - wrap to top when at bottom
		else if (kb.matches(keyData, "tui.select.down")) {
			if (this.filteredModels.length === 0) return;
			this.selectedIndex = this.selectedIndex === this.filteredModels.length - 1 ? 0 : this.selectedIndex + 1;
			this.updateList();
		}
		// Enter
		else if (kb.matches(keyData, "tui.select.confirm")) {
			const selectedModel = this.filteredModels[this.selectedIndex];
			if (selectedModel) {
				this.handleSelect(selectedModel);
			}
		}
		// Escape or Ctrl+C
		else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		}
		// Pass everything else to search input
		else {
			this.searchInput.handleInput(keyData);
			this.filterModels(this.searchInput.getValue());
		}
	}

	private handleSelect(item: ModelItem): void {
		this.onSelectCallback({ provider: item.provider, id: item.id });
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}
