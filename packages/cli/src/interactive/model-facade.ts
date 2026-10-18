/**
 * A1 ModelFacade (recon interactive-vendor §3.3) — NOT vendored Pi code: our adapter over
 * ProviderRouter + ResolvedAuth (resolveAuth) + the static @vanrel/ai catalog
 * (findCatalogModel, DEFAULT_MODEL_ALIASES). Replaces Pi model-runtime/model-resolver/
 * model-registry; no network catalog refresh (recon §2c).
 *
 * Deviation: set("provider/id") validates credential+catalog and switches current, but
 * request-time ProviderRouter routing still follows policy.order (the router cannot pin
 * to a provider — VENDOR-GAP, see report W12c); aliases ("default"/"cheap") route correctly.
 */
import type { AuthProviderId, CredentialSource, Model, ProviderRouter, ResolvedAuth } from "@vanrel/ai";
import { AUTH_PROVIDER_IDS, DEFAULT_MODEL_ALIASES } from "@vanrel/ai";
import { getBuiltinModels } from "@vanrel/ai/providers/all";
import type { Logger } from "@vanrel/telemetry";
import { CATALOG_PROVIDER, resolveModelRef } from "../stream.ts";
import type { AuthSelectorProvider } from "./components/oauth-selector.ts";

/** Signature — recon §3.3 (A1), strictly. */
export interface ModelFacade {
	listAvailable(): { provider: AuthProviderId; id: string; name: string }[]; // catalog × resolveAuth.byProvider
	current(): Model<any>;
	set(ref: string /* "provider/id" | alias */): void; // RouteError → up
	availableProviderCount(): number; // auth.byProvider.size
	loginProviderOptions(): AuthSelectorProvider[]; // from builtinAuthProviders + resolveAuth statuses
}

export interface ModelFacadeDeps {
	router: ProviderRouter;
	auth: ResolvedAuth;
	log: Logger;
	/** Model selected at runtime assembly (wiring.ts initialTarget); default — lazy route("default"). */
	initialModel?: Model<any>;
	/** Passes the model change into wiring (stream requestedModel + budget recompute — A0 host). */
	onModelChange?: (ref: string, model: Model<any>) => void;
}

/** Display names of builtin providers (from the §5.1 descriptions in auth/providers/*). */
const PROVIDER_DISPLAY_NAMES: Record<AuthProviderId, string> = {
	anthropic: "Anthropic (Claude Code)",
	agy: "Antigravity (Google)",
	codex: "OpenAI (Codex, ChatGPT)",
};

/**
 * CredentialSource → AuthCheck source label. The "OAuth"/"stored credential" and ENV_VAR
 * pairs are recognized by formatAuthSelectorProviderStatus (oauth-selector.ts) as
 * "✓ configured"/"env: X".
 */
function credentialSourceLabel(source: CredentialSource): string {
	switch (source.kind) {
		case "env":
			return source.name;
		case "vanrel-store":
			return "stored credential";
		case "login-flow":
			return "OAuth";
		case "external-file":
			return source.path;
	}
}

export class DefaultModelFacade implements ModelFacade {
	private readonly router: ProviderRouter;
	private readonly auth: ResolvedAuth;
	private readonly log: Logger;
	private readonly onModelChange?: (ref: string, model: Model<any>) => void;
	private currentModel: Model<any> | undefined;
	private currentRef: string | undefined;

	constructor(deps: ModelFacadeDeps) {
		this.router = deps.router;
		this.auth = deps.auth;
		this.log = deps.log;
		this.currentModel = deps.initialModel;
		this.onModelChange = deps.onModelChange;
	}

	listAvailable(): { provider: AuthProviderId; id: string; name: string }[] {
		const out: { provider: AuthProviderId; id: string; name: string }[] = [];
		for (const provider of AUTH_PROVIDER_IDS) {
			if (!this.auth.byProvider.has(provider)) continue;
			for (const model of getBuiltinModels(CATALOG_PROVIDER[provider])) {
				out.push({ provider, id: model.id, name: model.name });
			}
		}
		return out;
	}

	current(): Model<any> {
		if (!this.currentModel) this.set(this.currentRef ?? "default");
		// set() either assigns currentModel or throws RouteError — non-null is safe.
		return this.currentModel as Model<any>;
	}

	set(ref: string): void {
		const { provider, model } = this.resolveRef(ref);
		// Transactional (recon M3): onModelChange is wiring.setModel with budget recompute;
		// its throw (BudgetError/RouteError) leaves currentModel/currentRef unchanged.
		this.onModelChange?.(ref, model);
		this.currentModel = model;
		this.currentRef = ref;
		this.log.info("model changed", { ref, provider, model: model.id });
	}

	availableProviderCount(): number {
		return this.auth.byProvider.size;
	}

	loginProviderOptions(): AuthSelectorProvider[] {
		return AUTH_PROVIDER_IDS.map((id) => {
			const credential = this.auth.byProvider.get(id);
			return {
				id,
				name: PROVIDER_DISPLAY_NAMES[id],
				authType: "oauth" as const,
				subscription: true,
				status: credential
					? { type: "oauth" as const, source: credentialSourceLabel(credential.source) }
					: undefined,
			};
		});
	}

	/** ref → {provider, catalog Model}. All failures are RouteError (§3.3 contract: propagate up). */
	private resolveRef(ref: string): { provider: AuthProviderId; model: Model<any> } {
		// W14: logic moved to stream.ts resolveModelRef (shared with wiring.setModel).
		return resolveModelRef(ref, this.router, this.auth);
	}
}

/** Aliases the facade understands without an explicit provider — re-export for UI hints. */
export { DEFAULT_MODEL_ALIASES };
