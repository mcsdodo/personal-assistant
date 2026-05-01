import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  addJobEvent,
  createJob,
  getJobEvents,
  openWorkflowDb,
  setJobState,
} from "./workflow-db";
import { pushPendingClassifications } from "./workflow-mcp";

/**
 * Minimal stand-in for the MCP `Server` so we can record the calls
 * `pushPendingClassifications` makes against the live Claude channel.
 * The function only ever invokes `notification(...)`, so that's all the
 * fake exposes; we cast it to `any` at the call site to satisfy the
 * `Server` parameter type without dragging in the full SDK shape.
 */
interface PushedNotification {
  method: string;
  params: { content: string; meta: Record<string, unknown> };
}

function makeFakeChannel(): {
  pushed: PushedNotification[];
  notification: (n: PushedNotification) => Promise<void>;
} {
  const pushed: PushedNotification[] = [];
  return {
    pushed,
    notification: async (n: PushedNotification) => {
      pushed.push(n);
    },
  };
}

let tmpDir: string;
let db: Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wf-pushloop-test-"));
  db = openWorkflowDb(join(tmpDir, "workflow.db"));
});

afterEach(() => {
  db.close();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Windows can briefly lock WAL files after close.
  }
});

describe("pushPendingClassifications", () => {
  test("pushes once and is idempotent on repeat invocation", async () => {
    const job = createJob(db, {
      workflowType: "invoice_intake",
      inputJson: JSON.stringify({ email_source: "gmail", message_id: "m1" }),
      sourceRef: "gmail:m1",
      idempotencyKey: "pushloop-A",
      requiresApproval: false,
    });
    setJobState(db, job.id, "awaiting_classification");
    addJobEvent(db, job.id, "classification_request_meta", {
      event_type: "classify_email",
      email_source: "gmail",
      message_id: "m1",
      job_id: job.id,
    });

    const channel = makeFakeChannel();

    await pushPendingClassifications(db, channel as any);

    expect(channel.pushed.length).toBe(1);
    expect(channel.pushed[0].method).toBe("notifications/claude/channel");

    // Second call — should NOT push again because of the
    // classification_pushed dedupe event written on the first call.
    await pushPendingClassifications(db, channel as any);

    expect(channel.pushed.length).toBe(1);

    const events = getJobEvents(db, job.id);
    const pushedEvents = events.filter((e) => e.event_type === "classification_pushed");
    expect(pushedEvents.length).toBe(1);
  });

  test("skips jobs without a classification_request_meta breadcrumb", async () => {
    const job = createJob(db, {
      workflowType: "invoice_intake",
      inputJson: JSON.stringify({ email_source: "gmail", message_id: "m2" }),
      sourceRef: "gmail:m2",
      idempotencyKey: "pushloop-B",
      requiresApproval: false,
    });
    setJobState(db, job.id, "awaiting_classification");
    // Intentionally NO classification_request_meta event written.

    const channel = makeFakeChannel();

    await pushPendingClassifications(db, channel as any);

    expect(channel.pushed.length).toBe(0);

    const events = getJobEvents(db, job.id);
    const pushedEvents = events.filter((e) => e.event_type === "classification_pushed");
    expect(pushedEvents.length).toBe(0);
  });
});
