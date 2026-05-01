import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import { extractInvoiceLinks } from "./invoice-links";

// ── Fixtures ─────────────────────────────────────────────────────────────

const ALZA_ALZABOX_HTML = readFileSync(
  join(__dirname, "test-data/alza-alzabox-ready.html"),
  "utf-8",
);

// Minimal HTML with a single Alza invoice link
const ALZA_SIMPLE_HTML = `
<html><body>
  <a href="https://www.alza.sk/Apps/pdfdoc.asp?d=12345&x=abc">Stiahnuť faktúru</a>
</body></html>
`;

// Alza refund email (uses "Stiahnuť doklad" + subject pattern)
const ALZA_REFUND_HTML = `
<html><body>
  <a href="https://www.alza.sk/Apps/pdfdoc.asp?d=99999&x=def">Stiahnuť doklad</a>
</body></html>
`;

// Email with no invoice links (just regular links)
const NO_INVOICE_HTML = `
<html><body>
  <a href="https://www.alza.sk/order/detail?id=123">Zobraziť objednávku</a>
  <a href="https://www.alza.sk">Alza.sk</a>
</body></html>
`;

// Non-Alza email with similar link text (should NOT match)
const NON_ALZA_HTML = `
<html><body>
  <a href="https://www.example.com/invoice.pdf">Stiahnuť faktúru</a>
</body></html>
`;

// Real Alza href encodes `&` as `&amp;` per HTML attribute rules. The extracted
// URL must be decoded — otherwise fetch() sends `&amp;x=...` which Alza parses
// as a query param named `amp;x` and returns HTTP 404.
const ALZA_AMP_ENTITY_HTML = `
<html><body>
  <a href="https://www.alza.sk/Apps/pdfdoc.asp?d=5419913904&amp;x=22B221303522304236TgB1R24C7&amp;utm_source=template">Stiahnuť&nbsp;faktúru</a>
</body></html>
`;

// ── Tests ────────────────────────────────────────────────────────────────

describe("extractInvoiceLinks", () => {
  describe("real Alza AlzaBox email", () => {
    test("extracts invoice download links from production email", () => {
      const links = extractInvoiceLinks(
        ALZA_ALZABOX_HTML,
        "info@alza.sk",
        "Pripravené v AlzaBoxe / Obj. č. 100000001",
      );

      expect(links.length).toBeGreaterThanOrEqual(1);
      expect(links[0].url).toContain("pdfdoc.asp");
      expect(links[0].url).toContain("d=100000002");
      expect(links[0].text).toMatch(/Stiahnuť\s*faktúru/i);
      expect(links[0].docId).toBe("100000002");
    });

    test("deduplicates links by URL", () => {
      const links = extractInvoiceLinks(
        ALZA_ALZABOX_HTML,
        "info@alza.sk",
        "Pripravené v AlzaBoxe / Obj. č. 100000001",
      );

      const urls = links.map((l) => l.url);
      const uniqueUrls = [...new Set(urls)];
      expect(urls.length).toBe(uniqueUrls.length);
    });
  });

  describe("sender matching", () => {
    test("matches alza.sk sender", () => {
      const links = extractInvoiceLinks(
        ALZA_SIMPLE_HTML,
        "info@alza.sk",
        "Your order",
      );
      expect(links).toHaveLength(1);
      expect(links[0].docId).toBe("12345");
    });

    test("matches alza.sk in sender with display name", () => {
      const links = extractInvoiceLinks(
        ALZA_SIMPLE_HTML,
        "Alza.sk <info@alza.sk>",
        "Your order",
      );
      expect(links).toHaveLength(1);
    });

    test("matches alza.sk in subject (forwarded emails)", () => {
      const links = extractInvoiceLinks(
        ALZA_SIMPLE_HTML,
        "someone@example.com",
        "Fwd: alza.sk order confirmation",
      );
      expect(links).toHaveLength(1);
    });

    test("does not match non-alza sender with no alza in subject", () => {
      const links = extractInvoiceLinks(
        NON_ALZA_HTML,
        "someone@example.com",
        "Your invoice",
      );
      expect(links).toHaveLength(0);
    });
  });

  describe("link text matching", () => {
    test("matches 'Stiahnuť faktúru'", () => {
      const links = extractInvoiceLinks(
        ALZA_SIMPLE_HTML,
        "info@alza.sk",
        "Order",
      );
      expect(links).toHaveLength(1);
    });

    test("matches 'Stiahnuť doklad' with refund subject", () => {
      const links = extractInvoiceLinks(
        ALZA_REFUND_HTML,
        "info@alza.sk",
        "Vrátili sme vám peniaze",
      );
      expect(links).toHaveLength(1);
      expect(links[0].docId).toBe("99999");
    });

    test("does not match 'Stiahnuť doklad' without refund subject", () => {
      const links = extractInvoiceLinks(
        ALZA_REFUND_HTML,
        "info@alza.sk",
        "Pripravené v AlzaBoxe",
      );
      expect(links).toHaveLength(0);
    });
  });

  describe("no matches", () => {
    test("returns empty array when no invoice links found", () => {
      const links = extractInvoiceLinks(
        NO_INVOICE_HTML,
        "info@alza.sk",
        "Order status",
      );
      expect(links).toHaveLength(0);
    });

    test("returns empty array for empty HTML", () => {
      const links = extractInvoiceLinks("", "info@alza.sk", "Order");
      expect(links).toHaveLength(0);
    });

    test("returns empty array for plain text (no HTML tags)", () => {
      const links = extractInvoiceLinks(
        "Stiahnuť faktúru https://alza.sk/invoice.pdf",
        "info@alza.sk",
        "Order",
      );
      expect(links).toHaveLength(0);
    });
  });

  // Manual jobs (created via the create_invoice_intake_job MCP tool with no
  // watcher metadata in input_json) can land here with null sender and null
  // subject. The schema's nullableString allows it; this function must
  // gracefully handle the null path. Added in task 47 / Issue 1.
  describe("null sender/subject (manual job path)", () => {
    test("returns empty array when both sender and subject are null", () => {
      // Without sender/subject we can't classify which vendor the link
      // belongs to, so we don't try.
      const links = extractInvoiceLinks(ALZA_SIMPLE_HTML, null, null);
      expect(links).toHaveLength(0);
    });

    test("matches via subject when sender is null", () => {
      const links = extractInvoiceLinks(
        ALZA_SIMPLE_HTML,
        null,
        "Fwd: alza.sk order confirmation",
      );
      expect(links).toHaveLength(1);
      expect(links[0].docId).toBe("12345");
    });

    test("matches via sender when subject is null", () => {
      const links = extractInvoiceLinks(ALZA_SIMPLE_HTML, "info@alza.sk", null);
      expect(links).toHaveLength(1);
      expect(links[0].docId).toBe("12345");
    });
  });

  describe("doc_id extraction", () => {
    test("extracts doc_id from 'd' query parameter", () => {
      const links = extractInvoiceLinks(
        ALZA_SIMPLE_HTML,
        "info@alza.sk",
        "Order",
      );
      expect(links[0].docId).toBe("12345");
    });

    test("returns undefined docId when no 'd' parameter", () => {
      const html = `<html><body>
        <a href="https://www.alza.sk/Apps/pdfdoc.asp?x=abc">Stiahnuť faktúru</a>
      </body></html>`;
      const links = extractInvoiceLinks(html, "info@alza.sk", "Order");
      expect(links).toHaveLength(1);
      expect(links[0].docId).toBeUndefined();
    });
  });

  describe("edge cases", () => {
    test("ignores non-http links", () => {
      const html = `<html><body>
        <a href="mailto:info@alza.sk">Stiahnuť faktúru</a>
        <a href="https://www.alza.sk/Apps/pdfdoc.asp?d=1">Stiahnuť faktúru</a>
      </body></html>`;
      const links = extractInvoiceLinks(html, "info@alza.sk", "Order");
      expect(links).toHaveLength(1);
      expect(links[0].url).toStartWith("https://");
    });

    test("handles &nbsp; in link text", () => {
      const html = `<html><body>
        <a href="https://www.alza.sk/Apps/pdfdoc.asp?d=1">Stiahnuť&nbsp;faktúru</a>
      </body></html>`;
      const links = extractInvoiceLinks(html, "info@alza.sk", "Order");
      expect(links).toHaveLength(1);
    });
  });

  describe("href HTML entity decoding (regression — task 59 / 2026-04-18)", () => {
    test("decodes &amp; in href so signed query params reach the server intact", () => {
      const links = extractInvoiceLinks(
        ALZA_AMP_ENTITY_HTML,
        "sluzobnicek@alza.sk",
        "Už to chystáme. / Obj. č. 593058485",
      );

      expect(links).toHaveLength(1);
      // Must be `&x=`, not `&amp;x=` — fetch() of `&amp;x=...` makes Alza
      // parse it as a query param named `amp;x` and return HTTP 404.
      expect(links[0].url).not.toContain("&amp;");
      expect(links[0].url).toContain("&x=22B221303522304236TgB1R24C7");
      expect(links[0].url).toContain("&utm_source=template");
    });

    test("docId is parsed correctly from a href that originally had &amp;", () => {
      const links = extractInvoiceLinks(
        ALZA_AMP_ENTITY_HTML,
        "sluzobnicek@alza.sk",
        "Už to chystáme. / Obj. č. 593058485",
      );
      expect(links[0].docId).toBe("5419913904");
    });
  });
});
