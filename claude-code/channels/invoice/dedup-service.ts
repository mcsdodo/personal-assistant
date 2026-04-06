/**
 * Duplicate-detection service.
 *
 * Given a classification (with `order_id` and `total_amount`) and a
 * resolved correspondent, decides whether the document already exists in
 * Paperless. The decision is:
 *
 *   - `null`              — no duplicate (or no order_id to check by)
 *   - `duplicate`         — exact match: same order_id, matching amount
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
  outcome: "duplicate" | "duplicate_likely";
  existing_id: number;
  message: string;
}

export interface DedupeServiceLogger {
  log(message: string): void;
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
