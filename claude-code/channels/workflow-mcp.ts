#!/usr/bin/env bun

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Database } from "bun:sqlite";

import { executeNextJob, reclaimStaleJobs } from "./workflow-core";
import { PaperlessFieldRegistry } from "./paperless-fields";
import type { NotifyFn } from "./telegram-notify";
import {
  addJobEvent,
  approveJob,
  cancelJob,
  completeJob,
  createJob,
  failJob,
  getJob,
  getJobEvents,
  listJobs,
  openWorkflowDb,
  setJobState,
  submitClassification,
  sweepOrphanedDownloads,
  type JobRow,
} from "./workflow-db";

import { initTracing, createLogger, getMeter, getTracer, remoteParentContext, SpanStatusCode } from "./tracing";
import { getEmailTraceId } from "./db";

const WORKFLOW_DB_PATH = process.env.WORKFLOW_DB_PATH ?? "/data/email-watcher/workflow.db";
const WORKFLOW_POLL_MS = parseInt(process.env.WORKFLOW_POLL_MS ?? "2000", 10);
const WORKFLOW_PORT = parseInt(process.env.WORKFLOW_MCP_PORT ?? "8003", 10);

initTracing("workflow");
const log = createLogger("workflow");

// Task 57 / 4.2: Observability counter for guidance pauses. Incremented
// every time the worker parks a job in `awaiting_user_guidance` (via
// `pauseAndNotify` in invoice/intake-worker.ts). Exported so the worker
// can `.add()` to it directly; the Prometheus series is keyed by
// `reason` (classifier_unknown, encrypted_pdf, ...). Zero-cardinality in
// the happy path — only non-zero when jobs actually get stuck.
//
// `email_watcher_jobs{state="awaiting_user_guidance"}` already captures
// the instantaneous backlog since that gauge groups by (type, state),
// so we don't need a separate backlog metric for paused jobs. This
// counter is the trend view — "how often are we pausing, and for what".
const workflowMeter = getMeter("workflow");
export const guidanceRequestsTotal = workflowMeter.createCounter(
  "personal_assistant_guidance_requests_total",
  { description: "Job pauses for user guidance, by trigger reason" },
);

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const notifyTelegram: NotifyFn = async (message) => {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message }),
    });
  } catch (err) {
    log(`Telegram notification failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};

function text(value: unknown): { type: "text"; text: string } {
  return {
    type: "text",
    text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
  };
}

let db: Database;
let workerBusy = false;
let fieldRegistry: PaperlessFieldRegistry;

/**
 * Guidance payload accepted by the `provide_guidance` MCP tool. See
 * the tool registration below for the input schema. Actions:
 *
 * - `skip`  — user decides the job should complete without doing any
 *   remaining work. Job transitions to `completed` with `outcome:
 *   "skipped"`.
 * - `fail`  — user cancels the job. Job transitions to `failed` with
 *   `code: "user_cancelled"`.
 * - `retry` — re-run the step that paused without a payload patch.
 * - `patch` — re-run with a payload patch (e.g. classification
 *   overrides). The worker picks up the `guidance_applied` event on
 *   the next tick and merges the patch.
 *
 * `decrypt_password` is NEVER stored inside the `guidance_applied`
 * event — it goes into a separate `guidance_password` event so
 * password material doesn't leak into regular audit logs. The
 * `guidance_applied` event only records `decrypt_password_provided:
 * boolean` so operators can see a password was handed over without
 * seeing the value.
 */
export interface Guidance {
  action: "skip" | "retry" | "fail" | "patch";
  patch?: Record<string, unknown>;
  decrypt_password?: string;
  user_note?: string;
}

/**
 * Handle a `provide_guidance` MCP tool call. Exported for unit tests
 * and to keep the dispatch switch thin. Throws on caller errors (job
 * not found, job not in `awaiting_user_guidance`) so the MCP request
 * handler catch-block can surface them as `isError: true`.
 */
export function handleProvideGuidance(
  dbInstance: Database,
  args: { job_id: string; guidance: Guidance },
): void {
  const job = getJob(dbInstance, args.job_id);
  if (!job) throw new Error(`Job not found: ${args.job_id}`);
  if (job.state !== "awaiting_user_guidance") {
    throw new Error(
      `Job ${args.job_id} not in awaiting_user_guidance (state=${job.state})`,
    );
  }

  const { guidance } = args;

  // Loki event — the user has answered a guidance_request. Paired with
  // `guidance.requested` (emitted on pause) and `guidance.applied`
  // (emitted by the worker when it consumes the guidance_applied event).
  // See task 57 section "Observability".
  log(`guidance.received job_id=${args.job_id} action=${guidance.action}`);

  switch (guidance.action) {
    case "skip":
      addJobEvent(dbInstance, job.id, "guidance_applied", {
        action: "skip",
        user_note: guidance.user_note ?? null,
      });
      completeJob(dbInstance, job.id, {
        outcome: "skipped",
        reason: guidance.user_note ?? null,
      });
      break;

    case "fail":
      addJobEvent(dbInstance, job.id, "guidance_applied", {
        action: "fail",
        user_note: guidance.user_note ?? null,
      });
      failJob(dbInstance, job.id, {
        code: "user_cancelled",
        reason: guidance.user_note ?? null,
      });
      break;

    case "retry":
    case "patch":
      addJobEvent(dbInstance, job.id, "guidance_applied", {
        action: guidance.action,
        patch: guidance.patch ?? null,
        decrypt_password_provided: Boolean(guidance.decrypt_password),
        user_note: guidance.user_note ?? null,
      });
      // Sensitive password material goes into its own event so it
      // never lands in the normal guidance_applied audit trail.
      if (guidance.decrypt_password) {
        addJobEvent(dbInstance, job.id, "guidance_password", {
          password: guidance.decrypt_password,
        });
      }
      setJobState(dbInstance, job.id, "queued");
      break;

    default: {
      // Exhaustiveness check — tool schema's enum constrains the
      // action, but guard at runtime in case an older client calls
      // the tool with something unexpected.
      const exhaustive: never = guidance.action;
      throw new Error(`Unknown guidance action: ${String(exhaustive)}`);
    }
  }
}

async function workerTick(): Promise<void> {
  if (workerBusy) return;
  workerBusy = true;
  try {
    reclaimStaleJobs(db, { log });
    await executeNextJob(db, { log }, fieldRegistry, notifyTelegram, mcp);
  } finally {
    workerBusy = false;
  }
}

// ── Stale guidance sweep (task 57 Phase 4.1) ─────────────────────────
//
// Jobs paused in `awaiting_user_guidance` shouldn't sit forever. Two
// tiers:
//   * REMINDER_HOURS (24h): nudge the user via notifyFn so they know
//     they owe the queue an answer. State is unchanged.
//   * TIMEOUT_HOURS  (72h): give up — fail the job with a `timed_out`
//     error so the queue doesn't leak paused jobs indefinitely.
//
// The reminder is rate-limited per job via `last_reminder_at` so the
// 60s sweep tick doesn't spam Telegram. Without the cooldown, every
// tick re-fired the same nudge as long as a job sat in the 24h–72h
// window.
//
// Timestamps are compared using ISO 8601 bound as a parameter. Do NOT
// use `datetime('now', '-N hours')` inline in SQL — production writes
// `updated_at` via `nowIso()` and the two formats are not string-
// comparable (see channels/CLAUDE.md, workflow-core.ts reclaim bug).

export const GUIDANCE_REMINDER_HOURS = 24;
export const GUIDANCE_TIMEOUT_HOURS = 72;
export const GUIDANCE_REMINDER_COOLDOWN_HOURS = 6;

export function sweepStaleGuidance(
  dbInstance: import("bun:sqlite").Database,
  notifyFn: NotifyFn,
): void {
  const now = Date.now();
  const reminderCutoffIso = new Date(
    now - GUIDANCE_REMINDER_HOURS * 3600 * 1000,
  ).toISOString();
  const timeoutCutoffIso = new Date(
    now - GUIDANCE_TIMEOUT_HOURS * 3600 * 1000,
  ).toISOString();
  const cooldownCutoffIso = new Date(
    now - GUIDANCE_REMINDER_COOLDOWN_HOURS * 3600 * 1000,
  ).toISOString();

  // Tier 1: timeout — fail jobs parked > 72h.
  const stale = dbInstance
    .prepare(
      `SELECT * FROM jobs
       WHERE state = 'awaiting_user_guidance'
         AND updated_at < ?`,
    )
    .all(timeoutCutoffIso) as JobRow[];
  for (const job of stale) {
    failJob(dbInstance, job.id, {
      code: "timed_out",
      reason: `paused for >${GUIDANCE_TIMEOUT_HOURS}h with no guidance`,
    });
  }

  // Tier 2: reminder — nudge for jobs in the 24h–72h window that
  // haven't already been nudged in the last cooldown window.
  const needsReminder = dbInstance
    .prepare(
      `SELECT * FROM jobs
       WHERE state = 'awaiting_user_guidance'
         AND updated_at < ?
         AND updated_at >= ?
         AND (last_reminder_at IS NULL OR last_reminder_at < ?)`,
    )
    .all(reminderCutoffIso, timeoutCutoffIso, cooldownCutoffIso) as JobRow[];
  if (needsReminder.length > 0) {
    const remainingH = GUIDANCE_TIMEOUT_HOURS - GUIDANCE_REMINDER_HOURS;
    void notifyFn(
      `⏰ ${needsReminder.length} job(s) awaiting your guidance — auto-cancel in ${remainingH}h.`,
    );
    const stampIso = new Date(now).toISOString();
    const placeholders = needsReminder.map(() => "?").join(",");
    dbInstance
      .prepare(`UPDATE jobs SET last_reminder_at = ? WHERE id IN (${placeholders})`)
      .run(stampIso, ...needsReminder.map((j) => j.id));
  }
}

const mcp = new Server(
  { name: "workflow", version: "0.3.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions:
      "Workflow job queue. Creates and tracks invoice/scan processing jobs.\n" +
      "Events from workflow arrive as <channel source=\"workflow\" ...>.\n" +
      "Classification requests: when you see event_type=\"classify_email\" or \"classify_document\", " +
      "run the appropriate haiku subagent and call submit_classification with the result.",
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "create_invoice_intake_job",
      description:
        "Create a durable invoice processing job. The worker handles the full pipeline: " +
        "classification, download, dedup, and upload to Paperless. " +
        "Set force=true to reprocess an email that already has a completed job.",
      inputSchema: {
        type: "object" as const,
        properties: {
          email_source: {
            type: "string",
            description: "Email source: 'gmail' or 'outlook'",
          },
          message_id: {
            type: "string",
            description: "Email message ID from the email provider",
          },
          force: {
            type: "boolean",
            description: "Bypass idempotency check to reprocess an email that already has a completed job",
          },
        },
        required: ["email_source", "message_id"],
      },
    },
    {
      name: "create_scan_intake_job",
      description:
        "Create a durable workflow job for a scanned document from Google Drive. " +
        "The worker handles the full pipeline: download, classification (via channel), upload. " +
        "Set force=true to reprocess a file that already has a completed job.",
      inputSchema: {
        type: "object" as const,
        properties: {
          file_id: { type: "string", description: "Google Drive file ID" },
          watch_folder: { type: "string", description: "Watch folder path (e.g. techlab/invoicing)" },
          month_tag: { type: "string", description: "YYYY-MM tag from scan date (hard rule)" },
          filename: { type: "string", description: "Original filename from GDrive" },
          force: { type: "boolean", description: "Bypass idempotency check" },
        },
        required: ["file_id", "watch_folder", "month_tag"],
      },
    },
    {
      name: "get_job",
      description: "Fetch a single workflow job by id.",
      inputSchema: {
        type: "object" as const,
        properties: { job_id: { type: "string" } },
        required: ["job_id"],
      },
    },
    {
      name: "list_jobs",
      description: "List recent workflow jobs with optional filters.",
      inputSchema: {
        type: "object" as const,
        properties: {
          state: { type: "string" },
          workflow_type: { type: "string" },
          limit: { type: "number" },
        },
      },
    },
    {
      name: "get_job_events",
      description: "Get the event history for a workflow job.",
      inputSchema: {
        type: "object" as const,
        properties: { job_id: { type: "string" } },
        required: ["job_id"],
      },
    },
    {
      name: "approve_job",
      description: "Approve a paused workflow job and re-queue it.",
      inputSchema: {
        type: "object" as const,
        properties: {
          job_id: { type: "string" },
          approved_by: { type: "string" },
          note: { type: "string" },
        },
        required: ["job_id"],
      },
    },
    {
      name: "cancel_job",
      description: "Cancel a queued, running, or approval-paused workflow job.",
      inputSchema: {
        type: "object" as const,
        properties: {
          job_id: { type: "string" },
          reason: { type: "string" },
        },
        required: ["job_id"],
      },
    },
    {
      name: "submit_classification",
      description:
        "Submit a classification result for a job awaiting classification. " +
        "Called by Claude after running a haiku subagent (email-classifier or document-classifier).",
      inputSchema: {
        type: "object" as const,
        properties: {
          job_id: { type: "string", description: "Job ID" },
          step: {
            type: "string",
            enum: ["classify_email", "classify_document"],
            description: "Which classification step this result is for",
          },
          result: {
            type: "object",
            description: "Classification result JSON from the haiku subagent",
          },
        },
        required: ["job_id", "step", "result"],
      },
    },
    {
      name: "provide_guidance",
      description:
        "Resume a job paused in awaiting_user_guidance with user input. " +
        "Action is one of: skip, retry, fail, patch. " +
        "`patch` re-queues the job with a payload patch the worker merges on pickup; " +
        "`decrypt_password` is stored under a separate, sensitive guidance_password event.",
      inputSchema: {
        type: "object" as const,
        properties: {
          job_id: { type: "string" },
          guidance: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["skip", "retry", "fail", "patch"] },
              patch: { type: "object" },
              decrypt_password: { type: "string" },
              user_note: { type: "string" },
            },
            required: ["action"],
          },
        },
        required: ["job_id", "guidance"],
      },
    },
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "create_invoice_intake_job": {
        const emailSource = args?.email_source as string;
        const messageId = args?.message_id as string;
        if (!emailSource || !messageId) {
          return {
            content: [text("Error: email_source and message_id are required")],
            isError: true,
          };
        }

        // Use source:message_id as idempotency key; force bypasses with unique suffix
        // AND propagates into input_json so the worker can branch dedup → patch.
        const force = Boolean(args?.force);
        const inputPayload = {
          email_source: emailSource,
          message_id: messageId,
          ...(force ? { force: true } : {}),
        };
        const idempotencyKey = force
          ? `${emailSource}:${messageId}:force-${Date.now()}`
          : `${emailSource}:${messageId}`;

        const job = createJob(db, {
          workflowType: "invoice_intake",
          inputJson: JSON.stringify(inputPayload),
          sourceRef: `${emailSource}:${messageId}`,
          idempotencyKey,
          requiresApproval: false,
        });

        // Emit job_created span (links to email's trace)
        try {
          const emailDbPath = process.env.EMAIL_DB_PATH ?? "/mnt/shared_configs/personal-assistant/email-watcher/emails.db";
          const { Database: BunDb } = require("bun:sqlite");
          const emailDb = new BunDb(emailDbPath, { readonly: true });
          const traceId = getEmailTraceId(emailDb, messageId);
          emailDb.close();
          if (traceId) {
            const tracer = getTracer("workflow");
            const parentCtx = remoteParentContext(traceId);
            tracer.startActiveSpan(`workflow.job_created`, {
              attributes: {
                "job.type": "invoice_intake",
                "email.source": emailSource,
                "email.message_id": messageId,
              },
            }, parentCtx, (span) => {
              span.setStatus({ code: SpanStatusCode.OK });
              span.end();
            });
          }
        } catch { /* email DB not available — skip tracing */ }

        return { content: [text(job)] };
      }

      case "create_scan_intake_job": {
        const fileId = args?.file_id as string;
        const watchFolder = args?.watch_folder as string;
        const monthTag = args?.month_tag as string;
        if (!fileId || !watchFolder || !monthTag) {
          return { content: [text("Error: file_id, watch_folder, and month_tag are required")], isError: true };
        }

        const force = Boolean(args?.force);
        const inputPayload = {
          source: "gdrive",
          file_id: fileId,
          watch_folder: watchFolder,
          month_tag: monthTag,
          filename: (args?.filename as string | undefined) ?? undefined,
          ...(force ? { force: true } : {}),
        };

        const idempotencyKey = force
          ? `gdrive:${fileId}:force-${Date.now()}`
          : `gdrive:${fileId}`;

        const job = createJob(db, {
          workflowType: "scan_intake",
          inputJson: JSON.stringify(inputPayload),
          sourceRef: `gdrive:${fileId}`,
          idempotencyKey,
          requiresApproval: false,
        });
        return { content: [text(job)] };
      }

      case "get_job": {
        const jobId = args?.job_id as string;
        const job = getJob(db, jobId);
        if (!job) {
          return { content: [text(`Job ${jobId} not found`)], isError: true };
        }
        return { content: [text(job)] };
      }

      case "list_jobs": {
        const jobs = listJobs(db, {
          state: (args?.state as any) ?? undefined,
          workflowType: (args?.workflow_type as string | undefined) ?? undefined,
          limit: (args?.limit as number | undefined) ?? 20,
        });
        return { content: [text(jobs)] };
      }

      case "get_job_events": {
        const jobId = args?.job_id as string;
        return { content: [text(getJobEvents(db, jobId))] };
      }

      case "approve_job": {
        const jobId = args?.job_id as string;
        const ok = approveJob(
          db,
          jobId,
          (args?.approved_by as string | undefined) ?? null,
          (args?.note as string | undefined) ?? null,
        );
        if (!ok) {
          return { content: [text(`Job ${jobId} is not awaiting approval`)], isError: true };
        }
        return { content: [text(getJob(db, jobId))] };
      }

      case "cancel_job": {
        const jobId = args?.job_id as string;
        const ok = cancelJob(db, jobId, (args?.reason as string | undefined) ?? null);
        if (!ok) {
          return { content: [text(`Job ${jobId} cannot be cancelled`)], isError: true };
        }
        return { content: [text(getJob(db, jobId))] };
      }

      case "submit_classification": {
        const jobId = args?.job_id as string;
        const step = args?.step as string;
        const result = args?.result as Record<string, unknown>;
        if (!jobId || !step || !result) {
          return { content: [text("Error: job_id, step, and result are required")], isError: true };
        }
        const ok = submitClassification(db, jobId, step, result);
        if (!ok) {
          // submitClassification returns false for FOUR distinct reasons.
          // Re-fetch the job to give the caller the actual reason instead of
          // a generic message — schema validation failures left for hours of
          // debugging in the past, see _tasks/46-mcp-oauth-state-cleanup/.
          const j = getJob(db, jobId);
          if (!j) {
            return { content: [text(`Error: job ${jobId} not found`)], isError: true };
          }
          if (j.state === "failed" && j.error_json) {
            const errMsg = (() => {
              try {
                const e = JSON.parse(j.error_json);
                if (e.code === "schema_validation_failed") {
                  return `Schema validation failed for ${step}: ${e.message} (field: ${e.field ?? "?"})`;
                }
                return e.message ?? j.error_json;
              } catch {
                return j.error_json;
              }
            })();
            return { content: [text(`Error: job ${jobId} is failed — ${errMsg}`)], isError: true };
          }
          return { content: [text(`Error: job ${jobId} cannot accept submit_classification (state=${j.state}, expected awaiting_classification with matching step_started)`)], isError: true };
        }
        return { content: [text({ success: true, job_id: jobId, step })] };
      }

      case "provide_guidance": {
        const jobId = args?.job_id as string;
        const guidance = args?.guidance as Guidance | undefined;
        if (!jobId || !guidance || !guidance.action) {
          return {
            content: [text("Error: job_id and guidance.action are required")],
            isError: true,
          };
        }
        handleProvideGuidance(db, { job_id: jobId, guidance });
        return { content: [text({ success: true, job_id: jobId, action: guidance.action })] };
      }

      default:
        return { content: [text(`Unknown tool: ${name}`)], isError: true };
    }
  } catch (error) {
    return {
      content: [
        text({
          error: error instanceof Error ? error.message : String(error),
        }),
      ],
      isError: true,
    };
  }
});

async function main(): Promise<void> {
  db = openWorkflowDb(WORKFLOW_DB_PATH);
  log(`Opened workflow DB at ${WORKFLOW_DB_PATH}`);

  // Defense-in-depth: on startup, sweep the downloads directory and delete
  // any file older than DOWNLOAD_SWEEP_MAX_AGE_MS that isn't referenced by
  // an active job. Per-job cleanup runs in completeJob/failJob/cancelJob;
  // this catches orphans left behind by crashes or test runs.
  const downloadDir = process.env.DOWNLOAD_DIR ?? "/workspace/downloads";
  const sweepMaxAgeMs = parseInt(
    process.env.DOWNLOAD_SWEEP_MAX_AGE_MS ?? String(7 * 24 * 60 * 60 * 1000),
    10,
  );
  try {
    const sweep = sweepOrphanedDownloads(db, downloadDir, sweepMaxAgeMs, { log });
    log(
      `Download sweep: scanned=${sweep.scanned} deleted=${sweep.deleted} preserved=${sweep.preserved}`,
    );
  } catch (err) {
    log(`Download sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const paperlessUrl = process.env.PAPERLESS_URL;
  if (!paperlessUrl) throw new Error("PAPERLESS_URL environment variable is required");
  const paperlessToken = process.env.PAPERLESS_API_TOKEN ?? "";
  fieldRegistry = new PaperlessFieldRegistry(paperlessUrl, paperlessToken, log);
  await fieldRegistry.init();
  log("Custom field registry initialized");

  // Side HTTP server for Docker health check only
  Bun.serve({
    port: WORKFLOW_PORT,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/health") return new Response("ok", { status: 200 });
      return new Response("Not Found", { status: 404 });
    },
  });
  log(`Health endpoint on :${WORKFLOW_PORT}/health`);

  // Connect MCP via stdio (channel mode)
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  await mcp.connect(new StdioServerTransport());
  log("MCP server connected (stdio)");

  // Start worker poll loop
  await workerTick();
  setInterval(() => {
    workerTick().catch((error) => {
      log(`Worker tick failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, WORKFLOW_POLL_MS);

  // Stale-guidance sweep: nudge the user at 24h, auto-fail at 72h.
  // Runs every 60s — cheap (a couple of indexed SELECTs against jobs)
  // and decoupled from the fast worker-tick cadence. See task 57 Phase 4.1.
  setInterval(() => {
    try {
      sweepStaleGuidance(db, notifyTelegram);
    } catch (err) {
      log(
        `Stale-guidance sweep failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, 60_000);
}

if (import.meta.main) {
  main().catch((error) => {
    log(`Fatal error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
