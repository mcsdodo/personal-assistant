import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  openEmailDbReadOnly, openGdriveDbReadOnly,
  handleGetRecentEmails, handleGetEmailStats,
  handleGetGdriveScanStatus, handleGetGdriveScanStats,
  buildInvoiceIntakeInputPayload,
  buildScanIntakeInputPayload,
  isJobState,
} from "./workflow-mcp";
import { validateScanIntakeInput } from "./workflow-schemas";
import type { JobState } from "./workflow-db";

describe("isJobState", () => {
  // Hand-listed JobState members. The `satisfies` keeps each entry checked
  // against JobState (catches typos / removed states); the `_exhaustive`
  // assertion below catches NEW states added to the union.
  const ALL_STATES = [
    "queued",
    "running",
    "retryable",
    "awaiting_approval",
    "awaiting_classification",
    "awaiting_user_guidance",
    "completed",
    "failed",
    "cancelled",
  ] as const satisfies readonly JobState[];

  // Compile-time exhaustiveness: if a new member is added to JobState
  // without being added to ALL_STATES above, this line stops compiling.
  // That forces the test author to update ALL_STATES, which forces production
  // JOB_STATES to be reviewed too (since the test is the contract).
  type _Exhaustive = JobState extends (typeof ALL_STATES)[number] ? true : false;
  const _exhaustive: _Exhaustive = true;
  void _exhaustive;

  for (const state of ALL_STATES) {
    it(`accepts JobState "${state}"`, () => {
      expect(isJobState(state)).toBe(true);
    });
  }

  it("rejects unknown strings", () => {
    expect(isJobState("nonsense")).toBe(false);
    expect(isJobState("QUEUED")).toBe(false);
    expect(isJobState("")).toBe(false);
    expect(isJobState("queued ")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isJobState(undefined)).toBe(false);
    expect(isJobState(null)).toBe(false);
    expect(isJobState(123)).toBe(false);
    expect(isJobState({})).toBe(false);
    expect(isJobState([])).toBe(false);
  });
});

function tmpPath(prefix: string): string {
  return `/tmp/${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
}

function seedEmailsDb(path: string, rows: Array<Record<string, unknown>>): void {
  const db = new Database(path, { create: true });
  db.exec(`CREATE TABLE IF NOT EXISTS emails (
    id TEXT PRIMARY KEY, source TEXT NOT NULL, sender TEXT, subject TEXT,
    preview TEXT, has_attachments INTEGER DEFAULT 0, received_at TEXT,
    discovered_at TEXT NOT NULL DEFAULT (datetime('now')), trace_id TEXT,
    invoice_links TEXT
  );`);
  const stmt = db.prepare(`INSERT INTO emails
    (id, source, sender, subject, has_attachments, received_at)
    VALUES (?, ?, ?, ?, ?, ?)`);
  for (const r of rows) {
    stmt.run(r.id as string, r.source as string,
             (r.sender as string | null) ?? null,
             (r.subject as string | null) ?? null,
             r.has_attachments ? 1 : 0,
             (r.received_at as string | null) ?? null);
  }
  db.close();
}

function seedGdriveDb(path: string, rows: Array<Record<string, unknown>>): void {
  const db = new Database(path, { create: true });
  db.exec(`CREATE TABLE IF NOT EXISTS gdrive_files (
    id TEXT PRIMARY KEY, filename TEXT, mime_type TEXT, created_at TEXT,
    watch_folder TEXT, owner TEXT, bucket TEXT, folder_id TEXT,
    discovered_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);
  const stmt = db.prepare(`INSERT INTO gdrive_files
    (id, filename, mime_type, created_at, watch_folder, owner, bucket, folder_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const r of rows) {
    stmt.run(r.id as string, r.filename as string, r.mime_type as string,
             r.created_at as string | null, r.watch_folder as string,
             (r.owner as string | null) ?? null,
             (r.bucket as string | null) ?? null,
             (r.folder_id as string | null) ?? null);
  }
  db.close();
}

describe("workflow-mcp read-only debug tools", () => {
  it("get_recent_emails reads from a read-only handle", () => {
    const path = tmpPath("emails");
    seedEmailsDb(path, [{
      id: "msg-1", source: "gmail", sender: "x@y.com",
      subject: "Hello", has_attachments: true,
    }]);
    const roDb = openEmailDbReadOnly(path);
    const rows = handleGetRecentEmails(roDb, { limit: 10 });
    expect(rows.length).toBe(1);
    expect((rows[0] as any).id).toBe("msg-1");
  });

  it("get_email_stats returns total + last_24h counts", () => {
    const path = tmpPath("emails");
    seedEmailsDb(path, [
      { id: "a", source: "gmail" },
      { id: "b", source: "outlook" },
    ]);
    const roDb = openEmailDbReadOnly(path);
    const stats = handleGetEmailStats(roDb);
    expect(stats.total).toBe(2);
    expect(stats.last_24h).toBeGreaterThanOrEqual(0);
  });

  it("get_gdrive_scan_status reads gdrive.db read-only", () => {
    const path = tmpPath("gdrive");
    seedGdriveDb(path, [{
      id: "file-1", filename: "scan.pdf", mime_type: "application/pdf",
      created_at: "2026-04-15T10:00:00Z", watch_folder: "techlab/accounting",
    }]);
    const roDb = openGdriveDbReadOnly(path);
    const rows = handleGetGdriveScanStatus(roDb, { limit: 10 });
    expect(rows.length).toBe(1);
    expect((rows[0] as any).id).toBe("file-1");
  });

  it("get_gdrive_scan_stats returns total", () => {
    const path = tmpPath("gdrive");
    seedGdriveDb(path, [{
      id: "f1", filename: "a", mime_type: "x", created_at: null, watch_folder: "x",
    }]);
    const roDb = openGdriveDbReadOnly(path);
    expect(handleGetGdriveScanStats(roDb).total).toBe(1);
  });

  it("read-only handle rejects writes", () => {
    const path = tmpPath("emails");
    seedEmailsDb(path, []);
    const roDb = openEmailDbReadOnly(path);
    expect(() =>
      roDb.prepare("INSERT INTO emails (id, source) VALUES ('x', 'gmail')").run(),
    ).toThrow(/readonly|read-only/i);
  });
});

describe("buildInvoiceIntakeInputPayload", () => {
  it("populates sender/subject/received_at from emails.db so known_link reprocess can match vendor rules", () => {
    const path = tmpPath("emails");
    seedEmailsDb(path, [{
      id: "msg-alza", source: "outlook",
      sender: "sluzobnicek@alza.sk",
      subject: "Už to chystáme. / Obj. č. 593058485",
      received_at: "2026-04-20T09:57:11Z",
      has_attachments: true,
    }]);
    const roDb = openEmailDbReadOnly(path);

    const payload = buildInvoiceIntakeInputPayload(roDb, {
      email_source: "outlook",
      message_id: "msg-alza",
      force: true,
    });

    expect(payload.email_source).toBe("outlook");
    expect(payload.message_id).toBe("msg-alza");
    expect(payload.sender).toBe("sluzobnicek@alza.sk");
    expect(payload.subject).toBe("Už to chystáme. / Obj. č. 593058485");
    expect(payload.received_at).toBe("2026-04-20T09:57:11Z");
    expect(payload.force).toBe(true);
  });

  it("omits force flag when not requested", () => {
    const path = tmpPath("emails");
    seedEmailsDb(path, [{
      id: "msg-2", source: "gmail", sender: "x@y.com", subject: "S",
      received_at: "2026-04-21T00:00:00Z", has_attachments: false,
    }]);
    const roDb = openEmailDbReadOnly(path);

    const payload = buildInvoiceIntakeInputPayload(roDb, {
      email_source: "gmail",
      message_id: "msg-2",
      force: false,
    });

    expect("force" in payload).toBe(false);
  });

  it("returns null metadata when message_id is not in emails.db (legacy/manual ids)", () => {
    const path = tmpPath("emails");
    seedEmailsDb(path, []);
    const roDb = openEmailDbReadOnly(path);

    const payload = buildInvoiceIntakeInputPayload(roDb, {
      email_source: "outlook",
      message_id: "missing",
      force: false,
    });

    expect(payload.sender).toBeNull();
    expect(payload.subject).toBeNull();
    expect(payload.received_at).toBeNull();
  });
});

describe("buildScanIntakeInputPayload", () => {
  it("rebuilds a schema-valid job from the gdrive.db audit row (no caller-supplied owner/bucket/folder_id)", () => {
    const path = tmpPath("gdrive");
    seedGdriveDb(path, [{
      id: "1nyDd_personal_scan",
      filename: "Scanned_20260628-0919.pdf",
      mime_type: "application/pdf",
      created_at: "2026-06-28T07:19:30Z",
      watch_folder: "personal/accounting",
      owner: "personal",
      bucket: "accounting",
      folder_id: "drive-personal-acct-id",
    }]);
    const roDb = openGdriveDbReadOnly(path);

    const payload = buildScanIntakeInputPayload(roDb, {
      file_id: "1nyDd_personal_scan",
      force: false,
    });

    expect(payload.source).toBe("gdrive");
    expect(payload.file_id).toBe("1nyDd_personal_scan");
    expect(payload.watch_folder).toBe("personal/accounting");
    expect(payload.owner).toBe("personal");
    expect(payload.bucket).toBe("accounting");
    expect(payload.folder_id).toBe("drive-personal-acct-id");
    expect(payload.filename).toBe("Scanned_20260628-0919.pdf");
    // month_tag derived from created_at (mirrors the poller's YYYY-MM)
    expect(payload.month_tag).toBe("2026-06");
    // the whole point: the rebuilt payload passes the worker's schema gate
    expect(() => validateScanIntakeInput(payload)).not.toThrow();
  });

  it("includes force flag only when requested", () => {
    const path = tmpPath("gdrive");
    seedGdriveDb(path, [{
      id: "f-force", filename: "s.pdf", mime_type: "application/pdf",
      created_at: "2026-06-28T07:19:30Z", watch_folder: "techlab/accounting",
      owner: "business", bucket: "accounting", folder_id: "fid",
    }]);
    const roDb = openGdriveDbReadOnly(path);

    expect(buildScanIntakeInputPayload(roDb, { file_id: "f-force", force: true }).force).toBe(true);
    expect("force" in buildScanIntakeInputPayload(roDb, { file_id: "f-force", force: false })).toBe(false);
  });

  it("honours a caller month_tag override", () => {
    const path = tmpPath("gdrive");
    seedGdriveDb(path, [{
      id: "f-ovr", filename: "s.pdf", mime_type: "application/pdf",
      created_at: "2026-06-28T07:19:30Z", watch_folder: "techlab/accounting",
      owner: "business", bucket: "accounting", folder_id: "fid",
    }]);
    const roDb = openGdriveDbReadOnly(path);

    const payload = buildScanIntakeInputPayload(roDb, {
      file_id: "f-ovr", force: false, month_tag: "2026-05",
    });
    expect(payload.month_tag).toBe("2026-05");
  });

  it("fails loud when the file is not in the audit DB (file the poller never saw)", () => {
    const path = tmpPath("gdrive");
    seedGdriveDb(path, []);
    const roDb = openGdriveDbReadOnly(path);

    expect(() => buildScanIntakeInputPayload(roDb, { file_id: "ghost", force: false }))
      .toThrow(/not found|audit/i);
  });

  it("re-validates the assembled payload and fails loud on an out-of-enum owner", () => {
    // A row whose owner column holds a non-enum value (the poller guards this at
    // folder-resolution, but a corrupt/hand-edited row must not silently produce
    // a job the worker will later reject with schema_validation_failed).
    const path = tmpPath("gdrive");
    seedGdriveDb(path, [{
      id: "f-badowner", filename: "s.pdf", mime_type: "application/pdf",
      created_at: "2026-06-28T07:19:30Z", watch_folder: "weird/accounting",
      owner: "weird", bucket: "accounting", folder_id: "fid",
    }]);
    const roDb = openGdriveDbReadOnly(path);

    expect(() => buildScanIntakeInputPayload(roDb, { file_id: "f-badowner", force: false }))
      .toThrow(/ScanIntakeInput|owner/i);
  });

  it("fails loud on a pre-migration row missing owner/bucket/folder_id", () => {
    const path = tmpPath("gdrive");
    seedGdriveDb(path, [{
      id: "f-legacy", filename: "old.pdf", mime_type: "application/pdf",
      created_at: "2026-06-01T00:00:00Z", watch_folder: "techlab/accounting",
      // owner/bucket/folder_id intentionally omitted → NULL (pre-v3 row)
    }]);
    const roDb = openGdriveDbReadOnly(path);

    expect(() => buildScanIntakeInputPayload(roDb, { file_id: "f-legacy", force: false }))
      .toThrow(/owner|bucket|folder_id|re-?drop|predates/i);
  });
});
