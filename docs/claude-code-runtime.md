# Claude Code Runtime

How the `personal-assistant-claude` container runs Claude Code, what the entrypoint actually does, and the workarounds for the upstream bugs we hit. Read this before modifying [`claude-code/entrypoint.sh`](../claude-code/entrypoint.sh) — there is non-obvious history baked into it.

## Why tmux

Claude Code has two modes: interactive (TUI) and `-p` (single-shot, headless). We need interactive mode because:

- `--dangerously-load-development-channels` — the flag we use to load our stdio channel servers (`email-watcher`, `gdrive-watcher`, `telegram`, `workflow`) — only works in interactive mode. `-p` mode does not load development channels.
- Channels need bidirectional communication: the workflow channel pushes events INTO the session, the session reads them and dispatches subagents.

So we run `claude` inside a long-lived `tmux` session inside the container. The entrypoint orchestrates startup and the container's main process is a monitor loop that exits when tmux dies (triggering Docker's `restart: unless-stopped`).

Operators attach via `docker exec -it personal-assistant-claude tmux attach -t claude`. The session can also be driven from outside via `tmux send-keys` (which is how the entrypoint reconnects HTTP MCPs — see below).

## Entrypoint phases

[`claude-code/entrypoint.sh`](../claude-code/entrypoint.sh) runs these phases in order. Each phase has a defined success condition and timeout.

| # | Phase | Success condition | Timeout / behaviour |
|---|---|---|---|
| 1 | **Startup wait** | Pane contains `Listening for channel messages` | 60s. On timeout, log warning and continue. |
| 2 | **Dismiss extra prompts** | No more `new MCP server` / `trust` / `continue` prompts in pane | 10s sliding window. Sends Enter on detection. |
| 3 | **Verify stdio channels** | All 5 channel processes (`bun run *.ts`) visible in `pgrep` | Up to 60s of retries. On failure, **kills tmux to trigger container restart** — this is task 41 self-healing. |
| 4 | **Settle wait** | Fixed sleep | 25s. Empirically, the HTTP MCP layer needs this time to fully initialize before reconnect actions take effect. Without it, `reconnect_mcp` races with Claude's background init and silently fails. |
| 5 | **HTTP MCP reconnect** | Each HTTP MCP shows `Reconnected to <name>` in chat | See next section. |
| 6 | **Monitor loop** | Polls tmux every 10s; auto-dismisses rate-limit prompt | Exits with code 1 if tmux dies → container restart. |

## HTTP MCP reconnect workaround

### The bug

Claude Code v2.1.92 marks all HTTP MCP servers (`type: "http"` in `.mcp.json`) as `✘ failed` at startup, even when the upstream servers are healthy and unauthenticated. The `/mcp` UI's "Reconnect" button fixes them, but there is no CLI command for this.

Tracked upstream as [anthropics/claude-code#34008](https://github.com/anthropics/claude-code/issues/34008). Open with no fix in any released version. Related: [#39271](https://github.com/anthropics/claude-code/issues/39271) (regression since 2.1.83), [#27142](https://github.com/anthropics/claude-code/issues/27142) (cached MCP session IDs), [#1026](https://github.com/anthropics/claude-code/issues/1026) (no `claude mcp reconnect` CLI).

### The workaround

`reconnect_mcp` in [`entrypoint.sh`](../claude-code/entrypoint.sh) drives the `/mcp` TUI via `tmux send-keys`. For each of the 4 HTTP MCPs (`checker`, `gmail`, `outlook`, `paperless`) it:

1. Opens `/mcp` and captures the pane.
2. Parses the target server's current state from the line ` <name> · <state>`.
3. **Skips if already `✔ connected`.** No action, no key presses.
4. If `◯ disabled`, the action is `Enable`. Otherwise `Reconnect`.
5. Computes Down/Up presses from the captured menu cursor line (`❯`) to the target server line. **No hardcoded offsets** — adapts to menu reordering, addition/removal of servers, and a non-zero starting cursor position.
6. Opens the server detail menu, captures it, finds the option number for the target action via `grep -oE "[1-9]\.\s+${action}\b"`. The `\b` word boundary prevents `Authenticate` from matching `Re-authenticate`.
7. Navigates the detail-menu cursor and presses Enter.
8. Polls the chat output for `Reconnected to <name>` or `Failed to reconnect to <name>` for up to 8 seconds.

The function is structurally robust to whatever menu layout Claude Code currently shows: standard 3-option (`Authenticate / Reconnect / Disable`), 5-option OAuth-decorated (`View tools / Re-authenticate / Clear authentication / Reconnect / Disable`), 2-option disabled-state (`Enable / Authenticate`), etc.

### Gotchas (lessons paid for in a long debugging session)

- **`Esc-Esc` is Claude Code's Rewind dialog shortcut**, not "double-escape menu close". Two close-together Escapes pop a "Rewind" dialog that hijacks subsequent input — every following `tmux send-keys '/mcp'` gets typed into the dialog instead of executing as a slash command. Use a single Escape and a longer sleep.

- **`grep -n "❯"` matches the chat prompt indicator first, not the menu cursor.** The pane has `❯ /mcp` in the chat history (the prompt prefix) AND `❯ checker · ✘ failed` in the open menu. Both contain `❯`. A naive grep returns the chat-prompt line, gives a wildly wrong cursor reference, and the resulting `Down N` navigation lands somewhere arbitrary. The fix: require the `·` separator in the regex (`❯.*·`) — only menu cursor lines have it, never chat prompts.

- **Re-opening `/mcp` during action verification disrupts the in-flight reconnect.** The original verification strategy (re-open the menu, parse the server state) seems to interfere with Claude Code's action processing — the server stays in `failed` state. Verify by polling the chat for `Reconnected to <name>` instead. The chat is updated when the action completes; reading it doesn't disturb anything.

- **The `/register` OAuth stub is a dead end. Don't repeat the experiment.** Returning RFC 7591 `400 invalid_client_metadata` from the MCP servers on `POST /register` *does* suppress the SDK's `parseErrorResponse` JSON-parse exception — but the consequence is *worse*, not better. Claude Code interprets the clean OAuth error as "server supports OAuth, client isn't authenticated", and the detail menu collapses to `1. Authenticate / 2. Disable` with **no Reconnect option at all**. Pre-stub, Reconnect is at least available (in the OAuth-decorated 5-option menu or the standard 3-option menu) and the entrypoint script can navigate to it. The experiment was tried and reverted — search git log for `RFC 7591` if you want the full history.

- **The 25s settle wait is load-bearing.** Removing it makes `reconnect_mcp` race with Claude's background HTTP MCP init and fail silently. Don't shorten it without empirical justification.

- **Stdio channels are different from HTTP MCPs.** They live in the same `.mcp.json` but use `command: bun` instead of `type: http`, run as subprocesses of Claude Code, and don't have the OAuth probe or the reconnect problem. Phase 3 of the entrypoint verifies them via `pgrep` and triggers a hard container restart if any are missing — that's task 41's self-heal.

## When the entrypoint fails

If a fresh container shows HTTP MCPs as `✘ failed` after startup, in priority order:

1. Check `docker logs personal-assistant-claude` for the `Reconnecting HTTP MCP servers...` block — does it report `✓` or `✗` for each?
2. If `✗`, attach to the tmux session and look at the `/mcp` menu state manually. The menu layout may have changed in a Claude Code update, breaking the regex assumptions in `mcp_parse_state` or the option lookup.
3. Manual fallback: `docker exec -it personal-assistant-claude tmux attach -t claude`, then `/mcp`, navigate to the failed server, press Enter, navigate to Reconnect, press Enter. Five seconds of operator time per server.
4. If the manual fallback doesn't work either, the issue is upstream (Claude Code can't talk to the MCP server at all) — check the MCP server's container health, network, env vars.

## References

- [`claude-code/entrypoint.sh`](../claude-code/entrypoint.sh) — the script
- [`claude-code/.mcp.json`](../claude-code/.mcp.json) — the MCP server config
- [anthropics/claude-code#34008](https://github.com/anthropics/claude-code/issues/34008) — root upstream bug
- [anthropics/claude-code#27142](https://github.com/anthropics/claude-code/issues/27142) — MCP session ID caching
- [anthropics/claude-code#1026](https://github.com/anthropics/claude-code/issues/1026) — request for `claude mcp reconnect` CLI

## Reference: auth, settings and flags

### Authentication

- **Claude**: `docker exec -it personal-assistant-claude claude auth login` (one-time)
- **Gmail**: trigger `start_google_auth` from the Claude session; the `gmail-mcp-auth`
  sidecar passes the callback through and protects `/mcp*` with a bearer token
- **Outlook**: restart the container and read the device code from
  `docker logs personal-assistant-outlook-mcp 2>&1 | grep -A3 "OUTLOOK AUTH"`
- **Telegram**: DM the bot; `access.json` in the volume handles pairing
- Tokens persist in `/mnt/shared_configs/<stack>/` or your configured persistent volume
- After auth, restart Claude to reconnect the MCPs:
  `docker restart personal-assistant-claude`

### Settings

`claude-code/.claude/settings.json` is committed with `permissions.allow` and
`permissions.deny`. The permission model is `--permission-mode dontAsk`, which **auto-denies
any tool not in the allowlist**.

- Always available: `Read`, `Glob`, `Grep`, `Agent`, `ToolSearch`
- Allowed via settings: MCP tools (wildcards for our servers, individual for gmail),
  `Bash(sleep *)`, `Edit`/`Write` for the memory dir only
- Denied: gmail write/browse tools, and all file-manipulating Bash commands (`curl`, `rm`,
  `mkdir`, `cp`, `find`, `base64`, `qpdf`, `echo`, `cat`, `env`, `node`) -- file operations
  go through the `file-ops` MCP instead

Design rationale: [README.md#permission-model](../README.md#permission-model).

### A subagent's `tools:` frontmatter decides whether MCP tools are deferred

With this many MCP servers connected, tools are **deferred**: a subagent starts with ~83-106
tool *names* in a `deferred_tools_delta` and must spend a `ToolSearch` turn to load a schema
before it can call anything. **Naming a tool in a subagent's `tools:` frontmatter suppresses
that entirely for that subagent** -- no `deferred_tools_delta` is emitted at all, the tool
ships in the up-front list, and `ToolSearch` never enters its path.

This interacts with `maxTurns` in a way that fails silently. A subagent budgeted
`maxTurns: 2` for "turn 1 fetch, turn 2 answer" needs **three** turns once its tool is
deferred, and gets cut off mid-work: the caller receives the model's opening preamble
("I'll fetch the email...") instead of a result, with no error anywhere.

That is exactly what happened to [`email-classifier.md`](../claude-code/agents/email-classifier.md),
which was written when its Gmail tool was directly callable. It returned a usable
classification in **1 of 21 runs** over seven weeks -- and that one succeeded only because
the caller had pre-pasted the email body, so it made no tool call at all. Its sibling
[`document-classifier.md`](../claude-code/agents/document-classifier.md) was unaffected at
45/45 for the same reason the fix works: it declares `tools: "Read"`.

So, for any subagent that must call a tool:

- **Name every tool it needs in `tools:`.** Name *all* of them -- `tools:` is an allowlist,
  so listing only the Gmail fetch tool would silently strip the Outlook one and break
  `email_source: "outlook"`. The comma-separated form is one string:
  `tools: "mcp__gmail__get_gmail_message_content, mcp__outlook__get_email"`.
- **Budget `maxTurns` above the bare minimum**, so a transient tool error still leaves a turn
  to answer in.
- Keep the prompt's own turn-count wording in step with the frontmatter. The old prompt
  asserted "you have exactly 2 turns: turn 1 is the fetch" -- which had become false, and
  told the model its `ToolSearch` result was a failed turn 1 to retry.

### Flags

```bash
claude \
  --permission-mode dontAsk \                            # auto-deny tools not in allowlist
  --dangerously-load-development-channels server:name \  # load custom channel from .mcp.json
  --mcp-config /workspace/.mcp.json                      # explicit MCP config path
```

- `--dangerously-load-development-channels` has an unskippable TUI prompt; the entrypoint
  polls for it and sends Enter (this replaced an older blind `sleep 5`)
- `--channels plugin:name@marketplace` loads approved channel plugins without a prompt
- `--mcp-config` is needed because `-p` mode does not auto-discover the workspace `.mcp.json`
- `claude remote-control` is a subcommand and does **not** accept `--channels`

#### `--remote-control` is removed from both assistant entrypoints, deliberately

This is a **correction, not stale flag documentation** -- do not "tidy" it away, because
deleting it invites a re-add.

On current clients the flag registered a **new Remote Control session on the account on every
container start**, with nothing reusing or retiring the previous one. `--name` does not
prevent that (it is a display name, not a dedupe key). Channels are **verified to work
without the flag** -- voice answered `/v1/assist` end-to-end with it absent. The earlier
belief that it was required for channels came from a confounded outage (an expired OAuth
token) and is wrong.

If it is ever re-added, note the signature changed: current clients take the name directly
(`--remote-control [name]`), so copying the old line would produce sessions auto-named by
container id.

### LLM routing

Five environment variables on the `claude-code` service control which LLM backend the session
uses. The entrypoint reads all five; leave a variable unset (or empty) to skip it.

| Variable | What it sets | Empty behaviour |
|---|---|---|
| `ANTHROPIC_MODEL` | The session model. The entrypoint also passes it to `claude --model`, because the flag outranks the variable | Falls back to `sonnet` |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | What the `haiku` alias resolves to | Unset; `haiku` resolves as normal |
| `ANTHROPIC_BASE_URL` | The API endpoint Claude Code talks to | Unset; Claude Code talks to Anthropic directly |
| `ANTHROPIC_CUSTOM_HEADERS` | Extra HTTP headers sent with each request, for a gateway that needs one | Unset; no extra headers sent |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | The context-window size Claude Code plans against | Unset; Claude Code uses its own default for the model name |

`ANTHROPIC_CUSTOM_HEADERS` is the one variable of the five quoted in
[`docker-compose.yml`](../docker-compose.yml). A header string can contain a colon, and an
unquoted colon breaks YAML parsing.

**All five empty is the default.** [`claude-code/entrypoint.sh`](../claude-code/entrypoint.sh)
unsets each variable that arrives empty, so Claude Code talks straight to Anthropic with the
OAuth token in the mounted config, on `sonnet`, exactly as before these variables existed.

**Set together, the five variables point the session and its subagents at an
OpenAI-compatible gateway.** `ANTHROPIC_BASE_URL` and `ANTHROPIC_CUSTOM_HEADERS` redirect and
authenticate the connection; `ANTHROPIC_MODEL` picks the model for the main session.

`ANTHROPIC_DEFAULT_HAIKU_MODEL` moves **both** classifier subagents, plus Claude Code's own
background calls, in one step. [`email-classifier.md`](../claude-code/agents/email-classifier.md)
and [`document-classifier.md`](../claude-code/agents/document-classifier.md) both declare
`model: haiku` in their frontmatter, and the `haiku` alias is exactly what this variable
remaps. There is no way to move only one of the two subagents with these variables -- that
would need a literal model id written into one agent's frontmatter instead of `haiku`.

`CLAUDE_CODE_MAX_CONTEXT_TOKENS` matters on a gateway model because Claude Code does not
recognise a gateway model name. It assumes a 200k-token window for any model it does not
recognise, and auto-compacts the conversation against that assumed number. Set this variable
to the gateway model's real context size, or Claude Code compacts too early or too late.

`CLAUDE_CODE_SUBAGENT_MODEL` is deliberately not used here. Before Claude Code 2.1.251, it
overrode a subagent's `model:` frontmatter. From 2.1.251 on, it does not. Its meaning flips on
a version bump, so a fixed model id or `ANTHROPIC_DEFAULT_HAIKU_MODEL` is the stable choice.

### MCP config format

```json
{
  "mcpServers": {
    "channel-name": { "command": "bun", "args": ["run", "/path/to/channel.ts"] },
    "tool-server":  { "type": "http", "url": "http://service:8000/mcp" }
  }
}
```

Use `"type": "http"` for Streamable HTTP -- **not** `"type": "url"`. Channel servers use
`command`/`args` (stdio subprocess). HTTP servers need DNS rebinding protection disabled, or
a Host header rewrite, to work under Docker networking.
