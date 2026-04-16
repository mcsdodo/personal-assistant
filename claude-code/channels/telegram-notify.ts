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

/**
 * Input shape for formatGuidanceRequest. Compatible with the
 * GuidanceRequestPayload from workflow-db.ts (same `reason`, `missing_fields`,
 * `suggested_actions`, `context` fields) plus the `job_id` the caller passes
 * when building the Telegram prompt.
 */
export interface GuidanceRequestMessage {
  job_id: string;
  reason: string;
  missing_fields?: string[];
  suggested_actions: string[];
  context: Record<string, unknown>;
}

/** Short job_id prefix used in the Telegram header (first 8 chars). */
function shortJobId(jobId: string): string {
  return jobId.slice(0, 8);
}

/** Capitalize the first letter of a field name for human-readable labels. */
function capitalize(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Stringify a context value for display (numbers, strings, etc.). */
function formatContextValue(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return v;
  return JSON.stringify(v);
}

/**
 * Map a `suggested_actions[]` entry (machine-readable) to a Telegram slash
 * command hint (human-friendly). Examples:
 *   "skip"                                         -> "/skip"
 *   "retry"                                        -> "/retry"
 *   "send_password"                                -> "/password"
 *   "set:owner=personal"                           -> "/personal"
 *   "set:owner=techlab"                            -> "/techlab"
 *   "set:doc_type=account_statement"               -> "/statement"
 *   "set:owner=personal,doc_type=account_statement"-> "/personal_statement"
 */
function actionToCommand(action: string): string | null {
  if (action === "skip") return "/skip";
  if (action === "retry") return "/retry";
  if (action === "fail") return "/fail";
  if (action === "send_password") return "/password";

  if (action.startsWith("set:")) {
    const parts = action.slice(4).split(",");
    const segments: string[] = [];
    for (const part of parts) {
      const [key, value] = part.split("=");
      if (!key || !value) continue;
      if (key === "owner") {
        segments.push(value);
      } else if (key === "doc_type") {
        // Collapse "account_statement" -> "statement" for a compact hint.
        segments.push(value === "account_statement" ? "statement" : value);
      } else {
        segments.push(value);
      }
    }
    if (segments.length === 0) return null;
    return "/" + segments.join("_");
  }

  return null;
}

/**
 * Format a multi-line Telegram prompt for a job paused in
 * `awaiting_user_guidance`. See task 57 design doc, section "Telegram
 * protocol", for example outputs.
 */
export function formatGuidanceRequest(msg: GuidanceRequestMessage): string {
  const lines: string[] = [];

  lines.push(`🤔 Need guidance — job ${shortJobId(msg.job_id)}`);
  lines.push("");

  const ctx = msg.context ?? {};
  const filename = formatContextValue(ctx.filename);
  const sender = formatContextValue(ctx.sender);
  const subject = formatContextValue(ctx.subject);
  const vendor = formatContextValue(ctx.vendor);
  const totalAmount = ctx.total_amount != null ? formatContextValue(ctx.total_amount) : "";
  const docDate = formatContextValue(ctx.doc_date);
  const classifierNotes = formatContextValue(ctx.classifier_notes);

  if (filename) lines.push(`📎 ${filename}`);

  if (sender) {
    lines.push(subject ? `✉️ ${sender} · "${subject}"` : `✉️ ${sender}`);
  }

  const vendorParts: string[] = [];
  if (vendor) vendorParts.push(`🏢 Vendor: ${vendor}`);
  if (totalAmount) vendorParts.push(`💶 Total: ${totalAmount} EUR`);
  if (docDate) vendorParts.push(`📅 ${docDate}`);
  if (vendorParts.length > 0) lines.push(vendorParts.join("  "));

  // Reason-specific context line.
  if (msg.reason === "encrypted_pdf") {
    lines.push("⚠️ PDF is encrypted; decrypt failed…");
  } else if (msg.reason === "classifier_unknown") {
    const missing = msg.missing_fields ?? [];
    const field = missing[0] ?? "field";
    const label = `${capitalize(field)} unclear`;
    if (classifierNotes) {
      lines.push(`❓ ${label}: "${classifierNotes}"`);
    } else {
      lines.push(`❓ ${label}`);
    }
  } else if (classifierNotes) {
    lines.push(`⚠️ ${classifierNotes}`);
  }

  // Action hints block.
  const commands: string[] = [];
  for (const action of msg.suggested_actions) {
    const cmd = actionToCommand(action);
    if (cmd && !commands.includes(cmd)) commands.push(cmd);
  }
  if (commands.length > 0) {
    lines.push("");
    lines.push(commands.join("  "));
  }
  lines.push("Or reply with free text.");

  return lines.join("\n");
}

/**
 * Telegram Bot API inline-keyboard button. Callback data is limited to
 * 1..64 bytes by the platform; we encode as `g:{jobIdPrefix}:{action}`
 * where jobIdPrefix is the first 8 chars of the uuid — matches the
 * header shown to the user and keeps the payload well under the limit
 * even for the longest v1 action verb
 * (`set:owner=personal,doc_type=account_statement` = 45 chars, total
 * payload ~56 bytes).
 */
export interface TelegramInlineButton {
  text: string;
  callback_data: string;
}

/**
 * Telegram Bot API `reply_markup` value for an inline keyboard. Rows
 * are laid out top-to-bottom; buttons within a row render left-to-right.
 * See https://core.telegram.org/bots/api#inlinekeyboardmarkup.
 */
export interface InlineKeyboardMarkup {
  inline_keyboard: TelegramInlineButton[][];
}

/** Map an action verb to a short human-readable button label. */
function actionToButtonLabel(action: string): string | null {
  if (action === "skip") return "Skip";
  if (action === "retry") return "Retry";
  if (action === "fail") return "Fail";
  if (action === "send_password") return "Send password";

  if (action.startsWith("set:")) {
    const parts = action.slice(4).split(",");
    const segments: string[] = [];
    for (const part of parts) {
      const [key, value] = part.split("=");
      if (!key || !value) continue;
      if (key === "owner") {
        // "personal" -> "Personal", "techlab" -> "Techlab"
        segments.push(capitalize(value));
      } else if (key === "doc_type") {
        // Collapse "account_statement" -> "statement" for a compact label.
        segments.push(value === "account_statement" ? "statement" : value);
      } else {
        // Unknown set:<key> field — don't render a misleading label.
        return null;
      }
    }
    if (segments.length === 0) return null;
    return segments.join("+");
  }

  return null;
}

/**
 * Build a Telegram inline-keyboard `reply_markup` for a paused job's
 * suggested actions. Groups buttons into rows for ergonomic tapping:
 *
 *  - `send_password` on its own row (destructive / sensitive input).
 *  - Owner-combo pairs (`personal+statement`, `techlab+statement`) next to each other.
 *  - Plain owner pairs (`Personal`, `Techlab`) next to each other.
 *  - `set:doc_type=...` singletons next to each other (up to 3 per row).
 *  - `Skip` / `Retry` / `Fail` on a final control row (up to 3 per row).
 *
 * Unknown or unmappable action verbs are silently dropped so the button
 * grid never renders a blank or malformed row.
 *
 * NOTE (Task 3.4): v1 ships this as a pure function only. The outbound
 * `notifyTelegram` path in `workflow-mcp.ts` accepts a plain string body;
 * wiring `reply_markup` into `NotifyFn` requires signature changes in
 * the notify call sites (including `intake-worker.ts`). Plan allows
 * deferral — Task 3.2's `pauseAndNotify` helper can opt-in later by
 * passing the result of this function to an extended notify signature.
 * Until then the text prompt still carries `/slash` command hints, so
 * the user is never blocked by missing buttons.
 */
export function buildGuidanceReplyMarkup(payload: {
  job_id: string;
  suggested_actions: string[];
}): InlineKeyboardMarkup {
  const prefix = shortJobId(payload.job_id);

  type Bucket = "password" | "owner_combo" | "owner" | "doctype_or_other" | "control";
  const buckets: Record<Bucket, TelegramInlineButton[]> = {
    password: [],
    owner_combo: [],
    owner: [],
    doctype_or_other: [],
    control: [],
  };

  const seen = new Set<string>();
  for (const action of payload.suggested_actions) {
    if (seen.has(action)) continue;
    seen.add(action);

    const label = actionToButtonLabel(action);
    if (!label) continue;

    const button: TelegramInlineButton = {
      text: label,
      callback_data: `g:${prefix}:${action}`,
    };

    if (action === "send_password") {
      buckets.password.push(button);
    } else if (action === "skip" || action === "retry" || action === "fail") {
      buckets.control.push(button);
    } else if (action.startsWith("set:")) {
      const body = action.slice(4);
      const hasOwner = body.includes("owner=");
      const hasDocType = body.includes("doc_type=");
      if (hasOwner && hasDocType) {
        buckets.owner_combo.push(button);
      } else if (hasOwner) {
        buckets.owner.push(button);
      } else {
        buckets.doctype_or_other.push(button);
      }
    } else {
      buckets.doctype_or_other.push(button);
    }
  }

  const rows: TelegramInlineButton[][] = [];
  const pushChunked = (arr: TelegramInlineButton[], perRow: number): void => {
    for (let i = 0; i < arr.length; i += perRow) {
      rows.push(arr.slice(i, i + perRow));
    }
  };

  // Order: password (own row), owner combos (2/row), owner plain (2/row),
  //        doc_type/other singletons (3/row), control verbs (3/row).
  pushChunked(buckets.password, 1);
  pushChunked(buckets.owner_combo, 2);
  pushChunked(buckets.owner, 2);
  pushChunked(buckets.doctype_or_other, 3);
  pushChunked(buckets.control, 3);

  return { inline_keyboard: rows };
}
