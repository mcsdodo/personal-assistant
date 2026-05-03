"""E2E smoke test: Gmail email pipeline.

Sends a real email via Gmail API to the configured test address (GMAIL_TO),
waits for the pipeline (email-watcher -> worker -> classifier -> Paperless),
and verifies the document in Paperless.

Run:
    cd compose.stacks/infra/personal-assistant
    python -m pytest tests/test_email_gmail.py -v -x --timeout=300
"""

from __future__ import annotations

import re

import pytest

from .helpers import (
    GMAIL_TO,
    get_custom_field_lookup,
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

        # 240s is tight when this test runs after another Gmail test in the
        # same suite — Gmail delivery + watcher poll can stretch past 4 min.
        # 480s leaves headroom for the suite without slowing isolated runs.
        result = poll_job_completion("gmail:", timeout=480)
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

    def test_fuel(self, reset_pipeline, clean_paperless):
        """Slovnaft fuel receipt: lands in Paperless with litres + receipt_datetime stamped."""
        send_test_pdf("fuel_invoice.pdf", GMAIL_TO)

        result = poll_job_completion("gmail:", timeout=480)
        assert result.state == "completed"
        assert result.output is not None

        outcome = result.output.get("outcome")
        if outcome != "uploaded":
            # Allow duplicate/ignored when re-running against unwiped Paperless
            assert outcome in ("duplicate", "ignored"), f"Unexpected outcome: {outcome}"
            return

        # Verify Paperless state for fuel custom fields
        doc = paperless_find_by_title("Blok tankovanie Slovnaft")
        assert doc is not None, "Fuel doc not found in Paperless"

        # custom_fields is {field_id: value} as returned by paperless_documents()
        # Resolve numeric field IDs → human-readable names via the API
        field_lookup = get_custom_field_lookup()
        custom_fields_by_name = {
            field_lookup[field_id]: value
            for field_id, value in doc["custom_fields"].items()
            if field_id in field_lookup
        }

        # Task 63: verify the new fuel-only custom fields
        assert "litres" in custom_fields_by_name, (
            f"litres not set on doc {doc['id']}; got {custom_fields_by_name}"
        )
        assert custom_fields_by_name["litres"] > 0, "litres should be a positive number"
        assert "receipt_datetime" in custom_fields_by_name, (
            f"receipt_datetime not set on doc {doc['id']}; got {custom_fields_by_name}"
        )
        assert re.match(
            r"^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?$",
            str(custom_fields_by_name["receipt_datetime"]),
        ), f"unexpected receipt_datetime format: {custom_fields_by_name['receipt_datetime']!r}"
