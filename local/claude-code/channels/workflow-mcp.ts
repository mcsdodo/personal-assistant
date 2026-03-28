#!/usr/bin/env bun

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Database } from "bun:sqlite";

import { executeNextJob } from "./workflow-core";
import { PaperlessFieldRegistry } from "./paperless-fields";
import {
  approveJob,
  cancelJob,
  createJob,
  getJob,
  getJobEvents,
  listJobs,
  openWorkflowDb,
} from "./workflow-db";

const WORKFLOW_DB_PATH = process.env.WORKFLOW_DB_PATH ?? "/data/email-watcher/workflow.db";
const WORKFLOW_POLL_MS = parseInt(process.env.WORKFLOW_POLL_MS ?? "2000", 10);

function log(message: string): void {
  console.error(`[workflow] ${message}`);
}

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
    await executeNextJob(db, { log }, fieldRegistry);
  } finally {
    workerBusy = false;
  }
}

const mcp = new Server(
  { name: "workflow", version: "0.2.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "Use workflow tools for durable background jobs. " +
      "For invoice processing, prefer create_invoice_intake_job over direct inline processing. " +
      "The worker handles download, dedup, and upload deterministically.",
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "create_job",
      description: "Create a generic durable workflow job. Supports workflow_type='synthetic' and 'invoice_intake'.",
      inputSchema: {
        type: "object" as const,
        properties: {
          workflow_type: { type: "string" },
          input_json: {
            type: "string",
            description: "JSON string payload. For synthetic jobs use {\"mode\":\"success|fail|needs_approval\"}.",
          },
          source_ref: { type: "string" },
          idempotency_key: { type: "string" },
          requires_approval: { type: "boolean" },
        },
        required: ["workflow_type"],
      },
    },
    {
      name: "create_invoice_intake_job",
      description:
        "Create a durable invoice processing job. Use this after classifying an email as an invoice. " +
        "Pass file_path if the PDF is already downloaded to disk. " +
        "The worker will check for duplicates and upload to Paperless.",
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
          classification: {
            type: "object",
            description:
              "Classification output from email-classifier. Must include: is_invoice, confidence, vendor, " +
              "doc_type, suggested_tags, action, download_strategy, strategy_confidence, requires_review, " +
              "order_id, total_amount, currency",
          },
          subject: {
            type: "string",
            description: "Email subject line (for title generation)",
          },
          sender: {
            type: "string",
            description: "Email sender address",
          },
          received_at: {
            type: "string",
            description: "Email received timestamp (ISO format)",
          },
          file_path: {
            type: "string",
            description: "Path to pre-downloaded file on disk (Claude downloads before creating job)",
          },
          month_tag: {
            type: "string",
            description: "YYYY-MM tag (Claude infers from email context)",
          },
        },
        required: ["email_source", "message_id", "classification"],
      },
    },
    {
      name: "create_scan_intake_job",
      description: "Create a durable workflow job for a scanned document from Google Drive.",
      inputSchema: {
        type: "object" as const,
        properties: {
          file_id: { type: "string", description: "Google Drive file ID" },
          filename: { type: "string", description: "Original filename" },
          month_tag: { type: "string", description: "YYYY-MM tag derived from scan date" },
          classification: {
            type: "object",
            description: "Classification result from scan-classifier agent",
          },
          file_path: {
            type: "string",
            description: "Path to pre-downloaded file on disk",
          },
        },
        required: ["file_id", "classification"],
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
  ],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "create_job": {
        const workflowType = args?.workflow_type as string;
        if (!workflowType) {
          return { content: [text("Error: workflow_type is required")], isError: true };
        }
        const job = createJob(db, {
          workflowType,
          inputJson: (args?.input_json as string | undefined) ?? null,
          sourceRef: (args?.source_ref as string | undefined) ?? null,
          idempotencyKey: (args?.idempotency_key as string | undefined) ?? null,
          requiresApproval: Boolean(args?.requires_approval),
        });
        return { content: [text(job)] };
      }

      case "create_invoice_intake_job": {
        const emailSource = args?.email_source as string;
        const messageId = args?.message_id as string;
        const classification = args?.classification as Record<string, unknown>;
        if (!emailSource || !messageId || !classification) {
          return {
            content: [text("Error: email_source, message_id, and classification are required")],
            isError: true,
          };
        }

        // Build the input payload
        const inputPayload = {
          email_source: emailSource,
          message_id: messageId,
          classification,
          subject: (args?.subject as string | undefined) ?? undefined,
          sender: (args?.sender as string | undefined) ?? undefined,
          received_at: (args?.received_at as string | undefined) ?? undefined,
          file_path: (args?.file_path as string | undefined) ?? undefined,
          month_tag: (args?.month_tag as string | undefined) ?? undefined,
        };

        // Use source:message_id as idempotency key
        const idempotencyKey = `${emailSource}:${messageId}`;

        const job = createJob(db, {
          workflowType: "invoice_intake",
          inputJson: JSON.stringify(inputPayload),
          sourceRef: `${emailSource}:${messageId}`,
          idempotencyKey,
          requiresApproval: false,
        });
        return { content: [text(job)] };
      }

      case "create_scan_intake_job": {
        const fileId = args?.file_id as string;
        const classification = args?.classification as Record<string, unknown>;
        if (!fileId || !classification) {
          return { content: [text("Error: file_id and classification are required")], isError: true };
        }

        const inputPayload = {
          source: "gdrive",
          file_id: fileId,
          filename: (args?.filename as string | undefined) ?? undefined,
          month_tag: (args?.month_tag as string | undefined) ?? undefined,
          classification,
          file_path: (args?.file_path as string | undefined) ?? undefined,
        };

        const idempotencyKey = `gdrive:${fileId}`;

        const job = createJob(db, {
          workflowType: "scan_intake",
          inputJson: JSON.stringify(inputPayload),
          sourceRef: `gdrive:${fileId}`,
          idempotencyKey,
          requiresApproval: false,
        });
        return { content: [text(JSON.stringify(job, null, 2))] };
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

  const paperlessUrl = process.env.PAPERLESS_URL ?? "https://documents.lacny.me";
  const paperlessToken = process.env.PAPERLESS_API_TOKEN ?? "";
  fieldRegistry = new PaperlessFieldRegistry(paperlessUrl, paperlessToken, log);
  await fieldRegistry.init();
  log("Custom field registry initialized");

  await mcp.connect(new StdioServerTransport());
  log("Workflow MCP connected (stdio)");

  await workerTick();
  setInterval(() => {
    workerTick().catch((error) => {
      log(`Worker tick failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }, WORKFLOW_POLL_MS);
}

main().catch((error) => {
  log(`Fatal error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
