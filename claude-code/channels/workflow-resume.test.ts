import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { openWorkflowDb, createJob, addJobEvent } from "./workflow-db";
import { getCompletedSteps } from "./invoice-pipeline";

let tmpDir: string;
let db: Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wf-resume-test-"));
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

describe("step resume", () => {
  test("getCompletedSteps reads step_completed events", () => {
    const job = createJob(db, { workflowType: "invoice_intake", inputJson: "{}" });
    addJobEvent(db, job.id, "step_completed", { step: "classify_email", result: { vendor: "Alza" } });
    addJobEvent(db, job.id, "step_completed", { step: "download", filename: "test.pdf" });

    const completed = getCompletedSteps(db, job.id);
    expect(completed.has("classify_email")).toBe(true);
    expect(completed.has("download")).toBe(true);
    expect(completed.has("upload")).toBe(false);
  });

  test("getCompletedSteps returns empty map for new job", () => {
    const job = createJob(db, { workflowType: "invoice_intake", inputJson: "{}" });
    const completed = getCompletedSteps(db, job.id);
    expect(completed.size).toBe(0);
  });

  test("getCompletedSteps preserves step payload", () => {
    const job = createJob(db, { workflowType: "invoice_intake", inputJson: "{}" });
    addJobEvent(db, job.id, "step_completed", {
      step: "classify_document",
      result: { total_amount: 53.78, owner: "personal" },
    });

    const completed = getCompletedSteps(db, job.id);
    const docClass = completed.get("classify_document");
    expect(docClass).toBeTruthy();
    expect((docClass as any).result.total_amount).toBe(53.78);
    expect((docClass as any).result.owner).toBe("personal");
  });
});
