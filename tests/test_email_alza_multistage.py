"""E2E test: multi-stage Alza vendor emails (task 59 Phase 1).

Run:
    cd compose.stacks/infra/personal-assistant
    python -m pytest tests/test_email_alza_multistage.py -v -x --timeout=900
"""

from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path

import pytest

from .helpers import (
    JobResult,
    OUTLOOK_TO,
    clear_dbs,
    paperless_documents,
    paperless_wipe,
    poll_job_completion,
    preseed_source_state,
    send_html_email,
    start_claude,
    stop_claude,
    workflow_db_query,
)

pytestmark = [pytest.mark.outlook, pytest.mark.link, pytest.mark.slow]

CLAUDE_CONTAINER = "personal-assistant-claude"
PDF_SERVER_CONTAINER = "test-pdf-server-multistage"
COMPOSE_NETWORK = "personal-assistant_default"
TEST_PDF = Path(__file__).parent / "test_data" / "invoice.pdf"
ORDER_ID = "999000444"
POLL_INTERVAL_S = 10


def _make_html(stage: str, order_id: str, pdf_url: str) -> str:
    return f"""\
<html><body>
<h2>{stage}</h2>
<p>Objednavka <strong>c. {order_id}</strong>.</p>
<table><tr><td>Test Product</td><td>13,43 EUR</td></tr></table>
<p><a href="{pdf_url}">Stiahnuť faktúru</a></p>
<p>Alza.sk s.r.o., Karadzicova 8, 821 08 Bratislava</p>
</body></html>
"""


def _make_text(stage: str, order_id: str, pdf_url: str) -> str:
    return f"{stage}\nObjednavka c. {order_id}\nSuma: 13,43 EUR\nStiahnuť faktúru: {pdf_url}\n"


# -- Fixtures ----------------------------------------------------------------

@pytest.fixture(scope="module")
def reset_pipeline():
    stop_claude()
    clear_dbs()
    paperless_wipe()
    preseed_source_state("gmail", "outlook")
    start_claude()
    deadline = time.time() + 600
    while time.time() < deadline:
        try:
            res = subprocess.run(
                ["docker", "inspect", "-f", "{{.State.Health.Status}}", CLAUDE_CONTAINER],
                capture_output=True, timeout=5, check=False,
            )
            if res.stdout.decode().strip() == "healthy":
                time.sleep(5)
                break
        except Exception:
            pass
        time.sleep(10)
    else:
        raise TimeoutError("Container did not report healthy within 600s")
    yield


@pytest.fixture(scope="module")
def pdf_server():
    subprocess.run(["docker", "rm", "-f", PDF_SERVER_CONTAINER], capture_output=True, timeout=15)
    subprocess.run(
        ["docker", "run", "-d", "--name", PDF_SERVER_CONTAINER, "--network", COMPOSE_NETWORK, "nginx:alpine"],
        capture_output=True, timeout=30, check=True,
    )
    time.sleep(3)
    subprocess.run(
        ["docker", "cp", str(TEST_PDF), f"{PDF_SERVER_CONTAINER}:/usr/share/nginx/html/invoice.pdf"],
        capture_output=True, timeout=15, check=True,
    )
    pdf_url = f"http://{PDF_SERVER_CONTAINER}:80/invoice.pdf"
    for _ in range(5):
        r = subprocess.run(
            ["docker", "exec", CLAUDE_CONTAINER, "sh", "-c",
             f"curl -sf -o /dev/null -w '%{{http_code}}' {pdf_url}"],
            capture_output=True, timeout=10,
        )
        if r.stdout.strip() == b"200":
            break
        time.sleep(2)
    else:
        subprocess.run(["docker", "rm", "-f", PDF_SERVER_CONTAINER], capture_output=True)
        pytest.skip(f"PDF server not reachable at {pdf_url}")
    yield pdf_url
    subprocess.run(["docker", "rm", "-f", PDF_SERVER_CONTAINER], capture_output=True, timeout=15)


# -- Helpers ------------------------------------------------------------------

def _poll_next_job(source_prefix: str, exclude_id: str, timeout: int = 420) -> JobResult:
    terminal = {"completed", "failed", "cancelled"}
    deadline = time.time() + timeout
    while time.time() < deadline:
        rows = workflow_db_query(
            f"SELECT id,state,workflow_type,source_ref,output_json "
            f'FROM jobs WHERE source_ref LIKE \\"%{source_prefix}%\\" '
            f'AND id != \\"{exclude_id}\\" '
            f"ORDER BY created_at DESC LIMIT 1"
        )
        if rows and rows[0].get("state") in terminal:
            r = rows[0]
            output = json.loads(r["output_json"]) if r.get("output_json") else None
            return JobResult(id=r["id"], state=r["state"], workflow_type=r["workflow_type"],
                             source_ref=r.get("source_ref"), output=output)
        time.sleep(POLL_INTERVAL_S)
    raise TimeoutError(f"No new terminal job (excluding {exclude_id}) within {timeout}s")


# -- Test ---------------------------------------------------------------------

class TestAlzaMultiStage:

    def test_newer_email_refreshes_existing_doc(self, reset_pipeline, pdf_server):
        pdf_url = pdf_server

        # Stage A: early lifecycle
        send_html_email(
            to=OUTLOOK_TO,
            subject=f"Uz to chystame / Obj. c. {ORDER_ID} - Alza.sk",
            html=_make_html("Uz to chystame", ORDER_ID, pdf_url),
            text=_make_text("Uz to chystame", ORDER_ID, pdf_url),
        )
        result_a = poll_job_completion("outlook:", timeout=420)
        assert result_a.state == "completed", f"Stage A: {result_a}"
        assert result_a.output["outcome"] == "uploaded", f"Stage A outcome: {result_a.output}"
        doc_id = result_a.output["paperless_document_id"]
        assert doc_id is not None

        docs = paperless_documents()
        assert len(docs) == 1
        assert docs[0]["id"] == doc_id

        # Stage B: later lifecycle, same order
        time.sleep(5)
        send_html_email(
            to=OUTLOOK_TO,
            subject=f"Pripravene v AlzaBoxe / Obj. c. {ORDER_ID} - Alza.sk",
            html=_make_html("Pripravene v AlzaBoxe", ORDER_ID, pdf_url),
            text=_make_text("Pripravene v AlzaBoxe", ORDER_ID, pdf_url),
        )
        result_b = _poll_next_job("outlook:", exclude_id=result_a.id, timeout=420)
        assert result_b.state == "completed", f"Stage B: {result_b}"
        assert result_b.output["outcome"] == "refreshed", f"Stage B outcome: {result_b.output}"
        assert result_b.output["paperless_document_id"] == doc_id

        docs = paperless_documents()
        assert len(docs) == 1
        assert docs[0]["id"] == doc_id

        rows = workflow_db_query(
            f'SELECT id,paperless_doc_id FROM jobs WHERE source_ref LIKE \\"%outlook:%\\" '
            f"ORDER BY created_at DESC LIMIT 5"
        )
        assert sum(1 for r in rows if r.get("paperless_doc_id") == doc_id) >= 2
