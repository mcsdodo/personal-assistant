import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb as openGdriveDb } from "../../lib/gdrive-db";
import { openWorkflowDb } from "../../lib/workflow-db";
import { processNewFiles } from "./main";

function tmpPath(prefix: string): string {
  return `/tmp/${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
}

describe("gdrive-poller processNewFiles", () => {
  let gdriveDb: Database;
  let wfDb: Database;

  beforeEach(() => {
    gdriveDb = openGdriveDb(tmpPath("gdrive"));
    wfDb = openWorkflowDb(tmpPath("workflow"));
  });

  it("creates a scan_intake job for each new file and inserts the audit row", async () => {
    const files = [{
      id: "file-A",
      name: "scan-1.pdf",
      mimeType: "application/pdf",
      createdTime: "2026-04-15T10:00:00Z",
      modifiedTime: "2026-04-15T10:00:00Z",
      watchFolder: "techlab/accounting",
    }];

    await processNewFiles(gdriveDb, wfDb, files, 5);

    const audit = gdriveDb.prepare("SELECT id, watch_folder FROM gdrive_files").all();
    expect(audit.length).toBe(1);
    expect((audit[0] as any).id).toBe("file-A");

    const jobs = wfDb.prepare("SELECT workflow_type, source_ref, input_json FROM jobs").all();
    expect(jobs.length).toBe(1);
    const job = jobs[0] as any;
    expect(job.workflow_type).toBe("scan_intake");
    expect(job.source_ref).toBe("gdrive:file-A");
    const input = JSON.parse(job.input_json);
    expect(input.file_id).toBe("file-A");
    expect(input.month_tag).toBe("2026-04");
  });

  it("caps file count to MAX_NEW_PER_CYCLE", async () => {
    const files = Array.from({ length: 10 }, (_, i) => ({
      id: `file-${i}`,
      name: `scan-${i}.pdf`,
      mimeType: "application/pdf",
      createdTime: "2026-04-15T10:00:00Z",
      modifiedTime: "2026-04-15T10:00:00Z",
      watchFolder: "techlab/accounting",
    }));

    await processNewFiles(gdriveDb, wfDb, files, 3);

    const jobs = wfDb.prepare("SELECT id FROM jobs").all();
    expect(jobs.length).toBe(3);
  });
});
