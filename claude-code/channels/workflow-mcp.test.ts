import { describe, it, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  openEmailDbReadOnly, openGdriveDbReadOnly,
  handleGetRecentEmails, handleGetEmailStats,
  handleGetGdriveScanStatus, handleGetGdriveScanStats,
  buildInvoiceIntakeInputPayload,
} from "./workflow-mcp";

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
    watch_folder TEXT, discovered_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);
  const stmt = db.prepare(`INSERT INTO gdrive_files (id, filename, mime_type, created_at, watch_folder)
                           VALUES (?, ?, ?, ?, ?)`);
  for (const r of rows) {
    stmt.run(r.id as string, r.filename as string, r.mime_type as string,
             r.created_at as string | null, r.watch_folder as string);
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
