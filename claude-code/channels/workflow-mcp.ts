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
  createJob,
  getJob,
  getJobEvents,
  listJobs,
  openWorkflowDb,
  submitClassification,
} from "./workflow-db";

import { initTracing, createLogger, getTracer, remoteParentContext, SpanStatusCode } from "./tracing";
import { getEmailTraceId } from "./db";

const WORKFLOW_DB_PATH = process.env.WORKFLOW_DB_PATH ?? "/data/email-watcher/workflow.db";
const WORKFLOW_POLL_MS = parseInt(process.env.WORKFLOW_POLL_MS ?? "2000", 10);
const WORKFLOW_PORT = parseInt(process.env.WORKFLOW_MCP_PORT ?? "8003", 10);

initTracing("workflow");
const log = createLogger("workflow");

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
          return { content: [text("Error: job not found, not awaiting classification, or step mismatch")], isError: true };
        }
        return { content: [text({ success: true, job_id: jobId, step })] };
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
}

if (import.meta.main) {
  main().catch((error) => {
    log(`Fatal error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
