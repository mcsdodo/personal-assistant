#!/usr/bin/env bun

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Database } from "bun:sqlite";

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
} from "./workflow-db";

import { initTracing, createLogger, getMeter, getTracer, remoteParentContext, SpanStatusCode } from "./tracing";

// Re-export from worker.ts (task 64) so existing tests/callers using
// `import { sweepStaleGuidance, GUIDANCE_* } from "./workflow-mcp"` keep
// working unchanged after the function moved to the standalone worker module.
export {
  sweepStaleGuidance,
  GUIDANCE_REMINDER_HOURS,
  GUIDANCE_TIMEOUT_HOURS,
  GUIDANCE_REMINDER_COOLDOWN_HOURS,
} from "./worker";

const WORKFLOW_DB_PATH = process.env.WORKFLOW_DB_PATH ?? "/data/email-watcher/workflow.db";
const WORKFLOW_POLL_MS = parseInt(process.env.WORKFLOW_POLL_MS ?? "2000", 10);

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

function text(value: unknown): { type: "text"; text: string } {
  return {
    type: "text",
    text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
  };
}

let db: Database;

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

// ── Classification push loop (task 64 / Phase 2) ─────────────────────
//
// The soon-to-be-extracted pa-worker container runs the executor loop
// without an MCP server attached to a live Claude session, so it can't
// push channel notifications itself. Instead, `parkForClassification`
// writes a `classification_request_meta` job event as a breadcrumb;
// this loop runs inside `workflow-mcp.ts` (which DOES own the live
// channel) and replays each breadcrumb as an actual
// `notifications/claude/channel` push. A `classification_pushed` event
// is written after each successful push to dedupe re-runs — the loop
// will pick a job up only when it has a meta breadcrumb AND no prior
// `classification_pushed` event.
//
// Not yet wired into the worker tick — task 64 / Phase 4 hooks it into
// `main()`. Exported now so its tests can drive it directly.
export async function pushPendingClassifications(
  dbInstance: Database,
  channel: Server,
): Promise<void> {
  const pending = dbInstance.prepare(
    `SELECT j.id FROM jobs j
     WHERE j.state = 'awaiting_classification'
       AND NOT EXISTS (
         SELECT 1 FROM job_events e
         WHERE e.job_id = j.id AND e.event_type = 'classification_pushed'
       )
       AND EXISTS (
         SELECT 1 FROM job_events e
         WHERE e.job_id = j.id AND e.event_type = 'classification_request_meta'
       )`,
  ).all() as { id: string }[];

  for (const { id } of pending) {
    const metaRow = dbInstance.prepare(
      `SELECT payload_json FROM job_events
       WHERE job_id = ? AND event_type = 'classification_request_meta'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).get(id) as { payload_json: string } | undefined;
    if (!metaRow) continue;
    const meta = JSON.parse(metaRow.payload_json);
    const eventType = String(meta.event_type ?? "classify_email");
    const content = `${eventType} job_id=${id}`;
    try {
      await channel.notification({
        method: "notifications/claude/channel",
        params: { content, meta },
      });
      addJobEvent(dbInstance, id, "classification_pushed", { meta_event_type: eventType });
    } catch (err) {
      log(`pushPendingClassifications: failed to push for job ${id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ── Read-only audit-DB handles for debug tools (task 62) ─────────────
//
// `emails.db` is owned by `personal-assistant-email-poller`; `gdrive.db`
// is owned by `personal-assistant-gdrive-poller`. Both ship via the
// shared volume at /data/email-watcher and /data/gdrive-watcher.
// We open them read-only and cache the handle on first use so we never
// race the pollers' WAL writes.

const EMAIL_DB_PATH = process.env.EMAIL_DB_PATH ?? "/data/email-watcher/emails.db";
const GDRIVE_DB_PATH = process.env.GDRIVE_DB_PATH ?? "/data/gdrive-watcher/gdrive.db";

let emailDbRo: Database | null = null;
let gdriveDbRo: Database | null = null;

export function openEmailDbReadOnly(path: string = EMAIL_DB_PATH): Database {
  return new Database(path, { readonly: true });
}
export function openGdriveDbReadOnly(path: string = GDRIVE_DB_PATH): Database {
  return new Database(path, { readonly: true });
}
function getEmailDbRo(): Database {
  if (!emailDbRo) emailDbRo = openEmailDbReadOnly();
  return emailDbRo;
}
function getGdriveDbRo(): Database {
  if (!gdriveDbRo) gdriveDbRo = openGdriveDbReadOnly();
  return gdriveDbRo;
}

// ── Handlers (exported for unit tests; called from the MCP switch) ──
export function handleGetRecentEmails(
  roDb: Database,
  opts: { limit?: number; source?: string },
): unknown[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (opts.source) { conditions.push("source = ?"); params.push(opts.source); }
  let sql = "SELECT * FROM emails";
  if (conditions.length) sql += " WHERE " + conditions.join(" AND ");
  sql += " ORDER BY discovered_at DESC";
  if (opts.limit) { sql += " LIMIT ?"; params.push(opts.limit); }
  return roDb.prepare(sql).all(...params);
}

export function handleGetEmailStats(roDb: Database): { total: number; last_24h: number } {
  const total = roDb.prepare("SELECT COUNT(*) as count FROM emails").get() as { count: number };
  const last24h = roDb.prepare(
    "SELECT COUNT(*) as count FROM emails WHERE discovered_at >= datetime('now', '-1 day')",
  ).get() as { count: number };
  return { total: total.count, last_24h: last24h.count };
}

export function handleGetGdriveScanStatus(
  roDb: Database,
  opts: { limit?: number },
): unknown[] {
  return roDb.prepare("SELECT * FROM gdrive_files ORDER BY discovered_at DESC LIMIT ?")
    .all(opts.limit ?? 20);
}

export function handleGetGdriveScanStats(roDb: Database): { total: number } {
  const row = roDb.prepare("SELECT COUNT(*) as count FROM gdrive_files").get() as { count: number };
  return { total: row.count };
}

export interface InvoiceIntakeInputPayload {
  email_source: string;
  message_id: string;
  sender: string | null;
  subject: string | null;
  received_at: string | null;
  force?: true;
}

// Builds the input_json payload for a manual `create_invoice_intake_job` call.
// Watcher-created jobs ship sender/subject/received_at directly; manual jobs
// only get email_source+message_id from the operator. Look those fields up
// from the emails.db audit row so `submitClassification`'s merge step has
// real values, otherwise vendor-rule link extraction in `extractInvoiceLinks`
// bails out (sender+subject both null short-circuits to no matches).
export function buildInvoiceIntakeInputPayload(
  emailDbRo: Database,
  args: { email_source: string; message_id: string; force: boolean },
): InvoiceIntakeInputPayload {
  const row = emailDbRo
    .prepare("SELECT sender, subject, received_at FROM emails WHERE id = ? LIMIT 1")
    .get(args.message_id) as
      | { sender: string | null; subject: string | null; received_at: string | null }
      | null;
  return {
    email_source: args.email_source,
    message_id: args.message_id,
    sender: row?.sender ?? null,
    subject: row?.subject ?? null,
    received_at: row?.received_at ?? null,
    ...(args.force ? { force: true as const } : {}),
  };
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
    {
      name: "get_recent_emails",
      description: "Read recent rows from the email-poller audit log (read-only).",
      inputSchema: {
        type: "object" as const,
        properties: {
          limit: { type: "number", description: "Max rows (default: 20)" },
          source: { type: "string", description: "Filter by source (gmail, outlook)" },
        },
      },
    },
    {
      name: "get_email_stats",
      description: "Total email count and last-24-hour count from the email-poller audit log.",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "get_gdrive_scan_status",
      description: "Recent rows from the gdrive-poller audit log (read-only).",
      inputSchema: {
        type: "object" as const,
        properties: { limit: { type: "number", description: "Max rows (default: 20)" } },
      },
    },
    {
      name: "get_gdrive_scan_stats",
      description: "Total file count from the gdrive-poller audit log.",
      inputSchema: { type: "object" as const, properties: {} },
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
        const inputPayload = buildInvoiceIntakeInputPayload(getEmailDbRo(), {
          email_source: emailSource,
          message_id: messageId,
          force,
        });
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
          const row = getEmailDbRo()
            .prepare("SELECT trace_id FROM emails WHERE id = ? LIMIT 1")
            .get(messageId) as { trace_id: string | null } | null;
          const traceId = row?.trace_id ?? null;
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

      case "get_recent_emails": {
        const rows = handleGetRecentEmails(getEmailDbRo(), {
          limit: args?.limit as number | undefined,
          source: args?.source as string | undefined,
        });
        return { content: [text(rows)] };
      }
      case "get_email_stats": {
        return { content: [text(handleGetEmailStats(getEmailDbRo()))] };
      }
      case "get_gdrive_scan_status": {
        const rows = handleGetGdriveScanStatus(getGdriveDbRo(), {
          limit: args?.limit as number | undefined,
        });
        return { content: [text(rows)] };
      }
      case "get_gdrive_scan_stats": {
        return { content: [text(handleGetGdriveScanStats(getGdriveDbRo()))] };
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

  // Connect MCP via stdio (channel mode)
  const { StdioServerTransport } = await import(
    "@modelcontextprotocol/sdk/server/stdio.js"
  );
  await mcp.connect(new StdioServerTransport());
  log("MCP server connected (stdio)");

  // Channel push loop: drain classification_request_meta breadcrumbs
  // (written by pa-worker) into Claude-bound channel notifications.
  setInterval(() => {
    pushPendingClassifications(db, mcp).catch((err) => {
      log(`pushPendingClassifications failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, WORKFLOW_POLL_MS);
}

if (import.meta.main) {
  main().catch((error) => {
    log(`Fatal error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
