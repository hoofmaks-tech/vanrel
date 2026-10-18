// MIT License, Copyright (c) 2025 Mario Zechner
// Vendored from earendil-works/pi (packages/coding-agent/src/modes/interactive/components/theme-selector.ts), adapted for vanrel.
//
// Adaptation: @earendil-works/pi-tui → @vanrel/tui; onSelect/onPreview callbacks replaced by
// InteractiveThemeController (../theme/theme-controller.ts, W10): onSelectionChange/cancel —
// preview() without persist, select — setThemeSetting() (apply + persist via A3 inside the
// controller). Current theme — resolveThemeSetting(getThemeSelection()) (supports
// "light/dark" pairs); theme list — getAvailableThemes() from ../theme/theme.ts.

import { Container, type SelectItem, SelectList, type SelectListLayoutOptions } from "@vanrel/tui";
import {
	getAvailableThemes,
	getSelectListTheme,
	getTerminalTheme,
	resolveThemeSetting,
	SYSTEM_THEME_NAME,
} from "../theme/theme.ts";
import type { InteractiveThemeController } from "../theme/theme-controller.ts";
import { DynamicBorder } from "./dynamic-border.ts";

const THEME_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

/**
 * Component that renders a theme selector
 */
export class ThemeSelectorComponent extends Container {
	private selectList: SelectList;

	constructor(themeController: InteractiveThemeController, onCancel: () => void) {
		super();

		const originalThemeName =
			resolveThemeSetting(themeController.getThemeSelection(), getTerminalTheme()) ?? SYSTEM_THEME_NAME;

		// Get available themes and create select items
		const themes = getAvailableThemes();
		const themeItems: SelectItem[] = themes.map((name) => ({
			value: name,
			label: name,
			description: name === originalThemeName ? "(current)" : undefined,
		}));

		// Add top border
		this.addChild(new DynamicBorder());

		// Create selector
		this.selectList = new SelectList(themeItems, 10, getSelectListTheme(), THEME_SELECT_LIST_LAYOUT);

		// Preselect current theme
		const currentIndex = themes.indexOf(originalThemeName);
		if (currentIndex !== -1) {
			this.selectList.setSelectedIndex(currentIndex);
		}

		this.selectList.onSelect = (item) => {
			themeController.setThemeSetting(item.value);
			onCancel();
		};

		this.selectList.onCancel = () => {
			// Roll back preview to the original theme (no persist).
			themeController.preview(originalThemeName);
			onCancel();
		};

		this.selectList.onSelectionChange = (item) => {
			themeController.preview(item.value);
		};

		this.addChild(this.selectList);

		// Add bottom border
		this.addChild(new DynamicBorder());
	}

	getSelectList(): SelectList {
		return this.selectList;
	}
}
