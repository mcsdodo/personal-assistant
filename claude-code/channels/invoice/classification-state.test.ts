import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  openWorkflowDb,
  createJob,
  getJobEvents,
} from "../workflow-db";
import { parkForClassification } from "./classification-state";

let tmpDir: string;
let db: Database;
const silentLogger = { log: () => {} };

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "park-classify-test-"));
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

describe("parkForClassification breadcrumb event", () => {
  test("writes a classification_request_meta event carrying the notification meta", async () => {
    const job = createJob(db, {
      workflowType: "invoice_intake",
      inputJson: JSON.stringify({ email_source: "gmail", message_id: "m-1" }),
      sourceRef: "gmail:m-1",
      idempotencyKey: "park-classify-k1",
      requiresApproval: false,
    });
    // requestClassification only transitions out of state='running'.
    db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(job.id);

    const notificationMeta = {
      event_type: "classify_email",
      job_id: job.id,
      email_source: "gmail",
      message_id: "m-1",
      user_google_email: "user@example.com",
    };

    await parkForClassification(
      db,
      job.id,
      {
        step: "classify_email",
        parkedPayload: { email_source: "gmail", message_id: "m-1" },
        // No `channel` — exercises the path where the worker has no MCP
        // server attached (the post-extraction pa-worker container case).
        notificationContent: "Classification request: invoke email-classifier.",
        notificationMeta,
      },
      silentLogger,
    );

    const events = getJobEvents(db, job.id);
    const breadcrumb = events.find((e) => e.event_type === "classification_request_meta");
    expect(breadcrumb).toBeDefined();
    expect(breadcrumb!.payload_json).not.toBeNull();
    const parsed = JSON.parse(breadcrumb!.payload_json!);
    expect(parsed.event_type).toBe("classify_email");
    expect(parsed.email_source).toBe("gmail");
    expect(parsed.message_id).toBe("m-1");
    expect(parsed.job_id).toBe(job.id);
    expect(parsed.user_google_email).toBe("user@example.com");
  });

  test("breadcrumb is written even when channel is provided", async () => {
    // Backwards-compatibility: existing callers pass a channel; the
    // workflow-mcp push loop will dedupe via classification_pushed events,
    // so writing the breadcrumb in both paths is safe.
    const job = createJob(db, {
      workflowType: "scan_intake",
      inputJson: JSON.stringify({ file_id: "drv-1" }),
      sourceRef: "drv-1",
      idempotencyKey: "park-classify-k2",
      requiresApproval: false,
    });
    db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(job.id);

    let pushed = 0;
    const fakeChannel = {
      notification: async () => {
        pushed += 1;
      },
    };

    const notificationMeta = {
      event_type: "classify_document",
      job_id: job.id,
      file_path: "/workspace/downloads/scan-1.pdf",
    };

    await parkForClassification(
      db,
      job.id,
      {
        step: "classify_document",
        parkedPayload: { file_path: "/workspace/downloads/scan-1.pdf" },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        channel: fakeChannel as any,
        notificationContent: "Classification request: invoke document-classifier.",
        notificationMeta,
      },
      silentLogger,
    );

    expect(pushed).toBe(1);
    const events = getJobEvents(db, job.id);
    const breadcrumb = events.find((e) => e.event_type === "classification_request_meta");
    expect(breadcrumb).toBeDefined();
    expect(JSON.parse(breadcrumb!.payload_json!).event_type).toBe("classify_document");
  });
});
