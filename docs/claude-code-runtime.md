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
