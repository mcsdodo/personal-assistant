"""E2E smoke test: Outlook email pipeline.

Sends a real email via Gmail API to lacny.jozef+dev@hotmail.com,
waits for the Outlook pipeline to process it, and verifies Paperless.

Run:
    cd compose.stacks/infra/personal-assistant
    python -m pytest tests/test_email_outlook.py -v -x --timeout=300
"""

from __future__ import annotations

import pytest

from .helpers import (
    OUTLOOK_TO,
    poll_email_status,
    send_test_pdf,
    paperless_find_by_title,
)

pytestmark = [pytest.mark.outlook, pytest.mark.slow]


class TestOutlookAttachments:
    """Smoke test: Outlook attachment pipeline."""

    def test_invoice(self, reset_pipeline, clean_paperless):
        """Alza invoice via Outlook: downloaded, classified, uploaded."""
        send_test_pdf("invoice.pdf", OUTLOOK_TO)

        result = poll_email_status(
            "5418090558", {"processed", "ignored"}, source="outlook", timeout=240
        )
        if result.status == "processed":
            assert "5418090558" in (result.process_result or "")
            doc = paperless_find_by_title("5418090558")
            assert doc is not None
            assert doc["correspondent"] == "Alza.sk s.r.o."
            assert "invoicing" in doc["tags"]
        else:
            assert "duplicate" in (result.process_result or "").lower()
