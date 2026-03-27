import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { executeNextJob } from "./workflow-core";
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
