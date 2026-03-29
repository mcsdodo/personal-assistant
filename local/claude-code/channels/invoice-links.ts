// ---------------------------------------------------------------------------
// invoice-links — shared invoice link extraction from HTML email bodies
//
// Vendor rules live here (single source of truth). Used by both the
// email-watcher (Gmail HTML) and the invoice-worker (Outlook body_html).
// ---------------------------------------------------------------------------

export interface InvoiceLink {
  url: string;
  text: string;
  docId?: string;
}

interface VendorRule {
  sender: RegExp;
  linkText: RegExp;
  subject: RegExp | null;
}

const INVOICE_LINK_RULES: VendorRule[] = [
  { sender: /alza\.sk/i, linkText: /Stiahnuť\s*faktúru/i, subject: null },
  {
    sender: /alza\.sk/i,
    linkText: /Stiahnuť\s*doklad/i,
    subject: /[Vv]rátili|[Vv]raciame/,
  },
];

/**
 * Extract invoice download links from an HTML email body using vendor rules.
 *
 * Matches `<a href>` tags against sender/subject/link-text patterns.
 * Deduplicates by URL. Returns an empty array when nothing matches.
 */
export function extractInvoiceLinks(
  html: string,
  sender: string,
  subject: string,
): InvoiceLink[] {
  if (!html) return [];

  // Use regex to find all <a> tags with href attributes.
  // This avoids a DOM parser dependency while handling real-world email HTML.
  const anchorRegex = /<a\s[^>]*href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const links: InvoiceLink[] = [];
  const seen = new Set<string>();

  let match: RegExpExecArray | null;
  while ((match = anchorRegex.exec(html)) !== null) {
    const href = match[1].trim();
    if (seen.has(href) || !href.startsWith("http")) continue;
    seen.add(href);

    // Strip HTML tags and decode entities from link text
    const rawText = match[2]
      .replace(/<[^>]*>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#\d+;/g, (m) => String.fromCharCode(parseInt(m.slice(2, -1))))
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);

    const text = rawText || new URL(href).pathname.split("/").pop() || href.slice(0, 80);

    for (const rule of INVOICE_LINK_RULES) {
      // Match sender pattern against sender OR subject (handles forwarded emails)
      if (!rule.sender.test(sender) && !rule.sender.test(subject)) continue;
      if (!rule.linkText.test(text)) continue;
      if (rule.subject && !rule.subject.test(subject)) continue;

      const url = new URL(href);
      const docId = url.searchParams.get("d") ?? undefined;
      links.push({ url: href, text, docId });
      break;
    }
  }

  return links;
}
