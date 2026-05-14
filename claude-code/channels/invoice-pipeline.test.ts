import { describe, expect, test } from "bun:test";
import {
  applyScanFolderOverrides,
  buildSuggestedActions,
  buildScanTagNames,
  buildTagNames,
  generateTitle,
  mergeClassifications,
  parseServicePeriodStart,
  resolveMonthTag,
  resolveOwner,
  UNKNOWN_FIELDS,
  validMonthTag,
  type EmailClassification,
} from "./invoice-pipeline";

// ── mergeClassifications ────────────────────────────────────────────────

describe("mergeClassifications", () => {
  test("doc-classifier non-null values override email-classifier", () => {
    const email: EmailClassification = {
      vendor: "Alza",
      total_amount: null,
      owner: null,
      doc_type: "invoice",
      confidence: "medium",
      is_fuel: false,
      order_id: null,
      subtitle: null,
      currency: null,
    };
    const doc: Partial<EmailClassification> = {
      vendor: "Alza.sk s.r.o.",
      total_amount: 53.78,
      owner: "personal",
      doc_type: "invoice",
      confidence: "high",
    };
    const merged = mergeClassifications(email, doc);
    expect(merged.vendor).toBe("Alza.sk s.r.o.");
    expect(merged.total_amount).toBe(53.78);
    expect(merged.owner).toBe("personal");
    expect(merged.confidence).toBe("high");
  });

  test("email values preserved when doc returns null", () => {
    const email: EmailClassification = {
      vendor: "Alza",
      total_amount: 53.78,
      owner: null,
      doc_type: "invoice",
      confidence: "high",
      is_fuel: false,
      order_id: null,
      subtitle: null,
      currency: null,
    };
    const doc: Partial<EmailClassification> = {
      vendor: null,
      total_amount: null,
      owner: "personal",
      doc_type: null,
      confidence: null,
    };
    const merged = mergeClassifications(email, doc);
    expect(merged.vendor).toBe("Alza");
    expect(merged.total_amount).toBe(53.78);
    expect(merged.owner).toBe("personal");
  });

  test("undefined doc fields are ignored", () => {
    const email: EmailClassification = {
      vendor: "TestVendor",
      total_amount: 10,
      owner: "personal",
      doc_type: "invoice",
      confidence: "high",
      is_fuel: false,
      order_id: "ORD-1",
      subtitle: null,
      currency: "EUR",
    };
    const doc: Partial<EmailClassification> = {};
    const merged = mergeClassifications(email, doc);
    expect(merged).toEqual(email);
  });
});

// ── validMonthTag ───────────────────────────────────────────────────────

describe("validMonthTag", () => {
  test("accepts valid current/recent year", () => {
    expect(validMonthTag("2026-04")).toBe("2026-04");
    expect(validMonthTag("2024-01")).toBe("2024-01");
    expect(validMonthTag("2026-12")).toBe("2026-12");
  });

  test("rejects implausible far-future year", () => {
    expect(validMonthTag("2940-12")).toBeNull();
    expect(validMonthTag("9999-01")).toBeNull();
  });

  test("rejects year before 2000", () => {
    expect(validMonthTag("1999-12")).toBeNull();
    expect(validMonthTag("0023-04")).toBeNull();
  });

  test("rejects month > 12", () => {
    expect(validMonthTag("2026-13")).toBeNull();
    expect(validMonthTag("2026-99")).toBeNull();
    expect(validMonthTag("2026-61")).toBeNull();
  });

  test("rejects month 00", () => {
    expect(validMonthTag("2026-00")).toBeNull();
  });

  test("rejects malformed input", () => {
    expect(validMonthTag("2026-4")).toBeNull(); // missing leading zero
    expect(validMonthTag("2026/04")).toBeNull();
    expect(validMonthTag("26-04")).toBeNull();
    expect(validMonthTag("2026-04-15")).toBeNull(); // full date
    expect(validMonthTag("foo")).toBeNull();
    expect(validMonthTag("")).toBeNull();
    expect(validMonthTag(null)).toBeNull();
    expect(validMonthTag(undefined)).toBeNull();
  });
});

// ── parseServicePeriodStart ─────────────────────────────────────────────

describe("parseServicePeriodStart", () => {
  test("extracts left side of ISO 8601 interval", () => {
    expect(parseServicePeriodStart("2026-04-06/2026-05-06")).toBe("2026-04-06");
    expect(parseServicePeriodStart("2026-03-01/2026-03-31")).toBe("2026-03-01");
  });

  test("returns null for malformed input", () => {
    expect(parseServicePeriodStart("2026-04-06")).toBeNull(); // single date
    expect(parseServicePeriodStart("Apr 6 - May 6")).toBeNull();
    expect(parseServicePeriodStart("2026-04/2026-05")).toBeNull(); // not full dates
    expect(parseServicePeriodStart(null)).toBeNull();
    expect(parseServicePeriodStart(undefined)).toBeNull();
    expect(parseServicePeriodStart("")).toBeNull();
  });
});

// ── resolveMonthTag ─────────────────────────────────────────────────────

describe("resolveMonthTag", () => {
  // ── Priority order ──

  test("LLM accounting_period wins over everything", () => {
    expect(
      resolveMonthTag({
        accountingPeriod: "2026-04",
        supplyDate: "2026-01-01",
        docDate: "2026-02-15",
        subject: "Faktúra 03/2026",
        receivedAt: "2026-05-01T10:00:00Z",
      }),
    ).toBe("2026-04");
  });

  test("supply_date beats doc_date when accounting_period absent", () => {
    expect(
      resolveMonthTag({
        supplyDate: "2026-03-30",
        docDate: "2026-04-02",
      }),
    ).toBe("2026-03");
  });

  test("service_period_start used when supply_date absent", () => {
    expect(
      resolveMonthTag({
        servicePeriodStart: "2026-04-06",
        docDate: "2026-04-06",
      }),
    ).toBe("2026-04");
  });

  test("doc_date beats subject regex", () => {
    expect(
      resolveMonthTag({
        docDate: "2026-03-15",
        subject: "Receipt #2024-099876",
      }),
    ).toBe("2026-03");
  });

  test("subject regex used when no doc dates", () => {
    expect(
      resolveMonthTag({
        subject: "Faktúra 03/2026",
        receivedAt: "2026-04-01T10:00:00Z",
      }),
    ).toBe("2026-03");
  });

  test("YYYY-MM in subject works when surrounded by whitespace", () => {
    expect(resolveMonthTag({ subject: "Statement 2026-02" })).toBe("2026-02");
  });

  test("falls back to received_at when nothing else", () => {
    expect(
      resolveMonthTag({
        subject: "Invoice",
        receivedAt: "2026-04-01T10:00:00Z",
      }),
    ).toBe("2026-04");
  });

  test("scanFallback used as final fallback for scan pipeline", () => {
    expect(
      resolveMonthTag({
        scanFallback: "2026-03",
      }),
    ).toBe("2026-03");
  });

  test("returns null when nothing available", () => {
    expect(resolveMonthTag({})).toBeNull();
    expect(resolveMonthTag({ subject: "Invoice" })).toBeNull();
  });

  // ── Adversarial: regex hardening ──

  test("BUG #411: receipt number #2940-6120-5985 must NOT match", () => {
    // This is the smoking gun. Regex used to match `2940-61` from this subject.
    expect(
      resolveMonthTag({
        subject: "Your receipt from Anthropic, PBC #2940-6120-5985",
      }),
    ).toBeNull();
  });

  test("embedded numeric ID like 12345-678 must NOT match", () => {
    expect(resolveMonthTag({ subject: "Order 12345-67890 confirmed" })).toBeNull();
  });

  test("invoice number with year-like prefix must NOT match", () => {
    expect(resolveMonthTag({ subject: "Invoice FV2024-12345" })).toBeNull();
  });

  test("month > 12 in subject must NOT match", () => {
    expect(resolveMonthTag({ subject: "Receipt 2026-15" })).toBeNull();
    expect(resolveMonthTag({ subject: "Bill 13/2026" })).toBeNull();
  });

  test("year before 2000 in subject must NOT match", () => {
    expect(resolveMonthTag({ subject: "Faktúra 999-12" })).toBeNull();
    expect(resolveMonthTag({ subject: "Document 1850-05 archive" })).toBeNull();
  });

  test("far-future year in subject must NOT match", () => {
    expect(resolveMonthTag({ subject: "Sci-fi 2940-06 scenario" })).toBeNull();
  });

  test("MM/YYYY surrounded by other slashes must NOT match", () => {
    expect(resolveMonthTag({ subject: "path/03/2026/file" })).toBeNull();
  });

  test("doc_date overrides bogus subject regex hit", () => {
    // Even if subject contains a valid YYYY-MM, doc_date wins.
    expect(
      resolveMonthTag({
        docDate: "2026-04-06",
        subject: "Quarterly review 2024-01",
      }),
    ).toBe("2026-04");
  });

  test("Anthropic case end-to-end", () => {
    // The exact scenario that produced doc #411 with tag "2940-61".
    // With LLM reasoning: classifier returns accounting_period directly.
    expect(
      resolveMonthTag({
        accountingPeriod: "2026-04",
        supplyDate: "2026-04-06",
        servicePeriodStart: "2026-04-06",
        docDate: "2026-04-06",
        subject: "Your receipt from Anthropic, PBC #2940-6120-5985",
        receivedAt: "2026-04-06T18:00:00Z",
      }),
    ).toBe("2026-04");
  });

  test("Anthropic case if classifier somehow misses accounting_period", () => {
    // Even without accounting_period, supply_date carries us through correctly.
    expect(
      resolveMonthTag({
        supplyDate: "2026-04-06",
        servicePeriodStart: "2026-04-06",
        docDate: "2026-04-06",
        subject: "Your receipt from Anthropic, PBC #2940-6120-5985",
        receivedAt: "2026-04-06T18:00:00Z",
      }),
    ).toBe("2026-04");
  });

  test("Anthropic case with ONLY subject and received_at (worst case)", () => {
    // Everything date-related is missing. Subject regex must NOT produce 2940-61.
    // received_at still saves us with the email arrival month.
    expect(
      resolveMonthTag({
        subject: "Your receipt from Anthropic, PBC #2940-6120-5985",
        receivedAt: "2026-04-06T18:00:00Z",
      }),
    ).toBe("2026-04");
  });

  test("invalid accounting_period from LLM is rejected, falls through", () => {
    expect(
      resolveMonthTag({
        accountingPeriod: "2940-61", // bogus LLM output (defensive)
        docDate: "2026-04-06",
      }),
    ).toBe("2026-04");
  });
});

// ── resolveOwner ─────────────────────────────────────────────────────────

describe("resolveOwner", () => {
  test("payslip always resolves to personal, even if raw owner is techlab", () => {
    expect(resolveOwner("techlab", "payslip")).toBe("personal");
  });

  test("payslip with null raw owner resolves to personal", () => {
    expect(resolveOwner(null, "payslip")).toBe("personal");
  });

  test("payslip with undefined raw owner resolves to personal", () => {
    expect(resolveOwner(undefined, "payslip")).toBe("personal");
  });

  test("invoice keeps techlab owner", () => {
    expect(resolveOwner("techlab", "invoice")).toBe("techlab");
  });

  test("invoice keeps personal owner", () => {
    expect(resolveOwner("personal", "invoice")).toBe("personal");
  });

  test("unknown raw owner falls back to personal for non-payslip", () => {
    expect(resolveOwner("weird", "invoice")).toBe("personal");
  });

  test("null doc_type with techlab raw owner returns techlab", () => {
    expect(resolveOwner("techlab", null)).toBe("techlab");
  });
});

// ── buildTagNames ───────────────────────────────────────────────────────

describe("buildTagNames", () => {
  test("personal owner gets personal tag", () => {
    const tags = buildTagNames({ owner: "personal", doc_type: "invoice", is_fuel: false }, "2026-04");
    expect(tags).toContain("personal");
    expect(tags).toContain("2026-04");
    expect(tags).not.toContain("techlab");
  });

  test("techlab owner gets techlab + accounting tags", () => {
    const tags = buildTagNames({ owner: "techlab", doc_type: "invoice", is_fuel: false }, "2026-04");
    expect(tags).toContain("techlab");
    expect(tags).toContain("accounting");
  });

  test("fuel flag adds fuel tag", () => {
    const tags = buildTagNames({ owner: "personal", doc_type: "invoice", is_fuel: true }, "2026-04");
    expect(tags).toContain("fuel");
  });

  test("credit_note doc_type adds credit-note tag", () => {
    const tags = buildTagNames({ owner: "personal", doc_type: "credit_note", is_fuel: false }, null);
    expect(tags).toContain("credit-note");
  });

  test("account_statement doc_type adds account-statement tag", () => {
    const tags = buildTagNames({ owner: "personal", doc_type: "account_statement", is_fuel: false }, null);
    expect(tags).toContain("account-statement");
  });

  test("null month_tag is not included", () => {
    const tags = buildTagNames({ owner: "personal", doc_type: "invoice", is_fuel: false }, null);
    expect(tags).not.toContain(null);
    expect(tags).toEqual(["personal"]);
  });

  test("malformed month_tag is rejected (defense in depth)", () => {
    // Even if a buggy upstream caller passes a junk tag, buildTagNames must drop it
    // so it never reaches Paperless and silently auto-creates a malformed tag.
    const tags = buildTagNames(
      { owner: "techlab", doc_type: "invoice", is_fuel: false },
      "2940-61",
    );
    expect(tags).not.toContain("2940-61");
    expect(tags).toEqual(["techlab", "accounting"]);
  });

  test("month_tag with month > 12 is rejected", () => {
    const tags = buildTagNames(
      { owner: "personal", doc_type: "invoice", is_fuel: false },
      "2026-13",
    );
    expect(tags).not.toContain("2026-13");
    expect(tags).toEqual(["personal"]);
  });

  test("valid month_tag in plausible range is kept", () => {
    const tags = buildTagNames(
      { owner: "personal", doc_type: "invoice", is_fuel: false },
      "2026-04",
    );
    expect(tags).toContain("2026-04");
  });

  test("payslip doc_type with personal owner emits [personal, month] — no accounting tag", () => {
    // buildTagNames is expected to receive the already-resolved owner
    // (post-resolveOwner). Verifies that with owner=personal + doc_type=payslip,
    // no `accounting` tag leaks through, which would otherwise pull the
    // doc into checker-mcp matching.
    const tags = buildTagNames(
      { owner: "personal", doc_type: "payslip", is_fuel: false },
      "2026-03",
    );
    expect(tags).toEqual(["personal", "2026-03"]);
    expect(tags).not.toContain("accounting");
    expect(tags).not.toContain("techlab");
  });

  test("owner-based accounting logic unchanged (email path)", () => {
    const withTechlab = buildTagNames({ owner: "techlab", doc_type: "invoice", is_fuel: false }, "2026-03");
    expect(withTechlab).toContain("accounting");
    const withPersonal = buildTagNames({ owner: "personal", doc_type: "invoice", is_fuel: false }, "2026-03");
    expect(withPersonal).not.toContain("accounting");
  });
});

// ── buildScanTagNames ────────────────────────────────────────────────────

describe("buildScanTagNames", () => {
  test("accounting folder adds accounting tag", () => {
    const tags = buildScanTagNames("techlab/accounting", { doc_type: "invoice", is_fuel: false }, "2026-03");
    expect(tags).toContain("techlab");
    expect(tags).toContain("accounting");
    expect(tags).toContain("2026-03");
  });

  test("DOCUMENTS folder does not add accounting tag", () => {
    const tags = buildScanTagNames("techlab/DOCUMENTS", { doc_type: "invoice", is_fuel: false }, "2026-03");
    expect(tags).toContain("techlab");
    expect(tags).not.toContain("accounting");
  });

  test("fuel classification adds fuel tag regardless of folder", () => {
    const tags = buildScanTagNames("techlab/accounting", { doc_type: "receipt", is_fuel: true }, "2026-03");
    expect(tags).toContain("fuel");
  });

  test("owner comes from level1 segment", () => {
    const tags = buildScanTagNames("personal/receipts", { doc_type: "receipt", is_fuel: false }, null);
    expect(tags).toContain("personal");
    expect(tags).not.toContain("techlab");
    expect(tags).not.toContain("accounting");
  });
});

// ── applyScanFolderOverrides ─────────────────────────────────────────────

describe("applyScanFolderOverrides", () => {
  const base = {
    doc_type: "invoice",
    vendor: "twd SK",
    total_amount: 914.9,
    currency: "EUR",
    is_fuel: false,
    owner: "techlab",
    confidence: "high",
    order_id: "26051300558",
    subtitle: null,
    doc_date: null,
  };

  test("documents folder forces doc_type to document", () => {
    const result = applyScanFolderOverrides(base, "techlab/documents");
    expect(result.doc_type).toBe("document");
  });

  test("documents folder nulls total_amount and order_id", () => {
    const result = applyScanFolderOverrides(base, "techlab/documents");
    expect(result.total_amount).toBeNull();
    expect(result.order_id).toBeNull();
  });

  test("documents folder preserves vendor, owner, is_fuel, dates", () => {
    const result = applyScanFolderOverrides(base, "techlab/documents");
    expect(result.vendor).toBe("twd SK");
    expect(result.owner).toBe("techlab");
    expect(result.is_fuel).toBe(false);
  });

  test("accounting folder leaves classification unchanged", () => {
    const result = applyScanFolderOverrides(base, "techlab/accounting");
    expect(result).toEqual(base);
  });

  test("unrecognized level2 leaves classification unchanged", () => {
    const result = applyScanFolderOverrides(base, "techlab/somethingelse");
    expect(result).toEqual(base);
  });

  test("returns new object, does not mutate input", () => {
    const original = { ...base };
    applyScanFolderOverrides(base, "techlab/documents");
    expect(base).toEqual(original);
  });
});

// ── generateTitle ───────────────────────────────────────────────────────

describe("generateTitle", () => {
  test("vendor + order_id", () => {
    expect(generateTitle("Alza.sk s.r.o.", "590848993", null, null)).toBe("Alza.sk s.r.o. - 590848993");
  });

  test("vendor + subtitle when no order_id", () => {
    expect(generateTitle("DST s.r.o.", null, "Dochádzka marec 2026", null)).toBe("DST s.r.o. - Dochádzka marec 2026");
  });

  test("vendor + cleaned subject when no order_id or subtitle", () => {
    expect(generateTitle("Vendor", null, null, "Fwd: Your invoice #123")).toBe("Vendor - Your invoice #123");
  });

  test("vendor + fallback when nothing else", () => {
    expect(generateTitle("Vendor", null, null, null)).toBe("Vendor - invoice");
  });

  test("subject is trimmed to 80 chars", () => {
    const longSubject = "A".repeat(100);
    const result = generateTitle("V", null, null, longSubject);
    expect(result).toBe(`V - ${"A".repeat(80)}`);
  });
});

// ── UNKNOWN_FIELDS + buildSuggestedActions ──────────────────────────────

describe("UNKNOWN_FIELDS", () => {
  test("includes the fields the classifier may return as unknown", () => {
    expect(UNKNOWN_FIELDS).toContain("owner");
    expect(UNKNOWN_FIELDS).toContain("doc_type");
    expect(UNKNOWN_FIELDS).toContain("total_amount");
    expect(UNKNOWN_FIELDS).toContain("doc_date");
    expect(UNKNOWN_FIELDS).toContain("supply_date");
    expect(UNKNOWN_FIELDS).toContain("service_period");
    expect(UNKNOWN_FIELDS).toContain("accounting_period");
  });
});

describe("buildSuggestedActions", () => {
  test("owner unknown emits owner buttons + skip", () => {
    const actions = buildSuggestedActions(["owner"], { doc_type: "invoice" });
    expect(actions).toEqual(["set:owner=personal", "set:owner=techlab", "skip"]);
  });

  test("doc_type unknown emits doc_type buttons + skip", () => {
    const actions = buildSuggestedActions(["doc_type"], { doc_type: null });
    expect(actions).toEqual([
      "set:doc_type=invoice",
      "set:doc_type=receipt",
      "set:doc_type=account_statement",
      "skip",
    ]);
  });

  test("owner + doc_type both unknown emits both button sets + skip", () => {
    const actions = buildSuggestedActions(["owner", "doc_type"], {});
    expect(actions).toContain("set:owner=personal");
    expect(actions).toContain("set:owner=techlab");
    expect(actions).toContain("set:doc_type=invoice");
    expect(actions).toContain("skip");
  });

  test("unrelated unknown (e.g. total_amount) still emits skip", () => {
    const actions = buildSuggestedActions(["total_amount"], { doc_type: "invoice" });
    expect(actions).toEqual(["skip"]);
  });

  test("empty unknown list still emits skip (defensive)", () => {
    const actions = buildSuggestedActions([], {});
    expect(actions).toEqual(["skip"]);
  });
});
