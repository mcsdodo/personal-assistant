import { describe, expect, test } from "bun:test";

import {
  WorkflowSchemaError,
  validateClassificationByStep,
  validateDocumentClassificationResult,
  validateEmailClassificationResult,
  validateInvoiceIntakeInput,
  validateScanIntakeInput,
} from "./workflow-schemas";

// ── Helpers ────────────────────────────────────────────────────────────

function expectSchemaError(
  fn: () => unknown,
  match: { schemaName?: string; field?: string; expected?: string | RegExp },
) {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(WorkflowSchemaError);
  const err = caught as WorkflowSchemaError;
  if (match.schemaName) expect(err.schemaName).toBe(match.schemaName);
  if (match.field) expect(err.field).toBe(match.field);
  if (match.expected) {
    if (typeof match.expected === "string") {
      expect(err.expected).toContain(match.expected);
    } else {
      expect(err.expected).toMatch(match.expected);
    }
  }
}

// ── InvoiceIntakeInput ────────────────────────────────────────────────

describe("validateInvoiceIntakeInput", () => {
  test("accepts a minimal valid input", () => {
    const out = validateInvoiceIntakeInput({
      email_source: "outlook",
      message_id: "msg-123",
    });
    expect(out.email_source).toBe("outlook");
    expect(out.message_id).toBe("msg-123");
    expect(out.force).toBeUndefined();
  });

  test("accepts gmail and force=true", () => {
    const out = validateInvoiceIntakeInput({
      email_source: "gmail",
      message_id: "abc",
      force: true,
    });
    expect(out.email_source).toBe("gmail");
    expect(out.force).toBe(true);
  });

  test("tolerates extra fields (forward compatibility)", () => {
    const out = validateInvoiceIntakeInput({
      email_source: "gmail",
      message_id: "abc",
      future_field: "ignore me",
      another: 42,
    });
    expect(out.message_id).toBe("abc");
    expect((out as Record<string, unknown>).future_field).toBeUndefined();
  });

  test("rejects missing message_id", () => {
    expectSchemaError(
      () => validateInvoiceIntakeInput({ email_source: "outlook" }),
      { schemaName: "InvoiceIntakeInput", field: "message_id", expected: "non-empty string" },
    );
  });

  test("rejects empty message_id", () => {
    expectSchemaError(
      () => validateInvoiceIntakeInput({ email_source: "outlook", message_id: "" }),
      { field: "message_id" },
    );
  });

  test("rejects unknown email_source", () => {
    expectSchemaError(
      () => validateInvoiceIntakeInput({ email_source: "imap", message_id: "x" }),
      { field: "email_source", expected: "gmail" },
    );
  });

  test("rejects non-object input", () => {
    expectSchemaError(() => validateInvoiceIntakeInput(null), { field: "<root>" });
    expectSchemaError(() => validateInvoiceIntakeInput("a string"), { field: "<root>" });
    expectSchemaError(() => validateInvoiceIntakeInput([1, 2]), { field: "<root>" });
  });
});

// ── ScanIntakeInput ───────────────────────────────────────────────────

describe("validateScanIntakeInput", () => {
  test("accepts a valid scan input with owner/bucket/folder_id", () => {
    const out = validateScanIntakeInput({
      source: "gdrive",
      file_id: "fid-1",
      watch_folder: "techlab/accounting",
      month_tag: "2026-03",
      owner: "business",
      bucket: "accounting",
      folder_id: "drive-folder-xyz",
      filename: "scan.pdf",
    });
    expect(out.file_id).toBe("fid-1");
    expect(out.month_tag).toBe("2026-03");
    expect(out.owner).toBe("business");
    expect(out.bucket).toBe("accounting");
    expect(out.folder_id).toBe("drive-folder-xyz");
  });

  test("accepts the personal owner", () => {
    const out = validateScanIntakeInput({
      source: "gdrive",
      file_id: "fid-2",
      watch_folder: "personal/documents",
      month_tag: "2026-03",
      owner: "personal",
      bucket: "documents",
      folder_id: "drive-folder-abc",
    });
    expect(out.owner).toBe("personal");
    expect(out.bucket).toBe("documents");
  });

  test("rejects missing file_id", () => {
    expectSchemaError(
      () =>
        validateScanIntakeInput({
          source: "gdrive",
          watch_folder: "x",
          month_tag: "2026-03",
          owner: "business",
          bucket: "accounting",
          folder_id: "f",
        }),
      { field: "file_id" },
    );
  });

  test("rejects unknown source", () => {
    expectSchemaError(
      () =>
        validateScanIntakeInput({
          source: "dropbox",
          file_id: "x",
          watch_folder: "y",
          month_tag: "2026-03",
          owner: "business",
          bucket: "accounting",
          folder_id: "f",
        }),
      { field: "source" },
    );
  });

  test("rejects unknown owner (B3 fail-loud)", () => {
    expectSchemaError(
      () =>
        validateScanIntakeInput({
          source: "gdrive",
          file_id: "x",
          watch_folder: "techlab/accounting",
          month_tag: "2026-03",
          owner: "techlab",
          bucket: "accounting",
          folder_id: "f",
        }),
      { field: "owner" },
    );
  });

  test("rejects unknown bucket (B3 fail-loud)", () => {
    expectSchemaError(
      () =>
        validateScanIntakeInput({
          source: "gdrive",
          file_id: "x",
          watch_folder: "techlab/invoicing",
          month_tag: "2026-03",
          owner: "business",
          bucket: "invoicing",
          folder_id: "f",
        }),
      { field: "bucket" },
    );
  });

  test("rejects missing folder_id", () => {
    expectSchemaError(
      () =>
        validateScanIntakeInput({
          source: "gdrive",
          file_id: "x",
          watch_folder: "techlab/accounting",
          month_tag: "2026-03",
          owner: "business",
          bucket: "accounting",
        }),
      { field: "folder_id" },
    );
  });
});

// ── EmailClassificationResult ─────────────────────────────────────────

const VALID_EMAIL_CLASS = {
  is_invoice: true,
  confidence: "high",
  vendor: "Alza",
  is_fuel: false,
  action: "download_and_upload",
  download_strategy: "attachment",
  strategy_confidence: "high",
  requires_review: false,
  order_id: "FA2026030001",
  total_amount: 59.99,
  currency: "EUR",
  subject: "Your invoice FA2026030001",
  received_at: "2026-03-27T10:00:00Z",
  sender: "noreply@alza.sk",
};

describe("validateEmailClassificationResult", () => {
  test("accepts a fully populated valid result", () => {
    const out = validateEmailClassificationResult(VALID_EMAIL_CLASS);
    expect(out.vendor).toBe("Alza");
    expect(out.download_strategy).toBe("attachment");
    expect(out.action).toBe("download_and_upload");
    expect(out.total_amount).toBe(59.99);
  });

  test("accepts download_strategy=null when action=ignore", () => {
    const out = validateEmailClassificationResult({
      ...VALID_EMAIL_CLASS,
      action: "ignore",
      download_strategy: null,
      total_amount: null,
      currency: null,
      order_id: null,
    });
    expect(out.action).toBe("ignore");
    expect(out.download_strategy).toBeNull();
  });

  test("accepts null vendor and null strategy_confidence when action=ignore", () => {
    // When the email-classifier decides a non-invoice (e.g. newsletter,
    // marketing, personal message), it shouldn't have to invent a vendor
    // or a strategy_confidence — the rest of the pipeline short-circuits
    // on action=ignore anyway. See task 48 follow-up (production bug
    // surfaced after deploy: 3 jobs rejected for null vendor+strategy_confidence
    // with action=ignore).
    const out = validateEmailClassificationResult({
      ...VALID_EMAIL_CLASS,
      action: "ignore",
      is_invoice: false,
      vendor: null,
      strategy_confidence: null,
      download_strategy: null,
      total_amount: null,
      currency: null,
      order_id: null,
    });
    expect(out.action).toBe("ignore");
    expect(out.vendor).toBeNull();
    expect(out.strategy_confidence).toBeNull();
  });

  test("still rejects null vendor when action=download_and_upload", () => {
    // Safety: for real invoices, vendor must still be present so the
    // downstream correspondent resolution has something to fuzzy-match.
    expectSchemaError(
      () =>
        validateEmailClassificationResult({
          ...VALID_EMAIL_CLASS,
          action: "download_and_upload",
          vendor: null,
        }),
      { field: "vendor" },
    );
  });

  test("accepts the additional download strategies (claude_download, browser_required, manual_review)", () => {
    for (const ds of ["claude_download", "known_link", "direct_url", "browser_required", "manual_review"]) {
      const out = validateEmailClassificationResult({ ...VALID_EMAIL_CLASS, download_strategy: ds });
      expect(out.download_strategy).toBe(ds as any);
    }
  });

  test("tolerates extra fields", () => {
    const out = validateEmailClassificationResult({
      ...VALID_EMAIL_CLASS,
      novel_field: { nested: "ok" },
    });
    expect(out.vendor).toBe("Alza");
  });

  test("rejects missing vendor", () => {
    const { vendor: _vendor, ...rest } = VALID_EMAIL_CLASS;
    expectSchemaError(
      () => validateEmailClassificationResult(rest),
      { field: "vendor" },
    );
  });

  test("rejects wrong-type confidence", () => {
    expectSchemaError(
      () => validateEmailClassificationResult({ ...VALID_EMAIL_CLASS, confidence: 5 }),
      { field: "confidence" },
    );
  });

  test("rejects unknown action", () => {
    expectSchemaError(
      () => validateEmailClassificationResult({ ...VALID_EMAIL_CLASS, action: "delete_everything" }),
      { field: "action" },
    );
  });

  test("rejects unknown download_strategy", () => {
    expectSchemaError(
      () => validateEmailClassificationResult({ ...VALID_EMAIL_CLASS, download_strategy: "telepathy" }),
      { field: "download_strategy" },
    );
  });

  test("rejects missing subject (worker needs it for month_tag)", () => {
    const { subject: _s, ...rest } = VALID_EMAIL_CLASS;
    expectSchemaError(
      () => validateEmailClassificationResult(rest),
      { field: "subject" },
    );
  });
});

// ── DocumentClassificationResult ──────────────────────────────────────

const VALID_DOC_CLASS = {
  doc_type: "invoice",
  vendor: "Anthropic, PBC",
  total_amount: 100.0,
  currency: "EUR",
  is_fuel: false,
  owner: "business",
  owner_match_evidence: "Techlab s. r. o.",
  confidence: "high",
  order_id: "9E72DD91-0009",
  subtitle: null,
  doc_date: "2026-04-06",
  supply_date: "2026-04-06",
  service_period: "2026-04-06/2026-05-06",
  accounting_period: "2026-04",
  accounting_period_reasoning: "Subscription invoice for April",
};

describe("validateDocumentClassificationResult", () => {
  test("accepts a full canonical document classifier output", () => {
    const out = validateDocumentClassificationResult(VALID_DOC_CLASS);
    expect(out.vendor).toBe("Anthropic, PBC");
    expect(out.owner).toBe("business");
    expect(out.accounting_period).toBe("2026-04");
  });

  test("accepts null total_amount and null dates", () => {
    const out = validateDocumentClassificationResult({
      ...VALID_DOC_CLASS,
      total_amount: null,
      currency: null,
      order_id: null,
      doc_date: null,
      supply_date: null,
      service_period: null,
      accounting_period: null,
      accounting_period_reasoning: null,
    });
    expect(out.total_amount).toBeNull();
    expect(out.accounting_period).toBeNull();
  });

  // ── owner_match_evidence (task 83) ─────────────────────────────────
  // Haiku must quote the literal BUSINESS_* substring it matched before
  // claiming owner=business. The validator rejects business without proof
  // and rejects evidence on personal/unknown classifications.

  test("accepts owner=business with non-empty evidence", () => {
    const out = validateDocumentClassificationResult({
      ...VALID_DOC_CLASS,
      owner: "business",
      owner_match_evidence: "Techlab s. r. o.",
    });
    expect(out.owner).toBe("business");
    expect(out.owner_match_evidence).toBe("Techlab s. r. o.");
  });

  test("rejects owner=business with null evidence (proof required)", () => {
    expectSchemaError(
      () =>
        validateDocumentClassificationResult({
          ...VALID_DOC_CLASS,
          owner: "business",
          owner_match_evidence: null,
        }),
      { field: "owner_match_evidence", expected: "non-empty string when owner=business" },
    );
  });

  test("rejects owner=business with missing evidence (proof required)", () => {
    const { owner_match_evidence: _e, ...rest } = VALID_DOC_CLASS;
    expectSchemaError(
      () =>
        validateDocumentClassificationResult({
          ...rest,
          owner: "business",
        }),
      { field: "owner_match_evidence" },
    );
  });

  test("rejects owner=business with empty/whitespace evidence", () => {
    expectSchemaError(
      () =>
        validateDocumentClassificationResult({
          ...VALID_DOC_CLASS,
          owner: "business",
          owner_match_evidence: "",
        }),
      { field: "owner_match_evidence" },
    );
    expectSchemaError(
      () =>
        validateDocumentClassificationResult({
          ...VALID_DOC_CLASS,
          owner: "business",
          owner_match_evidence: "   ",
        }),
      { field: "owner_match_evidence" },
    );
  });

  test("accepts owner=personal with null evidence", () => {
    const out = validateDocumentClassificationResult({
      ...VALID_DOC_CLASS,
      owner: "personal",
      owner_match_evidence: null,
    });
    expect(out.owner).toBe("personal");
    expect(out.owner_match_evidence).toBeNull();
  });

  test("accepts owner=personal with missing evidence (treated as null)", () => {
    const { owner_match_evidence: _e, ...rest } = VALID_DOC_CLASS;
    const out = validateDocumentClassificationResult({
      ...rest,
      owner: "personal",
    });
    expect(out.owner).toBe("personal");
    expect(out.owner_match_evidence).toBeNull();
  });

  test("rejects owner=personal with non-null evidence (nothing to prove)", () => {
    expectSchemaError(
      () =>
        validateDocumentClassificationResult({
          ...VALID_DOC_CLASS,
          owner: "personal",
          owner_match_evidence: "stray string",
        }),
      { field: "owner_match_evidence", expected: "null when owner=personal" },
    );
  });

  test("accepts owner=unknown with null evidence and notes", () => {
    const out = validateDocumentClassificationResult({
      ...VALID_DOC_CLASS,
      owner: "unknown",
      owner_match_evidence: null,
      notes: "buyer block torn off, can't determine owner",
    });
    expect(out.owner).toBe("unknown");
    expect(out.owner_match_evidence).toBeNull();
  });

  test("rejects non-string evidence type", () => {
    expectSchemaError(
      () =>
        validateDocumentClassificationResult({
          ...VALID_DOC_CLASS,
          owner: "business",
          owner_match_evidence: 42,
        }),
      { field: "owner_match_evidence", expected: "string | null" },
    );
  });

  // ── owner enum rename: techlab→business (task 97) ────────────────────
  // Asserts the schema now rejects the old "techlab" token and accepts "business".

  test("rejects owner=techlab (renamed to business — old token invalid)", () => {
    expectSchemaError(
      () =>
        validateDocumentClassificationResult({
          ...VALID_DOC_CLASS,
          owner: "techlab",
          owner_match_evidence: "Techlab s. r. o.",
        }),
      { field: "owner" },
    );
  });

  test("accepts owner=business (renamed from techlab — new token valid)", () => {
    const out = validateDocumentClassificationResult({
      ...VALID_DOC_CLASS,
      owner: "business",
      owner_match_evidence: "Techlab s. r. o.",
    });
    expect(out.owner).toBe("business");
  });

  test("rejects missing owner (required for tag routing)", () => {
    const { owner: _o, ...rest } = VALID_DOC_CLASS;
    expectSchemaError(
      () => validateDocumentClassificationResult(rest),
      { field: "owner" },
    );
  });

  test("rejects total_amount as string", () => {
    expectSchemaError(
      () => validateDocumentClassificationResult({ ...VALID_DOC_CLASS, total_amount: "100" }),
      { field: "total_amount" },
    );
  });

  test("tolerates missing optional fields like supply_date", () => {
    const { supply_date: _s, accounting_period: _a, accounting_period_reasoning: _r, ...rest } = VALID_DOC_CLASS;
    const out = validateDocumentClassificationResult(rest);
    expect(out.vendor).toBe("Anthropic, PBC");
    expect(out.supply_date).toBeNull();
  });
});

// ── DocumentClassificationResult unknown values ───────────────────────

describe("DocumentClassificationResult unknown values", () => {
  const baseValid = {
    doc_type: "invoice", vendor: "X", total_amount: 1, currency: "EUR",
    is_fuel: false, confidence: "high", order_id: null, subtitle: null,
    owner: "personal", doc_date: "2026-01-01", supply_date: null,
    service_period: null, accounting_period: "2026-01",
    accounting_period_reasoning: "doc_date in Jan",
    notes: null,
  };

  test("owner can be 'unknown' when notes explains it", () => {
    const r = { ...baseValid, owner: "unknown", notes: "no IČO printed; buyer name only" };
    expect(() => validateDocumentClassificationResult(r)).not.toThrow();
  });

  test("doc_type can be 'unknown' when notes explains it", () => {
    const r = { ...baseValid, doc_type: "unknown", notes: "blank pages, encrypted" };
    expect(() => validateDocumentClassificationResult(r)).not.toThrow();
  });

  test("rejects 'unknown' without notes", () => {
    const r = { ...baseValid, owner: "unknown", notes: null };
    expect(() => validateDocumentClassificationResult(r))
      .toThrow(/notes required when any field is "unknown"/);
  });

  test("rejects 'unknown' with empty notes", () => {
    const r = { ...baseValid, owner: "unknown", notes: "  " };
    expect(() => validateDocumentClassificationResult(r))
      .toThrow(/notes required when any field is "unknown"/);
  });
});

// ── DocumentClassificationResult — litres + receipt_datetime ─────────

describe("DocumentClassificationResult — litres + receipt_datetime", () => {
  // Minimal valid base; tests below clone + override.
  const base = {
    doc_type: "receipt",
    vendor: "Slovnaft",
    total_amount: 45.30,
    currency: "EUR",
    is_fuel: true,
    owner: "business",
    owner_match_evidence: "SK12345678",
    confidence: "high",
    order_id: null,
    subtitle: null,
    doc_date: "2026-04-25",
  };

  test("accepts litres as a number", () => {
    const out = validateDocumentClassificationResult({ ...base, litres: 45.30 });
    expect(out.litres).toBe(45.30);
  });

  test("accepts litres as null", () => {
    const out = validateDocumentClassificationResult({ ...base, is_fuel: false, litres: null });
    expect(out.litres).toBeNull();
  });

  test("accepts missing litres (backward compatibility)", () => {
    const out = validateDocumentClassificationResult(base);
    expect(out.litres).toBeNull();
  });

  test("rejects litres as a string", () => {
    expect(() =>
      validateDocumentClassificationResult({ ...base, litres: "45.30" })
    ).toThrow(/litres/);
  });

  test("accepts receipt_datetime in YYYY-MM-DDTHH:MM:SS format", () => {
    const out = validateDocumentClassificationResult({ ...base, receipt_datetime: "2026-04-25T14:23:00" });
    expect(out.receipt_datetime).toBe("2026-04-25T14:23:00");
  });

  test("coerces date-only receipt_datetime to T00:00:00 (always emit full datetime)", () => {
    const out = validateDocumentClassificationResult({ ...base, receipt_datetime: "2026-04-25" });
    expect(out.receipt_datetime).toBe("2026-04-25T00:00:00");
  });

  test("accepts receipt_datetime as null and missing", () => {
    expect(validateDocumentClassificationResult({ ...base, receipt_datetime: null }).receipt_datetime).toBeNull();
    expect(validateDocumentClassificationResult(base).receipt_datetime).toBeNull();
  });

  test("rejects receipt_datetime with malformed string", () => {
    expect(() =>
      validateDocumentClassificationResult({ ...base, receipt_datetime: "25.04.2026" })
    ).toThrow(/receipt_datetime/);
    expect(() =>
      validateDocumentClassificationResult({ ...base, receipt_datetime: "2026-04-25 14:23:00" })  // space, not T
    ).toThrow(/receipt_datetime/);
  });
});

// ── validateClassificationByStep ──────────────────────────────────────

describe("validateClassificationByStep", () => {
  test("dispatches to email validator for classify_email", () => {
    const out = validateClassificationByStep("classify_email", VALID_EMAIL_CLASS) as Record<string, unknown>;
    expect(out.vendor).toBe("Alza");
  });

  test("dispatches to doc validator for classify_document", () => {
    const out = validateClassificationByStep("classify_document", VALID_DOC_CLASS) as Record<string, unknown>;
    expect(out.vendor).toBe("Anthropic, PBC");
  });

  test("attaches step name to error context", () => {
    let caught: unknown;
    try {
      validateClassificationByStep("classify_email", { vendor: "Alza" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WorkflowSchemaError);
    expect((caught as WorkflowSchemaError).context).toMatchObject({ step: "classify_email" });
    expect((caught as Error).message).toContain("classify_email");
  });

  test("passes through unknown steps unchanged (forward compatibility)", () => {
    const payload = { something: 1 };
    expect(validateClassificationByStep("unknown_future_step", payload)).toBe(payload);
  });
});

// ── Real worker test fixtures (regression: schemas must accept what the
// existing invoice-worker tests pass through createRunningJob) ────────

describe("compatibility with existing test fixtures", () => {
  test("accepts the defaultEmailClassification shape from invoice-worker.test.ts", () => {
    // This is the *exact* shape used by invoice-worker.test.ts:46-67. The
    // schema must accept it or every existing test breaks.
    const fixture = {
      is_invoice: true,
      confidence: "high",
      vendor: "Alza",
      doc_type: "invoice",
      is_fuel: false,
      owner: "business",
      action: "download_and_upload",
      download_strategy: "attachment",
      strategy_confidence: "high",
      requires_review: false,
      order_id: "FA2026030001",
      subtitle: null,
      total_amount: 59.99,
      currency: "EUR",
      sender: "noreply@alza.sk",
      subject: "Your invoice FA2026030001",
      received_at: "2026-03-27T10:00:00Z",
    };
    const out = validateEmailClassificationResult(fixture);
    expect(out.vendor).toBe("Alza");
  });

  test("accepts the defaultScanClassification shape from invoice-worker.test.ts", () => {
    const fixture = {
      doc_type: "invoice",
      vendor: "Alza",
      total_amount: 59.99,
      currency: "EUR",
      is_fuel: false,
      owner: "business",
      owner_match_evidence: "Techlab s. r. o.",
      confidence: "high",
      order_id: "FA2026030001",
      subtitle: null,
      doc_date: null,
    };
    const out = validateDocumentClassificationResult(fixture);
    expect(out.vendor).toBe("Alza");
    expect(out.doc_date).toBeNull();
  });
});

describe("EmailClassificationResult.skip_reason", () => {
  test("EmailClassificationResult preserves skip_reason on an accountant ignore", () => {
    const out = validateEmailClassificationResult({
      is_invoice: false, confidence: "high", vendor: null, doc_type: "document",
      is_fuel: false, action: "ignore", download_strategy: null,
      strategy_confidence: null, requires_review: false, order_id: null,
      total_amount: null, currency: null, subject: "Re: docs", received_at: null,
      sender: "acct@example.test", skip_reason: "query",
    });
    expect(out.skip_reason).toBe("query");
  });

  test("EmailClassificationResult defaults skip_reason to null when absent", () => {
    const out = validateEmailClassificationResult({
      is_invoice: true, confidence: "high", vendor: "Acme", doc_type: "invoice",
      is_fuel: false, action: "download_and_upload", download_strategy: "attachment",
      strategy_confidence: "high", requires_review: false, order_id: "A1",
      total_amount: 10, currency: "EUR", subject: "Invoice", received_at: null,
      sender: "billing@acme.test",
    });
    expect(out.skip_reason).toBeNull();
  });
});
