/**
 * Tests for download cleanup at terminal job states + safety sweep.
 *
 * Cleanup contract:
 * - completeJob → cleans recorded files
 * - terminal failJob → cleans recorded files
 * - cancelJob → cleans recorded files
 * - retryable / awaiting_* → does NOT clean (files needed for resume)
 * - sweep → deletes orphans older than max age, preserves active job files
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  cancelJob,
  cleanupJobFiles,
  completeJob,
  createJob,
  failJob,
  getDownloadedFiles,
  getJob,
  getJobEvents,
  openWorkflowDb,
  pauseForGuidance,
  recordDownloadedFile,
  scheduleRetry,
  sweepOrphanedDownloads,
} from "./workflow-db";
import { sweepStaleGuidance } from "./workflow-mcp";

let tmpDir: string;
let downloadDir: string;
let db: Database;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wf-cleanup-test-"));
  downloadDir = join(tmpDir, "downloads");
  mkdirSync(downloadDir, { recursive: true });
  db = openWorkflowDb(join(tmpDir, "workflow.db"));
});

afterEach(() => {
  db.close();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Windows can briefly hold WAL files.
  }
});

function makeJobWithFile(filename: string, content = "test-content"): { jobId: string; filePath: string } {
  const job = createJob(db, { workflowType: "invoice_intake", inputJson: "{}" });
  db.prepare("UPDATE jobs SET state='running' WHERE id=?").run(job.id);
  const filePath = join(downloadDir, filename);
  writeFileSync(filePath, content);
  recordDownloadedFile(db, job.id, filePath);
  return { jobId: job.id, filePath };
}

// ── recordDownloadedFile / getDownloadedFiles ─────────────────────────

describe("recordDownloadedFile", () => {
  test("emits a file_downloaded event with the path", () => {
    const { jobId } = makeJobWithFile("a.pdf");
    const events = getJobEvents(db, jobId);
    const dl = events.find((e) => e.event_type === "file_downloaded");
    expect(dl).toBeTruthy();
    const payload = JSON.parse(dl!.payload_json!);
    expect(payload.file_path).toContain("a.pdf");
  });

  test("getDownloadedFiles returns all recorded paths in insertion order", () => {
    const { jobId } = makeJobWithFile("first.pdf");
    const second = join(downloadDir, "second.pdf");
    writeFileSync(second, "x");
    recordDownloadedFile(db, jobId, second);

    const files = getDownloadedFiles(db, jobId);
    expect(files).toHaveLength(2);
    expect(files[0]).toContain("first.pdf");
    expect(files[1]).toContain("second.pdf");
  });
});

// ── Terminal-state cleanup ────────────────────────────────────────────

describe("cleanupJobFiles via terminal states", () => {
  test("completeJob deletes the recorded file", () => {
    const { jobId, filePath } = makeJobWithFile("complete.pdf");
    expect(existsSync(filePath)).toBe(true);

    completeJob(db, jobId, { outcome: "uploaded" });

    expect(existsSync(filePath)).toBe(false);
    expect(getJob(db, jobId)!.state).toBe("completed");
    // files_cleaned event should be present
    const events = getJobEvents(db, jobId);
    const cleaned = events.find((e) => e.event_type === "files_cleaned");
    expect(cleaned).toBeTruthy();
    expect(JSON.parse(cleaned!.payload_json!).count).toBe(1);
  });

  test("failJob deletes the recorded file (terminal)", () => {
    const { jobId, filePath } = makeJobWithFile("fail.pdf");
    expect(existsSync(filePath)).toBe(true);

    failJob(db, jobId, { code: "permanent_error", message: "boom" });

    expect(existsSync(filePath)).toBe(false);
    expect(getJob(db, jobId)!.state).toBe("failed");
  });

  test("cancelJob deletes the recorded file", () => {
    const { jobId, filePath } = makeJobWithFile("cancel.pdf");
    expect(existsSync(filePath)).toBe(true);

    cancelJob(db, jobId, "operator request");

    expect(existsSync(filePath)).toBe(false);
    expect(getJob(db, jobId)!.state).toBe("cancelled");
  });

  test("scheduleRetry preserves the file (resume needs it)", () => {
    const { jobId, filePath } = makeJobWithFile("retry.pdf");
    expect(existsSync(filePath)).toBe(true);

    scheduleRetry(db, jobId, { code: "transient", message: "blip" });

    expect(existsSync(filePath)).toBe(true);
    expect(getJob(db, jobId)!.state).toBe("retryable");
  });

  test("multiple files for one job all get cleaned on complete", () => {
    const { jobId, filePath } = makeJobWithFile("a.pdf");
    const f2 = join(downloadDir, "b.pdf");
    writeFileSync(f2, "x");
    recordDownloadedFile(db, jobId, f2);

    completeJob(db, jobId, { outcome: "uploaded" });

    expect(existsSync(filePath)).toBe(false);
    expect(existsSync(f2)).toBe(false);
  });

  test("cleanup is tolerant of already-deleted files", () => {
    const { jobId, filePath } = makeJobWithFile("ghost.pdf");
    rmSync(filePath); // pre-delete

    // Should not throw
    completeJob(db, jobId, { outcome: "uploaded" });

    expect(getJob(db, jobId)!.state).toBe("completed");
  });

  test("cleanupJobFiles can be called directly and returns the deleted list", () => {
    const { jobId, filePath } = makeJobWithFile("direct.pdf");

    const deleted = cleanupJobFiles(db, jobId);

    expect(deleted).toEqual([filePath]);
    expect(existsSync(filePath)).toBe(false);
  });
});

// ── Safety sweep ──────────────────────────────────────────────────────

describe("sweepOrphanedDownloads", () => {
  test("deletes orphan older than max age, preserves new orphan", () => {
    const oldOrphan = join(downloadDir, "old.pdf");
    const newOrphan = join(downloadDir, "new.pdf");
    writeFileSync(oldOrphan, "old");
    writeFileSync(newOrphan, "new");

    // Make oldOrphan look 8 days old
    const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(oldOrphan, eightDaysAgo, eightDaysAgo);

    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    const result = sweepOrphanedDownloads(db, downloadDir, sevenDays);

    expect(result.scanned).toBe(2);
    expect(result.deleted).toBe(1);
    expect(result.preserved).toBe(1);
    expect(existsSync(oldOrphan)).toBe(false);
    expect(existsSync(newOrphan)).toBe(true);
  });

  test("preserves files referenced by an active job even when old", () => {
    const { jobId, filePath } = makeJobWithFile("active.pdf");
    // Make it old
    const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(filePath, eightDaysAgo, eightDaysAgo);
    // jobId is in 'running' state — active

    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    const result = sweepOrphanedDownloads(db, downloadDir, sevenDays);

    expect(result.preserved).toBeGreaterThanOrEqual(1);
    expect(existsSync(filePath)).toBe(true);
    expect(getJob(db, jobId)!.state).toBe("running");
  });

  test("deletes old file referenced ONLY by a completed (terminal) job", () => {
    const { jobId, filePath } = makeJobWithFile("done.pdf");
    completeJob(db, jobId, { outcome: "uploaded" });
    // completeJob already deleted the file. Recreate it to simulate
    // an orphan that the per-job cleanup missed (e.g. cleanup ran before
    // an unrelated process re-wrote it).
    writeFileSync(filePath, "leftover");
    const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(filePath, eightDaysAgo, eightDaysAgo);

    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    const result = sweepOrphanedDownloads(db, downloadDir, sevenDays);

    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(existsSync(filePath)).toBe(false);
  });

  test("returns zero counts when downloads dir does not exist", () => {
    const ghostDir = join(tmpDir, "no-such");
    const result = sweepOrphanedDownloads(db, ghostDir, 1000);
    expect(result).toEqual({ scanned: 0, deleted: 0, preserved: 0 });
  });

  test("ignores subdirectories", () => {
    mkdirSync(join(downloadDir, "subdir"));
    writeFileSync(join(downloadDir, "loose.pdf"), "x");
    const eightDaysAgo = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(join(downloadDir, "loose.pdf"), eightDaysAgo, eightDaysAgo);

    const result = sweepOrphanedDownloads(db, downloadDir, 7 * 24 * 60 * 60 * 1000);
    // Only the file is scanned, not the directory
    expect(result.scanned).toBe(1);
    expect(result.deleted).toBe(1);
  });
});

// ── sweepStaleGuidance (72h auto-cancel + 24h reminder) ───────────────
//
// Task 57 Phase 4.1: jobs paused in `awaiting_user_guidance` shouldn't
// sit forever. If the user hasn't responded within 24h, nudge them.
// If they haven't responded within 72h, give up — fail the job with
// a `timed_out` error so the queue doesn't leak paused jobs.

function backdateUpdatedAt(jobId: string, hoursAgo: number): void {
  // Use ISO format bound as a parameter — must match production's
  // nowIso() writer format. See channels/CLAUDE.md for the rationale.
  const iso = new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString();
  db.prepare("UPDATE jobs SET updated_at = ? WHERE id = ?").run(iso, jobId);
}

function backdateLastReminderAt(jobId: string, hoursAgo: number): void {
  const iso = new Date(Date.now() - hoursAgo * 3600 * 1000).toISOString();
  db.prepare("UPDATE jobs SET last_reminder_at = ? WHERE id = ?").run(iso, jobId);
}

function makePausedJob(): string {
  const job = createJob(db, { workflowType: "invoice_intake", inputJson: "{}" });
  pauseForGuidance(db, job.id, {
    step: "classify_document",
    reason: "classifier_unknown",
    missing_fields: ["vendor"],
    suggested_actions: ["skip", "fail"],
    context: {},
  });
  return job.id;
}

describe("sweepStaleGuidance", () => {
  test("fails a paused job older than 72h with code=timed_out", () => {
    const jobId = makePausedJob();
    backdateUpdatedAt(jobId, 73);

    const notifyCalls: string[] = [];
    const notifyFn = async (msg: string) => {
      notifyCalls.push(msg);
    };
    sweepStaleGuidance(db, notifyFn);

    const job = getJob(db, jobId)!;
    expect(job.state).toBe("failed");
    const err = JSON.parse(job.error_json!);
    expect(err.code).toBe("timed_out");
    expect(err.reason).toContain("72h");
    // Timeout path does NOT send a reminder — the reminder is only for
    // the 24h–72h window.
    expect(notifyCalls).toHaveLength(0);
  });

  test("sends a reminder for a paused job in the 24h–72h window and leaves state unchanged", () => {
    const jobId = makePausedJob();
    backdateUpdatedAt(jobId, 25);

    const notifyCalls: string[] = [];
    const notifyFn = async (msg: string) => {
      notifyCalls.push(msg);
    };
    sweepStaleGuidance(db, notifyFn);

    // Still parked — reminder does not flip state.
    const job = getJob(db, jobId)!;
    expect(job.state).toBe("awaiting_user_guidance");

    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]).toContain("1 job(s) awaiting your guidance");
  });

  test("does nothing for a paused job < 24h old", () => {
    const jobId = makePausedJob();
    backdateUpdatedAt(jobId, 5);

    const notifyCalls: string[] = [];
    const notifyFn = async (msg: string) => {
      notifyCalls.push(msg);
    };
    sweepStaleGuidance(db, notifyFn);

    const job = getJob(db, jobId)!;
    expect(job.state).toBe("awaiting_user_guidance");
    expect(notifyCalls).toHaveLength(0);
  });

  test("reminder aggregates count across multiple jobs in the window", () => {
    const a = makePausedJob();
    const b = makePausedJob();
    const c = makePausedJob();
    backdateUpdatedAt(a, 30);
    backdateUpdatedAt(b, 48);
    backdateUpdatedAt(c, 5); // not stale yet — not counted

    const notifyCalls: string[] = [];
    const notifyFn = async (msg: string) => {
      notifyCalls.push(msg);
    };
    sweepStaleGuidance(db, notifyFn);

    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]).toContain("2 job(s) awaiting your guidance");
    expect(getJob(db, a)!.state).toBe("awaiting_user_guidance");
    expect(getJob(db, b)!.state).toBe("awaiting_user_guidance");
    expect(getJob(db, c)!.state).toBe("awaiting_user_guidance");
  });

  test("only considers jobs in awaiting_user_guidance — queued/running stale jobs are ignored", () => {
    // A queued job backdated >72h must NOT be failed by this sweep.
    const queued = createJob(db, { workflowType: "invoice_intake", inputJson: "{}" });
    backdateUpdatedAt(queued.id, 100);

    const notifyCalls: string[] = [];
    const notifyFn = async (msg: string) => {
      notifyCalls.push(msg);
    };
    sweepStaleGuidance(db, notifyFn);

    expect(getJob(db, queued.id)!.state).toBe("queued");
    expect(notifyCalls).toHaveLength(0);
  });

  // Cooldown: once a reminder is sent for a stuck job, don't re-notify
  // for 6h. Without this, the 60s sweep tick spammed the user every
  // minute as soon as any job crossed the 24h reminder threshold.
  test("does not re-notify within the 6h cooldown after sending a reminder", () => {
    const jobId = makePausedJob();
    backdateUpdatedAt(jobId, 25);

    const notifyCalls: string[] = [];
    const notifyFn = async (msg: string) => {
      notifyCalls.push(msg);
    };

    // First sweep — sends the reminder and stamps last_reminder_at.
    sweepStaleGuidance(db, notifyFn);
    expect(notifyCalls).toHaveLength(1);

    // Second sweep, immediately after — should NOT re-notify.
    sweepStaleGuidance(db, notifyFn);
    expect(notifyCalls).toHaveLength(1);
  });

  test("re-notifies after the 6h cooldown elapses", () => {
    const jobId = makePausedJob();
    backdateUpdatedAt(jobId, 30);
    // Simulate a reminder sent 7h ago — past the 6h cooldown.
    backdateLastReminderAt(jobId, 7);

    const notifyCalls: string[] = [];
    const notifyFn = async (msg: string) => {
      notifyCalls.push(msg);
    };
    sweepStaleGuidance(db, notifyFn);

    expect(notifyCalls).toHaveLength(1);
    expect(notifyCalls[0]).toContain("1 job(s) awaiting your guidance");
  });

  test("stamps last_reminder_at on each job that was nudged", () => {
    const jobId = makePausedJob();
    backdateUpdatedAt(jobId, 25);

    const before = getJob(db, jobId)!;
    expect(before.last_reminder_at).toBeNull();

    const notifyFn = async () => {};
    sweepStaleGuidance(db, notifyFn);

    const after = getJob(db, jobId)!;
    expect(after.last_reminder_at).not.toBeNull();
    // Stamp should be recent (within the last few seconds).
    const ageMs = Date.now() - new Date(after.last_reminder_at!).getTime();
    expect(ageMs).toBeLessThan(5_000);
  });
});
