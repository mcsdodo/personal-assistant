import { describe, expect, test } from "bun:test";
import {
  applyScanFolderOverrides,
  buildSuggestedActions,
  buildScanTagNames,
  buildTagNames,
  enforceNonMonetaryInvariants,
  generateTitle,
  mergeClassifications,
  parseServicePeriodStart,
  resolveMonthTag,
  resolveOwner,
  UNKNOWN_FIELDS,
  validMonthTag,
  type EmailClassification,
} from "./pipeline";

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

  // ── Priority 4 is gated on a non-monetary document ──
  //
  // Regression for a 15-page terms-and-conditions PDF that was filed as a
  // purchase. The document classifier read it correctly -- `doc_type:
  // "document"`, no amount, no order number -- and answered `doc_date` with the
  // day the shop published the terms. The chain fell to priority 4 and tagged a
  // July e-mail with the June accounting month.
  test("doc_type document: docDate does NOT become the accounting month", () => {
    expect(
      resolveMonthTag({
        accountingPeriod: null,
        supplyDate: null,
        servicePeriodStart: null,
        docDate: "2026-06-17",
        subject: "Prijatá objednávka číslo 10000001 | SomeShop.sk",
        receivedAt: "Thu, 23 Jul 2026 19:29:49 +0200",
        docType: "document",
      }),
    ).toBe("2026-07");
  });

  test("doc_type document: an explicit accounting_period still wins", () => {
    // The gate is on priority 4 only. If the classifier reasoned its way to a
    // period, that is still the highest authority.
    expect(
      resolveMonthTag({
        accountingPeriod: "2026-05",
        docDate: "2026-06-17",
        docType: "document",
      }),
    ).toBe("2026-05");
  });

  test("doc_type document: supply_date and service_period still win", () => {
    expect(
      resolveMonthTag({ supplyDate: "2026-05-30", docDate: "2026-06-17", docType: "document" }),
    ).toBe("2026-05");
    expect(
      resolveMonthTag({
        servicePeriodStart: "2026-05-01",
        docDate: "2026-06-17",
        docType: "document",
      }),
    ).toBe("2026-05");
  });

  test("doc_type account_statement: docDate is NOT gated", () => {
    // Deliberate exclusion. A statement's issue date IS about the money period;
    // the classifier prompt only prefers the month the statement covers, and
    // that arrives as accounting_period at priority 1. Gating here would drop
    // statements to the subject regex for no defect.
    expect(
      resolveMonthTag({
        docDate: "2026-03-31",
        receivedAt: "2026-04-01T08:00:00Z",
        docType: "account_statement",
      }),
    ).toBe("2026-03");
  });

  test("every other doc_type, and an absent docType, still resolve from docDate", () => {
    expect(resolveMonthTag({ docDate: "2026-06-17", docType: "invoice" })).toBe("2026-06");
    expect(resolveMonthTag({ docDate: "2026-06-17", docType: "receipt" })).toBe("2026-06");
    expect(resolveMonthTag({ docDate: "2026-06-17", docType: "payslip" })).toBe("2026-06");
    expect(resolveMonthTag({ docDate: "2026-06-17", docType: null })).toBe("2026-06");
    expect(resolveMonthTag({ docDate: "2026-06-17" })).toBe("2026-06");
  });

  test("scan path: a documents-bucket drop falls through to the scan month", () => {
    // `applyScanFolderOverrides` forces `doc_type: "document"` for the
    // `documents` bucket, so the gate reaches the scan pipeline too. Asserted
    // rather than assumed -- this is a deliberate change to scan behaviour.
    expect(
      resolveMonthTag({
        docDate: "2019-03-14",
        scanFallback: "2026-09",
        docType: "document",
      }),
    ).toBe("2026-09");
  });
});

// ── resolveOwner ─────────────────────────────────────────────────────────

describe("resolveOwner", () => {
  test("payslip always resolves to personal, even if raw owner is business", () => {
    expect(resolveOwner("business", "payslip")).toBe("personal");
  });

  test("payslip with null raw owner resolves to personal", () => {
    expect(resolveOwner(null, "payslip")).toBe("personal");
  });

  test("payslip with undefined raw owner resolves to personal", () => {
    expect(resolveOwner(undefined, "payslip")).toBe("personal");
  });

  test("invoice keeps business owner", () => {
    expect(resolveOwner("business", "invoice")).toBe("business");
  });

  test("invoice keeps personal owner", () => {
    expect(resolveOwner("personal", "invoice")).toBe("personal");
  });

  test("unknown raw owner falls back to personal for non-payslip", () => {
    expect(resolveOwner("weird", "invoice")).toBe("personal");
  });

  test("null doc_type with business raw owner returns business", () => {
    expect(resolveOwner("business", null)).toBe("business");
  });
});

// ── buildTagNames ───────────────────────────────────────────────────────

describe("buildTagNames", () => {
  test("personal owner gets personal tag", () => {
    const tags = buildTagNames({ owner: "personal", doc_type: "invoice", is_fuel: false }, "2026-04", "techlab");
    expect(tags).toContain("personal");
    expect(tags).toContain("2026-04");
    expect(tags).not.toContain("techlab");
  });

  test("business owner gets techlab tag + accounting tags", () => {
    const tags = buildTagNames({ owner: "business", doc_type: "invoice", is_fuel: false }, "2026-04", "techlab");
    expect(tags).toContain("techlab");
    expect(tags).toContain("accounting");
  });

  test("fuel flag adds fuel tag", () => {
    const tags = buildTagNames({ owner: "personal", doc_type: "invoice", is_fuel: true }, "2026-04", "techlab");
    expect(tags).toContain("fuel");
  });

  test("credit_note doc_type adds credit-note tag", () => {
    const tags = buildTagNames({ owner: "personal", doc_type: "credit_note", is_fuel: false }, null, "techlab");
    expect(tags).toContain("credit-note");
  });

  test("account_statement doc_type adds account-statement tag", () => {
    const tags = buildTagNames({ owner: "personal", doc_type: "account_statement", is_fuel: false }, null, "techlab");
    expect(tags).toContain("account-statement");
  });

  test("null month_tag is not included", () => {
    const tags = buildTagNames({ owner: "personal", doc_type: "invoice", is_fuel: false }, null, "techlab");
    expect(tags).not.toContain(null);
    expect(tags).toEqual(["personal"]);
  });

  test("malformed month_tag is rejected (defense in depth)", () => {
    // Even if a buggy upstream caller passes a junk tag, buildTagNames must drop it
    // so it never reaches Paperless and silently auto-creates a malformed tag.
    const tags = buildTagNames(
      { owner: "business", doc_type: "invoice", is_fuel: false },
      "2940-61",
      "techlab",
    );
    expect(tags).not.toContain("2940-61");
    expect(tags).toEqual(["techlab", "accounting"]);
  });

  test("month_tag with month > 12 is rejected", () => {
    const tags = buildTagNames(
      { owner: "personal", doc_type: "invoice", is_fuel: false },
      "2026-13",
      "techlab",
    );
    expect(tags).not.toContain("2026-13");
    expect(tags).toEqual(["personal"]);
  });

  test("valid month_tag in plausible range is kept", () => {
    const tags = buildTagNames(
      { owner: "personal", doc_type: "invoice", is_fuel: false },
      "2026-04",
      "techlab",
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
      "techlab",
    );
    expect(tags).toEqual(["personal", "2026-03"]);
    expect(tags).not.toContain("accounting");
    expect(tags).not.toContain("techlab");
  });

  test("owner-based accounting logic unchanged (email path)", () => {
    const withBusiness = buildTagNames({ owner: "business", doc_type: "invoice", is_fuel: false }, "2026-03", "techlab");
    expect(withBusiness).toContain("accounting");
    const withPersonal = buildTagNames({ owner: "personal", doc_type: "invoice", is_fuel: false }, "2026-03", "techlab");
    expect(withPersonal).not.toContain("accounting");
  });

  // ── OWNER_BUSINESS_LABEL configurability ──

  test("business owner with explicit businessLabel 'techlab' gets 'techlab' tag", () => {
    const tags = buildTagNames({ owner: "business", doc_type: "invoice", is_fuel: false }, "2026-04", "techlab");
    expect(tags).toContain("techlab");
    expect(tags[0]).toBe("techlab");
  });

  test("business owner with custom businessLabel 'acme' gets 'acme' tag", () => {
    const tags = buildTagNames({ owner: "business", doc_type: "invoice", is_fuel: false }, "2026-04", "acme");
    expect(tags).toContain("acme");
    expect(tags).not.toContain("techlab");
    expect(tags[0]).toBe("acme");
  });

  test("personal owner is unaffected by businessLabel", () => {
    const tags = buildTagNames({ owner: "personal", doc_type: "invoice", is_fuel: false }, "2026-04", "acme");
    expect(tags).toContain("personal");
    expect(tags).not.toContain("acme");
    expect(tags[0]).toBe("personal");
  });
});

// ── buildScanTagNames ────────────────────────────────────────────────────

describe("buildScanTagNames", () => {
  const LABEL = "techlab";

  test("business/accounting → business label tag + accounting", () => {
    const tags = buildScanTagNames("business", "accounting", LABEL, { doc_type: "invoice", is_fuel: false }, "2026-03");
    expect(tags).toContain("techlab");
    expect(tags).toContain("accounting");
    expect(tags).toContain("2026-03");
  });

  test("business/documents → no accounting tag", () => {
    const tags = buildScanTagNames("business", "documents", LABEL, { doc_type: "invoice", is_fuel: false }, "2026-03");
    expect(tags).toContain("techlab");
    expect(tags).not.toContain("accounting");
  });

  test("personal/accounting → personal tag with NO accounting tag", () => {
    const tags = buildScanTagNames("personal", "accounting", LABEL, { doc_type: "invoice", is_fuel: false }, "2026-03");
    expect(tags).toContain("personal");
    expect(tags).not.toContain("accounting");
    expect(tags).not.toContain("techlab");
  });

  test("personal/documents → personal tag only", () => {
    const tags = buildScanTagNames("personal", "documents", LABEL, { doc_type: "receipt", is_fuel: false }, null);
    expect(tags).toContain("personal");
    expect(tags).not.toContain("techlab");
    expect(tags).not.toContain("accounting");
  });

  test("non-default businessLabel is used for the owner tag", () => {
    const tags = buildScanTagNames("business", "accounting", "acme", { doc_type: "invoice", is_fuel: false }, "2026-03");
    expect(tags).toContain("acme");
    expect(tags).not.toContain("techlab");
    expect(tags).toContain("accounting");
  });

  test("fuel classification adds fuel tag regardless of bucket", () => {
    const tags = buildScanTagNames("business", "accounting", LABEL, { doc_type: "receipt", is_fuel: true }, "2026-03");
    expect(tags).toContain("fuel");
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
    owner: "business",
    confidence: "high",
    order_id: "26051300558",
    subtitle: null,
    doc_date: null,
  };

  test("documents bucket forces doc_type to document", () => {
    const result = applyScanFolderOverrides(base, "documents");
    expect(result.doc_type).toBe("document");
  });

  test("documents bucket nulls total_amount and order_id", () => {
    const result = applyScanFolderOverrides(base, "documents");
    expect(result.total_amount).toBeNull();
    expect(result.order_id).toBeNull();
  });

  test("documents bucket preserves vendor, owner, is_fuel, dates", () => {
    const result = applyScanFolderOverrides(base, "documents");
    expect(result.vendor).toBe("twd SK");
    expect(result.owner).toBe("business");
    expect(result.is_fuel).toBe(false);
  });

  test("accounting bucket leaves classification unchanged", () => {
    const result = applyScanFolderOverrides(base, "accounting");
    expect(result).toEqual(base);
  });

  test("returns new object, does not mutate input", () => {
    const original = { ...base };
    applyScanFolderOverrides(base, "documents");
    expect(base).toEqual(original);
  });
});

// ── enforceNonMonetaryInvariants ────────────────────────────────────────

describe("enforceNonMonetaryInvariants", () => {
  const base = {
    doc_type: "invoice",
    vendor: "SomeShop.sk",
    total_amount: 88.4,
    currency: "EUR",
    is_fuel: false,
    owner: "personal",
    order_id: "10000001",
    subtitle: null,
  };

  test("doc_type document nulls total_amount and order_id", () => {
    const result = enforceNonMonetaryInvariants({ ...base, doc_type: "document" });
    expect(result.total_amount).toBeNull();
    expect(result.order_id).toBeNull();
  });

  test("doc_type account_statement nulls total_amount and order_id", () => {
    const result = enforceNonMonetaryInvariants({ ...base, doc_type: "account_statement" });
    expect(result.total_amount).toBeNull();
    expect(result.order_id).toBeNull();
  });

  test("doc_type document preserves everything else", () => {
    const result = enforceNonMonetaryInvariants({ ...base, doc_type: "document" });
    expect(result.vendor).toBe("SomeShop.sk");
    expect(result.owner).toBe("personal");
    expect(result.currency).toBe("EUR");
    expect(result.is_fuel).toBe(false);
  });

  test("invoice, credit_note and payslip are untouched", () => {
    for (const docType of ["invoice", "credit_note", "payslip", "unknown", null]) {
      const input = { ...base, doc_type: docType };
      expect(enforceNonMonetaryInvariants(input)).toEqual(input);
    }
  });

  // Deliberately narrower than the document-classifier prompt, which also
  // lists `receipt` and `payslip` under its `order_id` null rule. That rule is
  // about the document's OWN number; this function is about money. An order id
  // carried over from the covering e-mail is still the dedup key (order_id +
  // correspondent) and the identifier the title prefers, and historical receipt
  // jobs relied on exactly that. Do not "fix" this to match the prompt.
  test("doc_type receipt KEEPS its order_id -- this is not an oversight", () => {
    const result = enforceNonMonetaryInvariants({ ...base, doc_type: "receipt" });
    expect(result.order_id).toBe("10000001");
    expect(result.total_amount).toBe(88.4);
  });

  test("returns a new object, does not mutate input", () => {
    const input = { ...base, doc_type: "document" };
    const snapshot = { ...input };
    enforceNonMonetaryInvariants(input);
    expect(input).toEqual(snapshot);
  });

  // The order-acknowledgement replay: the e-mail classifier guessed an amount
  // and an order number off the covering e-mail, the document classifier read
  // the PDF and returned null for both, and the merge kept the guesses because
  // a null reads as "no opinion". Both must be null by the time the custom
  // fields are set.
  test("merge then enforce: the email's amount and order number do not survive", () => {
    const email: EmailClassification = {
      vendor: "SomeShop.sk",
      total_amount: 88.4,
      owner: null,
      doc_type: "invoice",
      confidence: "medium",
      is_fuel: false,
      order_id: "10000001",
      subtitle: null,
      currency: "EUR",
    };
    const doc: Partial<EmailClassification> = {
      vendor: "Terms Publisher s. r. o.",
      total_amount: null,
      order_id: null,
      doc_type: "document",
      owner: "personal",
      confidence: "high",
    };

    const merged = mergeClassifications(email, doc);
    // The merge alone is not enough -- this is the defect.
    expect(merged.total_amount).toBe(88.4);
    expect(merged.order_id).toBe("10000001");

    const enforced = enforceNonMonetaryInvariants(merged);
    expect(enforced.total_amount).toBeNull();
    expect(enforced.order_id).toBeNull();
    expect(enforced.vendor).toBe("Terms Publisher s. r. o.");
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
    expect(actions).toEqual(["set:owner=personal", "set:owner=business", "skip"]);
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
    expect(actions).toContain("set:owner=business");
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
