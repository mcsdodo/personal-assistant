/**
 * Pure utility functions extracted from email-watcher.ts.
 *
 * This module has ZERO side effects — no MCP imports, no DB, no Server.
 * Safe to import from any test file without triggering module-level
 * initialization.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmailInfo {
  id: string;
  source: "gmail" | "outlook";
  sender?: string;
  to?: string;
  subject?: string;
  preview?: string;
  hasAttachments?: boolean;
  receivedAt?: string;
  invoiceLinks?: Array<{ url: string; text: string; docId?: string }>;
}

// ---------------------------------------------------------------------------
// Gmail query building
// ---------------------------------------------------------------------------

export function buildGmailQuery(base: string, lastChecked: string | null): string {
  if (!lastChecked) return base;
  const epoch = Math.floor(new Date(lastChecked).getTime() / 1000);
  return base ? `${base} after:${epoch}` : `after:${epoch}`;
}

// ---------------------------------------------------------------------------
// Duration parsing
// ---------------------------------------------------------------------------

export function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)\s*(h|d|w|m)$/i);
  if (!match) return 24 * 60 * 60 * 1000;
  const value = parseInt(match[1], 10);
  switch (match[2].toLowerCase()) {
    case "h": return value * 60 * 60 * 1000;
    case "d": return value * 24 * 60 * 60 * 1000;
    case "w": return value * 7 * 24 * 60 * 60 * 1000;
    case "m": return value * 30 * 24 * 60 * 60 * 1000;
    default: return 24 * 60 * 60 * 1000;
  }
}

// ---------------------------------------------------------------------------
// Prometheus metrics helpers
// ---------------------------------------------------------------------------

export function esc(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/"/g, '\\"');
}

export function metricLine(
  name: string,
  labels: Record<string, string | null | undefined>,
  value: number,
): string {
  const parts = Object.entries(labels)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}="${esc(v)}"`);
  return parts.length > 0
    ? `${name}{${parts.join(",")}} ${value}`
    : `${name} ${value}`;
}

// ---------------------------------------------------------------------------
// MCP tool result parsing
// ---------------------------------------------------------------------------

/**
 * Extract data from MCP tool result content blocks.
 *
 * FastMCP (Python) serialises list[dict] as separate text content blocks —
 * one JSON object per block. If there are multiple text blocks, try to parse
 * each individually and return an array. Single block: try JSON.parse, fall
 * back to raw text.
 */
export function parseToolResult(result: any): any {
  if (!result?.content) return null;

  const texts: string[] = [];
  for (const block of result.content) {
    if (block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    }
  }
  if (texts.length === 0) return null;

  if (texts.length > 1) {
    const items = texts.map((t) => {
      try { return JSON.parse(t); } catch { return t; }
    });
    return items;
  }

  try {
    return JSON.parse(texts[0]);
  } catch {
    return texts[0];
  }
}

// ---------------------------------------------------------------------------
// Gmail ID extraction
// ---------------------------------------------------------------------------

/**
 * Extract message IDs from gmail search results.
 * Handles: JSON array of strings, JSON object with messages key,
 * or raw text with hex IDs.
 */
export function extractGmailIds(data: any): string[] {
  if (Array.isArray(data)) {
    if (data.length > 0 && typeof data[0] === "string") return data;
    if (data.length > 0 && typeof data[0] === "object" && data[0]?.id) {
      return data.map((m: any) => String(m.id));
    }
    return [];
  }

  if (data && typeof data === "object") {
    if (Array.isArray(data.messages)) return extractGmailIds(data.messages);
    if (Array.isArray(data.messageIds)) return data.messageIds;
    if (data.id) return [String(data.id)];
  }

  if (typeof data === "string") {
    const matches = data.match(/\b[0-9a-f]{16,}\b/gi);
    return matches ?? [];
  }

  return [];
}

// ---------------------------------------------------------------------------
// Gmail email parsing
// ---------------------------------------------------------------------------

/**
 * Parse gmail email data into EmailInfo[].
 * Handles JSON array of email objects or formatted text fallback.
 */
export function parseGmailEmails(data: any, ids: string[]): EmailInfo[] {
  const emails: EmailInfo[] = [];

  if (Array.isArray(data)) {
    for (const item of data) {
      if (typeof item === "object" && item !== null) {
        const id = String(item.id ?? item.messageId ?? item.message_id ?? "");
        if (!id) continue;
        emails.push({
          id,
          source: "gmail",
          sender: item.sender ?? item.from ?? item.fromAddress ?? undefined,
          to: item.to ?? item.toAddress ?? item.recipient ?? undefined,
          subject: item.subject ?? undefined,
          preview: item.snippet ?? item.preview ?? item.body?.substring(0, 200) ?? undefined,
          hasAttachments: item.hasAttachments ?? item.has_attachments ?? false,
          receivedAt: item.receivedAt ?? item.received_at ?? item.date ?? item.internalDate ?? undefined,
        });
      }
    }
    if (emails.length > 0) return emails;
  }

  if (typeof data === "string" && data.includes("Message ID:")) {
    const blocks = data.split(/(?=Message ID:)/);
    for (const block of blocks) {
      const idMatch = block.match(/Message ID:\s*(\S+)/);
      if (!idMatch) continue;
      const fromMatch = block.match(/From:\s*(.+)/);
      const toMatch = block.match(/To:\s*(.+)/);
      const subjectMatch = block.match(/Subject:\s*(.+)/);
      const dateMatch = block.match(/Date:\s*(.+)/);
      const rawFrom = fromMatch?.[1]?.trim() ?? "";
      const emailMatch = rawFrom.match(/<([^>]+)>/);
      const rawTo = toMatch?.[1]?.trim() ?? "";
      const toEmailMatch = rawTo.match(/<([^>]+)>/);
      emails.push({
        id: idMatch[1],
        source: "gmail",
        sender: emailMatch ? emailMatch[1] : rawFrom,
        to: toEmailMatch ? toEmailMatch[1] : rawTo || undefined,
        subject: subjectMatch?.[1]?.trim(),
        hasAttachments: false,
        receivedAt: dateMatch?.[1]?.trim(),
      });
    }
    if (emails.length > 0) return emails;
  }

  return [];
}
