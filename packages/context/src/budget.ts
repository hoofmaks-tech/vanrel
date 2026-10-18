/**
 * Window budget model.
 * W = S + T + H + R + U; computeBudget is a pure stateless function.
 */

export interface ContextBudgetInput {
	contextWindow: number; // W, from Model.contextWindow
	systemTokens: number; // S: measurement of the assembled system message (estimateMessageTokens)
	toolSchemaTokens: number; // T: JSON schemas of the active toolset
	userTurnTokens: number; // U: estimate of the current user input
	minReasoningReserve: number; // R_min: reasoning → 4096, otherwise 1024
	maxOutputTokens?: number; // upper cap of the response; default 8192
	prevStopReason?: string; // "length" → adaptive doubling of R (§6.2)
}

export interface ContextBudget {
	W: number;
	S: number;
	T: number;
	R: number;
	U: number;
	historyBudget: number; // H_max = W − S − T − R − U (§6.1)
	/** Effective max_tokens of the request: min(maxOutputTokens, R). */
	requestMaxTokens: number;
}

export class BudgetError extends Error {
	readonly kind = "budget";
	constructor(message: string) {
		super(message);
		this.name = "BudgetError";
	}
}

export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
export const MIN_USER_TURN_TOKENS = 1024;
export const MAX_USER_TURN_TOKENS = 16384;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * Formulas §6.1:
 *   R*  = max(⌈0.25·W⌉, R_min);  prevStopReason == "length" → R* ← min(2·R*, ⌊0.5·W⌋)  (§6.2)
 *   R   = min(R*, ⌊0.5·W⌋)
 *   U   = clamp(U_est, 1024, 16384)
 *   H_max = W − S − T − R − U
 *   requestMaxTokens = min(maxOutputTokens, R)
 * Throws BudgetError if S + T + R + U ≥ W.
 */
export function computeBudget(input: ContextBudgetInput): ContextBudget {
	const W = input.contextWindow;
	const S = input.systemTokens;
	const T = input.toolSchemaTokens;
	if (!Number.isFinite(W) || W <= 0) {
		throw new BudgetError(`contextWindow must be a positive finite number, got ${W}`);
	}
	const halfW = Math.floor(0.5 * W);

	let rStar = Math.max(Math.ceil(0.25 * W), input.minReasoningReserve);
	if (input.prevStopReason === "length") {
		rStar = Math.min(2 * rStar, halfW);
	}
	const R = Math.min(rStar, halfW);
	const U = clamp(input.userTurnTokens, MIN_USER_TURN_TOKENS, MAX_USER_TURN_TOKENS);

	if (S + T + R + U >= W) {
		throw new BudgetError(
			`window ${W} cannot serve even empty history: S=${S} + T=${T} + R=${R} + U=${U} >= W; use a model with a larger context window`,
		);
	}

	const maxOutputTokens = input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
	return {
		W,
		S,
		T,
		R,
		U,
		historyBudget: W - S - T - R - U,
		requestMaxTokens: Math.min(maxOutputTokens, R),
	};
}
