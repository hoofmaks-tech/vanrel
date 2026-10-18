/**
 * FileCredentialStore — ~/.vanrel/auth.json (§5.5).
 * The only write target of the system: foreign files (~/.claude/*, ~/.gemini/*, ~/.codex/*)
 * are never written here. Atomic write via tmp+rename, mode 0600, dir 0700.
 *
 * Implements the pi-ai `CredentialStore` (read/list/modify/delete) on top of the gateway
 * format (§4.2.2: after discover/refresh the regular refreshStoredOAuthCredential takes over).
 * `modify`/`modifyGateway` is the only write path: in-process promise-chain
 * per provider + cross-process lockfile §5.7 (persist BEFORE the lock is released).
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Logger } from "@vanrel/telemetry";
import { AuthLockError } from "./errors.ts";
import type { AuthProviderId, Credential } from "./gateway-types.ts";
import { GATEWAY_NOOP_LOGGER } from "./gateway-types.ts";
import { withFileLock } from "./lockfile.ts";
import type { AuthOperationOptions, CredentialInfo, CredentialStore, OAuthCredential } from "./types.ts";

export interface FileCredentialStoreOptions {
	path?: string; // default ~/.vanrel/auth.json
	now?: () => number;
	log?: Logger;
	lockTimeoutMs?: number; // §5.7 default 10_000
	lockStaleMs?: number; // §5.7 default 60_000
}

/** Persisted form: Credential §4.2.1 without the source field (restored as vanrel-store). */
type StoredCredential = Omit<Credential, "source">;

interface StoreFile {
	v: 1;
	credentials: Partial<Record<string, StoredCredential>>;
}

const CARRIED_KEYS = ["refreshExpiresAt", "scopes", "accountId", "idToken", "extra"] as const;

/** auth.json backward compatibility: legacy provider id → current one (renames without file migration). */
const LEGACY_PROVIDER_ALIASES: Readonly<Record<string, AuthProviderId>> = { gemini: "agy" };

/** gateway Credential → pi-ai OAuthCredential (extra fields travel via index signature). */
function toPiAi(cred: Credential): OAuthCredential {
	const out: OAuthCredential = {
		type: "oauth",
		access: cred.accessToken,
		refresh: cred.refreshToken,
		expires: cred.expiresAt,
	};
	for (const key of CARRIED_KEYS) {
		const value = cred[key];
		if (value !== undefined) out[key] = value;
	}
	return out;
}

/** pi-ai OAuthCredential → gateway Credential; the caller sets source. */
function fromPiAi(provider: AuthProviderId, cred: OAuthCredential, source: Credential["source"]): Credential {
	const out: Credential = {
		provider,
		type: "oauth",
		accessToken: cred.access,
		refreshToken: cred.refresh,
		expiresAt: cred.expires,
		source,
	};
	if (typeof cred.refreshExpiresAt === "number") out.refreshExpiresAt = cred.refreshExpiresAt;
	if (Array.isArray(cred.scopes)) out.scopes = cred.scopes.filter((s): s is string => typeof s === "string");
	if (typeof cred.accountId === "string") out.accountId = cred.accountId;
	if (typeof cred.idToken === "string") out.idToken = cred.idToken;
	if (typeof cred.extra === "object" && cred.extra !== null) out.extra = cred.extra as Record<string, unknown>;
	return out;
}

function isValidStored(entry: unknown): entry is StoredCredential {
	const e = entry as StoredCredential | null;
	return (
		typeof e === "object" &&
		e !== null &&
		e.type === "oauth" &&
		typeof e.accessToken === "string" &&
		typeof e.refreshToken === "string" &&
		typeof e.expiresAt === "number"
	);
}

export class FileCredentialStore implements CredentialStore {
	readonly path: string;
	readonly lockPath: string;
	private readonly now: () => number;
	private readonly log: Logger;
	private readonly lockTimeoutMs: number;
	private readonly lockStaleMs: number;
	private readonly chains = new Map<string, Promise<unknown>>();

	constructor(options?: FileCredentialStoreOptions) {
		this.path = options?.path ?? join(homedir(), ".vanrel", "auth.json");
		this.lockPath = `${this.path}.lock`;
		this.now = options?.now ?? Date.now;
		this.log = options?.log ?? GATEWAY_NOOP_LOGGER;
		this.lockTimeoutMs = options?.lockTimeoutMs ?? 10_000;
		this.lockStaleMs = options?.lockStaleMs ?? 60_000;
	}

	/** Fresh read of the file from disk (no cache — the post-lock double-check requires fresh). */
	private async load(): Promise<StoreFile> {
		let raw: string;
		try {
			raw = await readFile(this.path, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { v: 1, credentials: {} };
			throw error;
		}
		try {
			const parsed = JSON.parse(raw) as StoreFile;
			if (typeof parsed !== "object" || parsed === null || typeof parsed.credentials !== "object") {
				throw new Error("unexpected shape");
			}
			return this.remapLegacyProviders({ v: 1, credentials: parsed.credentials ?? {} });
		} catch (error) {
			this.log.warn("credential store unreadable, treating as empty", { path: this.path, error: String(error) });
			return { v: 1, credentials: {} };
		}
	}

	/**
	 * On-the-fly mapping of legacy provider ids (§5.5 backward compatibility): a gemini
	 * entry is read as agy (WARN); on conflict the canonical entry wins. Persist after
	 * modify already writes canonical keys — lazy migration without a separate step.
	 */
	private remapLegacyProviders(file: StoreFile): StoreFile {
		for (const [legacy, canonical] of Object.entries(LEGACY_PROVIDER_ALIASES)) {
			const entry = file.credentials[legacy];
			if (entry === undefined) continue;
			if (file.credentials[canonical] === undefined) {
				file.credentials[canonical] = entry;
				this.log.warn("credential store: legacy provider id remapped on read", {
					path: this.path,
					from: legacy,
					to: canonical,
				});
			} else {
				this.log.warn("credential store: legacy provider id ignored (canonical entry exists)", {
					path: this.path,
					from: legacy,
					to: canonical,
				});
			}
			delete file.credentials[legacy];
		}
		return file;
	}

	/** Atomic write: tmp+rename, mode 0600 (§5.5). */
	private async persist(file: StoreFile): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
		const tmp = `${this.path}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
		await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
		await rename(tmp, this.path);
		this.log.debug("credential store persisted", { path: this.path });
	}

	/** In-process serialization per provider (on top of the cross-process lockfile). */
	private enqueue<T>(providerId: string, task: () => Promise<T>): Promise<T> {
		const previous = this.chains.get(providerId) ?? Promise.resolve();
		const queued = (async () => {
			await previous.catch(() => {});
			return task();
		})();
		const tail = queued.catch(() => {});
		this.chains.set(providerId, tail);
		void tail.then(() => {
			if (this.chains.get(providerId) === tail) this.chains.delete(providerId);
		});
		return queued;
	}

	private withLock<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
		return withFileLock(this.lockPath, fn, {
			timeoutMs: this.lockTimeoutMs,
			staleMs: this.lockStaleMs,
			signal,
			now: this.now,
			log: this.log,
		});
	}

	private materialize(provider: AuthProviderId, stored: StoredCredential): Credential {
		return { ...stored, provider, source: { kind: "vanrel-store", path: this.path } };
	}

	/** Gateway-native read. */
	async readGateway(provider: AuthProviderId): Promise<Credential | undefined> {
		const stored = (await this.load()).credentials[provider];
		if (stored === undefined) return undefined;
		if (!isValidStored(stored)) {
			this.log.warn("credential store entry invalid, skipping", { path: this.path, provider });
			return undefined;
		}
		return this.materialize(provider, stored);
	}

	/**
	 * Gateway-native serialized modify — the §5.7 PRIMITIVE: lockfile → fresh read → fn →
	 * persist (tmp+rename) → unlock. `signal` cancels only the lock wait; a started
	 * fn (HTTP refresh) does not release the lock on signal — the rotated token is not lost.
	 */
	modifyGateway(
		provider: AuthProviderId,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.enqueue(provider, () =>
			this.withLock(options?.signal, async () => {
				const file = await this.load();
				const raw = file.credentials[provider];
				const current = raw !== undefined && isValidStored(raw) ? this.materialize(provider, raw) : undefined;
				const next = await fn(current);
				if (next !== undefined) {
					const { source: _dropped, ...stored } = next;
					file.credentials[provider] = stored;
					await this.persist(file);
					return next;
				}
				return current;
			}),
		);
	}

	/** pi-ai CredentialStore.read */
	async read(providerId: string, options?: AuthOperationOptions): Promise<OAuthCredential | undefined> {
		options?.signal?.throwIfAborted();
		const cred = await this.readGateway(providerId as AuthProviderId);
		return cred ? toPiAi(cred) : undefined;
	}

	/** pi-ai CredentialStore.list */
	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		options?.signal?.throwIfAborted();
		const file = await this.load();
		return Object.entries(file.credentials)
			.filter(([, entry]) => isValidStored(entry))
			.map(([providerId]) => ({ providerId, type: "oauth" as const }));
	}

	/** pi-ai CredentialStore.modify — the only write path of the pi-ai protocol. */
	modify(
		providerId: string,
		fn: (current: OAuthCredential | undefined) => Promise<OAuthCredential | undefined>,
		options?: AuthOperationOptions,
	): Promise<OAuthCredential | undefined> {
		const provider = providerId as AuthProviderId;
		return this.enqueue(providerId, () =>
			this.withLock(options?.signal, async () => {
				const file = await this.load();
				const raw = file.credentials[providerId];
				const current = raw !== undefined && isValidStored(raw) ? this.materialize(provider, raw) : undefined;
				const next = await fn(current ? toPiAi(current) : undefined);
				if (next !== undefined) {
					if (next.type !== "oauth") throw new AuthLockError(`FileCredentialStore: oauth-only, got ${next.type}`);
					const gateway = fromPiAi(provider, next, { kind: "vanrel-store", path: this.path });
					const { source: _dropped, ...stored } = gateway;
					file.credentials[providerId] = stored;
					await this.persist(file);
					return next;
				}
				return current ? toPiAi(current) : undefined;
			}),
		);
	}

	/** pi-ai CredentialStore.delete — serialized with respect to modify. */
	delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		return this.enqueue(providerId, () =>
			this.withLock(options?.signal, async () => {
				const file = await this.load();
				if (file.credentials[providerId] !== undefined) {
					delete file.credentials[providerId];
					await this.persist(file);
					this.log.info("credential deleted", { provider: providerId });
				}
			}),
		);
	}
}
