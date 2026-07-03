import { Database } from "bun:sqlite";
import { readdirSync, statSync, unlinkSync } from "fs";
import { join } from "path";

import { nowIso } from "./schema";
import { addJobEvent, getJobEvents } from "./events";

// ── Download cleanup ───────────────────────────────────────────────────
//
// Track downloaded files in `file_downloaded` job events so we can clean
// them up deterministically when a job reaches a terminal state. The worker
// is the only thing that creates downloads, so the worker is the only thing
// that needs to know about cleanup.
//
// Cleanup runs after `completeJob`, terminal `failJob`, and `cancelJob`.
// It does NOT run on `retryable`, `awaiting_classification`, or
// `awaiting_approval` because resuming the job needs the file on disk.

/**
 * Record that a file was downloaded for this job. The path should be the
 * absolute file path on disk.
 */
export function recordDownloadedFile(
  db: Database,
  jobId: string,
  filePath: string,
): void {
  addJobEvent(db, jobId, "file_downloaded", { file_path: filePath, at: nowIso() });
}

/**
 * Get the absolute paths of all files downloaded for a given job.
 * Returns paths in insertion order.
 */
export function getDownloadedFiles(db: Database, jobId: string): string[] {
  const events = getJobEvents(db, jobId);
  const out: string[] = [];
  for (const e of events) {
    if (e.event_type !== "file_downloaded") continue;
    try {
      const p = JSON.parse(e.payload_json ?? "{}");
      if (typeof p.file_path === "string" && p.file_path.length > 0) {
        out.push(p.file_path);
      }
    } catch { /* ignore malformed */ }
  }
  return out;
}

/**
 * Delete all files recorded for this job. Logs but does not throw on
 * delete failures (the file may already be gone if a previous cleanup
 * partially completed, or if the OS removed it). Returns the list of
 * paths actually deleted.
 */
export function cleanupJobFiles(
  db: Database,
  jobId: string,
  logger?: { log(message: string): void },
): string[] {
  const paths = getDownloadedFiles(db, jobId);
  const deleted: string[] = [];
  for (const p of paths) {
    try {
      unlinkSync(p);
      deleted.push(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        logger?.log(`cleanupJobFiles: failed to delete ${p}: ${(err as Error).message}`);
      }
    }
  }
  if (deleted.length > 0) {
    addJobEvent(db, jobId, "files_cleaned", { paths: deleted, count: deleted.length });
  }
  return deleted;
}

/**
 * Sweep the downloads directory and delete any file older than `maxAgeMs`
 * that is NOT referenced by an active (non-terminal) job. Defense in depth
 * for orphans left behind by crashes or aborted runs.
 *
 * Active states: queued, running, retryable, awaiting_classification,
 * awaiting_approval. Terminal states: completed, failed, cancelled.
 */
export function sweepOrphanedDownloads(
  db: Database,
  downloadDir: string,
  maxAgeMs: number,
  logger?: { log(message: string): void },
): { scanned: number; deleted: number; preserved: number } {
  let scanned = 0;
  let deleted = 0;
  let preserved = 0;

  let entries: string[];
  try {
    entries = readdirSync(downloadDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { scanned: 0, deleted: 0, preserved: 0 };
    }
    throw err;
  }

  // Build the set of file paths referenced by any non-terminal job.
  const activeStates = [
    "queued",
    "running",
    "retryable",
    "awaiting_classification",
    "awaiting_approval",
  ];
  const placeholders = activeStates.map(() => "?").join(",");
  const activeJobs = db
    .prepare(
      `SELECT j.id FROM jobs j WHERE j.state IN (${placeholders})`,
    )
    .all(...activeStates) as Array<{ id: string }>;

  const referenced = new Set<string>();
  for (const job of activeJobs) {
    for (const p of getDownloadedFiles(db, job.id)) {
      referenced.add(p);
    }
  }

  const cutoff = Date.now() - maxAgeMs;

  for (const name of entries) {
    const fullPath = join(downloadDir, name);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    scanned++;

    if (referenced.has(fullPath)) {
      preserved++;
      continue;
    }
    if (stat.mtimeMs > cutoff) {
      preserved++;
      continue;
    }
    try {
      unlinkSync(fullPath);
      deleted++;
      logger?.log(`sweep: deleted orphan ${fullPath}`);
    } catch (err) {
      logger?.log(`sweep: failed to delete ${fullPath}: ${(err as Error).message}`);
    }
  }

  return { scanned, deleted, preserved };
}
