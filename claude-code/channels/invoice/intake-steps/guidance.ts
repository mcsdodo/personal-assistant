/**
 * Guidance protocol for paused intake jobs.
 *
 * Handles user-supplied guidance (password, patch overrides) on resume,
 * including pause notifications and encrypted-PDF recovery.
 */

import type { Database } from "bun:sqlite";
import * as downloadHelper from "../../download-helper";
import {
  addJobEvent,
  getJobEvents,
  pauseForGuidance,
  type GuidanceRequestPayload,
  type JobEventRow,
  type JobRow,
} from "../../workflow-db";
import { guidanceRequestsTotal } from "../../metrics";
import { formatGuidanceRequest, type NotifyFn } from "../../telegram-notify";
import type { WorkerLogger } from "./types";

// ── Guidance resume helpers ────────────────────────────────────────────
//
// When a user answers a `guidance_request`, `provide_guidance` writes a
// `guidance_applied` event (patch payload or retry marker) and flips the
// job back to `queued`. On next tick the worker runs again from the top
// of `executeInvoiceIntake` / `executeScanIntake`; it must:
//
//   1. Find the most recent `guidance_applied` event that has NOT been
//      consumed yet (no matching `guidance_applied_consumed` event
//      with the same event id after it).
//   2. Apply `patch` to the merged classification (Trigger A resume)
//      or force the classify_document step to re-run (`retry`).
//   3. Write a `guidance_applied_consumed` event so subsequent ticks
//      don't double-apply.
//
// Using a `guidance_applied_consumed` marker is simpler than rewriting
// the `guidance_applied` row — sqlite rows are append-only here and
// consumption is a boolean-per-event, not a state modification.
export interface GuidanceApplied {
  eventId: number;
  action: "patch" | "retry" | "skip" | "fail";
  patch?: Record<string, unknown>;
}

/**
 * Compute seconds between the most recent `guidance_request` event and
 * now. Used to enrich the `guidance.applied` Loki log line with
 * `latency_seconds=...` so ops can answer "how long was the user making
 * us wait?" from Loki alone (no DB join). Returns -1 if no
 * guidance_request exists in `events` or the timestamp fails to parse;
 * caller is expected to just log the sentinel rather than skip.
 */
export function guidanceLatencySeconds(events: JobEventRow[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event_type !== "guidance_request") continue;
    const t = Date.parse(e.created_at);
    if (Number.isNaN(t)) return -1;
    return Math.max(0, Math.round((Date.now() - t) / 1000));
  }
  return -1;
}

/**
 * Return the most recent unconsumed `guidance_applied` event, or null
 * if every guidance_applied has been consumed (or none exist). The
 * "unconsumed" signal is a `guidance_applied_consumed` event whose
 * `source_event_id` payload field equals the guidance_applied's row
 * id. Walk events in reverse chronological order and return the first
 * guidance_applied that is NOT referenced by a later consumed marker.
 */
export function findUnconsumedGuidance(events: JobEventRow[]): GuidanceApplied | null {
  const consumedIds = new Set<number>();
  for (const e of events) {
    if (e.event_type !== "guidance_applied_consumed") continue;
    try {
      const p = JSON.parse(e.payload_json ?? "{}");
      if (typeof p.source_event_id === "number") consumedIds.add(p.source_event_id);
    } catch { /* ignore malformed */ }
  }
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.event_type !== "guidance_applied") continue;
    if (consumedIds.has(e.id)) continue;
    try {
      const p = JSON.parse(e.payload_json ?? "{}");
      const action = p.action;
      if (action === "patch" || action === "retry") {
        return { eventId: e.id, action, patch: p.patch ?? undefined };
      }
      // skip/fail are applied by provide_guidance directly (completeJob/failJob);
      // the worker should never re-run these jobs, so ignore.
      return null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Apply the most recent unconsumed `guidance_password` event, if any:
 * call `tryDecryptWithPassword` and scrub the password off the event row
 * so it doesn't linger in the audit trail. Idempotent — subsequent ticks
 * see an empty payload and skip.
 *
 * Scrub strategy: UPDATE payload_json to `'{}'` on the event's id. We
 * don't delete the row because the audit trail should still show that a
 * password was handed over (matching the `decrypt_password_provided:
 * true` flag on guidance_applied). The password value itself is removed.
 */
export function applyGuidancePassword(
  db: Database,
  jobId: string,
  filePath: string,
  logger: WorkerLogger,
  events?: JobEventRow[],
): void {
  const evts = events ?? getJobEvents(db, jobId);
  // findLast: walk in reverse for the most recent event with a non-empty payload.
  for (let i = evts.length - 1; i >= 0; i--) {
    const e = evts[i];
    if (e.event_type !== "guidance_password") continue;
    let payload: { password?: string };
    try {
      payload = JSON.parse(e.payload_json ?? "{}");
    } catch {
      return;
    }
    if (!payload.password) return; // already scrubbed, nothing to do
    try {
      downloadHelper.tryDecryptWithPassword(filePath, payload.password);
      logger.log(`Job ${jobId}: applied user-supplied password for decrypt`);
    } finally {
      // Scrub regardless of decrypt outcome — the password should NEVER
      // linger in the audit row. If decrypt failed, Trigger B below fires
      // again and the user can re-supply.
      db.prepare("UPDATE job_events SET payload_json = '{}' WHERE id = ?").run(e.id);
    }
    return;
  }
}

/**
 * Pause a job for user guidance AND send a Telegram prompt in one shot.
 * Task 3.2: wraps `pauseForGuidance` so the worker never forgets to notify
 * when it parks a job in `awaiting_user_guidance`. Notification failures
 * are swallowed — the DB state (job + guidance_request event) is the
 * source of truth, telegram is best-effort.
 *
 * TODO(task 3.2): if `NotifyFn` gains a `message_id` return type later,
 * capture it here and update the `guidance_request` event's payload_json
 * with `telegram_message_id` so inline-keyboard callbacks can edit the
 * original message. The current signature is `(msg: string) => Promise<void>`
 * so we have no id to record.
 */
export async function pauseAndNotify(
  db: Database,
  jobId: string,
  payload: GuidanceRequestPayload,
  notify: NotifyFn | undefined,
  logger?: WorkerLogger,
): Promise<void> {
  pauseForGuidance(db, jobId, payload);
  // Task 57 / 4.2: observability. Counter tracks pause trends by reason
  // (encrypted_pdf rising → bank password wrong; classifier_unknown rising
  // → Haiku over-using IDK). Loki log is paired with guidance.received
  // (handleProvideGuidance) and guidance.applied (worker consume) so we
  // can compute average user-response latency per job.
  guidanceRequestsTotal.add(1, { reason: payload.reason });
  const lokiLine = `guidance.requested job_id=${jobId} reason=${payload.reason} step=${payload.step}`;
  if (logger) logger.log(lokiLine);
  if (!notify) return;
  const formatted = formatGuidanceRequest({ job_id: jobId, ...payload });
  await notify(formatted).catch(() => {
    // Notification failed; the job is still correctly parked in
    // `awaiting_user_guidance` and the `guidance_request` event carries
    // the full payload for observability.
  });
}

// ── Shared decrypt + guidance phase ────────────────────────────────────
//
// Both `executeInvoiceIntake` and `executeScanIntake` carry the same three
// steps right after the file lands on disk:
//
//   1. `tryDecrypt(filePath)` — best-effort decrypt with BANK_PDF_PASSWORD.
//   2. `applyGuidancePassword` — consume any `guidance_password` event and
//      scrub it from the audit trail.
//   3. If the PDF is still encrypted: pause the job and ask the user.
//
// The ONE invoice-only twist (Task 57 / §5.10b): if a prior
// `guidance_applied(action="patch")` event carries both `owner` AND
// `doc_type`, treat that as the operator's "upload anyway, with manual
// classification" override — synthesize a `classify_document` step_completed
// stub (`{ __from_guidance_patch: true }`) so the downstream classify step
// short-circuits, and continue past the pause. Scan path has no equivalent.
//
// Path-specific bits surfaced as parameters:
//   • `allowPatchCoversClassification` — true for invoice, false for scan
//   • `pauseContext` — invoice carries sender/subject, scan carries watch_folder
//   • `pauseLogSuffix` — scan log line ends in " (scan)" so ops can tell paths apart
//   • `completedSteps` — invoice mutates the in-scope Map after synthesizing
//     classify_document so step 1.5's `completedSteps.get("classify_document")`
//     check below short-circuits on the same tick

export type IntakePhaseOutcome =
  | { kind: "pause"; reason: string }
  | { kind: "continue" };

export async function runDecryptAndGuidancePhase(
  db: Database,
  job: JobRow,
  filePath: string,
  ctx: {
    notify: NotifyFn | undefined;
    logger: WorkerLogger;
    allowPatchCoversClassification: boolean;
    pauseContext: GuidanceRequestPayload["context"];
    pauseLogSuffix: string;
    completedSteps?: Map<string, Record<string, unknown>>;
    /** Pre-read events from the executor (T11). When passed, applyGuidancePassword
     *  and the patchCoversClassification lookup use it instead of re-reading. */
    events?: JobEventRow[];
  },
): Promise<IntakePhaseOutcome> {
  // Step 1: Try to decrypt the PDF if it's password-protected.
  // No-op when BANK_PDF_PASSWORD is unset or the file isn't encrypted.
  // Closes the gap between the email and GDrive paths (task 57).
  downloadHelper.tryDecrypt(filePath);

  // Step 2: Resume-decrypt with a user-supplied password, if the
  // provide_guidance tool wrote one to a `guidance_password` event. The
  // password is consumed and the event payload is scrubbed so it never
  // lingers in the audit trail. Task 57, Trigger B resume.
  applyGuidancePassword(db, job.id, filePath, ctx.logger, ctx.events);

  // Step 3: Trigger B — if the PDF is still encrypted after both decrypt
  // attempts, we have no classifier output to trust. Pause the job and ask
  // the user for the password (or permission to skip). On the invoice path,
  // an unconsumed `guidance_applied(action=patch, owner+doc_type)` lets the
  // operator override the pause with manual classification.
  if (!downloadHelper.isPdfEncrypted(filePath)) {
    return { kind: "continue" };
  }

  if (ctx.allowPatchCoversClassification) {
    const allEvents = ctx.events ?? getJobEvents(db, job.id);
    const pendingPatch = findUnconsumedGuidance(allEvents);
    const patchCoversClassification =
      pendingPatch?.action === "patch" &&
      pendingPatch.patch != null &&
      typeof pendingPatch.patch.owner === "string" &&
      typeof pendingPatch.patch.doc_type === "string";

    if (patchCoversClassification) {
      // Operator chose "upload anyway" via patch. Mark classify_document
      // complete with an empty result so the downstream classify step
      // short-circuits; the unconsumed guidance_applied event is consumed
      // at the normal merge point and the patch fields fill in
      // owner/doc_type/etc. for upload.
      if (!ctx.completedSteps?.has("classify_document")) {
        addJobEvent(db, job.id, "step_completed", {
          step: "classify_document",
          result: { __from_guidance_patch: true },
        });
        ctx.completedSteps?.set("classify_document", { result: { __from_guidance_patch: true } });
      }
      ctx.logger.log(
        `Job ${job.id}: encrypted PDF accepted via guidance patch — skipping decrypt-pause`,
      );
      return { kind: "continue" };
    }
  }

  await pauseAndNotify(
    db,
    job.id,
    {
      step: "decrypt_pdf",
      reason: "encrypted_pdf",
      missing_fields: [],
      suggested_actions: [
        "skip",
        "set:owner=personal,doc_type=account_statement",
        "set:owner=business,doc_type=account_statement",
        "send_password",
        "retry",
      ],
      context: ctx.pauseContext,
    },
    ctx.notify,
    ctx.logger,
  );
  ctx.logger.log(`Job ${job.id} paused: encrypted_pdf${ctx.pauseLogSuffix}`);
  return { kind: "pause", reason: "encrypted_pdf" };
}
