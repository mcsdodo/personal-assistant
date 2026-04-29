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

# Verify stdio channel subprocesses spawned.
#
# Claude Code v2.1.92 has a race loading 9 MCP servers (5 stdio + 4 HTTP)
# where one gets non-deterministically dropped. Session JSONL confirms the
# dropped server's tools never appear in deferred_tools_delta — Claude Code
# skips it entirely, not just delays it.
#
# To prevent an infinite restart loop, channels are split into two tiers:
#   CRITICAL: email-watcher + workflow-mcp — the invoice pipeline is dead
#             without these. Missing a critical channel → kill tmux → exit 1.
#   BEST_EFFORT: gdrive-watcher, telegram, file-ops — important but the
#                container should run without them. Missing → log WARN, not
#                restart. The watchdog also uses these tiers.
echo "Verifying stdio channels spawned..."
CRITICAL_CHANNELS=(
  "email-watcher.ts"
  "workflow-mcp.ts"
)
BEST_EFFORT_CHANNELS=(
  "gdrive-watcher.ts"
  "telegram/server.ts"
  "file-ops.ts"
)
ALL_CHANNELS=("${CRITICAL_CHANNELS[@]}" "${BEST_EFFORT_CHANNELS[@]}")

# Claude Code v2.1.92 races MCP connections against a 5s budget then spawns
# the rest in background. Processes appear anywhere from 30s to 180s after
# container start. 60 attempts × 5s = 300s covers observed worst case.
CRITICAL_READY=false
for attempt in $(seq 1 60); do
  MISSING_CRITICAL=()
  MISSING_BEST=()
  for ch in "${CRITICAL_CHANNELS[@]}"; do
    if ! pgrep -f "^bun run /app/channels/${ch}" >/dev/null 2>&1; then
      MISSING_CRITICAL+=("$ch")
    fi
  done
  for ch in "${BEST_EFFORT_CHANNELS[@]}"; do
    if ! pgrep -f "^bun run /app/channels/${ch}" >/dev/null 2>&1; then
      MISSING_BEST+=("$ch")
    fi
  done
  if [ ${#MISSING_CRITICAL[@]} -eq 0 ]; then
    CRITICAL_READY=true
    total_running=$(( ${#ALL_CHANNELS[@]} - ${#MISSING_BEST[@]} ))
    echo "Critical channels ready (after ${attempt} checks, $((attempt * 5))s). ${total_running}/${#ALL_CHANNELS[@]} stdio channels running."
    if [ ${#MISSING_BEST[@]} -gt 0 ]; then
      echo "  WARN: best-effort channels not spawned yet: ${MISSING_BEST[*]}"
      echo "  (may still spawn in background — watchdog will monitor)"
    fi
    break
  fi
  if [ $((attempt % 12)) -eq 0 ]; then
    echo "  attempt ${attempt}/60 ($((attempt * 5))s): critical missing: ${MISSING_CRITICAL[*]}; best-effort missing: ${MISSING_BEST[*]}"
  fi
  sleep 5
done
if [ "$CRITICAL_READY" = "false" ]; then
  echo "ERROR: Critical channels not spawned after 300s — see per-attempt log above"
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

# Monitor tmux session + rate-limit watchdog + channel liveness (single loop)
# - Exits if tmux session dies (Docker restart policy kicks in)
# - Auto-dismisses rate limit TUI prompt so Claude can wait internally
# - Periodically pgrep's stdio channels. CRITICAL channels trigger restart
#   after 2 consecutive misses (~20s). BEST_EFFORT channels get a bounded
#   self-recovery loop: after a 3-min grace period, restart the container
#   to re-roll the v2.1.x MCP-spawn race; max 3 attempts per channel with
#   exponential backoff (60s / 120s / 240s) between attempts. Recovery
#   state lives in BEST_EFFORT_STATE_DIR which survives `docker restart`
#   but gets wiped on `docker rm` — so a fresh deploy resets the budget.
#   See _tasks/47-pipeline-hardening-followups/ Issue 2 for the post-mortem.
BEST_EFFORT_STATE_DIR=/tmp/best_effort_recovery
BEST_EFFORT_GRACE_CHECKS=18   # 18 * 10s = 180s before considering restart
BEST_EFFORT_MAX_RESTARTS=3
mkdir -p "$BEST_EFFORT_STATE_DIR"

declare -A MISSING_COUNT
while tmux has-session -t claude 2>/dev/null; do
  pane_text=$(tmux capture-pane -t claude -p -S -15 2>/dev/null || true)

  if echo "$pane_text" | grep -q "Stop and wait for limit to reset"; then
    echo "[watchdog] Rate limit prompt detected — selecting 'wait for reset'"
    tmux send-keys -t claude Enter
  fi

  for ch in "${CRITICAL_CHANNELS[@]}"; do
    if pgrep -f "^bun run /app/channels/${ch}" >/dev/null 2>&1; then
      MISSING_COUNT[$ch]=0
    else
      MISSING_COUNT[$ch]=$(( ${MISSING_COUNT[$ch]:-0} + 1 ))
      if [ "${MISSING_COUNT[$ch]}" -ge 2 ]; then
        echo "[watchdog] FATAL: critical channel ${ch} missing for ${MISSING_COUNT[$ch]} consecutive checks — triggering container restart"
        tmux kill-server 2>/dev/null || true
        exit 1
      fi
      echo "[watchdog] WARN: critical channel ${ch} missing (count=${MISSING_COUNT[$ch]}/2)"
    fi
  done

  for ch in "${BEST_EFFORT_CHANNELS[@]}"; do
    ch_safe=${ch//\//_}
    count_file="$BEST_EFFORT_STATE_DIR/${ch_safe}.count"
    ts_file="$BEST_EFFORT_STATE_DIR/${ch_safe}.ts"

    if pgrep -f "^bun run /app/channels/${ch}" >/dev/null 2>&1; then
      if [ "${MISSING_COUNT[$ch]:-0}" -gt 0 ]; then
        echo "[watchdog] INFO: best-effort channel ${ch} recovered, resetting recovery counter"
        rm -f "$count_file" "$ts_file"
      fi
      MISSING_COUNT[$ch]=0
    else
      prev=${MISSING_COUNT[$ch]:-0}
      MISSING_COUNT[$ch]=$(( prev + 1 ))
      if [ "${MISSING_COUNT[$ch]}" -eq 1 ]; then
        echo "[watchdog] WARN: best-effort channel ${ch} not running (Claude Code v2.1.x MCP race — entering recovery loop)"
      fi

      if [ "${MISSING_COUNT[$ch]}" -ge "$BEST_EFFORT_GRACE_CHECKS" ]; then
        restart_count=$(cat "$count_file" 2>/dev/null || echo 0)

        if [ "$restart_count" -ge "$BEST_EFFORT_MAX_RESTARTS" ]; then
          # Budget exhausted. Log occasionally so the situation is visible
          # but don't spam — every 30 checks (5 min) is enough.
          if [ $(( MISSING_COUNT[$ch] % 30 )) -eq 0 ]; then
            echo "[watchdog] WARN: best-effort channel ${ch} still missing — ${restart_count}/${BEST_EFFORT_MAX_RESTARTS} restart attempts exhausted, manual intervention or redeploy required"
          fi
        else
          # Backoff: 60s before attempt 1, 120s before attempt 2, 240s before attempt 3
          backoff_sec=$(( 60 * (1 << restart_count) ))
          last_ts=$(cat "$ts_file" 2>/dev/null || echo 0)
          now=$(date +%s)
          elapsed=$(( now - last_ts ))

          if [ "$elapsed" -ge "$backoff_sec" ]; then
            new_count=$(( restart_count + 1 ))
            echo "$new_count" > "$count_file"
            echo "$now" > "$ts_file"
            echo "[watchdog] FATAL: best-effort channel ${ch} missing for ${MISSING_COUNT[$ch]} checks (~$((MISSING_COUNT[$ch]*10))s) — recovery restart attempt ${new_count}/${BEST_EFFORT_MAX_RESTARTS} (next backoff if needed: $((60 * (1 << new_count)))s)"
            tmux kill-server 2>/dev/null || true
            exit 1
          fi
          # Still in backoff window — log once when entering it
          if [ "${MISSING_COUNT[$ch]}" -eq "$BEST_EFFORT_GRACE_CHECKS" ]; then
            remaining=$(( backoff_sec - elapsed ))
            echo "[watchdog] WARN: best-effort channel ${ch} missing for grace period — recovery restart attempt $((restart_count + 1))/${BEST_EFFORT_MAX_RESTARTS} pending in ${remaining}s (backoff)"
          fi
        fi
      fi
    fi
  done

  sleep 10
done
echo "Claude session exited, stopping container for restart..."
exit 1
