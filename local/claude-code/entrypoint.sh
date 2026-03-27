#!/bin/bash
set -e

# First-run: create settings.json if missing (volume mount overlays Dockerfile version)
if [ ! -f /home/node/.claude/settings.json ]; then
  if [ -w /home/node/.claude ]; then
    echo '{"skipDangerousModePermissionPrompt": true}' > /home/node/.claude/settings.json
    echo "Created settings.json (first run)"
  else
    echo "WARNING: Cannot create /home/node/.claude/settings.json (directory not writable)"
    echo "Claude will continue with the mounted config as-is"
  fi
fi

# First-run: check for Claude credentials
if [ ! -f /home/node/.claude/.credentials.json ]; then
  echo "WARNING: No Claude credentials found."
  echo "Run: docker exec -it personal-assistant-claude claude login"
fi

# Run Claude Code in interactive mode inside tmux
tmux new-session -d -s claude \
  "claude --model sonnet --remote-control \
    --dangerously-load-development-channels server:email-watcher \
    --dangerously-load-development-channels server:telegram \
    --dangerously-skip-permissions \
    --mcp-config /workspace/.mcp.json"

# Wait for the development channels TUI prompt, then accept it
echo "Waiting for development channels prompt..."
accepted=false
for i in $(seq 1 60); do
  if tmux capture-pane -t claude -p 2>/dev/null | grep -q "local development"; then
    tmux send-keys -t claude Enter
    echo "Accepted development channels prompt (after ${i}s)"
    accepted=true
    break
  fi
  sleep 1
done

if [ "$accepted" = false ]; then
  echo "WARNING: Development channels prompt not detected after 60s"
  echo "Claude may have started without channels, or the prompt text changed"
fi

echo "Claude Code session started in tmux."
echo "Use 'docker exec -it <container> tmux attach -t claude' to view."

# Monitor tmux session — exit if it dies so Docker's restart policy kicks in
# (Docker only restarts on container exit, not on unhealthy status alone)
while tmux has-session -t claude 2>/dev/null; do
  sleep 10
done
echo "Claude session exited, stopping container for restart..."
exit 1
