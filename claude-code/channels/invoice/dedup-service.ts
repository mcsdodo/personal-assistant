/**
 * Duplicate-detection service.
 *
 * Given a classification (with `order_id` and `total_amount`) and a
 * resolved correspondent, decides whether the document already exists in
 * Paperless. The decision is:
 *
 *   - `null`              — no duplicate (or no order_id to check by)
 *   - `duplicate`         — exact match: same order_id, matching amount,
 *                            and the new email is not newer than the
 *                            existing doc's source email (silent skip)
 *   - `force_refresh`     — exact match, but the new email is newer than
 *                            the existing doc's source email — caller
 *                            should PATCH the existing doc in place
 *                            (multi-stage vendor refresh, task 59)
 *   - `duplicate_likely`  — same order_id, different amount (operator should
 *                            confirm whether to upload)
 *
 * Lookups go through the unified Paperless adapter
 * (`searchDocumentsByCustomFieldAndCorrespondent`); the comparison logic
 * is owned here.
 */

import type { PaperlessAdapter, CorrespondentInfo } from "../paperless-adapter";
import type { PaperlessFieldRegistry } from "../paperless-fields";
import { getTracer, withSpan } from "../tracing";

export interface DedupeResult {
  outcome: "duplicate" | "duplicate_likely" | "force_refresh";
  existing_id: number;
  message: string;
}

export interface DedupeServiceLogger {
  log(message: string): void;
}

export interface RefreshDecisionContext {
  /** received_at of the email that's about to be processed (any RFC 2822 or
   * ISO 8601 string the watchers may have stored — see task 59 investigation
   * for why these are heterogeneous). May be null for legacy/manual jobs. */
  newReceivedAt: string | null;
  /** Looks up the latest source-email received_at for an existing Paperless
   * doc. Returns null when no jobs reference that doc id (treated as
   * "newer wins"). */
  lookupExistingReceivedAt: (existingDocId: number) => Promise<string | null>;
}

/** Date-aware comparison that tolerates the heterogeneous timestamp formats
 * the email watchers store (raw `Date:` headers from senders, ISO 8601 from
 * Outlook MCP, etc.). Lexical comparison would be wrong — see task 59. */
function isStrictlyNewer(a: string | null, b: string | null): boolean {
  if (a == null) return false;
  if (b == null) return true;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) {
    // Defensive: if either side is unparseable, treat as "newer wins" so the
    // pipeline force-refreshes rather than silently skipping a real update.
    return true;
  }
  return ta > tb;
}

const tracer = getTracer("invoice-worker");

/**
 * Check whether a document with this `order_id` and correspondent already
 * exists in Paperless. Returns null if there's nothing to check by, no
 * matches, or no exact-match candidates.
 */
export async function checkDuplicate(
  classification: { order_id: string | null; total_amount: number | null },
  correspondent: CorrespondentInfo,
  adapter: PaperlessAdapter,
  registry: PaperlessFieldRegistry,
  logger: DedupeServiceLogger,
  refreshCtx?: RefreshDecisionContext,
): Promise<DedupeResult | null> {
  return withSpan(tracer, "invoice-worker.dedup", {
    "dedup.order_id": classification.order_id ?? "none",
    "dedup.correspondent": correspondent.name,
  }, async (span) => {
    if (!classification.order_id) {
      logger.log("No order_id — skipping dedup check");
      span.setAttribute("dedup.outcome", "no_duplicate");
      return null;
    }

    logger.log(`Checking for duplicate: order_id=${classification.order_id}`);
    const docs = await adapter.searchDocumentsByCustomFieldAndCorrespondent(
      classification.order_id,
      correspondent.id,
      logger,
    );

    if (!docs.length) {
      span.setAttribute("dedup.outcome", "no_duplicate");
      return null;
    }

    // Extract custom field values by field ID
    const orderIdFieldId = registry.getFieldId("order_id");
    const totalAmountFieldId = registry.getFieldId("total_amount");

    for (const doc of docs) {
      const existingOrderId = doc.custom_fields.find((cf) => cf.field === orderIdFieldId)?.value as
        | string
        | undefined;
      if (existingOrderId === classification.order_id) {
        const existingAmount = doc.custom_fields.find((cf) => cf.field === totalAmountFieldId)?.value as
          | number
          | undefined;
        if (
          existingAmount != null &&
          classification.total_amount != null &&
          existingAmount !== classification.total_amount
        ) {
          span.setAttribute("dedup.outcome", "duplicate_likely");
          return {
            outcome: "duplicate_likely",
            existing_id: doc.id,
            message: `Order ${classification.order_id} matches doc #${doc.id} "${doc.title}" but amount differs (${existingAmount} vs ${classification.total_amount})`,
          };
        }

        if (refreshCtx) {
          const existingReceivedAt = await refreshCtx.lookupExistingReceivedAt(doc.id);
          if (isStrictlyNewer(refreshCtx.newReceivedAt, existingReceivedAt)) {
            span.setAttribute("dedup.outcome", "force_refresh");
            return {
              outcome: "force_refresh",
              existing_id: doc.id,
              message: `Order ${classification.order_id} matches doc #${doc.id} "${doc.title}" — newer email arrived (${refreshCtx.newReceivedAt} > ${existingReceivedAt ?? "unknown"}), refreshing in place`,
            };
          }
        }

        span.setAttribute("dedup.outcome", "duplicate");
        return {
          outcome: "duplicate",
          existing_id: doc.id,
          message: `Order ${classification.order_id} already exists as doc #${doc.id} "${doc.title}"`,
        };
      }
    }

    span.setAttribute("dedup.outcome", "no_duplicate");
    return null;
  });
}
