#!/bin/bash
set -e

# Deploy settings.json from image to volume (always overwrite to pick up config changes)
cp /app/settings.json /home/node/.claude/settings.json

# First-run: check for Claude credentials
if [ ! -f /home/node/.claude/.credentials.json ]; then
  echo "WARNING: No Claude credentials found."
  echo "Run: docker exec -it personal-assistant-claude claude login"
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

# Reconnect HTTP MCPs. Claude Code v2.1.92 has a bug (claude-code#34008)
# where interactive sessions mark HTTP MCPs as "failed" at startup even when
# the upstream server is healthy and unauthenticated. The /mcp UI "Reconnect"
# action fixes them, but the detail menu layout varies per server state, so
# this function discovers the layout dynamically rather than hardcoding key
# offsets.
#
# Strategy:
#   1. Open /mcp, parse the pane, find the target server's current state.
#   2. Skip if already ✔ connected.
#   3. If ◯ disabled → look for "Enable" option; otherwise look for "Reconnect".
#   4. Compute Down/Up presses from cursor line to target server line.
#   5. Open detail menu, parse for the target option's number, navigate, Enter.
#   6. Verify success by re-reading the main menu state, not by chat grep.

# Read the current state of an MCP server from a captured /mcp menu pane.
# Returns the state word with status icon stripped: "connected", "failed",
# "disabled", or "" if the server isn't in the pane. Matches ` $name · `
# which works for both cursor and non-cursor lines (both have that pattern).
mcp_parse_state() {
  local pane=$1
  local name=$2
  echo "$pane" \
    | grep -E " ${name} ·" \
    | head -1 \
    | sed -E 's/.*· //' \
    | tr -d '[:space:]'
}

# Open /mcp menu and capture pane content. Used by both navigation and
# verification. Closes any open menu first to ensure clean state.
#
# IMPORTANT: only single Escape — Claude Code uses Esc-Esc as a Rewind
# dialog shortcut, which would trap subsequent input. Single Escape closes
# any open menu without triggering Rewind.
mcp_open_menu() {
  tmux send-keys -t claude Escape
  sleep 0.6
  tmux send-keys -t claude '/mcp' Enter
  sleep 3
  tmux capture-pane -t claude -p
}

reconnect_mcp() {
  local name=$1
  local pane state action target_action_num
  local cursor_line target_line delta i

  # 1. Open menu and check current state. If the menu didn't actually open
  #    (e.g. because something else is on screen), retry once.
  pane=$(mcp_open_menu)
  if ! echo "$pane" | grep -q "Manage MCP servers"; then
    tmux send-keys -t claude Escape
    sleep 1
    pane=$(mcp_open_menu)
  fi
  state=$(mcp_parse_state "$pane" "$name")

  if [ -z "$state" ]; then
    tmux send-keys -t claude Escape
    echo "  ✗ ${name} (not found in /mcp menu)"
    return 1
  fi

  case "$state" in
    *connected*)
      tmux send-keys -t claude Escape
      echo "  ✓ ${name} (already connected)"
      return 0
      ;;
    *disabled*)
      action="Enable"
      ;;
    *)
      action="Reconnect"
      ;;
  esac

  # 2. Navigate cursor to the target server's line. Compute delta from the
  #    current ❯ cursor line to the target server line in the captured pane.
  cursor_line=$(echo "$pane" | grep -n "❯" | head -1 | cut -d: -f1)
  target_line=$(echo "$pane" | grep -nE " ${name} ·" | head -1 | cut -d: -f1)
  if [ -z "$cursor_line" ] || [ -z "$target_line" ]; then
    tmux send-keys -t claude Escape
    echo "  ✗ ${name} (couldn't locate cursor or target line)"
    return 1
  fi
  delta=$((target_line - cursor_line))
  if [ "$delta" -gt 0 ]; then
    for i in $(seq 1 "$delta"); do
      tmux send-keys -t claude Down
      sleep 0.15
    done
  elif [ "$delta" -lt 0 ]; then
    for i in $(seq 1 $((-delta))); do
      tmux send-keys -t claude Up
      sleep 0.15
    done
  fi

  # 3. Open the server detail menu and parse it for the action's option number.
  tmux send-keys -t claude Enter
  sleep 2
  pane=$(tmux capture-pane -t claude -p)
  target_action_num=$(echo "$pane" | grep -oE "[1-9]\.[[:space:]]+${action}\b" | head -1 | grep -oE '^[1-9]')
  if [ -z "$target_action_num" ]; then
    # Single Escape closes the detail menu (returns to main menu).
    # The next mcp_open_menu call will Escape again to dismiss the main menu.
    # Avoid chained Escapes — Claude Code's Esc-Esc is a Rewind dialog
    # shortcut that hijacks subsequent input.
    tmux send-keys -t claude Escape
    sleep 0.5
    echo "  ✗ ${name} (no '${action}' option in detail menu, state was '${state}')"
    return 1
  fi

  # 4. Cursor in detail menu starts at item 1; press Down to reach target.
  for i in $(seq 1 $((target_action_num - 1))); do
    tmux send-keys -t claude Down
    sleep 0.15
  done
  tmux send-keys -t claude Enter

  # 5. Wait for the action to fully process, then verify state. Polling by
  #    re-opening /mcp seems to interfere with the reconnect, so do a single
  #    check after a generous wait. HTTP MCP reconnects typically complete
  #    within 2–3s once Reconnect is triggered.
  sleep 8
  pane=$(mcp_open_menu)
  state=$(mcp_parse_state "$pane" "$name")
  tmux send-keys -t claude Escape

  case "$state" in
    *connected*)
      echo "  ✓ ${name}"
      return 0
      ;;
    *)
      echo "  ✗ ${name} (still '${state}' after action)"
      return 1
      ;;
  esac
}

echo "Reconnecting HTTP MCP servers..."
reconnect_mcp checker   || true
reconnect_mcp gmail     || true
reconnect_mcp outlook   || true
reconnect_mcp paperless || true
# Don't exit on reconnect failure — the session is still usable for stdio
# channels, and gmail may legitimately need OAuth if the token expired.

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
