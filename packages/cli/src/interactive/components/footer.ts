// MIT License, Copyright (c) 2025 Mario Zechner
// Vendored from earendil-works/pi (packages/coding-agent/src/modes/interactive/components/footer.ts), adapted for vanrel.
//
// Adaptation: pi-tui → @vanrel/tui; theme → ../theme/theme.ts (W10);
// usage-totals → ../core/usage-totals.ts (W11); footer-data-provider → ../core/footer-data-provider.ts (W11;
// W11 has no getExtensionStatuses/ReadonlyFooterDataProvider — extension statuses stripped per recon §4,
// provider narrowed to getGitBranch/getAvailableProviderCount/onBranchChange);
// AgentSession (pi core/agent-session.ts) → local FooterSession interface on top of
// vanrel SessionManager (../../session.ts, A2) + agent state.
// Stripped: leafId/tree cache keys (linear model, R3), branch_summary/usage entry types
// (absent in vanrel SessionEntry), routedModel display (pi has no virtual models here),
// isUsingSubscription/" (sub)" badge (pi modelRuntime not vendored), experimental "xp" badge
// (core/experimental.ts not vendored).

import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ThinkingLevel } from "@vanrel/agent";
import type { Model } from "@vanrel/ai";
import { type Component, truncateToWidth, visibleWidth } from "@vanrel/tui";
import type { SessionManager } from "../../session.ts";
import type { FooterDataProvider } from "../core/footer-data-provider.ts";
import { addUsageToTotals, createUsageTotals, type UsageTotals } from "../core/usage-totals.ts";
import { theme } from "../theme/theme.ts";

/** Read-only surface of the footer data provider (pi ReadonlyFooterDataProvider without extension statuses). */
export type FooterData = Pick<FooterDataProvider, "getGitBranch" | "getAvailableProviderCount" | "onBranchChange">;

/**
 * Format token counts for compact footer display.
 */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatCwdForFooter(cwd: string, home: string | undefined): string {
	if (!home) return cwd;

	const resolvedCwd = resolve(cwd);
	const resolvedHome = resolve(home);
	const relativeToHome = relative(resolvedHome, resolvedCwd);
	const isInsideHome =
		relativeToHome === "" ||
		(relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));

	if (!isInsideHome) return cwd;
	return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

/** Mirror of pi ContextUsage (core/extensions/types.ts not vendored). */
export interface FooterContextUsage {
	/** Estimated context tokens, or null if unknown (e.g. right after compaction, before next LLM response). */
	tokens: number | null;
	contextWindow: number;
	/** Context usage as percentage of context window, or null if tokens is unknown. */
	percent: number | null;
}

export interface FooterSessionState {
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
}

/**
 * Minimal session surface needed by the footer. Implemented by the A0/A2 adapter over
 * InteractiveHost (agent.state + session + context usage from stats/compactor).
 */
export interface FooterSession {
	readonly sessionManager: Pick<
		SessionManager,
		"getEntryCount" | "getSessionId" | "getEntries" | "getCwd" | "getSessionName"
	>;
	readonly state: FooterSessionState;
	getContextUsage(): FooterContextUsage | undefined;
}

interface SessionStats {
	session: FooterSession;
	sessionId: string;
	entryCount: number;
	limitsModel: unknown;
	usageTotals: UsageTotals;
	latestCacheHitRate: number | undefined;
	contextUsage: FooterContextUsage | undefined;
}

/**
 * Footer component that shows pwd, token stats, and context usage.
 * Computes token/context stats from session, gets git branch and extension statuses from provider.
 */
export class FooterComponent implements Component {
	private autoCompactEnabled = true;
	private session: FooterSession;
	private footerData: FooterData;
	private sessionStats?: SessionStats;

	constructor(session: FooterSession, footerData: FooterData) {
		this.session = session;
		this.footerData = footerData;
	}

	setSession(session: FooterSession): void {
		this.session = session;
	}

	setAutoCompactEnabled(enabled: boolean): void {
		this.autoCompactEnabled = enabled;
	}

	/**
	 * No-op: git branch caching now handled by provider.
	 * Kept for compatibility with existing call sites in interactive-mode.
	 */
	invalidate(): void {
		// No-op: git branch is cached/invalidated by provider
	}

	/**
	 * Clean up resources.
	 * Git watcher cleanup now handled by provider.
	 */
	dispose(): void {
		// Git watcher cleanup handled by provider
	}

	/**
	 * Usage totals and context usage scan the whole session, and the footer renders on every frame.
	 * Entries are append-only, so the results only change with the session, entry count, or the
	 * model whose context window applies. (Vanrel linear model: leafId from the pi cache key removed.)
	 */
	private getSessionStats(): SessionStats {
		const sessionManager = this.session.sessionManager;
		const entryCount = sessionManager.getEntryCount();
		const sessionId = sessionManager.getSessionId();
		const limitsModel = this.session.state.model;
		const cached = this.sessionStats;
		if (
			cached &&
			cached.session === this.session &&
			cached.sessionId === sessionId &&
			cached.entryCount === entryCount &&
			cached.limitsModel === limitsModel
		) {
			return cached;
		}

		// Calculate cumulative usage from ALL session entries (not just post-compaction messages)
		const usageTotals = createUsageTotals();
		let latestCacheHitRate: number | undefined;

		for (const entry of sessionManager.getEntries()) {
			if (entry.type === "assistant") {
				addUsageToTotals(usageTotals, entry.message.usage);

				const latestPromptTokens =
					entry.message.usage.input + entry.message.usage.cacheRead + entry.message.usage.cacheWrite;
				latestCacheHitRate =
					latestPromptTokens > 0 ? (entry.message.usage.cacheRead / latestPromptTokens) * 100 : undefined;
			} else if (entry.type === "tool_result" && entry.message.usage) {
				addUsageToTotals(usageTotals, entry.message.usage);
			}
		}

		// Calculate context usage from session (handles compaction correctly).
		// After compaction, tokens are unknown until the next LLM response.
		const contextUsage = this.session.getContextUsage();
		this.sessionStats = {
			session: this.session,
			sessionId,
			entryCount,
			limitsModel,
			usageTotals,
			latestCacheHitRate,
			contextUsage,
		};
		return this.sessionStats;
	}

	render(width: number): string[] {
		const state = this.session.state;
		const { usageTotals, latestCacheHitRate, contextUsage } = this.getSessionStats();
		const contextWindow = contextUsage?.contextWindow ?? state.model?.contextWindow ?? 0;
		const contextPercentValue = contextUsage?.percent ?? 0;
		const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";

		// Replace home directory with ~
		let pwd = formatCwdForFooter(this.session.sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE);

		// Add git branch if available
		const branch = this.footerData.getGitBranch();
		if (branch) {
			pwd = `${pwd} (${branch})`;
		}

		// Add session name if set
		const sessionName = this.session.sessionManager.getSessionName();
		if (sessionName) {
			pwd = `${pwd} • ${sessionName}`;
		}

		// Build stats line
		const statsParts = [];
		if (usageTotals.input) statsParts.push(`↑${formatTokens(usageTotals.input)}`);
		if (usageTotals.output) statsParts.push(`↓${formatTokens(usageTotals.output)}`);
		if (usageTotals.cacheRead) statsParts.push(`R${formatTokens(usageTotals.cacheRead)}`);
		if (usageTotals.cacheWrite) statsParts.push(`W${formatTokens(usageTotals.cacheWrite)}`);
		if ((usageTotals.cacheRead > 0 || usageTotals.cacheWrite > 0) && latestCacheHitRate !== undefined) {
			statsParts.push(`CH${latestCacheHitRate.toFixed(1)}%`);
		}

		if (usageTotals.cost) {
			statsParts.push(`$${usageTotals.cost.toFixed(3)}`);
		}

		// Colorize context percentage based on usage
		let contextPercentStr: string;
		const autoIndicator = this.autoCompactEnabled ? " (auto)" : "";
		const contextPercentDisplay =
			contextPercent === "?"
				? `?/${formatTokens(contextWindow)}${autoIndicator}`
				: `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`;
		if (contextPercentValue > 90) {
			contextPercentStr = theme.fg("error", contextPercentDisplay);
		} else if (contextPercentValue > 70) {
			contextPercentStr = theme.fg("warning", contextPercentDisplay);
		} else {
			contextPercentStr = contextPercentDisplay;
		}
		statsParts.push(contextPercentStr);

		let statsLeft = statsParts.join(" ");

		// Add model name on the right side, plus thinking level if model supports it
		const modelName = state.model?.id || "no-model";

		let statsLeftWidth = visibleWidth(statsLeft);

		// If statsLeft is too wide, truncate it
		if (statsLeftWidth > width) {
			statsLeft = truncateToWidth(statsLeft, width, "...");
			statsLeftWidth = visibleWidth(statsLeft);
		}

		// Calculate available space for padding (minimum 2 spaces between stats and model)
		const minPadding = 2;

		// Add thinking level indicator if model supports reasoning
		let rightSide = modelName;
		if (state.model?.reasoning) {
			const thinkingLevel = state.thinkingLevel || "off";
			rightSide = thinkingLevel === "off" ? `${modelName} • thinking off` : `${modelName} • ${thinkingLevel}`;
		}

		// Prepend the provider in parentheses if there are multiple providers and there's enough room
		if (this.footerData.getAvailableProviderCount() > 1 && state.model) {
			const withProvider = `(${state.model.provider}) ${rightSide}`;
			if (statsLeftWidth + minPadding + visibleWidth(withProvider) <= width) {
				rightSide = withProvider;
			}
		}

		const rightSideWidth = visibleWidth(rightSide);
		const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

		let statsLine: string;
		if (totalNeeded <= width) {
			// Both fit - add padding to right-align model
			const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
			statsLine = statsLeft + padding + rightSide;
		} else {
			// Need to truncate right side
			const availableForRight = width - statsLeftWidth - minPadding;
			if (availableForRight > 0) {
				const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
				const truncatedRightWidth = visibleWidth(truncatedRight);
				const padding = " ".repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth));
				statsLine = statsLeft + padding + truncatedRight;
			} else {
				// Not enough space for right side at all
				statsLine = statsLeft;
			}
		}

		// Apply dim to each part separately. statsLeft may contain color codes (for context %)
		// that end with a reset, which would clear an outer dim wrapper. So we dim the parts
		// before and after the colored section independently.
		const dimStatsLeft = theme.fg("dim", statsLeft);
		const remainder = statsLine.slice(statsLeft.length); // padding + rightSide
		const dimRemainder = theme.fg("dim", remainder);

		const pwdLine = truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "..."));
		const lines = [pwdLine, dimStatsLeft + dimRemainder];

		// Extension statuses from the pi footer are stripped (extension subsystem not vendored, recon §4).

		return lines;
	}
}
