/**
 * QuotaLedger — an observable model of subscription quotas (§4.2.3): usage
 * events + exhaustion facts (429) + an optional probe. Limits are not public
 * (§8 R-5) → the model is built from observations, not configuration.
 * File ~/.vanrel/quota.json: {v:1, records, exhaustion, probes}, tmp+rename, 0600.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Logger } from "@vanrel/telemetry";
import type {
	AuthProviderId,
	ProviderQuotaState,
	QuotaLedgerOptions,
	UsageProbe,
	UsageRecord,
} from "./gateway-types.ts";
import { AUTH_PROVIDER_IDS, GATEWAY_NOOP_LOGGER } from "./gateway-types.ts";

const DEFAULT_WINDOW_MS = 5 * 3600_000;
const DEFAULT_RETAIN_MS = 7 * 24 * 3600_000;
const DEFAULT_CONSERVATIVE_BLOCK_MS = 15 * 60_000; // unknown blockedUntil → now + 15 min
const PERSIST_DEBOUNCE_MS = 500;

interface QuotaFile {
	v: 1;
	records: UsageRecord[];
	exhaustion: Partial<Record<AuthProviderId, number>>;
	probes: Partial<Record<AuthProviderId, UsageProbe>>;
}

function isRecord(r: UsageRecord): boolean {
	return (
		typeof r === "object" &&
		r !== null &&
		typeof r.ts === "number" &&
		typeof r.provider === "string" &&
		typeof r.model === "string" &&
		typeof r.inputTokens === "number" &&
		typeof r.outputTokens === "number"
	);
}

export class QuotaLedger {
	private readonly filePath: string;
	private readonly windowMs: number;
	private readonly retainMs: number;
	private readonly now: () => number;
	private readonly log: Logger;
	private records: UsageRecord[] = [];
	private exhaustion: Partial<Record<AuthProviderId, number>> = {};
	private probes: Partial<Record<AuthProviderId, UsageProbe>> = {};
	private dirty = false;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private persistChain: Promise<void> = Promise.resolve();

	constructor(options?: QuotaLedgerOptions) {
		this.filePath = options?.filePath ?? join(homedir(), ".vanrel", "quota.json");
		this.windowMs = options?.windowMs ?? DEFAULT_WINDOW_MS;
		this.retainMs = options?.retainMs ?? DEFAULT_RETAIN_MS;
		this.now = options?.now ?? Date.now;
		this.log = options?.log ?? GATEWAY_NOOP_LOGGER;
	}

	/** Reads filePath (missing/corrupt file → empty + WARN), prunes records older than retainMs. */
	async load(): Promise<void> {
		let raw: string;
		try {
			raw = await readFile(this.filePath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				this.log.warn("quota ledger unreadable, starting empty", { filePath: this.filePath, error: String(error) });
			}
			return;
		}
		try {
			const parsed = JSON.parse(raw) as QuotaFile;
			this.records = Array.isArray(parsed.records) ? parsed.records.filter(isRecord) : [];
			this.exhaustion = typeof parsed.exhaustion === "object" && parsed.exhaustion !== null ? parsed.exhaustion : {};
			this.probes = typeof parsed.probes === "object" && parsed.probes !== null ? parsed.probes : {};
		} catch (error) {
			this.log.warn("quota ledger corrupt, starting empty", { filePath: this.filePath, error: String(error) });
			this.records = [];
			this.exhaustion = {};
			this.probes = {};
		}
		this.prune();
	}

	/** prune: records/probes older than retainMs, expired blockedUntil. */
	private prune(): void {
		const cutoff = this.now() - this.retainMs;
		this.records = this.records.filter((r) => r.ts >= cutoff);
		for (const p of AUTH_PROVIDER_IDS) {
			if (this.probes[p] !== undefined && (this.probes[p]?.ts ?? 0) < cutoff) delete this.probes[p];
			const blocked = this.exhaustion[p];
			if (blocked !== undefined && blocked <= this.now()) delete this.exhaustion[p];
		}
	}

	private schedulePersist(): void {
		this.dirty = true;
		if (this.timer !== null) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			void this.persistNow().catch((error: unknown) => {
				this.log.error("quota ledger persist failed", { filePath: this.filePath, error: String(error) });
			});
		}, PERSIST_DEBOUNCE_MS);
		this.timer.unref?.();
	}

	/** Atomic write tmp+rename 0600; serialized via persistChain (debounce + flush). */
	private async persistNow(): Promise<void> {
		if (!this.dirty) return;
		this.dirty = false;
		const snapshot: QuotaFile = { v: 1, records: this.records, exhaustion: this.exhaustion, probes: this.probes };
		this.persistChain = this.persistChain.then(async () => {
			await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
			const tmp = `${this.filePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
			await writeFile(tmp, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
			await rename(tmp, this.filePath);
		});
		await this.persistChain;
	}

	/** append + debounced persist (500ms). */
	async record(rec: UsageRecord): Promise<void> {
		this.records.push(rec);
		this.prune();
		this.schedulePersist();
	}

	/** Quota exhaustion fact; unknown blockedUntil → conservatively now + 15 min. */
	async recordExhaustion(provider: AuthProviderId, blockedUntil: number | null): Promise<void> {
		const until = blockedUntil ?? this.now() + DEFAULT_CONSERVATIVE_BLOCK_MS;
		this.exhaustion[provider] = until;
		this.log.warn("provider quota exhausted", { provider, blockedUntil: until });
		this.schedulePersist();
	}

	/** UsageProbe: all fields optional (§8 R-5); unparsed data never reaches this point. */
	async recordProbe(provider: AuthProviderId, probe: UsageProbe): Promise<void> {
		this.probes[provider] = probe;
		this.schedulePersist();
	}

	/** blockedUntil: max( exhaustion, probe-derived block at utilization >= 1 ). */
	private computeBlockedUntil(provider: AuthProviderId): number | null {
		const now = this.now();
		let blocked: number | null = null;
		const explicit = this.exhaustion[provider];
		if (explicit !== undefined && explicit > now) blocked = explicit;
		const probe = this.probes[provider];
		if (probe) {
			if (
				(probe.fiveHourUtilization ?? 0) >= 1 &&
				typeof probe.fiveHourResetsAt === "number" &&
				probe.fiveHourResetsAt > now
			) {
				blocked = blocked === null ? probe.fiveHourResetsAt : Math.max(blocked, probe.fiveHourResetsAt);
			}
			if (
				(probe.weeklyUtilization ?? 0) >= 1 &&
				typeof probe.weeklyResetsAt === "number" &&
				probe.weeklyResetsAt > now
			) {
				blocked = blocked === null ? probe.weeklyResetsAt : Math.max(blocked, probe.weeklyResetsAt);
			}
		}
		return blocked;
	}

	private stateFor(provider: AuthProviderId): ProviderQuotaState {
		const start = this.now() - this.windowMs;
		let requests = 0;
		let inputTokens = 0;
		let outputTokens = 0;
		for (const r of this.records) {
			if (r.provider !== provider || r.ts < start) continue;
			requests++;
			inputTokens += r.inputTokens;
			outputTokens += r.outputTokens;
		}
		const state: ProviderQuotaState = {
			provider,
			window: { start, requests, inputTokens, outputTokens },
			blockedUntil: this.computeBlockedUntil(provider),
		};
		const probe = this.probes[provider];
		if (probe) state.lastProbe = probe;
		return state;
	}

	/** Synchronous snapshot (the ledger is kept in memory after load). */
	peek(provider?: AuthProviderId): ProviderQuotaState[] {
		if (provider !== undefined) return [this.stateFor(provider)];
		const seen = new Set<AuthProviderId>();
		for (const r of this.records) seen.add(r.provider);
		for (const p of AUTH_PROVIDER_IDS) {
			if (this.exhaustion[p] !== undefined || this.probes[p] !== undefined) seen.add(p);
		}
		return [...seen].map((p) => this.stateFor(p));
	}

	/** now >= blockedUntil (or null). The router's only hard criterion (§4.2.3). */
	available(provider: AuthProviderId): boolean {
		const blocked = this.computeBlockedUntil(provider);
		return blocked === null || this.now() >= blocked;
	}

	/** Cancels the debounce timer, writes immediately (if dirty). */
	async flush(): Promise<void> {
		if (this.timer !== null) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		await this.persistNow();
	}
}
