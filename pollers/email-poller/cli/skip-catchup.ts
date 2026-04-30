#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// skip-catchup CLI — operator escape hatch
//
// Advances last_checked = now for the given email source. Used when the
// catchup_overflow counter trips and the operator decides to drop the
// over-cap window rather than raise MAX_CATCHUP_EMAILS.
//
// Usage:
//   docker exec personal-assistant-email-poller \
//     bun /app/email-poller/cli/skip-catchup.ts gmail
// ---------------------------------------------------------------------------

import type { Database } from "bun:sqlite";
import { openDb as openEmailDb, setLastChecked } from "../../lib/email-db";

const VALID_SOURCES = new Set(["gmail", "outlook"]);

export function runSkipCatchup(db: Database, source: string): void {
  if (!VALID_SOURCES.has(source)) {
    throw new Error(`unknown source: ${source} (valid: ${[...VALID_SOURCES].join(", ")})`);
  }
  const ts = new Date().toISOString();
  setLastChecked(db, source, ts);
  console.log(`✓ ${source}: last_checked = ${ts}`);
}

if (import.meta.main) {
  const source = process.argv[2];
  if (!source) {
    console.error("Usage: skip-catchup.ts <gmail|outlook>");
    process.exit(2);
  }
  const dbPath = process.env.DB_PATH ?? "/data/email-watcher/emails.db";
  const db = openEmailDb(dbPath);
  try {
    runSkipCatchup(db, source);
  } catch (e: any) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}
