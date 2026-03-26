#!/bin/bash
set -e

# Run Claude Code in interactive mode inside tmux
tmux new-session -d -s claude \
  "claude --model sonnet --remote-control \
    --dangerously-load-development-channels server:email-watcher \
    --dangerously-skip-permissions \
    --mcp-config /workspace/.mcp.json"

# Auto-accept the development channels prompt (no settings key exists to skip it)
# The prompt defaults to option 1 "I am using this for local development" — just press Enter
sleep 5
tmux send-keys -t claude Enter

echo "Claude Code session started in tmux."
echo "Use 'docker exec -it <container> tmux attach -t claude' to view."

exec sleep infinity
