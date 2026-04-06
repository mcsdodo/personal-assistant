export type NotifyFn = (message: string) => Promise<void>;

export interface NotificationData {
  outcome: "uploaded" | "refreshed" | "duplicate" | "duplicate_likely" | "failed";
  vendor: string;
  total_amount: number | null;
  currency: string | null;
  doc_type: string;
  owner: string | null;
  /** YYYY-MM accounting period assigned to the document, or null if none was resolved. */
  month_tag?: string | null;
  /** Paperless document id — included in `refreshed` notifications so the operator can verify. */
  paperless_document_id?: number | null;
  duplicate_message?: string | null;
  error?: string | null;
}

/**
 * Format a compact one-liner notification for Telegram.
 * Returns null for silent duplicates (no notification).
 */
export function formatNotification(data: NotificationData): string | null {
  if (data.outcome === "duplicate") return null;

  const amount = data.total_amount != null ? String(data.total_amount) : "?";
  const currency = data.currency ?? "EUR";
  const amountStr = `${amount} ${currency}`;

  if (data.outcome === "duplicate_likely") {
    const msg = data.duplicate_message ?? "possible duplicate";
    return `♻️  ${data.vendor} | ${amountStr} | ${msg}`;
  }

  if (data.outcome === "failed") {
    const err = data.error ?? "unknown error";
    const owner = data.owner ?? "?";
    return `❌  ${data.vendor} | ${amountStr} | ${data.doc_type} | ${owner} | ${err}`;
  }

  // uploaded or refreshed
  const owner = data.owner ?? "?";
  const period = data.month_tag ?? "no-period";

  if (data.outcome === "refreshed") {
    const docRef = data.paperless_document_id != null ? ` (refreshed #${data.paperless_document_id})` : " (refreshed)";
    return `🔄  ${data.vendor} | ${amountStr} | ${data.doc_type} | ${owner} | ${period}${docRef}`;
  }

  return `✔️  ${data.vendor} | ${amountStr} | ${data.doc_type} | ${owner} | ${period}`;
}
