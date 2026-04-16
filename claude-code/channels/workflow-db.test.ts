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
  listJobs,
  openWorkflowDb,
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
});
