// Curated minimal catalog for the vanrel vendor strip (replaces the generated
// data/openai-codex.json catalog; `scripts/generate-models` is not run here).
// openai-codex is the ChatGPT-subscription backend (Responses API transport).
import type { Model } from "../types.ts";

export const OPENAI_CODEX_MODELS = {
	"gpt-5.5": {
		id: "gpt-5.5",
		name: "GPT-5.5",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: true,
		contextWindow: 400000,
		maxTokens: 128000,
	},
	"gpt-5.3-codex": {
		id: "gpt-5.3-codex",
		name: "GPT-5.3 Codex",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: true,
		contextWindow: 400000,
		maxTokens: 128000,
	},
	"gpt-5.2-codex": {
		id: "gpt-5.2-codex",
		name: "GPT-5.2 Codex",
		api: "openai-codex-responses",
		provider: "openai-codex",
		baseUrl: "https://chatgpt.com/backend-api",
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		reasoning: true,
		contextWindow: 400000,
		maxTokens: 128000,
	},
} satisfies Record<string, Model<"openai-codex-responses">>;
