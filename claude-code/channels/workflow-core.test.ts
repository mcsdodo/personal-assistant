import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { executeNextJob, reclaimStaleJobs } from "./workflow-core";
import { approveJob, createJob, getJob, openWorkflowDb } from "./workflow-db";

let tmpDir: string;
let db: Database;

const logger = {
  log(_message: string) {
    // no-op in tests
  },
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "workflow-core-test-"));
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

describe("workflow-core", () => {
  test("completes a synthetic success job", async () => {
    const job = createJob(db, {
      workflowType: "synthetic",
      inputJson: JSON.stringify({ mode: "success", result: { ok: true } }),
    });

    await executeNextJob(db, logger);

    const updated = getJob(db, job.id);
    expect(updated?.state).toBe("completed");
    expect(updated?.output_json).toContain('"ok":true');
  });

  test("fails a synthetic fail job", async () => {
    const job = createJob(db, {
      workflowType: "synthetic",
      inputJson: JSON.stringify({ mode: "fail", error: "boom" }),
    });

    await executeNextJob(db, logger);

    const updated = getJob(db, job.id);
    expect(updated?.state).toBe("failed");
    expect(updated?.error_json).toContain("boom");
  });

  test("pauses and resumes an approval job", async () => {
    const job = createJob(db, {
      workflowType: "synthetic",
      inputJson: JSON.stringify({ mode: "needs_approval", result: "approved-result" }),
    });

    await executeNextJob(db, logger);
    expect(getJob(db, job.id)?.state).toBe("awaiting_approval");

    expect(approveJob(db, job.id, "tester", "ok")).toBe(true);
    await executeNextJob(db, logger);

    const updated = getJob(db, job.id);
    expect(updated?.state).toBe("completed");
    expect(updated?.approved_by).toBe("tester");
    expect(updated?.output_json).toContain("approved-result");
  });
});

describe("stale job reclamation", () => {
  const originalEnv = process.env.STALE_JOB_MINUTES;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.STALE_JOB_MINUTES;
    else process.env.STALE_JOB_MINUTES = originalEnv;
  });

  // Test fixtures MUST write updated_at in the SAME format that production uses
  // (ISO 8601 with T and Z suffix, via nowIso() in workflow-db.ts). Using SQLite's
  // datetime('now','-N minutes') produces space-separated format and hides
  // string-comparison bugs in reclaimStaleJobs. See CLAUDE.md "Test fixtures
  // must match production writers".
  const minutesAgoIso = (minutes: number): string =>
    new Date(Date.now() - minutes * 60 * 1000).toISOString();

  test("reclaims running job stale for over threshold", () => {
    process.env.STALE_JOB_MINUTES = "0"; // 0 minutes = everything is stale
    const job = createJob(db, { workflowType: "invoice_intake", inputJson: "{}" });
    db.prepare("UPDATE jobs SET state = 'running', updated_at = ? WHERE id = ?").run(minutesAgoIso(10), job.id);

    reclaimStaleJobs(db, logger);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("retryable");
    expect(updated.retry_count).toBe(1);
  });

  test("reclaims awaiting_classification job stale for over threshold", () => {
    process.env.STALE_JOB_MINUTES = "0";
    const job = createJob(db, { workflowType: "invoice_intake", inputJson: "{}" });
    db.prepare("UPDATE jobs SET state = 'awaiting_classification', updated_at = ? WHERE id = ?").run(minutesAgoIso(10), job.id);

    reclaimStaleJobs(db, logger);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("retryable");
  });

  test("fails stale job after max retries exhausted", () => {
    process.env.STALE_JOB_MINUTES = "0";
    const job = createJob(db, { workflowType: "invoice_intake", inputJson: "{}" });
    db.prepare("UPDATE jobs SET state = 'running', retry_count = 3, updated_at = ? WHERE id = ?").run(minutesAgoIso(10), job.id);

    reclaimStaleJobs(db, logger);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("failed");
    expect(JSON.parse(updated.error_json!).code).toBe("stale_timeout");
  });

  test("does not touch fresh running jobs", () => {
    process.env.STALE_JOB_MINUTES = "5";
    const job = createJob(db, { workflowType: "invoice_intake", inputJson: "{}" });
    db.prepare("UPDATE jobs SET state = 'running', updated_at = ? WHERE id = ?").run(new Date().toISOString(), job.id);

    reclaimStaleJobs(db, logger);

    const updated = getJob(db, job.id)!;
    expect(updated.state).toBe("running");
  });

  test("does not touch queued or completed jobs", () => {
    process.env.STALE_JOB_MINUTES = "0";
    const queuedJob = createJob(db, { workflowType: "invoice_intake", inputJson: "{}" });
    db.prepare("UPDATE jobs SET updated_at = ? WHERE id = ?").run(minutesAgoIso(10), queuedJob.id);

    const completedJob = createJob(db, { workflowType: "invoice_intake", inputJson: "{}" });
    db.prepare("UPDATE jobs SET state = 'completed', updated_at = ? WHERE id = ?").run(minutesAgoIso(10), completedJob.id);

    reclaimStaleJobs(db, logger);

    expect(getJob(db, queuedJob.id)!.state).toBe("queued");
    expect(getJob(db, completedJob.id)!.state).toBe("completed");
  });
});
