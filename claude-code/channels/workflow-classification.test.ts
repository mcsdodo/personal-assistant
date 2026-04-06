import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  openWorkflowDb,
  createJob,
  cancelJob,
  getJob,
  getJobEvents,
  claimNextQueuedJob,
  requestClassification,
  submitClassification,
} from "./workflow-db";

let tmpDir: string;
let db: Database;

// Minimum-valid email classification — schemas reject anything narrower.
// See workflow-schemas.ts validateEmailClassificationResult for the contract.
const VALID_EMAIL_RESULT = {
  is_invoice: true,
  confidence: "high" as const,
  vendor: "Alza.sk",
  is_fuel: false,
  action: "download_and_upload" as const,
  download_strategy: "attachment" as const,
  strategy_confidence: "high" as const,
  requires_review: false,
  order_id: null,
  total_amount: null,
  currency: null,
  subject: "Test invoice",
  received_at: "2026-04-01T00:00:00Z",
  sender: "test@alza.sk",
};

const VALID_EMAIL_RESULT_FALSE = {
  ...VALID_EMAIL_RESULT,
  is_invoice: false,
  action: "ignore" as const,
  download_strategy: null,
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wf-classify-test-"));
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

describe("awaiting_classification state", () => {
  test("requestClassification sets state and writes step_started event", () => {
    const job = createJob(db, { workflowType: "invoice_intake", inputJson: "{}" });
    db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(job.id);

    requestClassification(db, job.id, "classify_email", {
      sender: "test@alza.sk",
      subject: "Invoice",
    });

    const updated = getJob(db, job.id);
    expect(updated!.state).toBe("awaiting_classification");

    const events = getJobEvents(db, job.id);
    const stepEvent = events.find((e) => e.event_type === "step_started");
    expect(stepEvent).toBeTruthy();
    const payload = JSON.parse(stepEvent!.payload_json!);
    expect(payload.step).toBe("classify_email");
    expect(payload.sender).toBe("test@alza.sk");
  });

  test("requestClassification fails if job is not running", () => {
    const job = createJob(db, { workflowType: "invoice_intake", inputJson: "{}" });

    const ok = requestClassification(db, job.id, "classify_email", {});
    expect(ok).toBe(false);

    const updated = getJob(db, job.id);
    expect(updated!.state).toBe("queued");
  });

  test("submitClassification writes step_completed and sets state back to running", () => {
    const job = createJob(db, { workflowType: "invoice_intake", inputJson: "{}" });
    db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(job.id);
    requestClassification(db, job.id, "classify_email", { sender: "test@alza.sk" });

    const ok = submitClassification(db, job.id, "classify_email", VALID_EMAIL_RESULT);
    expect(ok).toBe(true);

    const updated = getJob(db, job.id);
    expect(updated!.state).toBe("queued");

    const events = getJobEvents(db, job.id);
    const completed = events.find(
      (e) =>
        e.event_type === "step_completed" &&
        JSON.parse(e.payload_json!).step === "classify_email",
    );
    expect(completed).toBeTruthy();
    const stored = JSON.parse(completed!.payload_json!).result;
    expect(stored.vendor).toBe("Alza.sk");
    expect(stored.is_invoice).toBe(true);
  });

  test("submitClassification is idempotent — second call is no-op", () => {
    const job = createJob(db, { workflowType: "invoice_intake", inputJson: "{}" });
    db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(job.id);
    requestClassification(db, job.id, "classify_email", {});

    submitClassification(db, job.id, "classify_email", VALID_EMAIL_RESULT);
    const ok2 = submitClassification(db, job.id, "classify_email", VALID_EMAIL_RESULT_FALSE);
    expect(ok2).toBe(true); // idempotent, no error

    // First result preserved
    const events = getJobEvents(db, job.id);
    const completeds = events.filter(
      (e) =>
        e.event_type === "step_completed" &&
        JSON.parse(e.payload_json!).step === "classify_email",
    );
    expect(completeds).toHaveLength(1);
    expect(JSON.parse(completeds[0].payload_json!).result.is_invoice).toBe(true);
  });

  test("submitClassification rejects wrong step", () => {
    const job = createJob(db, { workflowType: "invoice_intake", inputJson: "{}" });
    db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(job.id);
    requestClassification(db, job.id, "classify_email", {});

    // Use a doc-classification-shaped payload but for the wrong step name
    const docPayload = {
      doc_type: "invoice", vendor: "X", total_amount: 10, currency: "EUR",
      is_fuel: false, owner: "techlab", confidence: "high",
      order_id: null, subtitle: null, doc_date: null,
    };
    const ok = submitClassification(db, job.id, "classify_document", docPayload);
    expect(ok).toBe(false);
  });

  test("submitClassification rejects if job not awaiting_classification", () => {
    const job = createJob(db, { workflowType: "invoice_intake", inputJson: "{}" });
    db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(job.id);

    // No requestClassification called, job still running
    const ok = submitClassification(db, job.id, "classify_email", VALID_EMAIL_RESULT);
    expect(ok).toBe(false);
  });

  test("submitClassification fails the job on schema validation error", () => {
    const job = createJob(db, { workflowType: "invoice_intake", inputJson: "{}" });
    db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(job.id);
    requestClassification(db, job.id, "classify_email", {});

    // Missing required fields (vendor, action, etc.)
    const malformed = { is_invoice: true };
    const ok = submitClassification(db, job.id, "classify_email", malformed);
    expect(ok).toBe(false);

    // Job should be marked failed with schema_validation_failed code
    const updated = getJob(db, job.id);
    expect(updated!.state).toBe("failed");
    const err = JSON.parse(updated!.error_json!);
    expect(err.code).toBe("schema_validation_failed");
    expect(err.step).toBe("classify_email");
    expect(err.schema).toBe("EmailClassificationResult");
  });

  test("claimNextQueuedJob skips awaiting_classification jobs", () => {
    const job1 = createJob(db, { workflowType: "invoice_intake", inputJson: "{}" });
    db.prepare("UPDATE jobs SET state = 'awaiting_classification' WHERE id = ?").run(job1.id);
    const job2 = createJob(db, { workflowType: "invoice_intake", inputJson: "{}" });

    const claimed = claimNextQueuedJob(db);
    expect(claimed!.id).toBe(job2.id);
  });

  test("cancelJob can cancel awaiting_classification jobs", () => {
    const job = createJob(db, { workflowType: "invoice_intake", inputJson: "{}" });
    db.prepare("UPDATE jobs SET state = 'awaiting_classification' WHERE id = ?").run(job.id);

    const ok = cancelJob(db, job.id, "timeout");
    expect(ok).toBe(true);
    expect(getJob(db, job.id)!.state).toBe("cancelled");
  });
});
