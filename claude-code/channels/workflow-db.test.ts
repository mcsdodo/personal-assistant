import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  addJobEvent,
  approveJob,
  cancelJob,
  claimNextQueuedJob,
  completeJob,
  createJob,
  failJob,
  getJob,
  getJobByIdempotencyKey,
  getJobEvents,
  getLatestReceivedAtForDoc,
  getPaperlessDocIdForSource,
  listJobs,
  openWorkflowDb,
  pauseForGuidance,
  requestJobApproval,
  setJobState,
} from "./workflow-db";

// Local helper — mints an isolated DB for tests that prefer a self-contained
// setup over the describe-scoped `db` fixture.
function openTestWorkflowDb(): Database {
  const dir = mkdtempSync(join(tmpdir(), "workflow-db-helper-"));
  return openWorkflowDb(join(dir, "workflow.db"));
}

let tmpDir: string;
let db: Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "workflow-db-test-"));
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

describe("workflow-db", () => {
  test("creates and fetches a job", () => {
    const job = createJob(db, {
      workflowType: "synthetic",
      inputJson: JSON.stringify({ mode: "success" }),
      sourceRef: "test:event:1",
    });

    const loaded = getJob(db, job.id);
    expect(loaded?.workflow_type).toBe("synthetic");
    expect(loaded?.state).toBe("queued");
    expect(loaded?.source_ref).toBe("test:event:1");
  });

  test("reuses idempotent job", () => {
    const first = createJob(db, {
      workflowType: "synthetic",
      idempotencyKey: "same-key",
    });
    const second = createJob(db, {
      workflowType: "synthetic",
      idempotencyKey: "same-key",
    });

    expect(second.id).toBe(first.id);
    expect(getJobByIdempotencyKey(db, "same-key")?.id).toBe(first.id);
  });

  test("lists jobs with filters", () => {
    createJob(db, { workflowType: "synthetic" });
    const second = createJob(db, { workflowType: "other" });
    failJob(db, second.id, { message: "boom" });

    expect(listJobs(db, {}).length).toBe(2);
    expect(listJobs(db, { workflowType: "synthetic" }).length).toBe(1);
    expect(listJobs(db, { state: "failed" }).length).toBe(1);
  });

  test("claims next queued job", () => {
    const job = createJob(db, { workflowType: "synthetic" });
    const claimed = claimNextQueuedJob(db);

    expect(claimed?.id).toBe(job.id);
    expect(getJob(db, job.id)?.state).toBe("running");
  });

  test("writes and reads job events", () => {
    const job = createJob(db, { workflowType: "synthetic" });
    addJobEvent(db, job.id, "custom", { ok: true });

    const events = getJobEvents(db, job.id);
    expect(events.some((event) => event.event_type === "created")).toBe(true);
    expect(events.some((event) => event.event_type === "custom")).toBe(true);
  });

  test("completes and fails jobs", () => {
    const completed = createJob(db, { workflowType: "synthetic" });
    const failed = createJob(db, { workflowType: "synthetic" });

    expect(completeJob(db, completed.id, { ok: true })).toBe(true);
    expect(failJob(db, failed.id, { code: "err" })).toBe(true);

    expect(getJob(db, completed.id)?.state).toBe("completed");
    expect(getJob(db, failed.id)?.state).toBe("failed");
  });

  test("handles approval and cancellation", () => {
    const job = createJob(db, { workflowType: "synthetic" });

    expect(requestJobApproval(db, job.id, { reason: "check" })).toBe(true);
    expect(getJob(db, job.id)?.state).toBe("awaiting_approval");

    expect(approveJob(db, job.id, "tester", "looks good")).toBe(true);
    expect(getJob(db, job.id)?.state).toBe("queued");

    expect(cancelJob(db, job.id, "no longer needed")).toBe(true);
    expect(getJob(db, job.id)?.state).toBe("cancelled");
  });

  test("awaiting_user_guidance is a valid JobState", () => {
    const db = openTestWorkflowDb();
    const job = createJob(db, { workflowType: "invoice_intake" });
    setJobState(db, job.id, "awaiting_user_guidance");
    const reloaded = getJob(db, job.id);
    expect(reloaded?.state).toBe("awaiting_user_guidance");
  });

  test("pauseForGuidance transitions to awaiting_user_guidance + writes event", () => {
    const db = openTestWorkflowDb();
    const job = createJob(db, { workflowType: "invoice_intake" });
    setJobState(db, job.id, "running");

    pauseForGuidance(db, job.id, {
      step: "classify_document",
      reason: "classifier_unknown",
      missing_fields: ["owner"],
      suggested_actions: ["set:owner=personal", "set:owner=techlab", "skip"],
      context: { filename: "x.pdf", classifier_notes: "no IČO" },
    });

    const reloaded = getJob(db, job.id);
    expect(reloaded?.state).toBe("awaiting_user_guidance");

    const events = getJobEvents(db, job.id);
    const guidanceEvent = events.find((e) => e.event_type === "guidance_request");
    expect(guidanceEvent).toBeDefined();
    const payload = JSON.parse(guidanceEvent!.payload_json!);
    expect(payload.reason).toBe("classifier_unknown");
    expect(payload.missing_fields).toEqual(["owner"]);
  });
});

describe("paperless_doc_id migration", () => {
  test("adds paperless_doc_id column on fresh DB", () => {
    const cols = db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "paperless_doc_id")).toBe(true);
  });

  test("creates index on paperless_doc_id", () => {
    const indexes = db.prepare("PRAGMA index_list(jobs)").all() as Array<{ name: string }>;
    expect(indexes.some((i) => i.name === "idx_jobs_paperless_doc_id")).toBe(true);
  });

  test("backfills paperless_doc_id from output_json on reopen", () => {
    const job = createJob(db, { workflowType: "invoice_intake" });
    // Simulate a legacy completed job where output_json has the doc id but
    // the new column wasn't populated at completion time.
    db.prepare("UPDATE jobs SET output_json = ?, paperless_doc_id = NULL WHERE id = ?")
      .run(JSON.stringify({ paperless_document_id: 411, outcome: "uploaded" }), job.id);

    db.close();
    db = openWorkflowDb(join(tmpDir, "workflow.db"));

    const row = db.prepare("SELECT paperless_doc_id FROM jobs WHERE id = ?").get(job.id) as
      | { paperless_doc_id: number | null }
      | null;
    expect(row?.paperless_doc_id).toBe(411);
  });

  test("leaves paperless_doc_id NULL when output_json lacks the field", () => {
    const job = createJob(db, { workflowType: "invoice_intake" });
    db.prepare("UPDATE jobs SET output_json = ? WHERE id = ?")
      .run(JSON.stringify({ outcome: "failed", error: "boom" }), job.id);

    db.close();
    db = openWorkflowDb(join(tmpDir, "workflow.db"));

    const row = db.prepare("SELECT paperless_doc_id FROM jobs WHERE id = ?").get(job.id) as
      | { paperless_doc_id: number | null }
      | null;
    expect(row?.paperless_doc_id).toBeNull();
  });

  test("idempotent: reopening the DB twice does not error", () => {
    db.close();
    db = openWorkflowDb(join(tmpDir, "workflow.db"));
    db.close();
    db = openWorkflowDb(join(tmpDir, "workflow.db"));
    const cols = db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
    expect(cols.filter((c) => c.name === "paperless_doc_id").length).toBe(1);
  });
});

describe("completeJob writes paperless_doc_id column", () => {
  function readDocId(jobId: string): number | null {
    const row = db.prepare("SELECT paperless_doc_id FROM jobs WHERE id = ?").get(jobId) as
      | { paperless_doc_id: number | null }
      | null;
    return row?.paperless_doc_id ?? null;
  }

  test("uploaded outcome populates paperless_doc_id from output.paperless_document_id", () => {
    const job = createJob(db, { workflowType: "invoice_intake" });
    completeJob(db, job.id, { outcome: "uploaded", paperless_document_id: 412 });
    expect(readDocId(job.id)).toBe(412);
  });

  test("refreshed outcome populates paperless_doc_id from output.paperless_document_id", () => {
    const job = createJob(db, { workflowType: "invoice_intake" });
    completeJob(db, job.id, { outcome: "refreshed", paperless_document_id: 411 });
    expect(readDocId(job.id)).toBe(411);
  });

  test("outcome without paperless_document_id leaves column NULL", () => {
    const job = createJob(db, { workflowType: "invoice_intake" });
    completeJob(db, job.id, { outcome: "ignored" });
    expect(readDocId(job.id)).toBeNull();
  });

  test("undefined output does not error and leaves column NULL", () => {
    const job = createJob(db, { workflowType: "invoice_intake" });
    expect(() => completeJob(db, job.id)).not.toThrow();
    expect(readDocId(job.id)).toBeNull();
  });

  test("ignores non-numeric paperless_document_id without throwing", () => {
    const job = createJob(db, { workflowType: "invoice_intake" });
    completeJob(db, job.id, { outcome: "uploaded", paperless_document_id: "not-a-number" });
    expect(readDocId(job.id)).toBeNull();
  });
});

describe("getLatestReceivedAtForDoc", () => {
  test("returns null when no jobs reference the doc id", () => {
    expect(getLatestReceivedAtForDoc(db, 999)).toBeNull();
  });

  test("returns received_at from the only job referencing the doc", () => {
    const job = createJob(db, {
      workflowType: "invoice_intake",
      inputJson: JSON.stringify({ received_at: "2026-04-20T09:57:11Z" }),
    });
    completeJob(db, job.id, { outcome: "uploaded", paperless_document_id: 411 });
    expect(getLatestReceivedAtForDoc(db, 411)).toBe("2026-04-20T09:57:11Z");
  });

  test("picks received_at from the most recently-created job for that doc", () => {
    const older = createJob(db, {
      workflowType: "invoice_intake",
      inputJson: JSON.stringify({ received_at: "2026-04-20T09:57:11Z" }),
    });
    completeJob(db, older.id, { outcome: "uploaded", paperless_doc_id: 411 });

    // SQLite's CURRENT_TIMESTAMP / nowIso() advances per call. Force a small
    // gap to avoid identical created_at values.
    const newer = createJob(db, {
      workflowType: "invoice_intake",
      inputJson: JSON.stringify({ received_at: "Wed, 22 Apr 2026 11:16:23 +0200" }),
    });
    db.prepare("UPDATE jobs SET created_at = ? WHERE id = ?").run(
      new Date(Date.now() + 1000).toISOString(),
      newer.id,
    );
    completeJob(db, newer.id, { outcome: "refreshed", paperless_document_id: 411 });

    expect(getLatestReceivedAtForDoc(db, 411)).toBe("Wed, 22 Apr 2026 11:16:23 +0200");
  });

  test("returns null when input_json has no received_at field", () => {
    const job = createJob(db, {
      workflowType: "invoice_intake",
      inputJson: JSON.stringify({ message_id: "x" }),
    });
    completeJob(db, job.id, { outcome: "uploaded", paperless_document_id: 411 });
    expect(getLatestReceivedAtForDoc(db, 411)).toBeNull();
  });
});

describe("getPaperlessDocIdForSource", () => {
  test("returns null when no jobs match the source_ref", () => {
    expect(getPaperlessDocIdForSource(db, "gdrive:nonexistent")).toBeNull();
  });

  test("returns null when source_ref matches but no job has paperless_doc_id", () => {
    const job = createJob(db, {
      workflowType: "scan_intake",
      inputJson: JSON.stringify({ file_id: "abc" }),
      sourceRef: "gdrive:abc",
    });
    failJob(db, job.id, { code: "x", message: "failed before upload" });
    expect(getPaperlessDocIdForSource(db, "gdrive:abc")).toBeNull();
  });

  test("returns paperless_doc_id from the only matching completed job", () => {
    const job = createJob(db, {
      workflowType: "scan_intake",
      inputJson: JSON.stringify({ file_id: "abc" }),
      sourceRef: "gdrive:abc",
    });
    completeJob(db, job.id, { outcome: "uploaded", paperless_document_id: 465 });
    expect(getPaperlessDocIdForSource(db, "gdrive:abc")).toBe(465);
  });

  test("picks the most recent job when multiple jobs share the source_ref", () => {
    const older = createJob(db, {
      workflowType: "scan_intake",
      inputJson: JSON.stringify({ file_id: "abc" }),
      sourceRef: "gdrive:abc",
    });
    completeJob(db, older.id, { outcome: "uploaded", paperless_document_id: 100 });

    const newer = createJob(db, {
      workflowType: "scan_intake",
      inputJson: JSON.stringify({ file_id: "abc", force: true }),
      sourceRef: "gdrive:abc",
      idempotencyKey: `gdrive:abc:force-${Date.now()}`,
    });
    db.prepare("UPDATE jobs SET created_at = ? WHERE id = ?").run(
      new Date(Date.now() + 1000).toISOString(),
      newer.id,
    );
    completeJob(db, newer.id, { outcome: "refreshed", paperless_document_id: 100 });

    expect(getPaperlessDocIdForSource(db, "gdrive:abc")).toBe(100);
  });

  test("ignores jobs with non-matching source_ref", () => {
    const a = createJob(db, {
      workflowType: "scan_intake",
      inputJson: JSON.stringify({ file_id: "a" }),
      sourceRef: "gdrive:a",
    });
    completeJob(db, a.id, { outcome: "uploaded", paperless_document_id: 200 });

    const b = createJob(db, {
      workflowType: "scan_intake",
      inputJson: JSON.stringify({ file_id: "b" }),
      sourceRef: "gdrive:b",
    });
    completeJob(db, b.id, { outcome: "uploaded", paperless_document_id: 300 });

    expect(getPaperlessDocIdForSource(db, "gdrive:a")).toBe(200);
    expect(getPaperlessDocIdForSource(db, "gdrive:b")).toBe(300);
  });
});
