/**
 * `vanrel auth status` (§4.6): provider table — credential source, expiresAt,
 * blockedUntil from QuotaLedger.peek, skipped reasons (ResolvedAuth.skipped, I5).
 * Exit 0 if at least one provider is available, otherwise 2 (all unavailable).
 */
import { AUTH_PROVIDER_IDS, QuotaLedger, resolveAuth } from "@vanrel/ai";
import type { Logger } from "@vanrel/telemetry";
import { EXIT_AUTH, EXIT_OK } from "./args.ts";
import type { CliConfig } from "./config.ts";
import type { VanrelPaths } from "./paths.ts";
import type { CliIo } from "./run.ts";

function fmtTs(ts: number | null | undefined, now: number): string {
	if (ts == null) return "-";
	const iso = new Date(ts).toISOString();
	return ts < now ? `${iso} (expired)` : iso;
}

function row(cells: string[], widths: number[]): string {
	return cells
		.map((cell, i) => cell.padEnd(widths[i] ?? 0))
		.join(" ")
		.trimEnd();
}

export async function authStatusCommand(
	paths: VanrelPaths,
	config: CliConfig,
	io: CliIo,
	log: Logger,
): Promise<number> {
	const auth = await resolveAuth({ storePath: paths.authFile, preferred: config.preferred, log });
	const quota = new QuotaLedger({ filePath: paths.quotaFile, log });
	await quota.load();
	const states = new Map(quota.peek().map((s) => [s.provider, s]));
	const now = Date.now();

	const header = ["provider", "credential", "source", "expiresAt", "blockedUntil", "window(req,in,out)"];
	const rows: string[][] = [];
	for (const id of AUTH_PROVIDER_IDS) {
		const cred = auth.byProvider.get(id);
		const state = states.get(id);
		const window = state ? `${state.window.requests},${state.window.inputTokens},${state.window.outputTokens}` : "-";
		if (cred) {
			const source =
				cred.source.kind === "env"
					? `env:${cred.source.name}`
					: `${cred.source.kind}${"path" in cred.source ? ` ${cred.source.path}` : ""}`;
			rows.push([id, "ok", source, fmtTs(cred.expiresAt, now), fmtTs(state?.blockedUntil, now), window]);
		} else {
			rows.push([id, "none", "-", "-", fmtTs(state?.blockedUntil, now), window]);
		}
	}
	const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
	io.stdout.write(`${row(header, widths)}\n`);
	for (const r of rows) io.stdout.write(`${row(r, widths)}\n`);
	for (const skipped of auth.skipped) io.stdout.write(`skipped: ${skipped.provider}: ${skipped.reason}\n`);

	const available = auth.byProvider.size;
	io.stdout.write(
		available > 0
			? `${available}/${AUTH_PROVIDER_IDS.length} providers available\n`
			: "no providers available — run `vanrel login <anthropic|agy|codex>`\n",
	);
	return available > 0 ? EXIT_OK : EXIT_AUTH;
}
