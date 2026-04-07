#!/bin/bash
set -e

# Deploy settings.json from image to volume (always overwrite to pick up config changes)
cp /app/settings.json /home/node/.claude/settings.json

# First-run: check for Claude credentials
if [ ! -f /home/node/.claude/.credentials.json ]; then
  echo "WARNING: No Claude credentials found."
  echo "Run: docker exec -it personal-assistant-claude claude login"
fi

# Strip stale mcpOAuth state from .credentials.json. Claude Code's MCP SDK
# caches OAuth Dynamic Client Registration discovery state per HTTP MCP server
# under the `mcpOAuth` key. Once an entry exists with a non-empty
# `discoveryState`, the SDK persistently treats that server as OAuth-protected
# on every startup — even with an empty `accessToken`. The /mcp UI then shows
# the server as "△ needs authentication" and replaces every real tool with
# an `authenticate` placeholder, silently breaking the pipeline (jobs stall
# at awaiting_classification because Claude can't fetch email bodies).
#
# We don't use OAuth on any HTTP MCP in this stack (gmail uses a Caddy bearer
# token sidecar; checker/paperless/outlook have no client auth). So the entire
# `mcpOAuth` block is always stale state that should be wiped on startup.
#
# Background: an experimental RFC 7591 /register stub (commit 6778670) caused
# the SDK to populate this state for paperless/checker/gmail. The stub was
# reverted server-side (3de8d81) but the cached client state survived in the
# bind-mounted data dir. See _tasks/46-mcp-oauth-state-cleanup/ for the full
# post-mortem and upstream tracking.
if [ -f /home/node/.claude/.credentials.json ]; then
  bun -e "$(cat <<'BUNEOF'
import {readFileSync, writeFileSync} from 'fs'
const path = '/home/node/.claude/.credentials.json'
const j = JSON.parse(readFileSync(path, 'utf8'))
if (j.mcpOAuth && Object.keys(j.mcpOAuth).length > 0) {
  const cleared = Object.keys(j.mcpOAuth)
  j.mcpOAuth = {}
  writeFileSync(path, JSON.stringify(j))
  console.log('Cleared stale mcpOAuth entries:', cleared.join(', '))
}
BUNEOF
)" 2>&1 || echo "WARNING: mcpOAuth cleanup failed, proceeding anyway"
fi

# Run Claude Code in interactive mode inside tmux
tmux new-session -d -s claude \
  "claude --model sonnet --remote-control --name personal-assistant \
    --dangerously-load-development-channels server:email-watcher \
    --dangerously-load-development-channels server:gdrive-watcher \
    --dangerously-load-development-channels server:telegram \
    --dangerously-load-development-channels server:workflow \
    --permission-mode dontAsk \
    --mcp-config /workspace/.mcp.json"

# Wait for Claude to be ready. With --permission-mode dontAsk, the dev channels
# prompt is skipped (channels load automatically). With --dangerously-skip-permissions,
# there's a TUI prompt requiring Enter. Handle both cases.
echo "Waiting for Claude startup..."
ready=false
for i in $(seq 1 60); do
  pane_content=$(tmux capture-pane -t claude -p 2>/dev/null || true)
  # dontAsk mode: no prompt, channels load directly
  if echo "$pane_content" | grep -q "Listening for channel messages"; then
    echo "Channels loaded (after ${i}s)"
    ready=true
    break
  fi
  # Legacy: dangerously-skip-permissions shows a TUI prompt
  if echo "$pane_content" | grep -q "local development"; then
    tmux send-keys -t claude Enter
    echo "Accepted development channels prompt (after ${i}s)"
    ready=true
    break
  fi
  sleep 1
done

if [ "$ready" = false ]; then
  echo "WARNING: Claude not ready after 60s — channels may not have loaded"
fi

# Dismiss any additional TUI prompts (e.g. "new MCP servers found", auto-update notices)
echo "Checking for additional startup prompts..."
for i in $(seq 1 10); do
  pane_content=$(tmux capture-pane -t claude -p 2>/dev/null || true)
  if echo "$pane_content" | grep -qi "new.*mcp\|new.*server\|trust\|approve\|continue"; then
    tmux send-keys -t claude Enter
    echo "Accepted additional startup prompt (after ${i}s)"
    sleep 2
  fi
  sleep 1
done

# Verify all expected stdio channel subprocesses spawned.
# Claude Code still has an occasional startup race where some channels fail
# to spawn. Retry for up to 60s before giving up and triggering a container
# restart via non-zero exit.
echo "Verifying stdio channels spawned..."
EXPECTED_CHANNELS=(
  "email-watcher.ts"
  "gdrive-watcher.ts"
  "telegram/server.ts"
  "file-ops.ts"
  "workflow-mcp.ts"
)
CHANNELS_READY=false
for attempt in $(seq 1 12); do
  MISSING=()
  for ch in "${EXPECTED_CHANNELS[@]}"; do
    if ! pgrep -f "bun run.*${ch}" >/dev/null 2>&1; then
      MISSING+=("$ch")
    fi
  done
  if [ ${#MISSING[@]} -eq 0 ]; then
    CHANNELS_READY=true
    echo "All 5 stdio channels running (after ${attempt} checks)"
    break
  fi
  sleep 5
done
if [ "$CHANNELS_READY" = "false" ]; then
  echo "ERROR: Missing channel subprocesses after 60s: ${MISSING[*]}"
  echo "Killing tmux session to trigger container restart..."
  tmux kill-server 2>/dev/null || true
  exit 1
fi

# NOTE: The /mcp HTTP-MCP "reconnect script" that used to live here has been
# removed (task 46). It was a workaround for Claude Code SDK bug #34008 where
# HTTP MCPs were ending up in `△ needs authentication` state at startup. The
# real root cause turned out to be persistent OAuth Dynamic Client Registration
# state cached under `mcpOAuth` in `.credentials.json` — the wipe step above
# is the proper fix and makes the reconnect loop redundant.
#
# Beyond being redundant, the reconnect loop was actively harmful: it sent
# `tmux send-keys ... Escape` and `/mcp\n` keystrokes into the live Claude
# session post-startup, racing with workflow channel pushes. Each Escape
# arriving while Claude was processing a `classify_email` channel event
# triggered `[Request interrupted by user]`, leaving invoice_intake jobs
# stuck in `awaiting_classification` indefinitely. Diagnosed via session jsonl
# in 2026-04-07 e2e test investigation. See _tasks/46-mcp-oauth-state-cleanup/
# for the full timeline.
#
# If a future Claude Code SDK regression re-introduces a similar startup
# brokenness, prefer fixing it on the SDK probe side (cache invalidation,
# server-side response shape, version pin) rather than re-introducing tmux
# keystroke navigation. The keystroke approach cannot be made race-free as
# long as the same tmux session also delivers channel notifications.

echo "Claude Code session started in tmux."
echo "Use 'docker exec -it <container> tmux attach -t claude' to view."

# Monitor tmux session + rate-limit watchdog (single loop)
# - Exits if tmux session dies (Docker restart policy kicks in)
# - Auto-dismisses rate limit TUI prompt so Claude can wait internally
while tmux has-session -t claude 2>/dev/null; do
  pane_text=$(tmux capture-pane -t claude -p -S -15 2>/dev/null || true)

  if echo "$pane_text" | grep -q "Stop and wait for limit to reset"; then
    echo "[watchdog] Rate limit prompt detected — selecting 'wait for reset'"
    tmux send-keys -t claude Enter
  fi

  sleep 10
done
echo "Claude session exited, stopping container for restart..."
exit 1
