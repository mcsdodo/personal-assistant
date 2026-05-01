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
  sender: string | null,
  subject: string | null,
): InvoiceLink[] {
  if (!html) return [];

  // sender and subject can be null for manual jobs (created via the
  // `create_invoice_intake_job` MCP tool, where the operator only supplies
  // email_source + message_id). Vendor-specific rules need at least one of
  // them to match — if both are null we skip vendor matching entirely and
  // return an empty list, since we can't classify which vendor the link
  // belongs to. See _tasks/_done/47-pipeline-hardening-followups/ Issue 1.
  if (sender === null && subject === null) return [];

  // Use regex to find all <a> tags with href attributes.
  // This avoids a DOM parser dependency while handling real-world email HTML.
  const anchorRegex = /<a\s[^>]*href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const links: InvoiceLink[] = [];
  const seen = new Set<string>();

  // Vendor rules expect string inputs for the regex .test() calls. Use
  // empty-string fallbacks for the null branches so the existing rule
  // semantics (test against sender OR subject) keep working when only
  // one of the two is available.
  const senderForMatch = sender ?? "";
  const subjectForMatch = subject ?? "";

  let match: RegExpExecArray | null;
  while ((match = anchorRegex.exec(html)) !== null) {
    // HTML attribute values must encode `&` as `&amp;`. Decode before use:
    // Alza's signed PDF URL `?d=…&amp;x=<token>` is parsed as a param named
    // `amp;x` if left literal, the signature check fails, and we get HTTP 404.
    // See _tasks/_done/59-multi-stage-vendor-emails/01-task.md.
    const href = match[1].trim().replace(/&amp;/g, "&");
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
      if (!rule.sender.test(senderForMatch) && !rule.sender.test(subjectForMatch)) continue;
      if (!rule.linkText.test(text)) continue;
      if (rule.subject && !rule.subject.test(subjectForMatch)) continue;

      const url = new URL(href);
      const docId = url.searchParams.get("d") ?? undefined;
      links.push({ url: href, text, docId });
      break;
    }
  }

  return links;
}
