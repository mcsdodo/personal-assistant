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

  test("pushes a second classification request on the same job", async () => {
    // A job goes through classify_email → classify_document. Each step
    // writes its own classification_request_meta breadcrumb. The push loop
    // must fire once per breadcrumb, not once per job.
    const job = createJob(db, {
      workflowType: "invoice_intake",
      inputJson: JSON.stringify({ email_source: "gmail", message_id: "m-multi" }),
      sourceRef: "gmail:m-multi",
      idempotencyKey: "pushloop-multi",
      requiresApproval: false,
    });
    setJobState(db, job.id, "awaiting_classification");
    addJobEvent(db, job.id, "classification_request_meta", {
      event_type: "classify_email",
      email_source: "gmail",
      message_id: "m-multi",
      job_id: job.id,
    });

    const channel = makeFakeChannel();
    await pushPendingClassifications(db, channel as any);
    expect(channel.pushed.length).toBe(1);
    expect(channel.pushed[0].params.meta.event_type).toBe("classify_email");

    // Simulate Claude completing the email step and the worker requesting
    // document classification next. Job stays in awaiting_classification.
    addJobEvent(db, job.id, "classification_request_meta", {
      event_type: "classify_document",
      file_path: "/workspace/downloads/invoice.pdf",
      job_id: job.id,
    });

    await pushPendingClassifications(db, channel as any);
    expect(channel.pushed.length).toBe(2);
    expect(channel.pushed[1].params.meta.event_type).toBe("classify_document");

    // A third call should be a no-op — both breadcrumbs are now answered.
    await pushPendingClassifications(db, channel as any);
    expect(channel.pushed.length).toBe(2);

    const events = getJobEvents(db, job.id);
    const pushedEvents = events.filter((e) => e.event_type === "classification_pushed");
    expect(pushedEvents.length).toBe(2);
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

  // Regression: task 98 wrote a numeric sentinel_start_ms into the breadcrumb
  // meta. Channel meta becomes XML attributes on the <channel> tag, and Claude
  // Code's notification handler throws an uncaught ZodError on any non-string
  // value — which dropped the stdio transport and crash-looped the container on
  // every classification push. The push loop must coerce all meta values to
  // strings so the notification is never sent a non-string field.
  test("coerces non-string meta values to strings before pushing", async () => {
    const job = createJob(db, {
      workflowType: "invoice_intake",
      inputJson: JSON.stringify({ email_source: "gmail", message_id: "m3" }),
      sourceRef: "gmail:m3",
      idempotencyKey: "pushloop-C",
      requiresApproval: false,
    });
    setJobState(db, job.id, "awaiting_classification");
    addJobEvent(db, job.id, "classification_request_meta", {
      event_type: "classify_email",
      email_source: "gmail",
      message_id: "m3",
      job_id: job.id,
      sentinel_trace_id: "abc123",
      sentinel_parent_span_id: "def456",
      sentinel_start_ms: 1782803304949, // numeric on purpose — must be stringified
    });

    const channel = makeFakeChannel();

    await pushPendingClassifications(db, channel as any);

    expect(channel.pushed.length).toBe(1);
    const meta = channel.pushed[0].params.meta;
    // Every value must be a string — no exceptions.
    for (const [key, value] of Object.entries(meta)) {
      expect(typeof value).toBe("string");
      expect(`${key}=${typeof value}`).toBe(`${key}=string`);
    }
    expect(meta.sentinel_start_ms).toBe("1782803304949");
  });
});
