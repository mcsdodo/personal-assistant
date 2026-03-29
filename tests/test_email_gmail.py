"""E2E tests: Gmail email pipeline.

Sends real emails via Gmail API to lacny.jozef+dev@gmail.com,
waits for the pipeline (email-watcher → email-classifier → document-classifier → worker),
and verifies documents in Paperless.

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
    send_email,
    paperless_find_by_title,
    paperless_documents,
)

pytestmark = [pytest.mark.gmail, pytest.mark.slow]


class TestGmailAttachments:
    """Test emails with PDF attachments via Gmail."""

    def test_invoice(self, reset_pipeline_gmail_only, clean_paperless):
        """Alza invoice: classified, downloaded, uploaded to Paperless."""
        send_test_pdf("invoice.pdf", GMAIL_TO)

        result = poll_email_status(
            "5418090558", {"processed", "ignored"}, source="gmail", timeout=240
        )
        # Could be ignored if duplicate from earlier run; check processed path
        if result.status == "processed":
            assert "5418090558" in (result.process_result or "")
            doc = paperless_find_by_title("5418090558")
            assert doc is not None, "Document not found in Paperless"
            assert doc["correspondent"] == "Alza.sk s.r.o."
            assert "invoicing" in doc["tags"]
            assert "techlab" in doc["tags"]
        else:
            # Duplicate detection — still valid
            assert "duplicate" in (result.process_result or "").lower() or \
                   "already" in (result.process_result or "").lower()

    def test_fuel_receipt(self, reset_pipeline_gmail_only, clean_paperless):
        """Slovnaft fuel receipt: fuel tag applied, correct amount."""
        send_test_pdf("fuel_invoice.pdf", GMAIL_TO)

        result = poll_email_status(
            "Slovnaft", {"processed"}, source="gmail", timeout=240
        )
        assert "57.49" in (result.process_result or "") or "SLOVNAFT" in (result.process_result or "")

        doc = paperless_find_by_title("1475807")
        assert doc is not None, "Fuel receipt not found in Paperless"
        assert "fuel" in doc["tags"], f"Missing 'fuel' tag, got: {doc['tags']}"
        assert "invoicing" in doc["tags"]

    def test_credit_note(self, reset_pipeline_gmail_only, clean_paperless):
        """Alza credit note: negative amount, correct order_id."""
        send_test_pdf("refund.pdf", GMAIL_TO)

        result = poll_email_status(
            "6401551319", {"processed"}, source="gmail", timeout=240
        )
        assert "6401551319" in (result.process_result or "")

        doc = paperless_find_by_title("6401551319")
        assert doc is not None, "Credit note not found in Paperless"
        assert doc["correspondent"] == "Alza.sk s.r.o."
        # Check negative amount in custom fields
        amounts = [v for v in doc["custom_fields"].values() if isinstance(v, (int, float, str)) and "-" in str(v)]
        assert len(amounts) > 0, f"Expected negative amount, got: {doc['custom_fields']}"

    def test_bank_statement_encrypted(self, reset_pipeline_gmail_only, clean_paperless):
        """Encrypted bank statement: decrypted with qpdf, uploaded."""
        send_test_pdf("account_statement_locked.pdf", GMAIL_TO)

        result = poll_email_status(
            "Tatra", {"processed"}, source="gmail", timeout=240
        )
        assert "Tatra" in (result.process_result or "") or "tatra" in (result.process_result or "").lower()

        doc = paperless_find_by_title("Tatra")
        assert doc is not None, "Bank statement not found in Paperless"
        assert "invoicing" in doc["tags"]

    def test_personal_invoice(self, reset_pipeline_gmail_only, clean_paperless):
        """Personal Alza invoice: gets personal tag, no techlab or invoicing."""
        send_test_pdf("personal.pdf", GMAIL_TO)

        result = poll_email_status(
            "5419358935", {"processed", "ignored"}, source="gmail", timeout=240
        )
        if result.status == "processed":
            doc = paperless_find_by_title("5419358935")
            assert doc is not None, "Personal invoice not found in Paperless"
            assert "personal" in doc["tags"], f"Missing 'personal' tag, got: {doc['tags']}"
            assert "techlab" not in doc["tags"], f"Should not have 'techlab' tag, got: {doc['tags']}"
            assert "invoicing" not in doc["tags"], f"Should not have 'invoicing' tag, got: {doc['tags']}"
        else:
            assert "duplicate" in (result.process_result or "").lower() or \
                   "already" in (result.process_result or "").lower()

    def test_non_invoice_ignored(self, reset_pipeline_gmail_only):
        """Non-invoice email: classified as ignore, no Paperless upload."""
        send_email(
            to=GMAIL_TO,
            subject="Ahoj, ako sa mas? (gmail-test)",
            body="Davno sme sa nevideli. Ozvi sa!",
        )

        result = poll_email_status(
            "gmail-test", {"ignored"}, source="gmail", timeout=180
        )
        assert result.status == "ignored"

        # Verify no document was created for this
        docs = paperless_documents()
        for d in docs:
            assert "gmail-test" not in (d["title"] or ""), "Non-invoice should not be in Paperless"
