/**
 * Parser for the CLI contract §4.6: interactive by default; --print one-shot; --session resume;
 * login <provider>; auth status; --no-splash/--provider/--model flags. Exit codes 0/1/2/3/130.
 */
import { AUTH_PROVIDER_IDS, type AuthProviderId } from "@vanrel/ai";

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_AUTH = 2;
export const EXIT_BUDGET = 3;
export const EXIT_SIGINT = 130;

export type CliCommand =
	| {
			kind: "run";
			print?: string;
			sessionId?: string;
			noSplash: boolean;
			provider?: AuthProviderId;
			model?: string;
	  }
	| { kind: "login"; provider: AuthProviderId; pasteCode: boolean }
	| { kind: "auth-status" }
	| { kind: "help" };

/** Argument parse error → usage to stderr + EXIT_ERROR (§4.6). */
export class ArgsError extends Error {
	readonly kind = "args";
	constructor(message: string) {
		super(message);
		this.name = "ArgsError";
	}
}

export const USAGE = `vanrel — terminal AI harness (subscription OAuth only)

Usage:
  vanrel                      interactive session (splash in TTY)
  vanrel --print "<prompt>"   one-shot, answer to stdout (-p)
  vanrel --session <id>       resume session ~/.vanrel/sessions/<id>.jsonl
  vanrel login <provider>     OAuth login: ${AUTH_PROVIDER_IDS.join("|")} (--paste-code: manual code entry, headless/SSH)
  vanrel auth status          provider credentials/quota table

Flags:
  --no-splash        suppress splash
  --provider <id>    pin routing to one provider (${AUTH_PROVIDER_IDS.join("|")})
  --model <id>       model alias ("default"|"cheap") or explicit catalog id
  --help, -h         this help

Exit codes: 0 ok | 1 error | 2 auth | 3 budget | 130 SIGINT
`;

function isAuthProviderId(value: string): value is AuthProviderId {
	return (AUTH_PROVIDER_IDS as readonly string[]).includes(value);
}

function readFlagValue(argv: readonly string[], index: number, flag: string, inline: string | undefined): string {
	if (inline !== undefined) {
		if (inline === "") throw new ArgsError(`${flag} requires a non-empty value`);
		return inline;
	}
	const next = argv[index + 1];
	if (next === undefined || (next.startsWith("-") && next !== "-")) throw new ArgsError(`${flag} requires a value`);
	return next;
}

export function parseArgs(argv: readonly string[]): CliCommand {
	const positional: string[] = [];
	let print: string | undefined;
	let sessionId: string | undefined;
	let noSplash = false;
	let provider: AuthProviderId | undefined;
	let model: string | undefined;
	let pasteCode = false;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		const [flag, ...rest] = arg.split("=");
		const inline = rest.length > 0 ? rest.join("=") : undefined;
		switch (flag) {
			case "--help":
			case "-h":
				return { kind: "help" };
			case "--no-splash":
				if (inline !== undefined) throw new ArgsError("--no-splash takes no value");
				noSplash = true;
				break;
			case "--print":
			case "-p":
				print = readFlagValue(argv, i, flag, inline);
				if (inline === undefined) i++;
				break;
			case "--session":
				sessionId = readFlagValue(argv, i, flag, inline);
				if (inline === undefined) i++;
				break;
			case "--provider": {
				const value = readFlagValue(argv, i, flag, inline);
				if (!isAuthProviderId(value))
					throw new ArgsError(`unknown provider "${value}" (expected ${AUTH_PROVIDER_IDS.join("|")})`);
				provider = value;
				if (inline === undefined) i++;
				break;
			}
			case "--model":
				model = readFlagValue(argv, i, flag, inline);
				if (inline === undefined) i++;
				break;
			case "--paste-code":
				if (inline !== undefined) throw new ArgsError("--paste-code takes no value");
				pasteCode = true;
				break;
			default:
				if (arg.startsWith("-")) throw new ArgsError(`unknown flag: ${arg}`);
				positional.push(arg);
		}
	}

	if (positional.length === 0) return { kind: "run", print, sessionId, noSplash, provider, model };

	if (positional[0] === "login") {
		if (positional.length !== 2) throw new ArgsError("login requires exactly one provider id");
		const value = positional[1]!;
		if (!isAuthProviderId(value))
			throw new ArgsError(`unknown provider "${value}" (expected ${AUTH_PROVIDER_IDS.join("|")})`);
		return { kind: "login", provider: value, pasteCode };
	}
	if (positional[0] === "auth") {
		if (positional.length === 2 && positional[1] === "status") return { kind: "auth-status" };
		throw new ArgsError('auth supports only the "status" subcommand');
	}
	throw new ArgsError(`unexpected argument: ${positional[0]} (prompt goes to --print)`);
}
