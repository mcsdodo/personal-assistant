#!/usr/bin/env bun

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Database } from "bun:sqlite";

import { executeNextJob } from "./workflow-core";
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

async function workerTick(): Promise<void> {
  if (workerBusy) return;
  workerBusy = true;
  try {
    await executeNextJob(db, { log });
  } finally {
    workerBusy = false;
  }
}

const mcp = new Server(
  { name: "workflow", version: "0.1.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "Use workflow tools for durable background jobs. " +
      "Prefer them for stateful or restart-sensitive work. " +
      "For now, the worker supports synthetic verification jobs.",
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "create_job",
      description: "Create a durable workflow job. Phase 1 supports workflow_type='synthetic'.",
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
