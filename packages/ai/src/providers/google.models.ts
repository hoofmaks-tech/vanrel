// Curated minimal catalog for the vanrel vendor strip (replaces the generated
// data/google.json catalog; `scripts/generate-models` is not run here).
import type { Model } from "../types.ts";

export const GOOGLE_MODELS = {
	"gemini-3-pro-preview": {
		id: "gemini-3-pro-preview",
		name: "Gemini 3 Pro Preview",
		api: "google-generative-ai",
		provider: "google",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		input: ["text", "image"],
		cost: { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2 },
		reasoning: true,
		contextWindow: 1048576,
		maxTokens: 65536,
	},
	"gemini-3-flash": {
		id: "gemini-3-flash",
		name: "Gemini 3 Flash",
		api: "google-generative-ai",
		provider: "google",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		input: ["text", "image"],
		cost: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0.3 },
		reasoning: true,
		contextWindow: 1048576,
		maxTokens: 65536,
	},
	"gemini-2.5-pro": {
		id: "gemini-2.5-pro",
		name: "Gemini 2.5 Pro",
		api: "google-generative-ai",
		provider: "google",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		input: ["text", "image"],
		cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
		reasoning: true,
		contextWindow: 1048576,
		maxTokens: 65536,
	},
	"gemini-2.5-flash": {
		id: "gemini-2.5-flash",
		name: "Gemini 2.5 Flash",
		api: "google-generative-ai",
		provider: "google",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		input: ["text", "image"],
		cost: { input: 0.15, output: 2.5, cacheRead: 0.015, cacheWrite: 0.15 },
		reasoning: true,
		contextWindow: 1048576,
		maxTokens: 65536,
	},
} satisfies Record<string, Model<"google-generative-ai">>;
