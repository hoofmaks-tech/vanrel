import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { AuthFlowError, type AuthProvider, GATEWAY_NOOP_LOGGER, type SubscriptionCredential } from "@vanrel/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EXIT_AUTH, EXIT_ERROR, EXIT_OK, EXIT_SIGINT } from "../src/args.ts";
import { loginCommand } from "../src/login.ts";
import { type VanrelPaths, vanrelPaths } from "../src/paths.ts";
import type { CliIo } from "../src/run.ts";

let dir: string;
let paths: VanrelPaths;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "vanrel-cli-login-"));
	paths = vanrelPaths({ VANREL_HOME: dir });
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

function fakeIo(stdinText: string): { io: CliIo; stdout: () => string; stderr: () => string } {
	let out = "";
	let err = "";
	const stdin = Readable.from([stdinText]) as unknown as NodeJS.ReadStream;
	const stdout = new Writable({
		write(chunk, _enc, cb) {
			out += String(chunk);
			cb();
		},
	}) as unknown as NodeJS.WriteStream;
	const stderr = new Writable({
		write(chunk, _enc, cb) {
			err += String(chunk);
			cb();
		},
	}) as unknown as NodeJS.WriteStream;
	return { io: { stdin, stdout, stderr }, stdout: () => out, stderr: () => err };
}

const fakeCred: SubscriptionCredential = {
	provider: "codex",
	type: "oauth",
	accessToken: "at",
	refreshToken: "rt",
	expiresAt: 1_900_000_000_000,
	source: { kind: "login-flow" },
};

function fakeProvider(login: NonNullable<AuthProvider["login"]>, supportsPasteCode = true): AuthProvider {
	return {
		id: "codex",
		supportsPasteCode,
		discover: async () => null,
		refresh: async (cred) => cred,
		needsRefresh: () => false,
		toRequestAuth: () => ({ headers: {}, baseUrl: "https://example.test" }),
		login,
	};
}

describe("loginCommand --paste-code (recon §5 item 6)", () => {
	it("exit 0: URL printed, code read from stdin, persisted line", async () => {
		const seen: string[] = [];
		const provider = fakeProvider(async (options) => {
			expect(options?.flow).toBe("paste-code");
			expect(options?.promptCode).toBeTypeOf("function");
			options?.onAuthUrl?.("https://example.test/auth?x=1");
			const input = await options!.promptCode!(
				{ message: "copy the code from the page", placeholder: "code#state" },
				options!.signal ?? new AbortController().signal,
			);
			seen.push(input);
			return fakeCred;
		});
		const { io, stdout } = fakeIo("mycode#mystate\n");
		const code = await loginCommand("codex", paths, io, GATEWAY_NOOP_LOGGER, {
			pasteCode: true,
			providers: [provider],
		});
		expect(code).toBe(EXIT_OK);
		expect(stdout()).toContain("https://example.test/auth?x=1");
		expect(stdout()).toContain("copy the code from the page");
		expect(stdout()).toContain("codex authenticated");
		expect(seen).toEqual(["mycode#mystate"]);
	});

	it("loopback mode: --paste-code hint, no old wording about missing paste-code", async () => {
		const provider = fakeProvider(async (options) => {
			expect(options?.flow).toBeUndefined();
			expect(options?.promptCode).toBeUndefined();
			options?.onAuthUrl?.("https://example.test/loopback");
			return fakeCred;
		});
		const { io, stdout } = fakeIo("");
		const code = await loginCommand("codex", paths, io, GATEWAY_NOOP_LOGGER, { providers: [provider] });
		expect(code).toBe(EXIT_OK);
		expect(stdout()).toContain("vanrel login codex --paste-code");
		expect(stdout()).not.toContain("no paste-code path");
	});

	it("provider without supportsPasteCode → EXIT_ERROR", async () => {
		const provider = fakeProvider(async () => fakeCred, false);
		const { io, stderr } = fakeIo("");
		const code = await loginCommand("codex", paths, io, GATEWAY_NOOP_LOGGER, {
			pasteCode: true,
			providers: [provider],
		});
		expect(code).toBe(EXIT_ERROR);
		expect(stderr()).toContain("no paste-code login flow");
	});

	it("AuthFlowError(exchange-failure) → exit 2", async () => {
		const provider = fakeProvider(async () => {
			throw new AuthFlowError("codex", "exchange-failure", "codex exchange failed (400)");
		});
		const { io, stderr } = fakeIo("");
		const code = await loginCommand("codex", paths, io, GATEWAY_NOOP_LOGGER, {
			pasteCode: true,
			providers: [provider],
		});
		expect(code).toBe(EXIT_AUTH);
		expect(stderr()).toContain("[auth-flow]");
		expect(stderr()).toContain("codex exchange failed (400)");
	});

	it("SIGINT → exit 130", async () => {
		const listeners = process.listeners("SIGINT");
		process.removeAllListeners("SIGINT");
		try {
			const provider = fakeProvider((options) => {
				process.emit("SIGINT"); // after the listener is registered in loginCommand
				return new Promise<SubscriptionCredential>((_resolve, reject) => {
					const cancel = () => reject(new AuthFlowError("codex", "user-cancel", "codex login cancelled"));
					if (options?.signal?.aborted) return cancel();
					options?.signal?.addEventListener("abort", cancel);
				});
			});
			const { io, stderr } = fakeIo("");
			const code = await loginCommand("codex", paths, io, GATEWAY_NOOP_LOGGER, {
				pasteCode: true,
				providers: [provider],
			});
			expect(code).toBe(EXIT_SIGINT);
			expect(stderr()).toContain("interrupted");
		} finally {
			for (const listener of listeners) process.on("SIGINT", listener);
		}
	});
});
