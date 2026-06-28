import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  openWorkflowDb,
  createJob,
  cancelJob,
  getJob,
  getJobEvents,
  claimNextQueuedJob,
  requestClassification,
  submitClassification,
  setJobState,
} from "./workflow-db";
import { handleProvideGuidance } from "./workflow-mcp";

let tmpDir: string;
let db: Database;

// Minimum-valid email classification — schemas reject anything narrower.
// See workflow-schemas.ts validateEmailClassificationResult for the contract.
const VALID_EMAIL_RESULT = {
  is_invoice: true,
  confidence: "high" as const,
  vendor: "Alza.sk",
  is_fuel: false,
  action: "download_and_upload" as const,
  download_strategy: "attachment" as const,
  strategy_confidence: "high" as const,
  requires_review: false,
  order_id: null,
  total_amount: null,
  currency: null,
  subject: "Test invoice",
  received_at: "2026-04-01T00:00:00Z",
  sender: "test@alza.sk",
};

const VALID_EMAIL_RESULT_FALSE = {
  ...VALID_EMAIL_RESULT,
  is_invoice: false,
  action: "ignore" as const,
  download_strategy: null,
};

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wf-classify-test-"));
  db = openWorkflowDb(join(tmpDir, "workflow.db"));
});

afterEach(() => {
  db.close();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Windows can briefly lock WAL files after close.
  }
});

describe("awaiting_classification state", () => {
  test("requestClassification sets state and writes step_started event", () => {
    const job = createJob(db, { workflowType: "invoice_intake", inputJson: "{}" });
    db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(job.id);

    requestClassification(db, job.id, "classify_email", {
      sender: "test@alza.sk",
      subject: "Invoice",
    });

    const updated = getJob(db, job.id);
    expect(updated!.state).toBe("awaiting_classification");

    const events = getJobEvents(db, job.id);
    const stepEvent = events.find((e) => e.event_type === "step_started");
    expect(stepEvent).toBeTruthy();
    const payload = JSON.parse(stepEvent!.payload_json!);
    expect(payload.step).toBe("classify_email");
    expect(payload.sender).toBe("test@alza.sk");
  });

  test("requestClassification fails if job is not running", () => {
    const job = createJob(db, { workflowType: "invoice_intake", inputJson: "{}" });

    const ok = requestClassification(db, job.id, "classify_email", {});
    expect(ok).toBe(false);

    const updated = getJob(db, job.id);
    expect(updated!.state).toBe("queued");
  });

  test("submitClassification writes step_completed and sets state back to running", () => {
    const job = createJob(db, { workflowType: "invoice_intake", inputJson: "{}" });
    db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(job.id);
    requestClassification(db, job.id, "classify_email", { sender: "test@alza.sk" });

    const ok = submitClassification(db, job.id, "classify_email", VALID_EMAIL_RESULT);
    expect(ok).toBe(true);

    const updated = getJob(db, job.id);
    expect(updated!.state).toBe("queued");

    const events = getJobEvents(db, job.id);
    const completed = events.find(
      (e) =>
        e.event_type === "step_completed" &&
        JSON.parse(e.payload_json!).step === "classify_email",
    );
    expect(completed).toBeTruthy();
    const stored = JSON.parse(completed!.payload_json!).result;
    expect(stored.vendor).toBe("Alza.sk");
    expect(stored.is_invoice).toBe(true);
  });

  test("submitClassification is idempotent — second call is no-op", () => {
    const job = createJob(db, { workflowType: "invoice_intake", inputJson: "{}" });
    db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(job.id);
    requestClassification(db, job.id, "classify_email", {});

    submitClassification(db, job.id, "classify_email", VALID_EMAIL_RESULT);
    const ok2 = submitClassification(db, job.id, "classify_email", VALID_EMAIL_RESULT_FALSE);
    expect(ok2).toBe(true); // idempotent, no error

    // First result preserved
    const events = getJobEvents(db, job.id);
    const completeds = events.filter(
      (e) =>
        e.event_type === "step_completed" &&
        JSON.parse(e.payload_json!).step === "classify_email",
    );
    expect(completeds).toHaveLength(1);
    expect(JSON.parse(completeds[0].payload_json!).result.is_invoice).toBe(true);
  });

  test("submitClassification rejects wrong step", () => {
    const job = createJob(db, { workflowType: "invoice_intake", inputJson: "{}" });
    db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(job.id);
    requestClassification(db, job.id, "classify_email", {});

    // Use a doc-classification-shaped payload but for the wrong step name
    const docPayload = {
      doc_type: "invoice", vendor: "X", total_amount: 10, currency: "EUR",
      is_fuel: false, owner: "business", confidence: "high",
      order_id: null, subtitle: null, doc_date: null,
    };
    const ok = submitClassification(db, job.id, "classify_document", docPayload);
    expect(ok).toBe(false);
  });

  test("submitClassification rejects if job not awaiting_classification", () => {
    const job = createJob(db, { workflowType: "invoice_intake", inputJson: "{}" });
    db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(job.id);

    // No requestClassification called, job still running
    const ok = submitClassification(db, job.id, "classify_email", VALID_EMAIL_RESULT);
    expect(ok).toBe(false);
  });

  test("submitClassification fails the job on schema validation error", () => {
    const job = createJob(db, { workflowType: "invoice_intake", inputJson: "{}" });
    db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(job.id);
    requestClassification(db, job.id, "classify_email", {});

    // Missing required fields (vendor, action, etc.)
    const malformed = { is_invoice: true };
    const ok = submitClassification(db, job.id, "classify_email", malformed);
    expect(ok).toBe(false);

    // Job should be marked failed with schema_validation_failed code
    const updated = getJob(db, job.id);
    expect(updated!.state).toBe("failed");
    const err = JSON.parse(updated!.error_json!);
    expect(err.code).toBe("schema_validation_failed");
    expect(err.step).toBe("classify_email");
    expect(err.schema).toBe("EmailClassificationResult");
  });

  test("claimNextQueuedJob skips awaiting_classification jobs", () => {
    const job1 = createJob(db, { workflowType: "invoice_intake", inputJson: "{}" });
    db.prepare("UPDATE jobs SET state = 'awaiting_classification' WHERE id = ?").run(job1.id);
    const job2 = createJob(db, { workflowType: "invoice_intake", inputJson: "{}" });

    const claimed = claimNextQueuedJob(db);
    expect(claimed!.id).toBe(job2.id);
  });

  test("cancelJob can cancel awaiting_classification jobs", () => {
    const job = createJob(db, { workflowType: "invoice_intake", inputJson: "{}" });
    db.prepare("UPDATE jobs SET state = 'awaiting_classification' WHERE id = ?").run(job.id);

    const ok = cancelJob(db, job.id, "timeout");
    expect(ok).toBe(true);
    expect(getJob(db, job.id)!.state).toBe("cancelled");
  });
});

// ── submitClassification merge step (task 47 / Issue 1) ────────────────
//
// The merge copies sender/subject/received_at from the job's input_json
// (where the watcher writes them at job-creation time) into Claude's
// classification result before schema validation. Tests cover:
//   - Watcher metadata wins when present in input_json
//   - Watcher null wins when explicitly null in input_json (source MCP
//     returned null)
//   - Falls back to Claude's value when watcher didn't provide the key
//   - Falls back to null when neither provided (and the field is
//     `nullableString` so validation accepts it)
//   - Manual jobs (empty input_json) work via Claude-injection fallback

describe("submitClassification metadata merge", () => {
  // Strip the would-be-injected fields from the base classification —
  // simulates Claude's NEW (post-task-47) submission that doesn't include
  // sender/subject/received_at because the worker no longer asks for them.
  const CLAUDE_RESULT_NO_METADATA = (() => {
    const { sender, subject, received_at, ...rest } = VALID_EMAIL_RESULT;
    return rest;
  })();

  function setupParkedJob(inputJson: string) {
    const job = createJob(db, { workflowType: "invoice_intake", inputJson });
    db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").run(job.id);
    requestClassification(db, job.id, "classify_email", {});
    return job;
  }

  function getStoredResult(jobId: string) {
    const events = getJobEvents(db, jobId);
    const completed = events.find(
      (e) =>
        e.event_type === "step_completed" &&
        JSON.parse(e.payload_json!).step === "classify_email",
    );
    return JSON.parse(completed!.payload_json!).result;
  }

  test("merges watcher-injected metadata when input_json has it", () => {
    const job = setupParkedJob(
      JSON.stringify({
        email_source: "outlook",
        message_id: "abc",
        sender: "watcher@vendor.com",
        subject: "From the watcher",
        received_at: "2026-04-07T10:00:00Z",
      }),
    );

    const ok = submitClassification(db, job.id, "classify_email", CLAUDE_RESULT_NO_METADATA);
    expect(ok).toBe(true);

    const stored = getStoredResult(job.id);
    expect(stored.sender).toBe("watcher@vendor.com");
    expect(stored.subject).toBe("From the watcher");
    expect(stored.received_at).toBe("2026-04-07T10:00:00Z");
    expect(stored.vendor).toBe("Alza.sk"); // Claude's classification preserved
  });

  test("merges null metadata when watcher explicitly wrote null", () => {
    const job = setupParkedJob(
      JSON.stringify({
        email_source: "outlook",
        message_id: "abc",
        sender: null,
        subject: null,
        received_at: null,
      }),
    );

    const ok = submitClassification(db, job.id, "classify_email", CLAUDE_RESULT_NO_METADATA);
    expect(ok).toBe(true);

    const stored = getStoredResult(job.id);
    expect(stored.sender).toBeNull();
    expect(stored.subject).toBeNull();
    expect(stored.received_at).toBeNull();
  });

  test("falls back to Claude-provided value when watcher didn't include the field (manual job)", () => {
    // Manual jobs from create_invoice_intake_job: input_json has only the
    // bare minimum, no watcher metadata. Claude would still include sender
    // etc. for backward compat in this scenario.
    const job = setupParkedJob(JSON.stringify({ email_source: "outlook", message_id: "abc" }));

    const ok = submitClassification(db, job.id, "classify_email", VALID_EMAIL_RESULT);
    expect(ok).toBe(true);

    const stored = getStoredResult(job.id);
    expect(stored.sender).toBe("test@alza.sk"); // from Claude's payload
    expect(stored.subject).toBe("Test invoice");
    expect(stored.received_at).toBe("2026-04-01T00:00:00Z");
  });

  test("watcher value wins over Claude value when both present", () => {
    // Defensive: during a hypothetical rolling upgrade, Claude might still
    // include sender. The watcher's value is the source of truth.
    const job = setupParkedJob(
      JSON.stringify({
        email_source: "outlook",
        message_id: "abc",
        sender: "watcher@authoritative.com",
      }),
    );

    const ok = submitClassification(db, job.id, "classify_email", VALID_EMAIL_RESULT);
    expect(ok).toBe(true);

    const stored = getStoredResult(job.id);
    expect(stored.sender).toBe("watcher@authoritative.com");
  });

  test("succeeds with null fields when neither watcher nor Claude provided them", () => {
    const job = setupParkedJob(JSON.stringify({ email_source: "outlook", message_id: "abc" }));

    const ok = submitClassification(db, job.id, "classify_email", CLAUDE_RESULT_NO_METADATA);
    expect(ok).toBe(true);

    const stored = getStoredResult(job.id);
    expect(stored.sender).toBeNull();
    expect(stored.subject).toBeNull();
    expect(stored.received_at).toBeNull();
    expect(stored.vendor).toBe("Alza.sk"); // classification preserved
  });

  test("malformed input_json is treated as empty (no merge), Claude's values used as fallback", () => {
    const job = setupParkedJob("not-valid-json");

    const ok = submitClassification(db, job.id, "classify_email", VALID_EMAIL_RESULT);
    expect(ok).toBe(true);

    const stored = getStoredResult(job.id);
    // No watcher metadata, Claude's values flow through
    expect(stored.sender).toBe("test@alza.sk");
  });
});

// ── provide_guidance MCP tool (task 57 / Task 1.4) ─────────────────────
//
// The tool resumes a job paused in `awaiting_user_guidance`. It is the
// single entry point for all four actions (skip/retry/fail/patch). The
// dispatch wrapper below mirrors the switch in workflow-mcp.ts so the
// test exercises the exact same handler code-path callers will hit.

interface CallToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

function setupWorkflowMcp() {
  async function callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    try {
      switch (name) {
        case "provide_guidance": {
          handleProvideGuidance(db, args as any);
          return { content: [{ type: "text", text: JSON.stringify({ success: true }) }] };
        }
        default:
          return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
      }
    } catch (err) {
      return {
        content: [
          { type: "text", text: err instanceof Error ? err.message : String(err) },
        ],
        isError: true,
      };
    }
  }
  return { db, callTool };
}

function extractText(result: CallToolResult): string {
  return result.content.map((c) => c.text).join("\n");
}

describe("provide_guidance", () => {
  test("skip action transitions awaiting_user_guidance → completed with outcome=skipped", async () => {
    const { db, callTool } = setupWorkflowMcp();
    const job = createJob(db, { workflowType: "invoice_intake" });
    setJobState(db, job.id, "awaiting_user_guidance");

    const result = await callTool("provide_guidance", {
      job_id: job.id, guidance: { action: "skip", user_note: "duplicate of #418" },
    });
    expect(result.isError).toBeFalsy();

    const reloaded = getJob(db, job.id);
    expect(reloaded?.state).toBe("completed");
    const output = JSON.parse(reloaded!.output_json!);
    expect(output.outcome).toBe("skipped");
  });

  test("patch action stores guidance event + transitions to queued", async () => {
    const { db, callTool } = setupWorkflowMcp();
    const job = createJob(db, { workflowType: "invoice_intake" });
    setJobState(db, job.id, "awaiting_user_guidance");

    await callTool("provide_guidance", {
      job_id: job.id,
      guidance: { action: "patch", patch: { owner: "personal" } },
    });

    const reloaded = getJob(db, job.id);
    expect(reloaded?.state).toBe("queued");
    const events = getJobEvents(db, job.id);
    const applied = events.find(e => e.event_type === "guidance_applied");
    expect(JSON.parse(applied!.payload_json!).patch).toEqual({ owner: "personal" });
  });

  test("rejects guidance for job not in awaiting_user_guidance", async () => {
    const { db, callTool } = setupWorkflowMcp();
    const job = createJob(db, { workflowType: "invoice_intake" });
    // job is queued, not paused
    const result = await callTool("provide_guidance", {
      job_id: job.id, guidance: { action: "skip" },
    });
    expect(result.isError).toBe(true);
    expect(extractText(result)).toMatch(/not in awaiting_user_guidance/);
  });
});
