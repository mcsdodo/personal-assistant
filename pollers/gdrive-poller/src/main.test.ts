import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { openDb as openGdriveDb } from "../../lib/gdrive-db";
import { openWorkflowDb } from "../../lib/workflow-db";
import { processNewFiles, ownerFolderToRole } from "./main";

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
      owner: "business" as const,
      bucket: "accounting" as const,
      folderId: "drive-acct-id",
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
    // task 96: owner/bucket/folder_id written explicitly onto the job
    expect(input.owner).toBe("business");
    expect(input.bucket).toBe("accounting");
    expect(input.folder_id).toBe("drive-acct-id");
  });

  it("writes the personal owner onto the job", async () => {
    const files = [{
      id: "file-P",
      name: "personal-scan.pdf",
      mimeType: "application/pdf",
      createdTime: "2026-04-15T10:00:00Z",
      modifiedTime: "2026-04-15T10:00:00Z",
      watchFolder: "personal/documents",
      owner: "personal" as const,
      bucket: "documents" as const,
      folderId: "drive-personal-docs-id",
    }];

    await processNewFiles(gdriveDb, wfDb, files, 5);

    const job = wfDb.prepare("SELECT input_json FROM jobs").get() as any;
    const input = JSON.parse(job.input_json);
    expect(input.owner).toBe("personal");
    expect(input.bucket).toBe("documents");
    expect(input.folder_id).toBe("drive-personal-docs-id");
  });

  it("caps file count to MAX_NEW_PER_CYCLE", async () => {
    const files = Array.from({ length: 10 }, (_, i) => ({
      id: `file-${i}`,
      name: `scan-${i}.pdf`,
      mimeType: "application/pdf",
      createdTime: "2026-04-15T10:00:00Z",
      modifiedTime: "2026-04-15T10:00:00Z",
      watchFolder: "techlab/accounting",
      owner: "business" as const,
      bucket: "accounting" as const,
      folderId: "drive-acct-id",
    }));

    await processNewFiles(gdriveDb, wfDb, files, 3);

    const jobs = wfDb.prepare("SELECT id FROM jobs").all();
    expect(jobs.length).toBe(3);
  });
});

describe("ownerFolderToRole", () => {
  it("maps the OWNER_BUSINESS_LABEL folder (default techlab) to business", () => {
    expect(ownerFolderToRole("techlab")).toBe("business");
  });

  it("maps the personal folder to personal", () => {
    expect(ownerFolderToRole("personal")).toBe("personal");
  });

  it("returns null for any unknown owner-folder name (fail loud)", () => {
    expect(ownerFolderToRole("_documents_intake")).toBeNull();
    expect(ownerFolderToRole("acme")).toBeNull();
  });
});
