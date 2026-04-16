"""E2E test: encrypted-PDF pause + resume via user guidance (task 57).

Exercises the task-57 guidance protocol end-to-end against the live stack:

1. Send a real Gmail with the password-protected mBank statement fixture
   (`test_data/account_statement_locked.pdf`) attached.
2. The watcher creates an `invoice_intake` job; the worker downloads the
   PDF, discovers it's encrypted, and — because we intentionally do NOT
   pre-seed a password that would let `tryDecrypt` succeed — parks the
   job in `awaiting_user_guidance` with `reason: "encrypted_pdf"`.
3. Simulate the operator's Telegram reply by calling the
   `provide_guidance` MCP tool (via `call_provide_guidance`, which
   exec's a bun script inside the claude-code container against the
   exported `handleProvideGuidance`) with an `action: "patch"` payload
   overriding owner + doc_type + month_tag.
4. Wait for the job to transition through `queued` → `running` →
   `completed` with `outcome: "uploaded"`.
5. Verify the resulting Paperless document has the `personal` tag, no
   `techlab` tag, and lives under the "Personal Documents" storage path.

Run:
    cd compose.stacks/infra/personal-assistant
    python -m pytest tests/test_email_encrypted_pdf.py -v -x --timeout=420

Requires the live stack: claude-code container running, Gmail OAuth
valid, Paperless reachable at localhost:8010. The test takes ~3-5
minutes because it waits for two full pipeline passes separated by the
guidance round-trip. See `tests/README.md` for full setup.
"""

from __future__ import annotations

import json

import pytest

from .helpers import (
    GMAIL_TO,
    TEST_DATA_DIR,
    call_provide_guidance,
    get_job_events,
    paperless_find_by_title_full,
    poll_job_completion,
    poll_job_state,
    send_email,
)

pytestmark = [pytest.mark.gmail, pytest.mark.slow]


# Deliberately unique subject so the test doesn't collide with any real
# mBank correspondence in the mailbox. Contains Slovak diacritics to
# exercise UTF-8 handling through Gmail → watcher → classifier → Paperless.
TEST_SUBJECT = "mBank – výpis testovací 03/2026"


class TestEncryptedPdfGuidance:
    """Task 57: encrypted PDF pauses the worker, user patches, worker resumes."""

    def test_encrypted_pdf_pauses_then_resumes_via_patch(
        self, reset_pipeline, clean_paperless
    ):
        """Real password-protected mBank PDF triggers the guidance protocol
        and resumes to a completed Paperless upload after a `patch`.

        The fixture `account_statement_locked.pdf` is a real encrypted
        mBank statement committed to `tests/test_data/`. We rely on
        `tryDecrypt` failing (no password matches) so the worker
        reliably parks the job in `awaiting_user_guidance`. If
        `PDF_PASSWORDS`/`BANK_STATEMENT_PASSWORD` env vars in the
        running container happen to include this fixture's password,
        the worker will bypass the guidance branch and the test will
        fail at the `poll_job_state(... awaiting_user_guidance)` step
        — that's the correct signal to scrub the test-data password
        from the env before running.
        """
        # 1. Send the encrypted PDF as a Gmail attachment
        attachment = TEST_DATA_DIR / "account_statement_locked.pdf"
        assert attachment.exists(), f"Test fixture not found: {attachment}"

        send_email(
            to=GMAIL_TO,
            subject=TEST_SUBJECT,
            body="Test encrypted PDF for task 57 guidance E2E.",
            attachment_path=attachment,
        )

        # 2. Wait for the worker to discover the PDF is encrypted and
        #    park the job in awaiting_user_guidance. Gmail delivery +
        #    watcher poll (30s) + classify + download can take up to
        #    ~3 minutes in local dev.
        paused = poll_job_state(
            "gmail:",
            state="awaiting_user_guidance",
            timeout=240,
        )
        job_id = paused["id"]
        assert paused["state"] == "awaiting_user_guidance"

        # 3. The worker must have written a `guidance_request` event
        #    with `reason: "encrypted_pdf"` — that's how the Telegram
        #    side-effect and the metrics tap know why we're paused.
        events = get_job_events(job_id)
        request_events = [e for e in events if e["event_type"] == "guidance_request"]
        assert request_events, (
            f"No guidance_request event found for job {job_id}. "
            f"Events: {[e['event_type'] for e in events]}"
        )
        payload = json.loads(request_events[-1]["payload_json"])
        assert payload["reason"] == "encrypted_pdf", (
            f"Expected reason=encrypted_pdf, got {payload.get('reason')}"
        )

        # 4. Inject user guidance simulating a Telegram `/personal` +
        #    free-form "period 03/2026 account_statement" reply.
        #    `action: patch` tells the worker to re-run with the
        #    classifier outputs overlaid by our patch.
        call_provide_guidance(
            job_id,
            {
                "action": "patch",
                "patch": {
                    "owner": "personal",
                    "doc_type": "account_statement",
                    "month_tag": "2026-03",
                },
                "user_note": "task 57 E2E — patching locked mBank statement",
            },
        )

        # 5. Wait for the job to reach a terminal state. The worker
        #    re-runs from the top of executeInvoiceIntake, merges the
        #    patch, and uploads to Paperless.
        completed = poll_job_completion("gmail:", timeout=240)
        assert completed.id == job_id, (
            f"Terminal job id {completed.id} != paused job id {job_id}; "
            f"a different job raced into the queue."
        )
        assert completed.state == "completed", (
            f"Expected completed, got {completed.state}. "
            f"Output: {completed.output}"
        )
        assert completed.output is not None
        assert completed.output.get("outcome") == "uploaded", (
            f"Expected outcome=uploaded, got {completed.output.get('outcome')}. "
            f"Full output: {completed.output}"
        )

        # 6. Verify Paperless metadata reflects the patch (personal
        #    owner, no techlab tag, personal storage path).
        doc = paperless_find_by_title_full(TEST_SUBJECT)
        assert doc is not None, (
            f"Uploaded document with subject '{TEST_SUBJECT}' not found in Paperless. "
            f"Job output: {completed.output}"
        )
        assert "personal" in doc["tag_names"], (
            f"Missing 'personal' tag on {doc['id']}; tags={doc['tag_names']}"
        )
        assert "techlab" not in doc["tag_names"], (
            f"Unexpected 'techlab' tag on {doc['id']}; tags={doc['tag_names']}"
        )
        assert doc["storage_path_name"] == "Personal Documents", (
            f"Expected storage_path_name='Personal Documents', "
            f"got {doc['storage_path_name']}"
        )

        # 7. Final audit: the guidance_applied event must reference the
        #    same job and not leak password material (we didn't send a
        #    password in this scenario, but the assertion guards the
        #    invariant).
        post_events = get_job_events(job_id)
        applied = [e for e in post_events if e["event_type"] == "guidance_applied"]
        assert applied, "No guidance_applied event was recorded after resume"
        applied_payload = json.loads(applied[-1]["payload_json"])
        assert applied_payload["action"] == "patch"
        assert applied_payload.get("decrypt_password_provided") is False, (
            "guidance_applied incorrectly flagged a password as provided"
        )
        # The sensitive `guidance_password` event must NOT exist for this
        # patch-only resume.
        assert not any(
            e["event_type"] == "guidance_password" for e in post_events
        ), "guidance_password event leaked for a password-less patch"
