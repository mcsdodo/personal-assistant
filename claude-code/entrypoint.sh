#!/bin/bash
set -e

LOG=/tmp/claude-output.log

# Test 1: Just verify claude starts and channels flag is accepted
# Start interactive session with channels in tmux
tmux new-session -d -s claude \
  "claude \
    --dangerously-load-development-channels server:email-watcher \
    --dangerously-skip-permissions \
    -p 'You are now running. List your available MCP tools and channels. Then wait for channel events.' \
    2>&1 | tee $LOG; echo 'SESSION_EXITED' >> $LOG"

echo "Claude Code session started in tmux."
exec tail -f $LOG
