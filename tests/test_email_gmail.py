"""E2E smoke test: Gmail email pipeline.

Sends a real email via Gmail API to the configured test address (GMAIL_TO),
waits for the pipeline (email-watcher -> worker -> classifier -> Paperless),
and verifies the document in Paperless.

Run:
    cd compose.stacks/infra/personal-assistant
    python -m pytest tests/test_email_gmail.py -v -x --timeout=300
"""

from __future__ import annotations

import pytest

from .helpers import (
    GMAIL_TO,
    poll_job_completion,
    send_test_pdf,
    paperless_find_by_title,
)

pytestmark = [pytest.mark.gmail, pytest.mark.slow]


class TestGmailAttachments:
    """Smoke test: Gmail attachment pipeline."""

    def test_invoice(self, reset_pipeline, clean_paperless):
        """Alza invoice: watcher creates job, worker classifies + uploads to Paperless."""
        send_test_pdf("invoice.pdf", GMAIL_TO)

        result = poll_job_completion("gmail:", timeout=240)
        assert result.state == "completed"
        assert result.output is not None

        outcome = result.output.get("outcome")
        if outcome == "uploaded":
            assert "5418090558" in result.output.get("title", "")
            assert result.output.get("correspondent") == "Alza.sk s.r.o."
            doc = paperless_find_by_title("5418090558")
            assert doc is not None, "Document not found in Paperless"
            assert doc["correspondent"] == "Alza.sk s.r.o."
            # Tags depend on BUSINESS_* env vars — just verify YYYY-MM is present
            assert any(t[:4].isdigit() and "-" in t for t in doc["tags"]), (
                f"No YYYY-MM tag found in {doc['tags']}"
            )
        else:
            assert outcome in ("duplicate", "ignored"), f"Unexpected outcome: {outcome}"
