"""E2E test: invoice download link email.

Sends an Alza-style HTML email with a "Stiahnuť faktúru" link pointing to
a test PDF server, then verifies the pipeline downloads and uploads it.

Prerequisites:
  - Test PDF server running: ssh root@192.168.0.96 'docker run -d --name test-pdf-server -p 8888:80 nginx:alpine'
  - Copy test PDF: docker cp _tmp/test-data/invoice.pdf test-pdf-server:/usr/share/nginx/html/
  - Or use the setup_pdf_server fixture (does it automatically via SSH)

Run:
    cd compose.stacks/infra/personal-assistant
    python -m pytest tests/test_email_link.py -v -x --timeout=300
"""

from __future__ import annotations

import socket
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


def _host_reachable(host: str, port: int = 22, timeout: float = 3) -> bool:
    try:
        s = socket.create_connection((host, port), timeout)
        s.close()
        return True
    except (OSError, TimeoutError):
        return False


pytestmark = [
    pytest.mark.link,
    pytest.mark.slow,
    pytest.mark.skipif(
        not _host_reachable("192.168.0.96"),
        reason="host1 not reachable for PDF server",
    ),
]

PDF_SERVER_HOST = "192.168.0.96"
PDF_SERVER_PORT = 8888
PDF_URL = f"http://{PDF_SERVER_HOST}:{PDF_SERVER_PORT}/invoice.pdf"
TEST_PDF = Path(__file__).parent / "test_data" / "invoice.pdf"

# Use unique order IDs to avoid duplicate detection
LINK_ORDER_ID = "999000111"
GMAIL_LINK_ORDER_ID = "999000222"

ALZA_HTML = f"""\
<html>
<body style="font-family: Arial, sans-serif;">
<table width="600" cellpadding="0" cellspacing="0" style="margin: auto; background: #fff;">
  <tr><td style="padding: 20px;">
    <h2>Pripravene v AlzaBoxe</h2>
    <p>Vasa objednavka <strong>c. {LINK_ORDER_ID}</strong> je pripravena.</p>
    <table width="100%" style="border-collapse: collapse;">
      <tr style="background: #f5f5f5;">
        <td style="padding: 8px; border: 1px solid #ddd;">Test Product</td>
        <td style="padding: 8px; border: 1px solid #ddd; text-align: right;">13,43 EUR</td>
      </tr>
    </table>
    <p style="margin-top: 20px;">
      <a href="{PDF_URL}" style="padding: 12px 24px; background: #78b159; color: #fff; text-decoration: none;">Stiahnuť fakturu</a>
    </p>
  </td></tr>
  <tr><td style="padding: 15px; font-size: 11px; color: #999;">
    Alza.sk s.r.o., Karadzicova 8, 821 08 Bratislava
  </td></tr>
</table>
</body>
</html>
"""

ALZA_TEXT = (
    f"Pripravene v AlzaBoxe\n"
    f"Objednavka c. {LINK_ORDER_ID}\n"
    f"Suma: 13,43 EUR\n"
    f"Stiahnuť fakturu: {PDF_URL}\n"
)


@pytest.fixture(scope="module")
def pdf_server():
    """Start nginx on host1 serving test invoice.pdf. Cleanup after tests."""
    # Start server
    subprocess.run(
        ["ssh", f"root@{PDF_SERVER_HOST}",
         "docker rm -f test-pdf-server 2>/dev/null; "
         "docker run -d --name test-pdf-server -p 8888:80 nginx:alpine"],
        capture_output=True, timeout=60,
    )
    time.sleep(5)

    # Copy test PDF into nginx
    import tarfile, io
    tar_buf = io.BytesIO()
    with tarfile.open(fileobj=tar_buf, mode="w") as tar:
        tar.add(str(TEST_PDF), arcname="invoice.pdf")
    tar_buf.seek(0)

    subprocess.run(
        ["ssh", f"root@{PDF_SERVER_HOST}",
         "docker cp - test-pdf-server:/usr/share/nginx/html/"],
        input=tar_buf.read(), capture_output=True, timeout=30,
    )

    # Verify
    for _ in range(5):
        try:
            r = requests.get(PDF_URL, timeout=5)
            if r.status_code == 200 and len(r.content) > 1000:
                break
        except requests.ConnectionError:
            time.sleep(2)
    else:
        pytest.skip(f"PDF server not reachable at {PDF_URL}")

    yield PDF_URL

    # Cleanup
    subprocess.run(
        ["ssh", f"root@{PDF_SERVER_HOST}", "docker rm -f test-pdf-server"],
        capture_output=True, timeout=30,
    )


class TestDownloadLink:
    """Test invoice download via link in email body."""

    def test_alza_known_link(self, reset_pipeline, clean_paperless, pdf_server):
        """Alza-style email with link: extracted, downloaded, uploaded."""
        send_html_email(
            to=OUTLOOK_TO,
            subject=f"Pripravene v AlzaBoxe / Obj. c. {LINK_ORDER_ID} - Alza.sk",
            html=ALZA_HTML,
            text=ALZA_TEXT,
        )

        result = poll_job_completion("outlook:", timeout=240)
        assert result.state == "completed"
        assert result.output is not None
        assert result.output.get("outcome") in ("uploaded", "duplicate")

        if result.output["outcome"] == "uploaded":
            doc = paperless_find_by_title(LINK_ORDER_ID)
            assert doc is not None, f"Document {LINK_ORDER_ID} not found in Paperless"


GMAIL_LINK_HTML = f"""\
<html>
<body style="font-family: Arial, sans-serif;">
<table width="600" cellpadding="0" cellspacing="0" style="margin: auto; background: #fff;">
  <tr><td style="padding: 20px;">
    <h2>Pripravene v AlzaBoxe</h2>
    <p>Vasa objednavka <strong>c. {GMAIL_LINK_ORDER_ID}</strong> je pripravena.</p>
    <table width="100%" style="border-collapse: collapse;">
      <tr style="background: #f5f5f5;">
        <td style="padding: 8px; border: 1px solid #ddd;">Test Product Gmail</td>
        <td style="padding: 8px; border: 1px solid #ddd; text-align: right;">19,99 EUR</td>
      </tr>
    </table>
    <p style="margin-top: 20px;">
      <a href="{PDF_URL}" style="padding: 12px 24px; background: #78b159; color: #fff; text-decoration: none;">Stiahnuť&nbsp;fakturu</a>
    </p>
  </td></tr>
  <tr><td style="padding: 15px; font-size: 11px; color: #999;">
    Alza.sk s.r.o., Karadzicova 8, 821 08 Bratislava
  </td></tr>
</table>
</body>
</html>
"""

GMAIL_LINK_TEXT = (
    f"Pripravene v AlzaBoxe\n"
    f"Objednavka c. {GMAIL_LINK_ORDER_ID}\n"
    f"Suma: 19,99 EUR\n"
    f"Stiahnuť fakturu: {PDF_URL}\n"
)


class TestGmailDownloadLink:
    """Test invoice download via link in Gmail email body."""

    def test_gmail_alza_known_link(self, reset_pipeline, clean_paperless, pdf_server):
        """Gmail Alza email with link: HTML extracted, downloaded, uploaded."""
        send_html_email(
            to=GMAIL_TO,
            subject=f"Pripravene v AlzaBoxe / Obj. c. {GMAIL_LINK_ORDER_ID} - Alza.sk",
            html=GMAIL_LINK_HTML,
            text=GMAIL_LINK_TEXT,
        )

        result = poll_job_completion("gmail:", timeout=240)
        assert result.state == "completed"
        assert result.output is not None
        assert result.output.get("outcome") in ("uploaded", "duplicate")

        if result.output["outcome"] == "uploaded":
            doc = paperless_find_by_title(GMAIL_LINK_ORDER_ID)
            assert doc is not None, f"Document {GMAIL_LINK_ORDER_ID} not found in Paperless"
