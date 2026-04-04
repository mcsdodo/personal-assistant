"""E2E test: invoice download link email.

Sends an Alza-style HTML email with a "Stiahnuť fakturu" link pointing to
a local nginx container serving a test PDF, then verifies the pipeline
downloads and uploads it.

The nginx container runs on the compose network so the invoice-worker
(inside claude-code) can reach it by container name.

Run:
    cd compose.stacks/infra/personal-assistant
    python -m pytest tests/test_email_link.py -v -x --timeout=420
"""

from __future__ import annotations

import subprocess
import time
from pathlib import Path

import pytest
import requests

from .helpers import (
    GMAIL_TO,
    OUTLOOK_TO,
    poll_job_completion,
    send_html_email,
    paperless_find_by_title,
)

pytestmark = [pytest.mark.link, pytest.mark.slow]

PDF_SERVER_CONTAINER = "test-pdf-server"
PDF_SERVER_PORT = 80
COMPOSE_NETWORK = "personal-assistant_default"
TEST_PDF = Path(__file__).parent / "test_data" / "invoice.pdf"

# Use unique order IDs to avoid duplicate detection
LINK_ORDER_ID = "999000111"
GMAIL_LINK_ORDER_ID = "999000222"


def _make_html(order_id: str, pdf_url: str) -> str:
    return f"""\
<html>
<body style="font-family: Arial, sans-serif;">
<table width="600" cellpadding="0" cellspacing="0" style="margin: auto; background: #fff;">
  <tr><td style="padding: 20px;">
    <h2>Pripravene v AlzaBoxe</h2>
    <p>Vasa objednavka <strong>c. {order_id}</strong> je pripravena.</p>
    <table width="100%" style="border-collapse: collapse;">
      <tr style="background: #f5f5f5;">
        <td style="padding: 8px; border: 1px solid #ddd;">Test Product</td>
        <td style="padding: 8px; border: 1px solid #ddd; text-align: right;">13,43 EUR</td>
      </tr>
    </table>
    <p style="margin-top: 20px;">
      <a href="{pdf_url}" style="padding: 12px 24px; background: #78b159; color: #fff; text-decoration: none;">Stiahnuť fakturu</a>
    </p>
  </td></tr>
  <tr><td style="padding: 15px; font-size: 11px; color: #999;">
    Alza.sk s.r.o., Karadzicova 8, 821 08 Bratislava
  </td></tr>
</table>
</body>
</html>
"""


def _make_text(order_id: str, pdf_url: str) -> str:
    return (
        f"Pripravene v AlzaBoxe\n"
        f"Objednavka c. {order_id}\n"
        f"Suma: 13,43 EUR\n"
        f"Stiahnuť fakturu: {pdf_url}\n"
    )


@pytest.fixture(scope="module")
def pdf_server():
    """Start nginx on the compose network serving test invoice.pdf. Cleanup after tests."""
    # Remove stale container if exists
    subprocess.run(
        ["docker", "rm", "-f", PDF_SERVER_CONTAINER],
        capture_output=True, timeout=15,
    )

    # Start nginx on the compose network
    subprocess.run(
        [
            "docker", "run", "-d",
            "--name", PDF_SERVER_CONTAINER,
            "--network", COMPOSE_NETWORK,
            "nginx:alpine",
        ],
        capture_output=True, timeout=30, check=True,
    )
    time.sleep(3)

    # Copy test PDF into nginx's html root
    subprocess.run(
        ["docker", "cp", str(TEST_PDF), f"{PDF_SERVER_CONTAINER}:/usr/share/nginx/html/invoice.pdf"],
        capture_output=True, timeout=15, check=True,
    )

    # Build the URL reachable from inside the compose network
    pdf_url = f"http://{PDF_SERVER_CONTAINER}:{PDF_SERVER_PORT}/invoice.pdf"

    # Verify from inside claude-code container
    for _ in range(5):
        result = subprocess.run(
            ["docker", "exec", "personal-assistant-claude", "sh", "-c",
             f"curl -sf -o /dev/null -w '%{{http_code}}' {pdf_url}"],
            capture_output=True, timeout=10,
        )
        if result.stdout.strip() == b"200":
            break
        time.sleep(2)
    else:
        subprocess.run(["docker", "rm", "-f", PDF_SERVER_CONTAINER], capture_output=True)
        pytest.skip(f"PDF server not reachable from claude-code at {pdf_url}")

    yield pdf_url

    # Cleanup
    subprocess.run(
        ["docker", "rm", "-f", PDF_SERVER_CONTAINER],
        capture_output=True, timeout=15,
    )


class TestDownloadLink:
    """Test invoice download via link in Outlook email body."""

    def test_alza_known_link(self, reset_pipeline, clean_paperless, pdf_server):
        """Alza-style email with link: extracted, downloaded, uploaded."""
        pdf_url = pdf_server
        send_html_email(
            to=OUTLOOK_TO,
            subject=f"Pripravene v AlzaBoxe / Obj. c. {LINK_ORDER_ID} - Alza.sk",
            html=_make_html(LINK_ORDER_ID, pdf_url),
            text=_make_text(LINK_ORDER_ID, pdf_url),
        )

        result = poll_job_completion("outlook:", timeout=240)
        assert result.state == "completed"
        assert result.output is not None
        assert result.output.get("outcome") in ("uploaded", "duplicate")

        if result.output["outcome"] == "uploaded":
            doc = paperless_find_by_title(LINK_ORDER_ID)
            assert doc is not None, f"Document {LINK_ORDER_ID} not found in Paperless"


class TestGmailDownloadLink:
    """Test invoice download via link in Gmail email body."""

    def test_gmail_alza_known_link(self, reset_pipeline, clean_paperless, pdf_server):
        """Gmail Alza email with link: HTML extracted, downloaded, uploaded."""
        pdf_url = pdf_server
        send_html_email(
            to=GMAIL_TO,
            subject=f"Pripravene v AlzaBoxe / Obj. c. {GMAIL_LINK_ORDER_ID} - Alza.sk",
            html=_make_html(GMAIL_LINK_ORDER_ID, pdf_url),
            text=_make_text(GMAIL_LINK_ORDER_ID, pdf_url),
        )

        result = poll_job_completion("gmail:", timeout=240)
        assert result.state == "completed"
        assert result.output is not None
        assert result.output.get("outcome") in ("uploaded", "duplicate")

        if result.output["outcome"] == "uploaded":
            doc = paperless_find_by_title(GMAIL_LINK_ORDER_ID)
            assert doc is not None, f"Document {GMAIL_LINK_ORDER_ID} not found in Paperless"
