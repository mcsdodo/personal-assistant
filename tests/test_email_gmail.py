"""E2E smoke test: Gmail email pipeline.

Sends a real email via Gmail API to the configured test address (GMAIL_TO),
waits for the pipeline (email-watcher -> email-classifier -> document-classifier -> worker),
and verifies the document in Paperless.

Run:
    cd compose.stacks/infra/personal-assistant
    python -m pytest tests/test_email_gmail.py -v -x --timeout=300
"""

from __future__ import annotations

import pytest

from .helpers import (
    GMAIL_TO,
    poll_email_status,
    send_test_pdf,
    paperless_find_by_title,
)

pytestmark = [pytest.mark.gmail, pytest.mark.slow]


class TestGmailAttachments:
    """Smoke test: Gmail attachment pipeline."""

    def test_invoice(self, reset_pipeline, clean_paperless):
        """Alza invoice: classified, downloaded, uploaded to Paperless."""
        send_test_pdf("invoice.pdf", GMAIL_TO)

        result = poll_email_status(
            "5418090558", {"processed", "ignored"}, source="gmail", timeout=240
        )
        if result.status == "processed":
            assert "5418090558" in (result.process_result or "")
            doc = paperless_find_by_title("5418090558")
            assert doc is not None, "Document not found in Paperless"
            assert doc["correspondent"] == "Alza.sk s.r.o."
            assert "invoicing" in doc["tags"]
            assert "techlab" in doc["tags"]
        else:
            assert (
                "duplicate" in (result.process_result or "").lower()
                or "already" in (result.process_result or "").lower()
            )
