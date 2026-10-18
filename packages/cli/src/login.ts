/**
 * `vanrel login <provider> [--paste-code]` (§4.6): interactive OAuth flow
 * AuthProvider.login (§4.2.1), persisted inside the gateway via FileCredentialStore (§5.5).
 * onAuthUrl → print the URL. --paste-code: manual code entry via readline on io.stdin
 * (headless/SSH; re-prompt up to 3 times without network — inside runManualCodeLogin).
 * AuthFlowError/AuthLockError → exit 2; SIGINT → 130; success → 0.
 */
import * as readline from "node:readline/promises";
import { AuthFlowError, AuthLockError, type AuthProvider, type AuthProviderId, builtinAuthProviders } from "@vanrel/ai";
import type { Logger } from "@vanrel/telemetry";
import { EXIT_AUTH, EXIT_ERROR, EXIT_OK, EXIT_SIGINT } from "./args.ts";
import type { VanrelPaths } from "./paths.ts";
import type { CliIo } from "./run.ts";

export interface LoginCommandOptions {
	/** true → "paste-code" flow (manual code entry); default loopback. */
	pasteCode?: boolean;
	/** Injection for tests; default builtinAuthProviders({ storePath: paths.authFile }). */
	providers?: AuthProvider[];
}

/** readline code prompt on io.stdin; aborted by signal (recon §4.5 item 2). */
async function promptForCode(
	io: CliIo,
	prompt: { message: string; placeholder?: string },
	signal: AbortSignal,
): Promise<string> {
	io.stdout.write(`${prompt.message}\n`);
	const rl = readline.createInterface({ input: io.stdin, output: io.stdout, terminal: io.stdin.isTTY === true });
	try {
		const query = prompt.placeholder ? `Paste code (${prompt.placeholder}): ` : "Paste code: ";
		return await rl.question(query, { signal });
	} finally {
		rl.close();
	}
}

export async function loginCommand(
	providerId: AuthProviderId,
	paths: VanrelPaths,
	io: CliIo,
	log: Logger,
	options?: LoginCommandOptions,
): Promise<number> {
	const providers = options?.providers ?? builtinAuthProviders({ storePath: paths.authFile, log });
	const provider = providers.find((p) => p.id === providerId);
	if (!provider?.login) {
		io.stderr.write(`vanrel: provider ${providerId} has no interactive login flow\n`);
		return EXIT_ERROR;
	}
	const pasteCode = options?.pasteCode === true;
	if (pasteCode && !provider.supportsPasteCode) {
		io.stderr.write(`vanrel: provider ${providerId} has no paste-code login flow\n`);
		return EXIT_ERROR;
	}
	const abort = new AbortController();
	const onSigint = () => abort.abort();
	process.on("SIGINT", onSigint);
	try {
		io.stdout.write(`vanrel login ${providerId}: starting OAuth flow…\n`);
		const cred = await provider.login({
			signal: abort.signal,
			flow: pasteCode ? "paste-code" : undefined,
			promptCode: pasteCode ? (prompt, signal) => promptForCode(io, prompt, signal) : undefined,
			onAuthUrl: (url) => {
				if (pasteCode) {
					io.stdout.write(`Open this URL in a browser:\n${url}\n\n`);
				} else {
					io.stdout.write(
						`Open this URL in a browser to authenticate:\n${url}\n\n` +
							"Waiting for the browser callback on the local redirect port.\n" +
							`(Headless/SSH: vanrel login ${providerId} --paste-code)\n`,
					);
				}
			},
		});
		log.info("login succeeded", {
			provider: providerId,
			expiresAt: cred.expiresAt,
			flow: pasteCode ? "paste-code" : "loopback",
		});
		io.stdout.write(
			`vanrel: ${providerId} authenticated (expires ${new Date(cred.expiresAt).toISOString()}), stored in ${paths.authFile}\n`,
		);
		return EXIT_OK;
	} catch (error) {
		if (abort.signal.aborted) {
			io.stderr.write("vanrel: login interrupted (SIGINT)\n");
			return EXIT_SIGINT;
		}
		if (error instanceof AuthFlowError || error instanceof AuthLockError) {
			io.stderr.write(`vanrel: login failed [${error.kind}] ${error.message}\n`);
			return EXIT_AUTH;
		}
		const message = error instanceof Error ? error.message : String(error);
		log.error("login failed", { provider: providerId, error: message });
		io.stderr.write(`vanrel: login failed: ${message}\n`);
		return EXIT_ERROR;
	} finally {
		process.removeListener("SIGINT", onSigint);
	}
}
