import { afterEach, describe, expect, test } from "bun:test";
import { buildGuidanceReplyMarkup, formatGuidanceRequest, formatNotification } from "./telegram-notify";

describe("formatNotification", () => {
  test("uploaded — all fields present", () => {
    expect(formatNotification({
      outcome: "uploaded",
      vendor: "Slovak Telekom",
      total_amount: 42.99,
      currency: "EUR",
      doc_type: "invoice",
      owner: "business",
      month_tag: "2026-04",
    })).toBe("✔️  Slovak Telekom | 42.99 EUR | invoice | techlab | 2026-04");
  });

  test("uploaded — null amount shows ?", () => {
    expect(formatNotification({
      outcome: "uploaded",
      vendor: "Alza",
      total_amount: null,
      currency: "EUR",
      doc_type: "receipt",
      owner: "personal",
      month_tag: "2026-03",
    })).toBe("✔️  Alza | ? EUR | receipt | personal | 2026-03");
  });

  test("uploaded — null currency defaults to EUR", () => {
    expect(formatNotification({
      outcome: "uploaded",
      vendor: "Tesco",
      total_amount: 18.50,
      currency: null,
      doc_type: "invoice",
      owner: "business",
      month_tag: "2026-04",
    })).toBe("✔️  Tesco | 18.5 EUR | invoice | techlab | 2026-04");
  });

  test("uploaded — null owner shows ?", () => {
    expect(formatNotification({
      outcome: "uploaded",
      vendor: "Orange",
      total_amount: 29.99,
      currency: "EUR",
      doc_type: "invoice",
      owner: null,
      month_tag: "2026-03",
    })).toBe("✔️  Orange | 29.99 EUR | invoice | ? | 2026-03");
  });

  test("uploaded — null month_tag shows no-period", () => {
    expect(formatNotification({
      outcome: "uploaded",
      vendor: "SomeVendor",
      total_amount: null,
      currency: null,
      doc_type: "invoice",
      owner: null,
      month_tag: null,
    })).toBe("✔️  SomeVendor | ? EUR | invoice | ? | no-period");
  });

  test("uploaded — missing month_tag shows no-period", () => {
    expect(formatNotification({
      outcome: "uploaded",
      vendor: "SomeVendor",
      total_amount: null,
      currency: null,
      doc_type: "invoice",
      owner: null,
    })).toBe("✔️  SomeVendor | ? EUR | invoice | ? | no-period");
  });

  test("duplicate_likely — shows duplicate message", () => {
    expect(formatNotification({
      outcome: "duplicate_likely",
      vendor: "Tesco",
      total_amount: 18.50,
      currency: "EUR",
      doc_type: "invoice",
      owner: "business",
      duplicate_message: 'duplicate of "Tesco FA-2026-001"',
    })).toBe('♻️  Tesco | 18.5 EUR | duplicate of "Tesco FA-2026-001"');
  });

  test("failed — shows error", () => {
    expect(formatNotification({
      outcome: "failed",
      vendor: "Orange",
      total_amount: null,
      currency: null,
      doc_type: "invoice",
      owner: "business",
      error: "download failed: 404",
    })).toBe("❌  Orange | ? EUR | invoice | techlab | download failed: 404");
  });

  test("failed — null error shows unknown error", () => {
    expect(formatNotification({
      outcome: "failed",
      vendor: "Orange",
      total_amount: 10,
      currency: "EUR",
      doc_type: "invoice",
      owner: null,
      error: null,
    })).toBe("❌  Orange | 10 EUR | invoice | ? | unknown error");
  });

  test("duplicate — returns null (no notification)", () => {
    expect(formatNotification({
      outcome: "duplicate",
      vendor: "Tesco",
      total_amount: 18.5,
      currency: "EUR",
      doc_type: "invoice",
      owner: "business",
    })).toBeNull();
  });

  test("refreshed — includes 🔄 icon, period and (refreshed #N)", () => {
    expect(formatNotification({
      outcome: "refreshed",
      vendor: "Anthropic, PBC",
      total_amount: 100.0,
      currency: "EUR",
      doc_type: "invoice",
      owner: "business",
      month_tag: "2026-04",
      paperless_document_id: 411,
    })).toBe("🔄  Anthropic, PBC | 100 EUR | invoice | techlab | 2026-04 (refreshed #411)");
  });

  test("refreshed — without doc id falls back to (refreshed)", () => {
    expect(formatNotification({
      outcome: "refreshed",
      vendor: "Alza",
      total_amount: 53.78,
      currency: "EUR",
      doc_type: "invoice",
      owner: "personal",
      month_tag: "2026-03",
    })).toBe("🔄  Alza | 53.78 EUR | invoice | personal | 2026-03 (refreshed)");
  });
});

describe("formatNotification — /car hint", () => {
  const baseUploaded = {
    outcome: "uploaded" as const,
    vendor: "Mestský Parkovací Systém",
    total_amount: 4.20,
    currency: "EUR",
    doc_type: "receipt",
    owner: "business" as const,
    month_tag: "2026-04",
    paperless_document_id: 422,
  };

  test("appends /car hint for non-fuel receipt", () => {
    const msg = formatNotification({ ...baseUploaded, is_fuel: false });
    expect(msg).toContain("Reply /car");
  });

  test("does not append /car hint for fuel receipt", () => {
    const msg = formatNotification({ ...baseUploaded, vendor: "Slovnaft", is_fuel: true });
    expect(msg).not.toContain("Reply /car");
  });

  test("does not append /car hint for invoice (non-receipt doc_type)", () => {
    const msg = formatNotification({ ...baseUploaded, doc_type: "invoice", is_fuel: false });
    expect(msg).not.toContain("Reply /car");
  });

  test("does not append /car hint for payslip / account_statement / document", () => {
    for (const dt of ["payslip", "account_statement", "document"]) {
      const msg = formatNotification({ ...baseUploaded, doc_type: dt, is_fuel: false });
      expect(msg).not.toContain("Reply /car");
    }
  });
});

describe("formatGuidanceRequest", () => {
  test("encrypted_pdf reason includes filename, sender, and decrypt-failed note", () => {
    const msg = formatGuidanceRequest({
      job_id: "abc123",
      reason: "encrypted_pdf",
      context: {
        filename: "mKonto_c_0157_za_2026-03.pdf",
        sender: "kontakt@mbank.sk",
        subject: "mBank – Mesačný výpis z účtu",
        classifier_notes: "PDF is encrypted; decrypt failed",
      },
      suggested_actions: ["skip", "set:owner=personal,doc_type=account_statement", "send_password"],
    });
    expect(msg).toContain("🤔");
    expect(msg).toContain("mKonto_c_0157_za_2026-03.pdf");
    expect(msg).toContain("kontakt@mbank.sk");
    expect(msg).toContain("encrypted");
    expect(msg).toContain("/skip");
  });

  test("classifier_unknown reason shows missing fields and notes", () => {
    const msg = formatGuidanceRequest({
      job_id: "def456",
      reason: "classifier_unknown",
      missing_fields: ["owner"],
      context: {
        filename: "invoice.pdf",
        vendor: "Alza.sk s.r.o.",
        total_amount: 142.30,
        classifier_notes: "no IČO printed",
      },
      suggested_actions: ["set:owner=personal", "set:owner=business", "skip"],
    });
    expect(msg).toContain("Owner unclear");
    expect(msg).toContain("no IČO");
    expect(msg).toContain("/personal");
    expect(msg).toContain("/techlab");
  });
});

describe("buildGuidanceReplyMarkup", () => {
  test("classifier_unknown — owner choices paired, skip on its own row", () => {
    const markup = buildGuidanceReplyMarkup({
      job_id: "def45678-aaaa-bbbb-cccc-111122223333",
      suggested_actions: ["skip", "set:owner=personal", "set:owner=business"],
    });
    expect(markup).toEqual({
      inline_keyboard: [
        [
          { text: "Personal", callback_data: "g:def45678:set:owner=personal" },
          { text: "Techlab", callback_data: "g:def45678:set:owner=business" },
        ],
        [
          { text: "Skip", callback_data: "g:def45678:skip" },
        ],
      ],
    });
  });

  test("encrypted_pdf — full Trigger B action list renders and pairs combos", () => {
    const markup = buildGuidanceReplyMarkup({
      job_id: "abc123de-aaaa-bbbb-cccc-111122223333",
      suggested_actions: [
        "send_password",
        "set:owner=personal,doc_type=account_statement",
        "set:owner=business,doc_type=account_statement",
        "skip",
        "retry",
      ],
    });
    expect(markup).toEqual({
      inline_keyboard: [
        [
          { text: "Send password", callback_data: "g:abc123de:send_password" },
        ],
        [
          { text: "Personal+statement", callback_data: "g:abc123de:set:owner=personal,doc_type=account_statement" },
          { text: "Techlab+statement", callback_data: "g:abc123de:set:owner=business,doc_type=account_statement" },
        ],
        [
          { text: "Skip", callback_data: "g:abc123de:skip" },
          { text: "Retry", callback_data: "g:abc123de:retry" },
        ],
      ],
    });
  });

  test("every callback_data stays under the 64-byte Telegram limit", () => {
    // Longest plausible action in v1 is the combo
    // "set:owner=personal,doc_type=account_statement" (45 chars) plus
    // "g:<8-char-prefix>:" prefix (11 chars) = 56 bytes.
    const markup = buildGuidanceReplyMarkup({
      job_id: "ffffffff-eeee-dddd-cccc-111122223333",
      suggested_actions: [
        "set:owner=personal,doc_type=account_statement",
        "set:owner=business,doc_type=account_statement",
        "send_password",
        "skip",
        "retry",
        "fail",
      ],
    });
    for (const row of markup.inline_keyboard) {
      for (const btn of row) {
        // Buffer.byteLength counts UTF-8 bytes, matching Telegram's 1..64 bytes rule.
        const bytes = Buffer.byteLength(btn.callback_data, "utf8");
        expect(bytes).toBeGreaterThan(0);
        expect(bytes).toBeLessThanOrEqual(64);
      }
    }
  });

  test("unknown/unmappable actions are dropped rather than rendered blank", () => {
    const markup = buildGuidanceReplyMarkup({
      job_id: "11112222-aaaa-bbbb-cccc-111122223333",
      suggested_actions: ["set:weird_field=42", "skip"],
    });
    expect(markup.inline_keyboard).toEqual([
      [
        { text: "Skip", callback_data: "g:11112222:skip" },
      ],
    ]);
  });
});

// ── OWNER_BUSINESS_LABEL env var ────────────────────────────────────────────

describe("formatNotification — OWNER_BUSINESS_LABEL", () => {
  afterEach(() => {
    delete process.env.OWNER_BUSINESS_LABEL;
  });

  test("default (no env var): business owner shows 'techlab' in summary", () => {
    const msg = formatNotification({
      outcome: "uploaded",
      vendor: "Telekom",
      total_amount: 10,
      currency: "EUR",
      doc_type: "invoice",
      owner: "business",
      month_tag: "2026-04",
    });
    expect(msg).toContain("techlab");
    expect(msg).not.toContain("| business |");
  });

  test("OWNER_BUSINESS_LABEL=acme: business owner shows 'acme' in summary", () => {
    process.env.OWNER_BUSINESS_LABEL = "acme";
    const msg = formatNotification({
      outcome: "uploaded",
      vendor: "Telekom",
      total_amount: 10,
      currency: "EUR",
      doc_type: "invoice",
      owner: "business",
      month_tag: "2026-04",
    });
    expect(msg).toContain("acme");
    expect(msg).not.toContain("techlab");
    expect(msg).not.toContain("| business |");
  });

  test("personal owner is unaffected by OWNER_BUSINESS_LABEL", () => {
    process.env.OWNER_BUSINESS_LABEL = "acme";
    const msg = formatNotification({
      outcome: "uploaded",
      vendor: "Telekom",
      total_amount: 10,
      currency: "EUR",
      doc_type: "invoice",
      owner: "personal",
      month_tag: "2026-04",
    });
    expect(msg).toContain("personal");
    expect(msg).not.toContain("acme");
  });
});

describe("formatGuidanceRequest — OWNER_BUSINESS_LABEL", () => {
  afterEach(() => {
    delete process.env.OWNER_BUSINESS_LABEL;
  });

  test("default: business action renders /techlab command", () => {
    const msg = formatGuidanceRequest({
      job_id: "abc123de-aaaa-bbbb-cccc-111122223333",
      reason: "classifier_unknown",
      missing_fields: ["owner"],
      context: {},
      suggested_actions: ["set:owner=business", "set:owner=personal", "skip"],
    });
    expect(msg).toContain("/techlab");
    expect(msg).not.toContain("/acme");
  });

  test("OWNER_BUSINESS_LABEL=acme: business action renders /acme command", () => {
    process.env.OWNER_BUSINESS_LABEL = "acme";
    const msg = formatGuidanceRequest({
      job_id: "abc123de-aaaa-bbbb-cccc-111122223333",
      reason: "classifier_unknown",
      missing_fields: ["owner"],
      context: {},
      suggested_actions: ["set:owner=business", "set:owner=personal", "skip"],
    });
    expect(msg).toContain("/acme");
    expect(msg).not.toContain("/techlab");
  });
});

describe("buildGuidanceReplyMarkup — OWNER_BUSINESS_LABEL", () => {
  afterEach(() => {
    delete process.env.OWNER_BUSINESS_LABEL;
  });

  test("default: business owner button shows 'Techlab'", () => {
    const markup = buildGuidanceReplyMarkup({
      job_id: "abc12345-aaaa-bbbb-cccc-111122223333",
      suggested_actions: ["set:owner=business", "skip"],
    });
    const allTexts = markup.inline_keyboard.flat().map((b) => b.text);
    expect(allTexts).toContain("Techlab");
    expect(allTexts).not.toContain("Acme");
  });

  test("OWNER_BUSINESS_LABEL=acme: business owner button shows 'Acme'", () => {
    process.env.OWNER_BUSINESS_LABEL = "acme";
    const markup = buildGuidanceReplyMarkup({
      job_id: "abc12345-aaaa-bbbb-cccc-111122223333",
      suggested_actions: ["set:owner=business", "skip"],
    });
    const allTexts = markup.inline_keyboard.flat().map((b) => b.text);
    expect(allTexts).toContain("Acme");
    expect(allTexts).not.toContain("Techlab");
  });
});
