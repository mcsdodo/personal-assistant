import { Database } from "bun:sqlite";

import { addJobEvent } from "./events";
import { setJobState } from "./jobs";

/**
 * Payload for a `guidance_request` event emitted when the worker pauses a
 * job and asks the user for direction (classifier said "unknown", encrypted
 * PDF we can't decrypt, etc.). See task 57 for the full protocol.
 */
export interface GuidanceRequestPayload {
  /** Pipeline step that triggered the pause (e.g. "classify_document", "decrypt_pdf"). */
  step: string;
  /** Machine-readable reason code (e.g. "classifier_unknown", "encrypted_pdf"). */
  reason: string;
  /** Fields the classifier was unsure about; empty for non-classifier pauses. */
  missing_fields: string[];
  /** Short strings the UI/bot can turn into buttons (e.g. "set:owner=personal", "skip"). */
  suggested_actions: string[];
  /** Free-form context shown to the user (filename, sender, classifier notes, etc.). */
  context: Record<string, unknown>;
  /** Telegram message id, set after the bot sends the prompt (filled in by Task 3.2). */
  telegram_message_id?: number;
}

/**
 * Park a job in `awaiting_user_guidance` and emit a `guidance_request` event
 * carrying the payload. The worker stops after this call; it resumes only
 * when `provide_guidance` writes a matching `guidance_applied` event and
 * flips the state back to `queued`.
 */
export function pauseForGuidance(
  db: Database,
  jobId: string,
  payload: GuidanceRequestPayload,
): void {
  const tx = db.transaction(() => {
    setJobState(db, jobId, "awaiting_user_guidance");
    addJobEvent(db, jobId, "guidance_request", payload);
  });
  tx();
}
