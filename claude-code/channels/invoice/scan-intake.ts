/**
 * Scan intake executor (GDrive source).
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
  getPaperlessDocIdForSource,
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
  downloadFromGdrive as downloadFromGdriveImpl,
} from "./download-service";
import {
  checkDuplicate as checkDuplicateImpl,
} from "./dedup-service";
import {
  buildScanTitle,
  moveGdriveFile as moveGdriveFileImpl,
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
  applyScanFolderOverrides,
  buildScanTagNames,
  buildSuggestedActions,
  getCompletedSteps,
  parseServicePeriodStart,
  resolveMonthTag,
  requireBusinessLabel,
  UNKNOWN_FIELDS,
} from "./pipeline";
import {
  validateScanIntakeInput,
  WorkflowSchemaError,
} from "../workflow-schemas";
import {
  type DownloadedFile,
  type InvoiceIntakeResult,
  type ScanClassification,
  type ScanIntakeInput,
  type WorkerLogger,
} from "./intake-steps/types";
import {
  GMAIL_MCP_URL,
  GOOGLE_EMAIL,
} from "./intake-steps/config";
import {
  correspondentsCounter,
  emitSentinelSpan,
  failJobMetered,
  missingMonthTagCounter,
  seedCounterFromDb,
  tracer,
} from "./intake-steps/observability";
import {
  findUnconsumedGuidance,
  guidanceLatencySeconds,
  pauseAndNotify,
  runDecryptAndGuidancePhase,
} from "./intake-steps/guidance";

export async function executeScanIntake(
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
    failJobMetered(db, job.id, { code: "invalid_input", message: "Missing or invalid input_json" }, "scan_intake");
    return;
  }
  let input: ScanIntakeInput;
  try {
    input = validateScanIntakeInput(rawInput) as ScanIntakeInput;
  } catch (err) {
    if (err instanceof WorkflowSchemaError) {
      failJobMetered(db, job.id, {
        code: "schema_validation_failed",
        message: err.message,
        schema: err.schemaName,
        field: err.field,
      }, "scan_intake");
      return;
    }
    throw err;
  }

  const { file_id, watch_folder, month_tag, owner, bucket, folder_id } = input;

  await tracer.startActiveSpan(`scan-worker.execute`, {
    attributes: {
      "job.id": job.id,
      "job.type": "scan_intake",
      "source": "gdrive",
      // Filename + file_id surfaced on the top-level span so traces are
      // immediately self-identifying in Tempo without drilling into child
      // spans. See task 48, Issue 4.
      "scan.file_id": file_id,
      "scan.filename": input.filename ?? "",
      "scan.watch_folder": watch_folder,
      "scan.owner": owner,
      "scan.bucket": bucket,
      "gdrive.folder_id": folder_id,
    },
  }, async (span: Span) => {
    let outcome = "unknown";
    let vendorForSpan = "unknown";
    try {
      // T11: see executeInvoiceIntake — pre-read events and refresh after writes.
      let events = getJobEvents(db, job.id);
      const completedSteps = getCompletedSteps(db, job.id, events);
      const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR ?? "/workspace/downloads";

      // Step 1: Download file from GDrive (or read from disk)
      const cachedDownload = completedSteps.get("download") ?? completedSteps.get("read_from_disk");
      let filePath: string;
      let file: DownloadedFile;

      if (cachedDownload) {
        filePath = (cachedDownload as { file_path?: string }).file_path
          ?? `${DOWNLOAD_DIR}/${(cachedDownload as { filename?: string }).filename ?? "unknown"}`;
        file = readFileAsDownload(filePath);
        logger.log(`Resuming: reusing file from ${filePath}`);
      } else if (input.file_path && existsSync(input.file_path)) {
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
        addJobEvent(db, job.id, "step_started", { step: "download", source: "gdrive" });
        file = await downloadFromGdrive(file_id, input.filename, logger);
        mkdirSync(DOWNLOAD_DIR, { recursive: true });
        // On-disk path uses the job UUID + extension (see invoice path above).
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

      // Step 1.1-1.3: decrypt + guidance-password resume + Trigger B pause.
      // Shared with `executeInvoiceIntake` via `runDecryptAndGuidancePhase`.
      // Scan path opts out of `allowPatchCoversClassification` — there is no
      // operator-managed "upload anyway with manual classification" override
      // for scans (the email path needs it because bank-statement emails
      // arrive encrypted and the operator wants to set owner/doc_type by
      // hand; gdrive scans don't have that workflow).
      //
      // Refresh events so the helper sees download/read_from_disk writes above.
      events = getJobEvents(db, job.id);
      const scanDecryptPhase = await runDecryptAndGuidancePhase(db, job, filePath, {
        notify,
        logger,
        allowPatchCoversClassification: false,
        pauseContext: {
          filename: file.filename,
          watch_folder,
          classifier_notes:
            "PDF is encrypted; decrypt failed (no password configured or wrong password).",
        },
        pauseLogSuffix: " (scan)",
        events,
      });
      if (scanDecryptPhase.kind === "pause") {
        outcome = "awaiting_user_guidance";
        span.setAttribute("invoice.outcome", "awaiting_user_guidance");
        span.setStatus({ code: SpanStatusCode.OK });
        return;
      }

      // Step 2: Document classification via channel
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
            source: "gdrive",
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

      const cachedClassification = cachedDocClassification.result as ScanClassification;
      // Apply any pending `guidance_applied` patch so the user's choices
      // override the classifier's "unknown" (scan Trigger A resume). Make a
      // shallow copy so we don't mutate the cached event payload in place.
      const classification: ScanClassification = { ...cachedClassification };
      // Refresh events: the decrypt phase above doesn't currently write rows
      // on the scan path (no patchCovers branch), but we keep the array fresh
      // so future writes in the helper are visible here.
      events = getJobEvents(db, job.id);
      const scanUnconsumed = findUnconsumedGuidance(events);
      if (scanUnconsumed) {
        if (scanUnconsumed.action === "patch" && scanUnconsumed.patch) {
          Object.assign(classification, scanUnconsumed.patch);
          logger.log(`Applied guidance patch to scan classification: ${JSON.stringify(scanUnconsumed.patch)}`);
        } else if (scanUnconsumed.action === "retry") {
          logger.log(`guidance_applied action=retry (scan) — consumed marker, continuing`);
        }
        addJobEvent(db, job.id, "guidance_applied_consumed", {
          source_event_id: scanUnconsumed.eventId,
        });
        // Task 57 / 4.2: see email-intake path above for rationale.
        const scanLatency = guidanceLatencySeconds(events);
        logger.log(
          `guidance.applied job_id=${job.id} action=${scanUnconsumed.action} latency_seconds=${scanLatency}`,
        );
      }

      // Bucket-driven overrides: the resolved `bucket` expresses user intent
      // and overrides the classifier's content-based decisions (e.g. dropping
      // an invoice-shaped doc in `documents` makes it a non-monetary document).
      Object.assign(classification, applyScanFolderOverrides(classification, bucket));

      vendorForSpan = classification.vendor;
      span.setAttribute("invoice.vendor", classification.vendor);

      // Trigger A (scan): classifier returned `"unknown"` for a required
      // field. Pause for user guidance before any Paperless work.
      const scanUnknownFields = UNKNOWN_FIELDS.filter(
        (f) => classification[f] === "unknown",
      );
      if (scanUnknownFields.length > 0) {
        await pauseAndNotify(db, job.id, {
          step: "post_classification",
          reason: "classifier_unknown",
          missing_fields: scanUnknownFields,
          suggested_actions: buildSuggestedActions(scanUnknownFields, {
            doc_type: (classification.doc_type as string | null | undefined) ?? null,
          }),
          context: {
            filename: file.filename,
            watch_folder,
            vendor: classification.vendor ?? null,
            total_amount: classification.total_amount ?? null,
            doc_date: classification.doc_date ?? null,
            classifier_notes: classification.notes ?? null,
          },
        }, notify, logger);
        logger.log(
          `Job ${job.id} paused (classifier_unknown scan: ${scanUnknownFields.join(", ")})`,
        );
        outcome = "awaiting_user_guidance";
        span.setAttribute("invoice.outcome", "awaiting_user_guidance");
        span.setStatus({ code: SpanStatusCode.OK });
        return;
      }

      // Derive month_tag — document-classifier's reasoned accounting_period wins.
      // GDrive scan creation date is only the *last* fallback (a scanned invoice
      // photographed weeks after issue should NOT be tagged by the scan date).
      if (classification.accounting_period_reasoning) {
        logger.log(`accounting_period: ${classification.accounting_period} — ${classification.accounting_period_reasoning}`);
      }
      const resolvedMonthTag = resolveMonthTag({
        accountingPeriod: classification.accounting_period,
        supplyDate: classification.supply_date,
        servicePeriodStart: parseServicePeriodStart(classification.service_period),
        docDate: classification.doc_date,
        scanFallback: month_tag,
      });
      if (!resolvedMonthTag) {
        missingMonthTagCounter.add(1, { workflow_type: "scan_intake" });
        logger.log(`⚠ Job ${job.id}: no valid accounting period resolved — uploading without month tag`);
        if (notify) {
          await notify(`⚠ ${classification.vendor ?? "Scan"}: no accounting period detected. Tag manually in Paperless.`).catch(() => {});
        }
      } else if (resolvedMonthTag !== month_tag) {
        logger.log(`month_tag overridden: ${month_tag} → ${resolvedMonthTag}`);
      }

      // Step 3: Resolve correspondent
      addJobEvent(db, job.id, "step_started", { step: "resolve_correspondent" });
      const correspondent = await resolveCorrespondentImpl(classification.vendor, adapter, logger);
      addJobEvent(db, job.id, "step_completed", {
        step: "resolve_correspondent",
        correspondent,
      });

      // Step 4: Deduplicate. force=true switches dedup hits from short-circuit
      // to in-place PATCH (forceTargetDocId captured here, used by upload step).
      // Force-reprocess short-circuit: if a prior scan for this file_id already
      // uploaded a doc, PATCH it directly. Bypasses the classifier-based dedup
      // (order_id + correspondent + amount) — which can miss when the classifier
      // extracts a different order_id on re-run (LLM non-determinism). The
      // source_ref → paperless_doc_id link is deterministic and survives that.
      addJobEvent(db, job.id, "step_started", { step: "deduplicate" });
      let forceTargetDocId: number | undefined;
      if (input.force) {
        const priorDocId = getPaperlessDocIdForSource(db, `gdrive:${file_id}`);
        if (priorDocId) {
          forceTargetDocId = priorDocId;
          logger.log(`force=true: using prior paperless_doc_id=${priorDocId} from source_ref (skipping classifier dedup)`);
          span.setAttribute("invoice.force_refresh", true);
          span.setAttribute("invoice.force_target_doc_id", priorDocId);
          addJobEvent(db, job.id, "step_completed", {
            step: "deduplicate",
            outcome: "force_prior_source",
            existing_id: priorDocId,
          });
        }
      }
      const dedupeResult = forceTargetDocId !== undefined
        ? null
        : await checkDuplicateImpl(classification, correspondent, adapter, registry, logger);
      if (dedupeResult) {
        addJobEvent(db, job.id, "step_completed", { step: "deduplicate", ...dedupeResult });

        if (input.force) {
          forceTargetDocId = dedupeResult.existing_id;
          logger.log(`force=true: will refresh existing doc #${forceTargetDocId} (${dedupeResult.outcome}) instead of skipping`);
          span.setAttribute("invoice.force_refresh", true);
          span.setAttribute("invoice.force_target_doc_id", forceTargetDocId);
        } else if (dedupeResult.outcome === "duplicate") {
          completeJob(db, job.id, {
            outcome: "duplicate",
            duplicate_of: dedupeResult.existing_id,
            duplicate_message: dedupeResult.message,
          });
          await moveGdriveFileImpl(file_id, "processed", folder_id, GMAIL_MCP_URL, GOOGLE_EMAIL, logger);
          logger.log(`Job ${job.id} completed: duplicate`);
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
      } else if (forceTargetDocId === undefined) {
        // No prior source_ref match AND no classifier dedup hit
        addJobEvent(db, job.id, "step_completed", { step: "deduplicate", outcome: "no_duplicate" });
      }

      // Step 5: Resolve tags — owner-aware, from the poller-resolved owner role + bucket.
      addJobEvent(db, job.id, "step_started", { step: "resolve_tags" });
      const allTagNames = buildScanTagNames(
        owner,
        bucket,
        requireBusinessLabel(),
        classification,
        resolvedMonthTag,
      );
      const tagIds = await resolveTagIds(allTagNames, adapter, logger);
      addJobEvent(db, job.id, "step_completed", { step: "resolve_tags", tags: tagIds });

      // Step 6: Resolve document type + storage path (owner is the resolved role)
      const documentTypeId = await resolveDocumentTypeId(classification.doc_type, adapter, logger);
      const storagePathId = await resolveStoragePathId(owner, classification.doc_type, adapter, logger);

      // Step 7: Upload to Paperless — or PATCH the existing doc if force-refresh.
      addJobEvent(db, job.id, "step_started", { step: "upload" });
      const title = buildScanTitle(classification.vendor, classification.order_id, classification.subtitle, input.filename);
      let finalDocId: number | undefined;
      let finalOutcome: "uploaded" | "refreshed";

      if (forceTargetDocId) {
        const patchResult = await patchExistingDocument({
          documentId: forceTargetDocId,
          title,
          correspondentId: correspondent.id,
          tagIds,
          documentTypeId,
          storagePathId,
          totalAmount: classification.total_amount,
          orderId: classification.order_id,
          litres: classification.litres,
          receiptDatetime: classification.receipt_datetime,
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
          title, file,
          correspondentId: correspondent.id, tagIds, documentTypeId, storagePathId,
          totalAmount: classification.total_amount, orderId: classification.order_id,
        }, adapter, logger);
        addJobEvent(db, job.id, "step_completed", { step: "upload", mode: "post", ...uploadResult });

        // Step 8: Resolve doc_id via waitForConsumption and set custom fields
        // (post path only — patch path already set them in the single PATCH).
        // setDocumentCustomFields returns doc_id even when there are no fields
        // to set, so we always invoke it to resolve the upload's doc id.
        addJobEvent(db, job.id, "step_started", { step: "set_custom_fields" });
        const cfResult = await setDocumentCustomFieldsImpl(
          uploadResult.task_uuid, classification.total_amount, classification.order_id,
          classification.litres,
          classification.receipt_datetime,
          adapter, registry, logger,
        );
        addJobEvent(db, job.id, "step_completed", { step: "set_custom_fields", ...cfResult });
        finalDocId = cfResult.doc_id;
        finalOutcome = "uploaded";
      }

      // Step 9: Move GDrive file to Processed/
      await moveGdriveFileImpl(file_id, "processed", folder_id, GMAIL_MCP_URL, GOOGLE_EMAIL, logger);

      const result: InvoiceIntakeResult = {
        outcome: finalOutcome, title,
        paperless_document_id: finalDocId,
        correspondent: correspondent.name,
        tags: allTagNames,
        total_amount: classification.total_amount,
      };
      completeJob(db, job.id, result);
      logger.log(`Job ${job.id} completed: ${finalOutcome} "${title}" → doc #${finalDocId ?? "?"}`);
      correspondentsCounter.add(1, { correspondent: correspondent.name });
      if (notify) {
        const msg = formatNotification({
          outcome: finalOutcome,
          vendor: correspondent.name,
          total_amount: classification.total_amount,
          currency: classification.currency,
          doc_type: classification.doc_type,
          owner,
          month_tag: resolvedMonthTag,
          paperless_document_id: finalDocId,
          is_fuel: classification.is_fuel,
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
      const errPayload = { code: "scan_intake_error", message, step: "unknown" };
      if (shouldRetry(db, job.id)) {
        scheduleRetry(db, job.id, errPayload);
        logger.log(`Job ${job.id} scheduled for retry: ${message}`);
        outcome = "retryable";
        span.setAttribute("invoice.outcome", "retryable");
      } else {
        failJobMetered(db, job.id, errPayload, "scan_intake");
        await moveGdriveFileImpl(file_id, "errors", folder_id, GMAIL_MCP_URL, GOOGLE_EMAIL, logger).catch((moveErr) => {
          logger.log(`Failed to move file to errors/: ${moveErr instanceof Error ? moveErr.message : String(moveErr)}`);
        });
        logger.log(`Job ${job.id} failed permanently: ${message}`);
        if (notify) {
          const msg = formatNotification({
            outcome: "failed", vendor: vendorForSpan,
            total_amount: null, currency: null, doc_type: null, owner: null, error: message,
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

// ── GDrive helpers ────────────────────────────────────────────────────
//
// `downloadFromGdrive` is kept as an in-file wrapper to bind the MCP URL +
// GOOGLE_EMAIL env vars at the call site (the orchestrator should not have
// to thread those through). It is NOT a Paperless adapter wrapper.

function downloadFromGdrive(
  fileId: string,
  filename: string | undefined,
  logger: WorkerLogger,
): Promise<DownloadedFile> {
  return downloadFromGdriveImpl(fileId, filename, GMAIL_MCP_URL, GOOGLE_EMAIL, logger);
}
