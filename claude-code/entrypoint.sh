#!/bin/bash
set -e

# Run Claude Code in interactive mode inside tmux
# Settings: skipDangerousModePermissionPrompt baked into settings.json
# MCP servers: pre-approved via enabledMcpjsonServers in .claude.json
tmux new-session -d -s claude \
  "claude \
    --dangerously-load-development-channels server:email-watcher \
    --dangerously-skip-permissions \
    --mcp-config /workspace/.mcp.json"

echo "Claude Code session started in tmux."
echo "Use 'docker exec -it <container> tmux attach -t claude' to view."

# Keep container alive
exec sleep infinity
