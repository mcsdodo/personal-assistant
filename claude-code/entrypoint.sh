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
# Claude Code v2.1.86 had a startup race where some channels failed silently.
# Fixed in v2.1.92, but keep this check as a safety net — exits with code 1
# to trigger Docker's restart policy if channels are missing.
echo "Verifying stdio channels spawned..."
sleep 3  # give subprocesses time to appear in ps
EXPECTED_CHANNELS=(
  "email-watcher.ts"
  "gdrive-watcher.ts"
  "telegram/server.ts"
  "file-ops.ts"
  "workflow-mcp.ts"
)
MISSING=()
for ch in "${EXPECTED_CHANNELS[@]}"; do
  if ! pgrep -f "bun run.*${ch}" >/dev/null 2>&1; then
    MISSING+=("$ch")
  fi
done
if [ ${#MISSING[@]} -gt 0 ]; then
  echo "ERROR: Missing channel subprocesses: ${MISSING[*]}"
  echo "Killing tmux session to trigger container restart..."
  tmux kill-server 2>/dev/null || true
  exit 1
fi
echo "All 5 stdio channels running."

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
