/**
 * Pure pipeline functions extracted from invoice-worker.ts.
 *
 * These are deterministic, side-effect-free functions for:
 * - Classification merging (email + document classifier results)
 * - Month tag inference from subject / dates
 * - Tag name resolution from classification metadata
 * - Title generation from vendor + metadata
 */

// ── Types ──────────────────────────────────────────────────────────────

export interface EmailClassification {
  vendor: string | null;
  total_amount: number | null;
  owner: string | null;
  doc_type: string | null;
  confidence: "high" | "medium" | "low" | null;
  is_fuel: boolean;
  order_id?: string | null;
  subtitle?: string | null;
  currency?: string | null;
}

// ── mergeClassifications ────────────────────────────────────────────────

/**
 * Merge document-classifier results on top of email-classifier results.
 * Non-null doc values override email values; null/undefined doc values
 * are ignored (email values preserved).
 */
export function mergeClassifications(
  email: EmailClassification,
  doc: Partial<EmailClassification>,
): EmailClassification {
  const merged = { ...email };
  for (const key of Object.keys(doc) as (keyof EmailClassification)[]) {
    if (doc[key] != null) {
      (merged as any)[key] = doc[key];
    }
  }
  return merged;
}

// ── resolveMonthTag ─────────────────────────────────────────────────────

/**
 * Infer YYYY-MM month tag from available context.
 * Priority: subject billing period > doc date > received_at.
 */
export function resolveMonthTag(
  subject: string | null,
  receivedAt: string | null,
  docDate: string | null,
): string | null {
  // Try subject: look for MM/YYYY or YYYY-MM patterns
  if (subject) {
    const mmYyyy = subject.match(/(\d{2})\/(\d{4})/);
    if (mmYyyy) return `${mmYyyy[2]}-${mmYyyy[1]}`;
    const yyyyMm = subject.match(/(\d{4})-(\d{2})/);
    if (yyyyMm) return `${yyyyMm[1]}-${yyyyMm[2]}`;
  }
  // Try doc date
  if (docDate) {
    const d = new Date(docDate);
    if (!isNaN(d.getTime())) return `${d.getFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  // Fall back to received_at
  if (receivedAt) {
    const d = new Date(receivedAt);
    if (!isNaN(d.getTime())) return `${d.getFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  return null;
}

// ── buildTagNames ───────────────────────────────────────────────────────

/**
 * Build the list of tag NAMES from classification metadata.
 * This is the pure half — actual Paperless tag ID resolution is separate (I/O).
 */
export function buildTagNames(
  classification: { owner: string | null; doc_type: string | null; is_fuel: boolean },
  monthTag: string | null,
): string[] {
  const tags: string[] = [];
  tags.push(classification.owner === "techlab" ? "techlab" : "personal");
  if (classification.owner === "techlab") tags.push("accounting");
  if (classification.doc_type === "credit_note") tags.push("credit-note");
  if (classification.doc_type === "account_statement") tags.push("account-statement");
  if (classification.is_fuel) tags.push("fuel");
  if (monthTag) tags.push(monthTag);
  return tags;
}

// ── generateTitle ───────────────────────────────────────────────────────

/**
 * Build document title from vendor + best available identifier.
 * Priority: order_id > subtitle > cleaned subject > "invoice" fallback.
 */
export function generateTitle(
  vendor: string,
  orderId: string | null | undefined,
  subtitle: string | null | undefined,
  subject: string | null | undefined,
): string {
  if (orderId) {
    return `${vendor} - ${orderId}`;
  }
  if (subtitle) {
    return `${vendor} - ${subtitle}`;
  }
  if (subject) {
    const cleaned = subject
      .replace(/^(Fwd|Re|FW):\s*/gi, "")
      .trim()
      .slice(0, 80);
    return `${vendor} - ${cleaned}`;
  }
  return `${vendor} - invoice`;
}
