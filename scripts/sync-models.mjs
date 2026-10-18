// Regenerate the vendored model catalogs from the latest @earendil-works/pi-ai npm release.
//
// pi-ai ships pi-curated catalogs at dist/providers/data/<provider>.json (hydrated from
// models.dev by pi's scripts/generate-models.ts). This script fetches those JSONs, applies
// the vanrel subscription allowlists, rewrites packages/ai/src/providers/*.models.ts, and
// runs biome format on them. Run: npm run models:sync
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PI_PACKAGE = "@earendil-works/pi-ai";

/** Curation: which upstream chat models vanrel exposes (subscription-relevant only). */
const PROVIDERS = {
	anthropic: {
		api: "anthropic-messages",
		exportName: "ANTHROPIC_MODELS",
		ids: [
			"claude-fable-5-1",
			"claude-fable-5",
			"claude-opus-5-5",
			"claude-opus-5",
			"claude-opus-4-8",
			"claude-opus-4-7",
			"claude-opus-4-6",
			"claude-opus-4-5",
			"claude-sonnet-5-5",
			"claude-sonnet-5",
			"claude-sonnet-4-6",
			"claude-sonnet-4-5",
			"claude-haiku-5-5",
			"claude-haiku-4-5",
		],
	},
	google: {
		api: "google-generative-ai",
		exportName: "GOOGLE_MODELS",
		ids: [
			"gemini-4-argon",
			"gemini-3.8-flash",
			"gemini-3.7-flash",
			"gemini-3.6-flash",
			"gemini-3.5-flash",
			"gemini-3.5-flash-lite",
			"gemini-3.1-pro-preview",
			"gemini-3.1-pro-preview-customtools",
			"gemini-3-flash-preview",
			"gemini-3.1-flash-lite",
			"gemini-3.1-flash-lite-preview",
			"gemini-flash-latest",
			"gemini-flash-lite-latest",
		],
	},
	"openai-codex": {
		api: "openai-codex-responses",
		exportName: "OPENAI_CODEX_MODELS",
		ids: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra"],
	},
};

async function fetchJson(url) {
	const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
	if (!response.ok) throw new Error(`GET ${url} → ${response.status}`);
	return response.json();
}

async function main() {
	const meta = await fetchJson(`https://registry.npmjs.org/${PI_PACKAGE.replace("/", "%2F")}/latest`);
	const version = meta.version;
	if (typeof version !== "string") throw new Error("npm registry response has no version");
	console.log(`source: ${PI_PACKAGE}@${version}`);

	const written = [];
	for (const [provider, cfg] of Object.entries(PROVIDERS)) {
		const data = await fetchJson(`https://unpkg.com/${PI_PACKAGE}@${version}/dist/providers/data/${provider}.json`);
		const entries = data[cfg.api];
		if (entries === undefined) throw new Error(`${provider}: api key ${cfg.api} missing upstream`);

		const picked = {};
		for (const id of cfg.ids) {
			const entry = entries[`chat:${id}`];
			if (entry === undefined) throw new Error(`${provider}: allowlisted id ${id} missing upstream — refresh the allowlist`);
			picked[id] = entry;
		}

		const body = JSON.stringify(picked, null, "\t");
		const source = `// Vendored model catalog for the vanrel strip. Hydrated from ${PI_PACKAGE}@${version}\n// (dist/providers/data/${provider}.json; pi curates these from models.dev) — regenerate with\n// \`npm run models:sync\`. Curated to subscription-relevant chat models.\nimport type { Model } from "../types.ts";\n\nexport const ${cfg.exportName} = ${body} satisfies Record<string, Model<"${cfg.api}">>;\n`;
		const file = join(ROOT, "packages/ai/src/providers", `${provider}.models.ts`);
		writeFileSync(file, source);
		written.push(file);
		console.log(`${provider}: ${cfg.ids.length} models → ${file}`);
	}

	const biome = join(ROOT, "node_modules", ".bin", "biome");
	execFileSync(biome, ["format", "--write", ...written], { stdio: "inherit" });
	console.log("done; run `npm run check` to typecheck the result");
}

main().catch((error) => {
	console.error(`sync-models failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
});
