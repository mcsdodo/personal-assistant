#!/bin/bash
set -e

# Deploy settings.json from image to volume (always overwrite to pick up config changes)
cp /app/settings.json /home/node/.claude/settings.json

# First-run: check for Claude credentials
if [ ! -f /home/node/.claude/.credentials.json ]; then
  echo "WARNING: No Claude credentials found."
  echo "Run: docker exec -it personal-assistant-claude claude login"
fi

# Start workflow-mcp HTTP server (background, before Claude so it's ready for tool calls)
bun run /app/channels/workflow-mcp.ts &
WORKFLOW_PID=$!
echo "Started workflow-mcp (PID $WORKFLOW_PID, port ${WORKFLOW_MCP_PORT:-8003})"

# Wait for workflow-mcp to be ready
for i in $(seq 1 15); do
  if curl -sf "http://localhost:${WORKFLOW_MCP_PORT:-8003}/health" > /dev/null 2>&1; then
    echo "Workflow-mcp healthy (after ${i}s)"
    break
  fi
  sleep 1
done

# Run Claude Code in interactive mode inside tmux
tmux new-session -d -s claude \
  "claude --model sonnet --remote-control --name personal-assistant \
    --dangerously-load-development-channels server:email-watcher \
    --dangerously-load-development-channels server:gdrive-watcher \
    --dangerously-load-development-channels server:telegram \
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

echo "Claude Code session started in tmux."
echo "Use 'docker exec -it <container> tmux attach -t claude' to view."

# Monitor tmux session — exit if it dies so Docker's restart policy kicks in
# (Docker only restarts on container exit, not on unhealthy status alone)
while tmux has-session -t claude 2>/dev/null; do
  sleep 10
done
echo "Claude session exited, stopping container for restart..."
exit 1
