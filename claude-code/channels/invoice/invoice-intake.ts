/**
 * Invoice intake executor — the `invoice_intake` (email) half of the pipeline.
 *
 * classify_email (park→channel) → action gate → download → classify_document
 * (park→channel) → merge → month_tag → correspondent → dedup → tags →
 * doc type → storage path → upload → custom fields → notify
 *
 * Classification steps park the job (awaiting_classification) and push a
 * channel notification to Claude. Claude runs a haiku subagent and calls
 * submit_classification() to resume. Step results are cached in job_events
 * for resume on retry.
 */

import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { extname } from "path";

import { SpanStatusCode, trace } from "../tracing";
import type { Span } from "../tracing";

import {
  addJobEvent,
  completeJob,
  getJobEvents,
  getLatestReceivedAtForDoc,
  parseJobJson,
  recordDownloadedFile,
  requestJobApproval,
  scheduleRetry,
  shouldRetry,
  type JobRow,
} from "../workflow-db";
import type { PaperlessFieldRegistry } from "../paperless-fields";
import type { PaperlessAdapter } from "../paperless-adapter";
import {
  downloadInvoice as downloadInvoiceImpl,
} from "./download-service";
import {
  checkDuplicate as checkDuplicateImpl,
} from "./dedup-service";
import { parkForClassification } from "./classification-state";
import {
  patchExistingDocument,
  resolveCorrespondent as resolveCorrespondentImpl,
  resolveDocumentTypeId,
  resolveStoragePathId,
  resolveTagIds,
  setDocumentCustomFields as setDocumentCustomFieldsImpl,
  uploadToPaperless as uploadToPaperlessImpl,
} from "./postprocess-service";
import { readFileAsDownload } from "../download-helper";
import { formatNotification, type NotifyFn } from "../telegram-notify";
import {
  buildSuggestedActions,
  buildTagNames,
  requireBusinessLabel,
  generateTitle,
  getCompletedSteps,
  mergeClassifications,
  parseServicePeriodStart,
  resolveMonthTag,
  resolveOwner,
  UNKNOWN_FIELDS,
  type DocumentClassificationFields,
} from "./pipeline";
import {
  validateInvoiceIntakeInput,
  WorkflowSchemaError,
  type InvoiceIntakeInputSchema,
} from "../workflow-schemas";
import { extractPdfText, isSampleInvoice } from "./sample-detection";
import {
  type InvoiceClassification,
  type InvoiceIntakeResult,
  type DownloadedFile,
  type WorkerLogger,
} from "./intake-steps/types";
import {
  OUTLOOK_MCP_URL,
  GMAIL_MCP_URL,
  GOOGLE_EMAIL,
} from "./intake-steps/config";
import {
  tracer,
  correspondentsCounter,
  missingMonthTagCounter,
  sampleSkippedCounter,
  accountantSkippedCounter,
  ACCOUNTANT_SKIP_REASONS,
  failJobMetered,
  emitSentinelSpan,
  seedCounterFromDb,
} from "./intake-steps/observability";
import {
  findUnconsumedGuidance,
  guidanceLatencySeconds,
  pauseAndNotify,
  runDecryptAndGuidancePhase,
} from "./intake-steps/guidance";

// The Paperless adapter is built once per dispatch in workflow-core.executeNextJob
// and threaded into both executors as an explicit parameter. The executors pass
// it directly into postprocess-service / dedup-service / download-service calls.
// (Before this refactor, intake-worker carried a lazy module-level singleton
// rebuilt-on-registry-change to bridge the registry-per-call API to a stateless
// adapter — that singleton and ~9 one-liner wrappers around it are gone now.)

// ── Main executor ──────────────────────────────────────────────────────

export async function executeInvoiceIntake(
  db: Database,
  job: JobRow,
  logger: WorkerLogger,
  registry: PaperlessFieldRegistry,
  adapter: PaperlessAdapter,
  notify?: NotifyFn,
): Promise<void> {
  seedCounterFromDb(db);
  const rawInput = parseJobJson<unknown>(job.input_json);
  if (!rawInput) {
    failJobMetered(db, job.id, { code: "invalid_input", message: "Missing or invalid input_json" }, "invoice_intake");
    return;
  }
  let input: InvoiceIntakeInputSchema;
  try {
    // Validate input_json against the schema. This catches drift between
    // the watcher and the worker, and rejects manually-edited workflow.db
    // entries that don't match the contract.
    input = validateInvoiceIntakeInput(rawInput);
  } catch (err) {
    if (err instanceof WorkflowSchemaError) {
      failJobMetered(db, job.id, {
        code: "schema_validation_failed",
        message: err.message,
        schema: err.schemaName,
        field: err.field,
      }, "invoice_intake");
      return;
    }
    throw err;
  }

  await tracer.startActiveSpan(`invoice-worker.execute`, {
    attributes: {
      "job.id": job.id,
      "job.type": "invoice_intake",
      // Message identifiers on the top-level span so traces are immediately
      // self-identifying in Tempo without drilling. See task 48, Issue 4.
      "email.source": input.email_source,
      "email.message_id": input.message_id,
      "email.subject": input.subject ?? "",
      "email.sender": input.sender ?? "",
    },
  }, async (span: Span) => {
    let outcome = "unknown";
    let vendorForSpan = "unknown";
    try {
      // T11: Read events once at the top and pass into helpers to avoid
      // 3-4× linear scans of job_events per tick. Refreshed (Pattern A) at
      // each point downstream code might see a write made earlier in the
      // same tick — specifically before applyGuidancePassword (download
      // step wrote rows) and after runDecryptAndGuidancePhase (may have
      // synthesized a step_completed). Late writes after the trigger-A read
      // (correspondent / dedup / tags / upload / set_custom_fields) are not
      // followed by any same-tick events-consumer, so no refresh is needed.
      let events = getJobEvents(db, job.id);

      // Resume logic — read completed steps to skip on re-entry
      const completedSteps = getCompletedSteps(db, job.id, events);

      // Step 0: Email classification via channel
      const cachedEmailClass = completedSteps.get("classify_email");
      if (!cachedEmailClass?.result) {
        const activeCtx = trace.getActiveSpan()?.spanContext();
        await parkForClassification(db, job.id, {
          step: "classify_email",
          parkedPayload: {
            email_source: input.email_source,
            message_id: input.message_id,
          },
          notificationMeta: {
            event_type: "classify_email",
            job_id: job.id,
            email_source: input.email_source,
            message_id: input.message_id,
            // gmail tools require user_google_email; outlook tools don't.
            // Pre-resolve here so the subagent can fetch the body in one turn
            // (matches the strict maxTurns: 2 contract: one MCP call + final JSON).
            ...(input.email_source === "gmail" ? { user_google_email: GOOGLE_EMAIL } : {}),
            ...(activeCtx
              ? {
                  sentinel_trace_id: activeCtx.traceId,
                  sentinel_parent_span_id: activeCtx.spanId,
                  sentinel_start_ms: String(Date.now()),
                }
              : {}),
          },
        }, logger);
        outcome = "awaiting_classification";
        span.setAttribute("invoice.outcome", "awaiting_classification");
        span.setStatus({ code: SpanStatusCode.OK });
        return;
      }

      emitSentinelSpan(tracer, events, "classify_email");

      const classification = cachedEmailClass.result as InvoiceClassification;
      // `vendor` is nullable when action=ignore — the classifier has no
      // counterparty for non-invoices. Coerce to "unknown" for span attributes
      // and vendorForSpan so downstream observability code doesn't trip on null.
      vendorForSpan = classification.vendor ?? "unknown";
      span.setAttribute("invoice.vendor", vendorForSpan);
      span.setAttribute("invoice.download_strategy", String(classification.download_strategy));

      // Handle ignore action. An accountant intent-skip carries `skip_reason`
      // (set by the email-classifier for accountant senders only) → distinct,
      // auditable, silent outcome. A plain ignore (marketing, etc.) stays `ignored`.
      if (classification.action === "ignore") {
        const rawReason = classification.skip_reason ?? null;
        if (rawReason) {
          const reason = (ACCOUNTANT_SKIP_REASONS as readonly string[]).includes(rawReason)
            ? rawReason
            : "other";
          accountantSkippedCounter.add(1, { reason });
          addJobEvent(db, job.id, "step_completed", {
            step: "accountant_intent",
            outcome: "skipped",
            reason,
          });
          completeJob(db, job.id, { outcome: "accountant_non_invoice_skipped", classification });
          logger.log(`Job ${job.id} completed: accountant non-invoice skipped (reason: ${reason})`);
          outcome = "accountant_non_invoice_skipped";
          span.setAttribute("invoice.outcome", "accountant_non_invoice_skipped");
          span.setAttribute("invoice.skip_reason", reason);
          span.setStatus({ code: SpanStatusCode.OK });
          return;
        }
        completeJob(db, job.id, { outcome: "ignored", classification });
        logger.log(`Job ${job.id} completed: ignored by email classifier`);
        outcome = "ignored";
        span.setAttribute("invoice.outcome", "ignored");
        span.setStatus({ code: SpanStatusCode.OK });
        return;
      }

      // Step 1: Download file and persist to disk
      const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR ?? "/workspace/downloads";
      const cachedDownload = completedSteps.get("download") ?? completedSteps.get("read_from_disk");
      let filePath: string;
      let file: DownloadedFile;

      if (cachedDownload) {
        // Resume: file already downloaded in a previous tick
        filePath = (cachedDownload as { file_path?: string }).file_path
          ?? `${DOWNLOAD_DIR}/${(cachedDownload as { filename?: string }).filename ?? "unknown"}`;
        file = readFileAsDownload(filePath);
        logger.log(`Resuming: reusing file from ${filePath}`);
      } else if (input.file_path && existsSync(input.file_path)) {
        // Pre-existing file on disk (e.g. tests)
        filePath = input.file_path;
        file = readFileAsDownload(filePath);
        addJobEvent(db, job.id, "step_started", { step: "read_from_disk", file_path: filePath });
        addJobEvent(db, job.id, "step_completed", {
          step: "read_from_disk",
          file_path: filePath,
          filename: file.filename,
          size: file.size,
        });
      } else {
        // Download from email MCP, save to disk
        const strategy = classification.download_strategy;
        if (strategy === "browser_required" || strategy === "manual_review") {
          requestJobApproval(db, job.id, {
            reason: `Download strategy "${strategy}" requires manual intervention`,
            vendor: classification.vendor,
          });
          logger.log(`Job ${job.id} paused: ${strategy}`);
          outcome = "paused";
          span.setAttribute("invoice.outcome", "paused");
          span.setStatus({ code: SpanStatusCode.OK });
          return;
        }
        addJobEvent(db, job.id, "step_started", { step: "download", strategy });
        file = await downloadInvoice(input, classification, logger);
        mkdirSync(DOWNLOAD_DIR, { recursive: true });
        // On-disk path uses the job UUID + extension so it stays ASCII no
        // matter what the source filename contains. The original filename is
        // preserved on `file.filename` and survives downstream to the
        // Paperless upload as `original_filename`.
        filePath = `${DOWNLOAD_DIR}/${job.id}${extname(file.filename) || ".pdf"}`;
        writeFileSync(filePath, Buffer.from(file.content_base64, "base64"));
        recordDownloadedFile(db, job.id, filePath);
        addJobEvent(db, job.id, "step_completed", {
          step: "download",
          file_path: filePath,
          filename: file.filename,
          size: file.size,
          content_type: file.content_type,
        });
      }

      // Steps 1.1-1.3: decrypt + guidance-password resume + Trigger B pause.
      // Shared with `executeScanIntake` via `runDecryptAndGuidancePhase`.
      // Invoice-only: `allowPatchCoversClassification` lets the operator
      // force-upload an encrypted PDF after a prior `guidance_applied(
      // action=patch, owner+doc_type)`; the helper synthesizes a
      // `classify_document` step_completed stub so step 1.5 short-circuits.
      //
      // Refresh `events` here so the helper sees any download/read_from_disk
      // step_completed rows written above. The helper passes the array into
      // applyGuidancePassword and uses it for the patchCovers lookup.
      events = getJobEvents(db, job.id);
      const decryptPhase = await runDecryptAndGuidancePhase(db, job, filePath, {
        notify,
        logger,
        allowPatchCoversClassification: true,
        pauseContext: {
          filename: file.filename,
          sender: classification.sender,
          subject: classification.subject,
          classifier_notes:
            "PDF is encrypted; decrypt failed (no password configured or wrong password).",
        },
        pauseLogSuffix: "",
        completedSteps,
        events,
      });
      if (decryptPhase.kind === "pause") {
        outcome = "awaiting_user_guidance";
        span.setAttribute("invoice.outcome", "awaiting_user_guidance");
        span.setStatus({ code: SpanStatusCode.OK });
        return;
      }

      // Step 1.4: Sample-invoice guard. Alza serves a watermarked "preview"
      // (non-tax-document) from its download link before goods are picked up.
      // Short-circuit BEFORE the Haiku classify_document call so we never ingest it.
      const sampleText = await extractPdfText(filePath);
      const sampleResult = isSampleInvoice(sampleText);
      if (sampleResult.isSample) {
        addJobEvent(db, job.id, "step_completed", {
          step: "sample_check",
          outcome: "sample_detected",
          matched: sampleResult.matched,
        });
        sampleSkippedCounter.add(1, { vendor: vendorForSpan });
        completeJob(db, job.id, { outcome: "sample_skipped", classification });
        logger.log(`Job ${job.id} completed: sample invoice skipped (matched: ${sampleResult.matched.join(",")})`);
        outcome = "sample_skipped";
        span.setAttribute("invoice.outcome", "sample_skipped");
        span.setStatus({ code: SpanStatusCode.OK });
        return;
      }
      addJobEvent(db, job.id, "step_completed", { step: "sample_check", outcome: "not_sample" });

      // Step 1.5: Document classification via channel (non-blocking)
      const cachedDocClassification = completedSteps.get("classify_document");
      if (!cachedDocClassification?.result) {
        const activeCtx = trace.getActiveSpan()?.spanContext();
        await parkForClassification(db, job.id, {
          step: "classify_document",
          parkedPayload: { file_path: filePath },
          notificationMeta: {
            event_type: "classify_document",
            job_id: job.id,
            file_path: filePath,
            vendor: classification.vendor,
            ...(activeCtx
              ? {
                  sentinel_trace_id: activeCtx.traceId,
                  sentinel_parent_span_id: activeCtx.spanId,
                  sentinel_start_ms: String(Date.now()),
                }
              : {}),
          },
        }, logger);
        outcome = "awaiting_classification";
        span.setAttribute("invoice.outcome", "awaiting_classification");
        span.setStatus({ code: SpanStatusCode.OK });
        return;
      }

      emitSentinelSpan(tracer, events, "classify_document");

      // Merge doc classification into email classification.
      // mergeClassifications carries forward ALL doc keys (shared + doc-only),
      // so the returned type is InvoiceClassification & DocumentClassificationFields.
      const docResult = cachedDocClassification.result as Partial<InvoiceClassification> &
        Partial<DocumentClassificationFields>;
      const mergedClassification: InvoiceClassification & DocumentClassificationFields =
        mergeClassifications(classification, docResult);

      // Trigger A resume — apply the most recent unconsumed `guidance_applied`
      // event. For `patch`, merge the user-supplied fields into the cached
      // classification so downstream steps see the real owner/doc_type/etc.
      // For `retry`, we consume the marker and fall through; the plan calls
      // for re-running classify, which at worst produces another unknown.
      // Emitting `guidance_applied_consumed` immediately prevents double-apply
      // on subsequent ticks.
      //
      // Refresh events here: runDecryptAndGuidancePhase above may have
      // synthesized a `step_completed` for classify_document (patchCovers
      // path). It does not write a guidance_applied_consumed row, but other
      // step_started/step_completed rows may have been added; keeping the
      // array fresh costs one read and avoids latent staleness if the
      // helper grows new writes later.
      events = getJobEvents(db, job.id);
      const unconsumed = findUnconsumedGuidance(events);
      if (unconsumed) {
        if (unconsumed.action === "patch" && unconsumed.patch) {
          Object.assign(mergedClassification, unconsumed.patch);
          logger.log(`Applied guidance patch to classification: ${JSON.stringify(unconsumed.patch)}`);
        } else if (unconsumed.action === "retry") {
          logger.log(`guidance_applied action=retry — consumed marker, continuing with cached classification`);
        }
        addJobEvent(db, job.id, "guidance_applied_consumed", {
          source_event_id: unconsumed.eventId,
        });
        // Task 57 / 4.2: Loki event paired with guidance.requested (pause)
        // and guidance.received (user replied). `latency_seconds` is the
        // wall-clock gap between the guidance_request event and now, so
        // Loki alone can answer "how responsive is the operator?".
        const latency = guidanceLatencySeconds(events);
        logger.log(
          `guidance.applied job_id=${job.id} action=${unconsumed.action} latency_seconds=${latency}`,
        );
      }

      const merged = mergedClassification;
      logger.log(`Merged doc classification (owner=${merged.owner})`);

      // Trigger A: classifier returned `"unknown"` for at least one required
      // field. Pause the job and ask the user via Telegram. Task 57, Trigger A.
      const unknownFields = UNKNOWN_FIELDS.filter(
        (f) => mergedClassification[f] === "unknown",
      );
      if (unknownFields.length > 0) {
        await pauseAndNotify(db, job.id, {
          step: "post_classification",
          reason: "classifier_unknown",
          missing_fields: unknownFields,
          suggested_actions: buildSuggestedActions(unknownFields, {
            doc_type: (mergedClassification.doc_type as string | null | undefined) ?? null,
          }),
          context: {
            filename: file.filename,
            sender: classification.sender,
            subject: classification.subject,
            vendor: mergedClassification.vendor ?? null,
            total_amount: mergedClassification.total_amount ?? null,
            doc_date: mergedClassification.doc_date ?? null,
            classifier_notes: mergedClassification.notes ?? null,
          },
        }, notify, logger);
        logger.log(
          `Job ${job.id} paused (classifier_unknown: ${unknownFields.join(", ")})`,
        );
        outcome = "awaiting_user_guidance";
        span.setAttribute("invoice.outcome", "awaiting_user_guidance");
        span.setStatus({ code: SpanStatusCode.OK });
        return;
      }

      // Step 3.5: Derive month_tag from classification metadata.
      // Document-classifier is the authority — its `accounting_period` reflects
      // explicit reasoning over supply date / service period / doc type / Slovak
      // VAT rules. The deterministic chain is a hardened safety net only.
      if (merged.accounting_period_reasoning) {
        logger.log(`accounting_period: ${merged.accounting_period} — ${merged.accounting_period_reasoning}`);
      }
      const monthTag = resolveMonthTag({
        accountingPeriod: merged.accounting_period,
        supplyDate: merged.supply_date,
        servicePeriodStart: parseServicePeriodStart(merged.service_period),
        docDate: merged.doc_date,
        subject: classification.subject,
        receivedAt: classification.received_at,
      });
      if (!monthTag) {
        missingMonthTagCounter.add(1, { workflow_type: "invoice_intake" });
        logger.log(`⚠ Job ${job.id}: no valid accounting period resolved — uploading without month tag`);
        if (notify) {
          await notify(`⚠ ${merged.vendor ?? "Document"}: no accounting period detected. Tag manually in Paperless.`).catch(() => {});
        }
      }

      // Step 2: Resolve correspondent
      addJobEvent(db, job.id, "step_started", { step: "resolve_correspondent" });
      const correspondent = await resolveCorrespondentImpl(merged.vendor, adapter, logger);
      addJobEvent(db, job.id, "step_completed", {
        step: "resolve_correspondent",
        correspondent,
      });

      // Step 3: Deduplicate
      // If force=true is set, dedup hits do NOT short-circuit — instead the
      // worker captures forceTargetDocId and the upload step PATCHes the
      // existing Paperless document in place. This is the operator's path for
      // "reprocess this and update the doc with the new tags/title/period".
      // Task 59: a `force_refresh` outcome from the dedup service triggers
      // the same PATCH path automatically when a newer email for the same
      // order arrives (multi-stage vendors like Alza).
      addJobEvent(db, job.id, "step_started", { step: "deduplicate" });
      const dedupeResult = await checkDuplicateImpl(merged, correspondent, adapter, registry, logger, {
        newReceivedAt: input.received_at ?? null,
        lookupExistingReceivedAt: async (docId) => getLatestReceivedAtForDoc(db, docId),
      });
      let forceTargetDocId: number | undefined;
      if (dedupeResult) {
        addJobEvent(db, job.id, "step_completed", {
          step: "deduplicate",
          ...dedupeResult,
        });

        if (input.force || dedupeResult.outcome === "force_refresh") {
          forceTargetDocId = dedupeResult.existing_id;
          const trigger = input.force ? "force=true" : "newer email arrived";
          logger.log(`${trigger}: will refresh existing doc #${forceTargetDocId} (${dedupeResult.outcome}) instead of skipping`);
          span.setAttribute("invoice.force_refresh", true);
          span.setAttribute("invoice.force_target_doc_id", forceTargetDocId);
        } else if (dedupeResult.outcome === "duplicate") {
          const result: InvoiceIntakeResult = {
            outcome: "duplicate",
            duplicate_of: dedupeResult.existing_id,
            duplicate_message: dedupeResult.message,
          };
          completeJob(db, job.id, result);
          logger.log(`Job ${job.id} completed: duplicate of doc #${dedupeResult.existing_id}`);
          outcome = "duplicate";
          span.setAttribute("invoice.outcome", "duplicate");
          span.setStatus({ code: SpanStatusCode.OK });
          return;
        } else if (dedupeResult.outcome === "duplicate_likely") {
          requestJobApproval(db, job.id, {
            reason: dedupeResult.message,
            existing_document_id: dedupeResult.existing_id,
          });
          logger.log(`Job ${job.id} paused: likely duplicate`);
          outcome = "paused";
          span.setAttribute("invoice.outcome", "paused");
          span.setStatus({ code: SpanStatusCode.OK });
          return;
        }
      } else {
        addJobEvent(db, job.id, "step_completed", {
          step: "deduplicate",
          outcome: "no_duplicate",
        });
      }

      // Step 4: Resolve tags — derived deterministically from merged classification
      addJobEvent(db, job.id, "step_started", { step: "resolve_tags" });
      const rawOwner = merged.owner;
      if (!rawOwner) {
        const msg = "Missing owner field — document-classifier did not return owner.";
        failJobMetered(db, job.id, { code: "missing_owner", message: msg }, "invoice_intake");
        logger.log(`Job ${job.id} failed: missing owner`);
        outcome = "failed";
        span.setAttribute("invoice.outcome", "failed");
        span.setStatus({ code: SpanStatusCode.ERROR, message: msg });
        return;
      }

      // Single-point owner resolution: payslip → personal, regardless of
      // what the classifier's business-identifier check produced. See
      // invoice-pipeline.ts resolveOwner for the rule.
      const owner = resolveOwner(rawOwner, merged.doc_type);
      span.setAttribute("invoice.owner.raw", rawOwner);
      span.setAttribute("invoice.owner.resolved", owner);

      const allTagNames = buildTagNames(
        { owner, doc_type: merged.doc_type, is_fuel: merged.is_fuel },
        monthTag,
        requireBusinessLabel(),
      );
      const tagIds = await resolveTagIds(allTagNames, adapter, logger);
      addJobEvent(db, job.id, "step_completed", { step: "resolve_tags", tags: tagIds });

      // Step 5: Resolve document type
      const documentTypeId = await resolveDocumentTypeId(merged.doc_type, adapter, logger);

      // Step 5b: Resolve storage path (uses the SAME resolved owner as tags)
      const storagePathId = await resolveStoragePathId(owner, merged.doc_type, adapter, logger);

      // Step 6: Upload to Paperless — or PATCH the existing doc if force-refresh.
      addJobEvent(db, job.id, "step_started", { step: "upload" });
      const title = generateTitle(merged.vendor, merged.order_id, merged.subtitle, classification.subject);
      let finalDocId: number | undefined;
      let finalOutcome: "uploaded" | "refreshed";

      if (forceTargetDocId) {
        // Force-refresh path: PATCH the existing doc with fresh metadata.
        // Single request handles title/correspondent/document_type/tags/storage_path/custom_fields.
        const patchResult = await patchExistingDocument({
          documentId: forceTargetDocId,
          title,
          correspondentId: correspondent.id,
          tagIds,
          documentTypeId,
          storagePathId,
          totalAmount: merged.total_amount,
          orderId: merged.order_id,
          litres: merged.litres,
          receiptDatetime: merged.receipt_datetime,
        }, adapter, registry, logger);
        addJobEvent(db, job.id, "step_completed", {
          step: "upload",
          mode: "patch",
          document_id: patchResult.document_id,
          title: patchResult.title,
        });
        finalDocId = patchResult.document_id;
        finalOutcome = "refreshed";
      } else {
        const uploadResult = await uploadToPaperlessImpl({
          title,
          file,
          correspondentId: correspondent.id,
          tagIds,
          documentTypeId,
          storagePathId,
          totalAmount: merged.total_amount,
          orderId: merged.order_id,
        }, adapter, logger);
        addJobEvent(db, job.id, "step_completed", {
          step: "upload",
          mode: "post",
          ...uploadResult,
        });

        // Step 7: Resolve doc_id via waitForConsumption and set custom fields
        // (total_amount, order_id) when applicable. post_document doesn't
        // accept custom fields in multipart, so we PATCH after consumption.
        // setDocumentCustomFields always calls waitForConsumption to resolve
        // the doc id — and returns it in cfResult.doc_id even when there are
        // no custom fields to set. The force-refresh path above already has
        // doc id from the patch endpoint.
        addJobEvent(db, job.id, "step_started", { step: "set_custom_fields" });
        const cfResult = await setDocumentCustomFieldsImpl(
          uploadResult.task_uuid,
          merged.total_amount,
          merged.order_id,
          merged.litres,
          merged.receipt_datetime,
          adapter,
          registry,
          logger,
        );
        addJobEvent(db, job.id, "step_completed", { step: "set_custom_fields", ...cfResult });
        finalDocId = cfResult.doc_id;
        finalOutcome = "uploaded";
      }

      const result: InvoiceIntakeResult = {
        outcome: finalOutcome,
        title,
        paperless_document_id: finalDocId,
        correspondent: correspondent.name,
        tags: allTagNames,
        total_amount: merged.total_amount,
      };
      completeJob(db, job.id, result);
      logger.log(`Job ${job.id} completed: ${finalOutcome} "${title}" → doc #${finalDocId ?? "?"}`);
      correspondentsCounter.add(1, { correspondent: correspondent.name });
      if (notify) {
        const msg = formatNotification({
          outcome: finalOutcome,
          vendor: correspondent.name,
          total_amount: merged.total_amount,
          currency: merged.currency,
          doc_type: merged.doc_type,
          owner: owner ?? null,
          month_tag: monthTag,
          paperless_document_id: finalDocId,
          is_fuel: merged.is_fuel,
        });
        if (msg) await notify(msg).catch((e) => {
          span.addEvent("notification_failed", { error: e instanceof Error ? e.message : String(e) });
        });
      }
      outcome = finalOutcome;
      span.setAttribute("invoice.outcome", finalOutcome);
      span.setAttribute("paperless.document_id", finalDocId ?? 0);
      span.setStatus({ code: SpanStatusCode.OK });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errPayload = { code: "invoice_intake_error", message, step: "unknown" };
      if (shouldRetry(db, job.id)) {
        scheduleRetry(db, job.id, errPayload);
        logger.log(`Job ${job.id} scheduled for retry: ${message}`);
        outcome = "retryable";
        span.setAttribute("invoice.outcome", "retryable");
      } else {
        failJobMetered(db, job.id, errPayload, "invoice_intake");
        logger.log(`Job ${job.id} failed permanently: ${message}`);
        if (notify) {
          const msg = formatNotification({
            outcome: "failed",
            vendor: vendorForSpan,
            total_amount: null,
            currency: null,
            doc_type: null,
            owner: null,
            error: message,
          });
          if (msg) await notify(msg).catch((e) => {
            span.addEvent("notification_failed", { error: e instanceof Error ? e.message : String(e) });
          });
        }
        outcome = "failed";
        span.setAttribute("invoice.outcome", "failed");
      }
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      span.recordException(error instanceof Error ? error : new Error(message));
    } finally {
      span.setAttribute("invoice.vendor", vendorForSpan ?? "unknown");
      span.setAttribute("invoice.outcome", outcome);
      span.end();
    }
  });
}

// ── Download step ──────────────────────────────────────────────────────
//
// All download logic now lives in `./invoice/download-service.ts`. This
// thin wrapper preserves the in-file call signature so the orchestrator
// (executeInvoiceIntake) doesn't need to know about MCP URLs.

function downloadInvoice(
  input: InvoiceIntakeInputSchema,
  classification: InvoiceClassification,
  logger: WorkerLogger,
): Promise<DownloadedFile> {
  return downloadInvoiceImpl(
    { email_source: input.email_source, message_id: input.message_id },
    {
      sender: classification.sender,
      subject: classification.subject,
      download_strategy: classification.download_strategy,
    },
    { gmail: GMAIL_MCP_URL, outlook: OUTLOOK_MCP_URL },
    GOOGLE_EMAIL,
    logger,
  );
}
