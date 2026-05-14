import { Database } from "bun:sqlite";

/**
 * Returns the `input_json.received_at` from the most recently-created job
 * that touched the given Paperless document. Used by the dedup service to
 * decide whether an incoming email is newer than what's already in Paperless
 * (multi-stage vendor refresh path, task 59). Returns null when no jobs
 * reference this doc id — the caller treats that as "newer wins".
 *
 * Orders by `created_at` (always ISO from `nowIso()`) instead of MAX(received_at)
 * because received_at is heterogeneous (sender-controlled RFC 2822, ISO 8601,
 * etc. — see task 59 investigation log) and SQL MAX would lex-compare.
 */
export function getLatestReceivedAtForDoc(db: Database, paperlessDocId: number): string | null {
  const row = db
    .prepare(
      `SELECT json_extract(input_json, '$.received_at') AS received_at
         FROM jobs WHERE paperless_doc_id = ?
        ORDER BY created_at DESC LIMIT 1`,
    )
    .get(paperlessDocId) as { received_at: string | null } | undefined;
  return row?.received_at ?? null;
}

/**
 * Find the most recent successfully-uploaded paperless_doc_id for a scan source_ref
 * (e.g. `gdrive:<file_id>`). Used by force-reprocess to bypass classifier-based dedup:
 * the file_id → doc_id link is deterministic and survives classifier non-determinism
 * (e.g. extracting a different order_id on a re-run).
 */
export function getPaperlessDocIdForSource(db: Database, sourceRef: string): number | null {
  const row = db
    .prepare(
      `SELECT paperless_doc_id FROM jobs
         WHERE source_ref = ? AND paperless_doc_id IS NOT NULL
         ORDER BY created_at DESC LIMIT 1`,
    )
    .get(sourceRef) as { paperless_doc_id: number | null } | undefined;
  return row?.paperless_doc_id ?? null;
}
