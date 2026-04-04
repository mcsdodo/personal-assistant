"""E2E smoke test: Outlook email pipeline.

Sends a real email via Gmail API to the configured test address (OUTLOOK_TO),
waits for the pipeline to process it, and verifies Paperless.

Run:
    cd compose.stacks/infra/personal-assistant
    python -m pytest tests/test_email_outlook.py -v -x --timeout=300
"""

from __future__ import annotations

import pytest

from .helpers import (
    OUTLOOK_TO,
    poll_job_completion,
    send_test_pdf,
    paperless_find_by_title,
)

pytestmark = [pytest.mark.outlook, pytest.mark.slow]


class TestOutlookAttachments:
    """Smoke test: Outlook attachment pipeline."""

    def test_invoice(self, reset_pipeline, clean_paperless):
        """Alza invoice via Outlook: watcher creates job, worker classifies + uploads."""
        send_test_pdf("invoice.pdf", OUTLOOK_TO)

        result = poll_job_completion("outlook:", timeout=240)
        assert result.state == "completed"
        assert result.output is not None

        outcome = result.output.get("outcome")
        if outcome == "uploaded":
            assert "5418090558" in result.output.get("title", "")
            assert result.output.get("correspondent") == "Alza.sk s.r.o."
            doc = paperless_find_by_title("5418090558")
            assert doc is not None
            assert doc["correspondent"] == "Alza.sk s.r.o."
            assert any(t[:4].isdigit() and "-" in t for t in doc["tags"]), (
                f"No YYYY-MM tag found in {doc['tags']}"
            )
        else:
            assert outcome in ("duplicate", "ignored"), f"Unexpected outcome: {outcome}"
