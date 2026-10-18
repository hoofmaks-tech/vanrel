// Curated vendor catalog: replaces the upstream auto-generated file
// (scripts/generate-models.ts from providers/data/*.json). The vanrel strip
// keeps only the anthropic, google and openai-codex providers;.
import { ANTHROPIC_MODELS } from "./providers/anthropic.models.ts";
import { GOOGLE_MODELS } from "./providers/google.models.ts";
import { OPENAI_CODEX_MODELS } from "./providers/openai-codex.models.ts";

export const MODELS: {
	readonly anthropic: typeof ANTHROPIC_MODELS;
	readonly google: typeof GOOGLE_MODELS;
	readonly "openai-codex": typeof OPENAI_CODEX_MODELS;
} = {
	anthropic: ANTHROPIC_MODELS,
	google: GOOGLE_MODELS,
	"openai-codex": OPENAI_CODEX_MODELS,
};

export const IMAGE_MODELS: Record<string, never> = {};

export const CLASSIFIER_MODELS: Record<string, never> = {};
