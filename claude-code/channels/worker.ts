#!/usr/bin/env bun
/**
 * pa-worker — standalone executor for the workflow job queue.
 *
 * Extracted from workflow-mcp.ts by task 64. Owns:
 *  - workerTick (executeNextJob + reclaimStaleJobs) on WORKFLOW_POLL_MS
 *  - sweepStaleGuidance on 60s
 *  - sweepOrphanedDownloads once on boot
 *  - notifyTelegram (outbound, env-driven)
 *  - /health on :WORKFLOW_PORT (default 8003)
 *
 * Does NOT own the Claude channel push for classify_email/classify_document —
 * that path stays in workflow-mcp.ts via `pushPendingClassifications`. The
 * worker writes a classification_request_meta job event; workflow-mcp polls
 * for unpushed events and emits the channel notification on Claude's side.
 */

import { Database } from "bun:sqlite";

import { executeNextJob, reclaimStaleJobs } from "./workflow-core";
import { recordJobFailure } from "./metrics";
import { PaperlessFieldRegistry } from "./paperless-fields";
import type { NotifyFn } from "./telegram-notify";
import {
  failJob,
  openWorkflowDb,
  sweepOrphanedDownloads,
  type JobRow,
} from "./workflow-db";
import { initTracing, createLogger, shutdownTracing } from "./tracing";

const WORKFLOW_DB_PATH = process.env.WORKFLOW_DB_PATH ?? "/data/email-watcher/workflow.db";
const WORKFLOW_POLL_MS = parseInt(process.env.WORKFLOW_POLL_MS ?? "2000", 10);
const WORKFLOW_PORT = parseInt(process.env.WORKFLOW_MCP_PORT ?? "8003", 10);

initTracing("worker");
const log = createLogger("worker");

// ── Telegram notify (extracted from workflow-mcp) ────────────────────
export function buildNotifyTelegram(
  token: string | undefined,
  chatId: string | undefined,
  logFn: (msg: string) => void,
): NotifyFn {
  return async (message: string) => {
    if (!token || !chatId) return;
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: message }),
      });
    } catch (err) {
      logFn(`Telegram notification failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

// ── Stale guidance sweep (moved verbatim from workflow-mcp) ──────────
//
// Jobs paused in `awaiting_user_guidance` shouldn't sit forever.
// REMINDER_HOURS (24h): nudge the user via notifyFn so they know they
//   owe the queue an answer. State unchanged.
// TIMEOUT_HOURS (72h): give up — fail the job with a `timed_out` error.
// Reminder rate-limited per job via `last_reminder_at` so the 60s sweep
// tick doesn't spam Telegram.

export const GUIDANCE_REMINDER_HOURS = 24;
export const GUIDANCE_TIMEOUT_HOURS = 72;
export const GUIDANCE_REMINDER_COOLDOWN_HOURS = 6;

export function sweepStaleGuidance(
  dbInstance: Database,
  notifyFn: NotifyFn,
): void {
  const now = Date.now();
  const reminderCutoffIso = new Date(now - GUIDANCE_REMINDER_HOURS * 3600 * 1000).toISOString();
  const timeoutCutoffIso = new Date(now - GUIDANCE_TIMEOUT_HOURS * 3600 * 1000).toISOString();
  const cooldownCutoffIso = new Date(now - GUIDANCE_REMINDER_COOLDOWN_HOURS * 3600 * 1000).toISOString();

  const stale = dbInstance.prepare(
    `SELECT * FROM jobs WHERE state = 'awaiting_user_guidance' AND updated_at < ?`
  ).all(timeoutCutoffIso) as JobRow[];
  for (const job of stale) {
    failJob(dbInstance, job.id, {
      code: "timed_out",
      reason: `paused for >${GUIDANCE_TIMEOUT_HOURS}h with no guidance`,
    });
    recordJobFailure("timed_out", job.workflow_type);
  }

  const needsReminder = dbInstance.prepare(
    `SELECT * FROM jobs
     WHERE state = 'awaiting_user_guidance'
       AND updated_at < ?
       AND updated_at >= ?
       AND (last_reminder_at IS NULL OR last_reminder_at < ?)`
  ).all(reminderCutoffIso, timeoutCutoffIso, cooldownCutoffIso) as JobRow[];
  if (needsReminder.length > 0) {
    const remainingH = GUIDANCE_TIMEOUT_HOURS - GUIDANCE_REMINDER_HOURS;
    void notifyFn(`⏰ ${needsReminder.length} job(s) awaiting your guidance — auto-cancel in ${remainingH}h.`);
    const stampIso = new Date(now).toISOString();
    const placeholders = needsReminder.map(() => "?").join(",");
    dbInstance.prepare(`UPDATE jobs SET last_reminder_at = ? WHERE id IN (${placeholders})`)
      .run(stampIso, ...needsReminder.map((j) => j.id));
  }
}

// ── Worker tick guard ─────────────────────────────────────────────────
let workerBusy = false;

export async function workerTick(
  db: Database,
  fieldRegistry: PaperlessFieldRegistry,
  notifyFn: NotifyFn,
): Promise<void> {
  if (workerBusy) return;
  workerBusy = true;
  try {
    reclaimStaleJobs(db, { log });
    await executeNextJob(db, { log }, fieldRegistry, notifyFn);
  } finally {
    workerBusy = false;
  }
}

// ── main() ────────────────────────────────────────────────────────────

export async function main(): Promise<void> {
  const db = openWorkflowDb(WORKFLOW_DB_PATH);
  log(`Opened workflow DB at ${WORKFLOW_DB_PATH}`);

  const downloadDir = process.env.DOWNLOAD_DIR ?? "/workspace/downloads";
  const sweepMaxAgeMs = parseInt(
    process.env.DOWNLOAD_SWEEP_MAX_AGE_MS ?? String(7 * 24 * 60 * 60 * 1000),
    10,
  );
  try {
    const sweep = sweepOrphanedDownloads(db, downloadDir, sweepMaxAgeMs, { log });
    log(`Download sweep: scanned=${sweep.scanned} deleted=${sweep.deleted} preserved=${sweep.preserved}`);
  } catch (err) {
    log(`Download sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const paperlessUrl = process.env.PAPERLESS_URL;
  if (!paperlessUrl) throw new Error("PAPERLESS_URL environment variable is required");
  const paperlessToken = process.env.PAPERLESS_API_TOKEN ?? "";
  const fieldRegistry = new PaperlessFieldRegistry(paperlessUrl, paperlessToken, log);
  await fieldRegistry.init();
  log("Custom field registry initialized");

  const notifyTelegram = buildNotifyTelegram(
    process.env.TELEGRAM_BOT_TOKEN,
    process.env.TELEGRAM_CHAT_ID,
    log,
  );

  const healthServer = Bun.serve({
    port: WORKFLOW_PORT,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") return new Response("ok", { status: 200 });
      return new Response("Not Found", { status: 404 });
    },
  });
  log(`Health endpoint on :${WORKFLOW_PORT}/health`);

  await workerTick(db, fieldRegistry, notifyTelegram);
  const tickHandle = setInterval(() => {
    workerTick(db, fieldRegistry, notifyTelegram).catch((error) => {
      log(`Worker tick failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, WORKFLOW_POLL_MS);

  const guidanceSweepHandle = setInterval(() => {
    try { sweepStaleGuidance(db, notifyTelegram); }
    catch (err) { log(`Stale-guidance sweep failed: ${err instanceof Error ? err.message : String(err)}`); }
  }, 60_000);

  // Graceful shutdown — `docker stop` sends SIGTERM and waits 10s before
  // SIGKILL. Closing the DB cleanly on the way out is good hygiene; WAL
  // is crash-safe but a clean close avoids leaving a *.db-shm/*.db-wal
  // pair that the next boot has to recover.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`Received ${signal}, shutting down...`);
    clearInterval(tickHandle);
    clearInterval(guidanceSweepHandle);
    healthServer.stop();
    await shutdownTracing();
    try { db.close(); } catch (err) {
      log(`db.close() failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (import.meta.main) {
  main().catch((error) => {
    log(`Fatal error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
