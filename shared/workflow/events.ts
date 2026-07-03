import { Database } from "bun:sqlite";

import type { JobEventRow } from "./schema";

export function addJobEvent(
  db: Database,
  jobId: string,
  eventType: string,
  payload?: unknown,
): void {
  db.prepare(
    `INSERT INTO job_events (job_id, event_type, payload_json)
     VALUES (?, ?, ?)`
  ).run(jobId, eventType, payload === undefined ? null : JSON.stringify(payload));
}

export function getJobEvents(db: Database, jobId: string): JobEventRow[] {
  return db
    .prepare("SELECT * FROM job_events WHERE job_id = ? ORDER BY created_at ASC, id ASC")
    .all(jobId) as JobEventRow[];
}

export function parseJobJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}
