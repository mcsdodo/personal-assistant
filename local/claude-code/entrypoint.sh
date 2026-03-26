#!/bin/bash
set -e

# First-run: create settings.json if missing (volume mount overlays Dockerfile version)
if [ ! -f /home/node/.claude/settings.json ]; then
  echo '{"skipDangerousModePermissionPrompt": true}' > /home/node/.claude/settings.json
  echo "Created settings.json (first run)"
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

# Auto-accept the development channels prompt (no settings key exists to skip it)
# The prompt defaults to option 1 "I am using this for local development" — just press Enter
sleep 5
tmux send-keys -t claude Enter

echo "Claude Code session started in tmux."
echo "Use 'docker exec -it <container> tmux attach -t claude' to view."

exec sleep infinity
