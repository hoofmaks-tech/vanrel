<p align="center"><strong>vanrel</strong> is a terminal AI harness that runs on subscriptions you already pay for — Claude Code, Antigravity (Google), and Codex (ChatGPT). No API keys.</p>

---

## Quickstart

Requires Node.js 22+.

```sh
npm install -g vanrel
vanrel
```

To build from source instead:

```sh
git clone https://github.com/shleder/vanrel.git
cd vanrel
npm ci --legacy-peer-deps
npm run build
node packages/cli/dist/main.js --help
```

## Sign in

vanrel logs in with the same OAuth flow as the official CLIs:

```sh
vanrel login anthropic   # Claude Code subscription
vanrel login agy         # Antigravity / Google
vanrel login codex       # ChatGPT
```

On a headless machine, add `--paste-code`. Credentials from `~/.claude`, `~/.codex`, and `~/.gemini` are picked up read-only if present. `vanrel auth status` shows what was found and why anything was skipped.

## Usage

```sh
vanrel                       # interactive TUI
vanrel --print "fix the failing test"
vanrel --session <id>        # resume a session
```

Inside the TUI: `/model`, `/settings`, `/compact`, `/resume`, `/export`, `/hotkeys`; `!cmd` runs a shell command. Sessions are append-only JSONL in `~/.vanrel/sessions`; every request and response lands in a flight-recorder trace under `~/.vanrel/traces`.

Config lives in `~/.vanrel/config.json`: provider order, model aliases (`default`, `cheap`), QC gates, MCP servers.

## What the harness adds

- Failover across providers. A request that hits a quota error moves to the next provider with a live subscription.
- Context budgeting. Tool output is filtered to 6–8 KB per call, old tool results are elided to disk with a pointer, and an LLM summary runs only when that alone doesn't fit. On the reference workload this sends 11.35× fewer tokens than passing everything through (`packages/context/fixtures/report.json`).
- QC gates. With `qc.enabled`, file edits go to a shadow worktree and reach your repo only when `tsc` and `biome` pass.
- MCP. stdio and streamable-HTTP servers from config; a server that fails to start warns and the session goes on without it.

## Development

```sh
npm test     # 243 tests, no network
npm run check
```

## License

MIT. Includes code vendored from [earendil-works/pi](https://github.com/earendil-works/pi) (MIT, © 2025 Mario Zechner). See [NOTICE](NOTICE).
