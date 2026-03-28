"""E2E tests: Outlook email pipeline.

Sends real emails via Gmail API to lacny.jozef+dev@hotmail.com,
waits for the Outlook pipeline to process them, and verifies Paperless.

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
    send_email,
    paperless_find_by_title,
    paperless_documents,
)

pytestmark = [pytest.mark.outlook, pytest.mark.slow]


class TestOutlookAttachments:
    """Test emails with PDF attachments via Outlook."""

    def test_invoice(self, reset_pipeline_outlook_only, clean_paperless):
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

    def test_fuel_receipt(self, reset_pipeline_outlook_only, clean_paperless):
        """Slovnaft fuel receipt via Outlook: fuel tag applied."""
        send_test_pdf("fuel_invoice.pdf", OUTLOOK_TO)

        result = poll_email_status(
            "Slovnaft", {"processed"}, source="outlook", timeout=240
        )
        doc = paperless_find_by_title("1475807")
        assert doc is not None
        assert "fuel" in doc["tags"]

    def test_credit_note(self, reset_pipeline_outlook_only, clean_paperless):
        """Alza credit note via Outlook."""
        send_test_pdf("refund.pdf", OUTLOOK_TO)

        result = poll_email_status(
            "6401551319", {"processed"}, source="outlook", timeout=240
        )
        doc = paperless_find_by_title("6401551319")
        assert doc is not None
        assert doc["correspondent"] == "Alza.sk s.r.o."

    def test_bank_statement_encrypted(self, reset_pipeline_outlook_only, clean_paperless):
        """Encrypted bank statement via Outlook: decrypted and uploaded."""
        send_test_pdf("account_statement_locked.pdf", OUTLOOK_TO)

        result = poll_email_status(
            "Tatra", {"processed"}, source="outlook", timeout=240
        )
        doc = paperless_find_by_title("Tatra")
        assert doc is not None
        assert "invoicing" in doc["tags"]

    def test_non_invoice_ignored(self, reset_pipeline_outlook_only):
        """Non-invoice via Outlook: ignored."""
        send_email(
            to=OUTLOOK_TO,
            subject="Ahoj, ako sa mas? (outlook-test)",
            body="Davno sme sa nevideli. Ozvi sa!",
        )

        result = poll_email_status(
            "outlook-test", {"ignored"}, source="outlook", timeout=180
        )
        assert result.status == "ignored"
