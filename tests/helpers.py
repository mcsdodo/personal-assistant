"""Shared helpers for personal-assistant E2E pipeline tests.

Provides: Gmail sending, Paperless API, email-watcher DB polling, container management.
"""

from __future__ import annotations

import base64
import mimetypes
import os
import socket
import ssl
import subprocess
import time
from dataclasses import dataclass
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email import encoders
from email.utils import formatdate
from pathlib import Path
from typing import Callable, TypeVar

import requests

T = TypeVar("T")

_NETWORK_RETRY_EXCEPTIONS = (
    ConnectionAbortedError,
    ConnectionResetError,
    ConnectionRefusedError,
    ssl.SSLError,
    socket.timeout,
    TimeoutError,
)


def _retry_on_network_error(
    fn: Callable[[], T],
    *,
    max_attempts: int = 3,
    base_delay: float = 2.0,
) -> T:
    """Run `fn` and retry on transient network exceptions with exponential backoff.

    Used to wrap Gmail API calls because gmail.googleapis.com sometimes aborts
    TLS connections mid-request from this dev box (intermittent, observed
    during gate-32 pytest runs). The error is environmental, not a pipeline
    bug — bounded retry is enough to ride it out.

    Re-raises the last network exception after `max_attempts`.
    Non-network exceptions propagate immediately on the first occurrence.
    """
    last_exc: BaseException | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            return fn()
        except _NETWORK_RETRY_EXCEPTIONS as exc:
            last_exc = exc
            if attempt == max_attempts:
                break
            time.sleep(base_delay * (2 ** (attempt - 1)))
    assert last_exc is not None
    raise last_exc

# ---------------------------------------------------------------------------
# Paths & constants
# ---------------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parents[4]  # C:\_dev\home.notavailable
PA_STACK = REPO_ROOT / "compose.stacks" / "infra" / "personal-assistant"
PA_DATA = PA_STACK / "data"
TEST_DATA_DIR = Path(__file__).parent / "test_data"

# Load .env from the project root so tests pick up the same config as docker compose
_ENV_FILE = PA_STACK / ".env"
_dotenv: dict[str, str] = {}
if _ENV_FILE.exists():
    for line in _ENV_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        _dotenv[key.strip()] = value.strip()


def _env(key: str, default: str = "") -> str:
    """Read from shell env first, then .env file, then default."""
    return os.environ.get(key) or _dotenv.get(key) or default


CREDENTIALS_FILE = Path(
    os.environ.get("GOOGLE_CREDENTIALS_FILE", "config/credentials.json")
)
TOKEN_FILE = Path(os.environ.get("GOOGLE_TOKEN_FILE", "config/token.json"))
GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.send"]

# Drive scopes needed for E2E gdrive tests.
# NOTE: If the token.json was originally created with only gmail.send scope,
# it must be re-authorized to include drive scope (delete token.json and
# re-run the auth flow with GOOGLE_SCOPES including drive).  The helpers
# below will fail gracefully with an informative error if the scope is missing.
DRIVE_SCOPES = [
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/drive",
]

GMAIL_FROM = _env("GMAIL_EMAIL", "your-email@gmail.com")
GMAIL_TO = _env("GMAIL_TO", "your-email+dev@gmail.com")
OUTLOOK_TO = _env("OUTLOOK_TO", "your-email+dev@hotmail.com")

# PAPERLESS_URL from .env is container-to-container (http://paperless:8010).
# Tests run on the host, so always use localhost.
PAPERLESS_URL = os.environ.get("PAPERLESS_URL", "http://localhost:8010/api")
PAPERLESS_TOKEN = _env("PAPERLESS_TOKEN") or _env("PAPERLESS_API_TOKEN")
if not PAPERLESS_TOKEN:
    raise RuntimeError(
        f"PAPERLESS_TOKEN or PAPERLESS_API_TOKEN not found in env or {_ENV_FILE}"
    )

CONTAINER = "personal-assistant-claude"
COMPOSE_CMD = "docker compose --profile local --env-file .env"

# Business identity — used by document classifier to determine owner tag.
# Tests should assert against these rather than hardcoding "techlab"/"personal".
BUSINESS_COMPANY_NAME = _env("BUSINESS_COMPANY_NAME", "")
BUSINESS_CRN = _env("BUSINESS_CRN", "")

# Subject templates matching what the email-classifier expects
SUBJECT_MAP = {
    "invoice.pdf": "Faktúra 1000000001 - Alza.sk",
    "fuel_invoice.pdf": "Blok tankovanie Slovnaft",
    "refund.pdf": "Opravný doklad 1000000002 - Alza.sk",
    "account_statement_locked.pdf": "Výpis z účtu za 03/2026 - Tatra banka",
    "personal.pdf": "Faktúra 1000000003 - Alza.sk",
}


# ---------------------------------------------------------------------------
# Gmail sending
# ---------------------------------------------------------------------------

_gmail_service = None


def gmail_service():
    """Lazy-init Gmail API service (reuses across calls)."""
    global _gmail_service
    if _gmail_service is not None:
        return _gmail_service

    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build

    creds = Credentials.from_authorized_user_file(str(TOKEN_FILE), DRIVE_SCOPES)
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        TOKEN_FILE.write_text(creds.to_json())

    _gmail_service = build("gmail", "v1", credentials=creds)
    return _gmail_service


def send_email(
    to: str,
    subject: str,
    body: str = "Test invoice for pipeline.",
    attachment_path: Path | None = None,
) -> str:
    """Send an email via Gmail API. Returns message ID."""
    if attachment_path:
        msg = MIMEMultipart()
        msg.attach(MIMEText(body, "plain"))
        content_type, _ = mimetypes.guess_type(str(attachment_path))
        if content_type is None:
            content_type = "application/octet-stream"
        main_type, sub_type = content_type.split("/", 1)
        with open(attachment_path, "rb") as f:
            part = MIMEBase(main_type, sub_type)
            part.set_payload(f.read())
        encoders.encode_base64(part)
        part.add_header(
            "Content-Disposition", "attachment", filename=attachment_path.name
        )
        msg.attach(part)
    else:
        msg = MIMEText(body, "plain")

    msg["To"] = to
    msg["From"] = GMAIL_FROM
    msg["Subject"] = subject
    msg["Date"] = formatdate(localtime=True)

    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode("utf-8")
    result = _retry_on_network_error(
        lambda: gmail_service()
        .users()
        .messages()
        .send(userId="me", body={"raw": raw})
        .execute()
    )
    return result["id"]


def send_html_email(to: str, subject: str, html: str, text: str) -> str:
    """Send an HTML email via Gmail API. Returns message ID."""
    msg = MIMEMultipart("alternative")
    msg["To"] = to
    msg["From"] = GMAIL_FROM
    msg["Subject"] = subject
    msg["Date"] = formatdate(localtime=True)
    msg.attach(MIMEText(text, "plain", "utf-8"))
    msg.attach(MIMEText(html, "html", "utf-8"))

    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode("utf-8")
    result = _retry_on_network_error(
        lambda: gmail_service()
        .users()
        .messages()
        .send(userId="me", body={"raw": raw})
        .execute()
    )
    return result["id"]


def send_test_pdf(filename: str, to: str) -> str:
    """Send a test PDF from test-data/ with the standard subject."""
    path = TEST_DATA_DIR / filename
    assert path.exists(), f"Test file not found: {path}"
    subject = SUBJECT_MAP.get(filename, f"Test: {filename}")
    return send_email(to=to, subject=subject, attachment_path=path)


# ---------------------------------------------------------------------------
# Paperless API
# ---------------------------------------------------------------------------


def _paperless_headers() -> dict:
    return {"Authorization": f"Token {PAPERLESS_TOKEN}"}


def paperless_get(endpoint: str, **params) -> dict:
    """GET from Paperless API."""
    r = requests.get(
        f"{PAPERLESS_URL}/{endpoint}/",
        headers=_paperless_headers(),
        params=params,
        timeout=10,
    )
    r.raise_for_status()
    return r.json()


def paperless_documents() -> list[dict]:
    """Get all Paperless documents with resolved metadata."""
    docs = paperless_get("documents", page_size=100, ordering="-added")
    correspondents = {
        c["id"]: c["name"]
        for c in paperless_get("correspondents", page_size=100)["results"]
    }
    tags = {t["id"]: t["name"] for t in paperless_get("tags", page_size=100)["results"]}

    results = []
    for d in docs["results"]:
        results.append(
            {
                "id": d["id"],
                "title": d["title"],
                "correspondent": correspondents.get(d.get("correspondent")),
                "tags": sorted(tags.get(t, str(t)) for t in d.get("tags", [])),
                "original_file_name": d.get("original_file_name"),
                "custom_fields": {
                    cf["field"]: cf["value"] for cf in d.get("custom_fields", [])
                },
            }
        )
    return results


def paperless_find_by_title(substring: str) -> dict | None:
    """Find first Paperless document whose title contains substring."""
    for doc in paperless_documents():
        if substring in (doc["title"] or ""):
            return doc
    return None


def paperless_find_by_title_full(substring: str) -> dict | None:
    """Find first Paperless document whose title contains substring and
    return the raw document dict *plus* resolved `correspondent_name`,
    `tag_names`, `document_type_name`, and `storage_path_name` fields.

    `paperless_documents()` (above) filters to a minimal shape that drops
    storage-path info; task 57's E2E flow needs to assert on
    `storage_path_name`, so we keep that here as a separate helper rather
    than widening the existing minimal shape (which other tests rely on).
    """
    docs = paperless_get("documents", page_size=100, ordering="-added")
    correspondents = {
        c["id"]: c["name"]
        for c in paperless_get("correspondents", page_size=100)["results"]
    }
    tags = {t["id"]: t["name"] for t in paperless_get("tags", page_size=100)["results"]}
    doc_types = {
        dt["id"]: dt["name"]
        for dt in paperless_get("document_types", page_size=100)["results"]
    }
    storage_paths = {
        sp["id"]: sp["name"]
        for sp in paperless_get("storage_paths", page_size=100)["results"]
    }

    for d in docs["results"]:
        if substring in (d.get("title") or ""):
            return {
                **d,
                "correspondent_name": correspondents.get(d.get("correspondent")),
                "tag_names": sorted(tags.get(t, str(t)) for t in d.get("tags", [])),
                "document_type_name": doc_types.get(d.get("document_type")),
                "storage_path_name": storage_paths.get(d.get("storage_path")),
            }
    return None


def paperless_get_by_id(doc_id: int) -> dict | None:
    """Fetch a Paperless document by id and return the same enriched shape
    as `paperless_find_by_title_full` (raw fields + resolved
    correspondent_name / tag_names / document_type_name / storage_path_name).

    Use this when the test already knows the doc id from the worker output;
    it's stable against title-generation changes that would break a
    title-substring lookup.
    """
    r = requests.get(
        f"{PAPERLESS_URL}/documents/{doc_id}/",
        headers=_paperless_headers(),
        timeout=10,
    )
    if r.status_code == 404:
        return None
    r.raise_for_status()
    d = r.json()
    correspondents = {
        c["id"]: c["name"]
        for c in paperless_get("correspondents", page_size=100)["results"]
    }
    tags = {t["id"]: t["name"] for t in paperless_get("tags", page_size=100)["results"]}
    doc_types = {
        dt["id"]: dt["name"]
        for dt in paperless_get("document_types", page_size=100)["results"]
    }
    storage_paths = {
        sp["id"]: sp["name"]
        for sp in paperless_get("storage_paths", page_size=100)["results"]
    }
    return {
        **d,
        "correspondent_name": correspondents.get(d.get("correspondent")),
        "tag_names": sorted(tags.get(t, str(t)) for t in d.get("tags", [])),
        "document_type_name": doc_types.get(d.get("document_type")),
        "storage_path_name": storage_paths.get(d.get("storage_path")),
    }


# Storage paths the worker resolves at upload time (see
# claude-code/channels/invoice/postprocess-service.ts:43,48). Both must exist
# in Paperless or every E2E test that asserts on `storage_path_name` will see
# `None`. Fresh local Paperless deployments ship with zero storage paths, so
# the test setup must create them itself — `paperless_ensure_storage_paths`
# is idempotent (matches by name) and cheap enough to run on every wipe.
_REQUIRED_STORAGE_PATHS = (
    ("Personal Documents", "Personal/{created_year}"),
    ("Personal Invoices", "Personal/{correspondent}/{created_year}-{created_month}"),
    ("Techlab Documents", "Techlab/{created_year}"),
    ("Techlab Invoices", "Techlab/{correspondent}/{created_year}-{created_month}"),
)


def paperless_ensure_storage_paths():
    """Create the worker's expected storage paths if they don't already exist."""
    h = _paperless_headers()
    existing = requests.get(
        f"{PAPERLESS_URL}/storage_paths/",
        headers=h,
        params={"page_size": 500},
        timeout=10,
    ).json()
    by_name = {sp["name"]: sp for sp in existing.get("results", [])}
    for name, path in _REQUIRED_STORAGE_PATHS:
        if name in by_name:
            continue
        requests.post(
            f"{PAPERLESS_URL}/storage_paths/",
            headers={**h, "Content-Type": "application/json"},
            json={"name": name, "path": path, "matching_algorithm": 0},
            timeout=10,
        ).raise_for_status()


def paperless_wipe():
    """Delete all documents, correspondents, tags, and document types.

    Re-creates the worker's required storage paths on the way out so the next
    test starts from a known-good baseline.
    """
    h = _paperless_headers()
    # Delete documents
    docs = requests.get(
        f"{PAPERLESS_URL}/documents/",
        headers=h,
        params={"page_size": 500, "fields": "id"},
        timeout=10,
    ).json()
    doc_ids = [d["id"] for d in docs.get("results", [])]
    if doc_ids:
        requests.post(
            f"{PAPERLESS_URL}/documents/bulk_edit/",
            headers={**h, "Content-Type": "application/json"},
            json={"documents": doc_ids, "method": "delete"},
            timeout=30,
        )
        time.sleep(3)
        # Empty trash
        trash = requests.get(
            f"{PAPERLESS_URL}/trash/",
            headers=h,
            params={"page_size": 500},
            timeout=10,
        ).json()
        trash_ids = [d["id"] for d in trash.get("results", [])]
        if trash_ids:
            requests.post(
                f"{PAPERLESS_URL}/trash/",
                headers={**h, "Content-Type": "application/json"},
                json={"documents": trash_ids, "action": "empty"},
                timeout=30,
            )
            time.sleep(3)

    # Delete correspondents, tags, document types
    for resource in ("correspondents", "tags", "document_types"):
        items = requests.get(
            f"{PAPERLESS_URL}/{resource}/",
            headers=h,
            params={"page_size": 500},
            timeout=10,
        ).json()
        for item in items.get("results", []):
            requests.delete(
                f"{PAPERLESS_URL}/{resource}/{item['id']}/",
                headers=h,
                timeout=10,
            )

    # Always end a wipe with the storage paths in place so the next test's
    # setup phase doesn't have to remember to call this separately.
    paperless_ensure_storage_paths()


# ---------------------------------------------------------------------------
# Email-watcher DB polling (via docker exec)
# ---------------------------------------------------------------------------


def _bun_query(db_path: str, sql: str) -> str:
    """Run a SQL query via bun inside the container. Returns stdout."""
    script = (
        f'import{{Database}}from"bun:sqlite";'
        f'const db=new Database("{db_path}",{{readonly:true}});'
        f'const r=db.prepare("{sql}").all();'
        f"console.log(JSON.stringify(r));"
        f"db.close();"
    )
    result = subprocess.run(
        ["docker", "exec", CONTAINER, "sh", "-c", f"bun -e '{script}'"],
        capture_output=True,
        timeout=15,
    )
    return result.stdout.decode("utf-8", errors="replace").strip()


def email_db_query(sql: str) -> list[dict]:
    """Query the email-watcher DB. Returns list of row dicts."""
    import json

    raw = _bun_query("/data/email-watcher/emails.db", sql)
    return json.loads(raw) if raw else []


def workflow_db_query(sql: str) -> list[dict]:
    """Query the workflow DB. Returns list of row dicts."""
    import json

    raw = _bun_query("/data/email-watcher/workflow.db", sql)
    return json.loads(raw) if raw else []


def poll_scan_doc(unique_filename: str, timeout: int = 300) -> dict | None:
    """Poll workflow.db for the scan_intake job created from a Drive upload whose
    filename matches ``unique_filename``.

    The gdrive-poller stamps ``filename`` into the job's ``input_json``; the worker
    titles the resulting Paperless doc by vendor+order_id (not the filename) and
    stores its id in the indexed ``paperless_doc_id`` column — so locating the doc
    via the job is robust, whereas searching Paperless by the upload filename never
    matches.

    Returns ``{"state", "outcome", "paperless_doc_id"}`` once the job reaches a
    terminal state, or ``None`` on timeout.
    """
    import json as _json

    # NOTE: _bun_query wraps the SQL in `bun -e '...'` (single-quoted shell), so the
    # SQL MUST NOT contain single quotes. We therefore select without a WHERE string
    # literal and filter in Python by workflow_type + filename + terminal state.
    deadline = time.time() + timeout
    while time.time() < deadline:
        rows = workflow_db_query(
            "SELECT workflow_type, state, paperless_doc_id, output_json, input_json FROM jobs"
        )
        for r in rows:
            if r.get("workflow_type") != "scan_intake":
                continue
            if unique_filename not in (r.get("input_json") or ""):
                continue
            if r.get("state") in ("completed", "failed"):
                out = _json.loads(r["output_json"]) if r.get("output_json") else {}
                return {
                    "state": r["state"],
                    "outcome": out.get("outcome"),
                    "paperless_doc_id": r.get("paperless_doc_id"),
                }
        time.sleep(5)
    return None


# NOTE: A previous version of this file exposed `EmailStatus` and
# `poll_email_status` which queried `emails.db` for status/action/vendor/
# process_result columns. Those columns no longer exist on the current
# emails.db schema (`db.ts:36`) — emails.db is an insert-only audit trail.
# Processing state lives in workflow.db. Use `poll_job_completion` below.


# ---------------------------------------------------------------------------
# Workflow DB polling (jobs created directly by watchers)
# ---------------------------------------------------------------------------


@dataclass
class JobResult:
    id: str
    state: str
    workflow_type: str
    source_ref: str | None
    output: dict | None


def poll_job_completion(
    source_ref_contains: str,
    timeout: int = 240,
    poll_interval: int = 10,
) -> JobResult:
    """Poll workflow DB until a job matching source_ref reaches a terminal state.

    Terminal states: completed, failed, cancelled.
    Raises TimeoutError if not reached within timeout seconds.
    """
    import json

    terminal = {"completed", "failed", "cancelled"}
    deadline = time.time() + timeout
    rows: list[dict] = []

    while time.time() < deadline:
        rows = workflow_db_query(
            f"SELECT id,state,workflow_type,source_ref,output_json "
            f'FROM jobs WHERE source_ref LIKE \\"%{source_ref_contains}%\\" '
            f"ORDER BY created_at DESC LIMIT 1"
        )
        if rows and rows[0].get("state") in terminal:
            r = rows[0]
            output = None
            if r.get("output_json"):
                try:
                    output = json.loads(r["output_json"])
                except (json.JSONDecodeError, TypeError):
                    pass
            return JobResult(
                id=r["id"],
                state=r["state"],
                workflow_type=r["workflow_type"],
                source_ref=r.get("source_ref"),
                output=output,
            )
        time.sleep(poll_interval)

    raise TimeoutError(
        f"Job matching source_ref '{source_ref_contains}' did not reach terminal state "
        f"within {timeout}s. Last rows: {rows}"
    )


def poll_job_state(
    source_ref_contains: str,
    state: str,
    timeout: int = 180,
    poll_interval: int = 5,
) -> dict:
    """Poll workflow DB until a job matching source_ref reaches the given state.

    Unlike `poll_job_completion` this accepts *any* state (including the
    non-terminal `awaiting_user_guidance`). Returns the raw row dict as
    stored in `workflow.db` so callers can inspect `id`, `state`,
    `source_ref`, `output_json`, etc.

    Raises TimeoutError if the state isn't reached within the timeout.
    """
    deadline = time.time() + timeout
    rows: list[dict] = []

    while time.time() < deadline:
        rows = workflow_db_query(
            f"SELECT id,state,workflow_type,source_ref,output_json "
            f'FROM jobs WHERE source_ref LIKE \\"%{source_ref_contains}%\\" '
            f"ORDER BY created_at DESC LIMIT 1"
        )
        if rows and rows[0].get("state") == state:
            return rows[0]
        time.sleep(poll_interval)

    raise TimeoutError(
        f"Job matching source_ref '{source_ref_contains}' did not reach state "
        f"'{state}' within {timeout}s. Last rows: {rows}"
    )


def get_job_events(job_id: str) -> list[dict]:
    """Return the ordered event trail for a job from workflow.db.

    Each row is `{id, event_type, payload_json, created_at}`. The caller
    is responsible for `json.loads(payload_json)` on entries they care
    about — payloads are stored as opaque JSON blobs to match the
    production schema (see `channels/workflow-db.ts`).
    """
    return workflow_db_query(
        f'SELECT id,event_type,payload_json,created_at FROM job_events '
        f'WHERE job_id = \\"{job_id}\\" ORDER BY created_at ASC, id ASC'
    )


def call_provide_guidance(job_id: str, guidance: dict) -> None:
    """Simulate a `provide_guidance` MCP tool call against a paused job.

    The workflow channel is a stdio MCP server (no HTTP endpoint), so
    tests can't hit it via `requests`. Instead we exec a bun one-liner
    inside the `personal-assistant-claude` container that imports the
    exported `handleProvideGuidance` from `/app/channels/workflow-mcp.ts`
    and invokes it against the live `workflow.db`. This matches the side
    effects the real MCP tool would produce (adds `guidance_applied`
    event, flips job state from `awaiting_user_guidance` → `queued`,
    stores any `decrypt_password` under a separate `guidance_password`
    event so passwords don't leak into regular audit logs).

    The workflow worker's next `workerTick()` picks up the requeued job
    and resumes the pipeline.
    """
    import json
    import shlex

    # Build a bun script that opens the workflow DB, calls
    # handleProvideGuidance, and closes the DB. We use single-quotes
    # around the payload so JSON stays intact, and interpolate via
    # JSON.parse at the other end to avoid TS-template pitfalls.
    guidance_json = json.dumps(guidance)
    payload_json = json.dumps({"job_id": job_id, "guidance": guidance})

    script = (
        'import{openWorkflowDb}from"/app/channels/workflow-db.ts";'
        'import{handleProvideGuidance}from"/app/channels/workflow-mcp.ts";'
        f"const payload=JSON.parse({json.dumps(payload_json)});"
        'const db=openWorkflowDb("/data/email-watcher/workflow.db");'
        "try{handleProvideGuidance(db,payload);"
        'console.log(JSON.stringify({ok:true,job_id:payload.job_id}));'
        "}catch(e){"
        'console.log(JSON.stringify({ok:false,error:(e&&e.message)||String(e)}));'
        "process.exit(1);"
        "}finally{db.close();}"
    )

    # Use a heredoc-style invocation so quoting survives the shell layer.
    # Bash -lc keeps env and pipe behaviour sane on Linux containers.
    cmd = (
        f"bun -e {shlex.quote(script)}"
    )
    result = subprocess.run(
        ["docker", "exec", CONTAINER, "sh", "-c", cmd],
        capture_output=True,
        timeout=30,
    )
    stdout = result.stdout.decode("utf-8", errors="replace").strip()
    stderr = result.stderr.decode("utf-8", errors="replace").strip()
    if result.returncode != 0:
        raise RuntimeError(
            f"provide_guidance failed (rc={result.returncode}) "
            f"for job {job_id} with guidance {guidance_json}.\n"
            f"stdout: {stdout}\nstderr: {stderr}"
        )
    # Best-effort parse for observability; don't fail the test if the
    # container printed extra noise (e.g. bun warnings to stdout).
    try:
        last_line = stdout.splitlines()[-1]
        parsed = json.loads(last_line)
        if not parsed.get("ok"):
            raise RuntimeError(
                f"provide_guidance returned ok=false: {parsed.get('error')}"
            )
    except (IndexError, json.JSONDecodeError):
        # Non-JSON stdout with rc=0 — trust the exit code.
        pass


# ---------------------------------------------------------------------------
# Container & DB management
# ---------------------------------------------------------------------------


# Pipeline containers that must be stopped together to safely wipe shared
# DBs. email-poller, gdrive-poller, and pa-worker are now standalone containers
# (not stdio children of claude-code). They must be stopped before clear_dbs()
# so they release their SQLite file handles — otherwise writes go to the
# deleted inode and the new workflow.db/gdrive.db created after restart is
# invisible to them. pa-worker (task 64) opens workflow.db on boot just like
# the pollers do; a leftover handle there causes scan_intake / invoice_intake
# jobs created post-reset to never get claimed.
PIPELINE_SERVICES = ("claude-code", "email-poller", "gdrive-poller", "pa-worker")


def stop_claude():
    """Stop all pipeline containers (claude + worker + watchers)."""
    services = " ".join(PIPELINE_SERVICES)
    subprocess.run(
        f"cd {PA_STACK} && {COMPOSE_CMD} stop {services}",
        shell=True,
        capture_output=True,
        timeout=120,
    )


def start_claude():
    """Start all pipeline containers (claude + worker + watchers)."""
    services = " ".join(PIPELINE_SERVICES)
    subprocess.run(
        f"cd {PA_STACK} && {COMPOSE_CMD} start {services}",
        shell=True,
        capture_output=True,
        timeout=120,
    )


def clear_dbs():
    """Delete email-watcher, workflow, and gdrive-watcher DBs (container must be stopped)."""
    for pattern in (
        "email-watcher/emails.db*",
        "email-watcher/workflow.db*",
        "gdrive-watcher/gdrive.db*",
    ):
        for f in PA_DATA.glob(pattern):
            f.unlink(missing_ok=True)
    # Clear downloads
    for f in (PA_DATA / "downloads").glob("*.pdf"):
        f.unlink(missing_ok=True)


def wait_healthy(timeout: int = 180):
    """Wait for the email-watcher health endpoint (port 9465 on claude-code).

    Default 180s because after `stop_claude → start_claude` the container
    needs to start, MCPs to connect, and the watcher to complete its first
    poll before /health flips to 200. 90s was tight enough to flake when a
    test fired after another long-running one.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            r = requests.get("http://localhost:9465/health", timeout=3)
            if r.status_code == 200:
                return
        except requests.ConnectionError:
            pass
        time.sleep(5)
    raise TimeoutError(f"email-watcher not healthy within {timeout}s")


def wait_claude_ready(timeout: int = 1500):
    """Wait until the claude-code container reports `healthy` AND the
    CRITICAL stdio channels (workflow-mcp.ts, email-watcher.ts) are
    spawned — mirroring entrypoint.sh CRITICAL_CHANNELS. The remaining
    channels (gdrive-watcher, telegram, file-ops) are BEST_EFFORT: the
    Claude Code v2.1.x MCP-spawn race occasionally drops one of them,
    and the in-container watchdog logs a WARN but does NOT restart on
    best-effort misses. The pytest fixture follows the same contract.

    Default timeout 1500s: Claude Code v2.1.x can take 160-300s to
    spawn stdio MCP subprocesses on a cold start, and on bad cold
    starts the entrypoint times out, kills tmux, Docker restarts the
    container. 1500s covers ~5 entrypoint cycles end-to-end.
    """
    expected_channels = ("workflow-mcp.ts",)
    best_effort_channels = ("telegram/server.ts", "file-ops.ts")
    deadline = time.time() + timeout
    missing: list[str] = list(expected_channels)
    while time.time() < deadline:
        # 1. container `healthy` (the docker-compose healthcheck verifies the
        #    tmux session is alive AND email-watcher health is OK).
        try:
            res = subprocess.run(
                ["docker", "inspect", "-f", "{{.State.Health.Status}}", "personal-assistant-claude"],
                capture_output=True,
                timeout=5,
                check=False,
            )
            health = res.stdout.decode().strip()
        except Exception:
            health = ""

        if health == "healthy":
            # 2. all 3 stdio channel subprocesses spawned.
            try:
                res = subprocess.run(
                    [
                        "docker",
                        "exec",
                        "personal-assistant-claude",
                        "sh",
                        "-c",
                        'for pid in /proc/[0-9]*; do tr "\\0" " " < "$pid/cmdline" 2>/dev/null; echo; done',
                    ],
                    capture_output=True,
                    timeout=10,
                    check=False,
                )
                cmdlines = res.stdout.decode("utf-8", errors="replace")
                missing = [c for c in expected_channels if c not in cmdlines]
                missing_best_effort = [c for c in best_effort_channels if c not in cmdlines]
                if not missing:
                    if missing_best_effort:
                        print(
                            f"[wait_claude_ready] best-effort channels not running "
                            f"(v2.1.x MCP race, tolerated): {missing_best_effort}"
                        )
                    # 3. give the workflow-mcp stdio channel an extra moment
                    #    to attach its notification handler so an early
                    #    channel push doesn't get dropped.
                    time.sleep(5)
                    return
            except Exception:
                pass

        time.sleep(5)

    raise TimeoutError(
        f"Claude not fully ready within {timeout}s "
        f"(missing channels: {missing})"
    )


def preseed_source_state(*sources: str):
    """Pre-create the email-watcher DB with last_checked for given sources.

    Must be called BEFORE starting the container (after clear_dbs) so the
    email-watcher sees last_checked on its first poll and skips the first_start
    flow. This prevents Claude from getting stuck waiting for Telegram input.
    """
    import sqlite3

    db_dir = PA_DATA / "email-watcher"
    db_dir.mkdir(parents=True, exist_ok=True)
    db_path = db_dir / "emails.db"

    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS emails (
            id TEXT PRIMARY KEY, source TEXT NOT NULL, sender TEXT, subject TEXT,
            preview TEXT, has_attachments INTEGER DEFAULT 0, received_at TEXT,
            discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
            classified_at TEXT, classification TEXT, action TEXT, vendor TEXT,
            confidence TEXT, processed_at TEXT, process_result TEXT,
            status TEXT NOT NULL DEFAULT 'new', trace_id TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS source_state (
            source TEXT PRIMARY KEY, last_checked TEXT NOT NULL
        )
    """)
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    for source in sources:
        conn.execute(
            "INSERT OR REPLACE INTO source_state (source, last_checked) VALUES (?, ?)",
            (source, now),
        )
    conn.commit()
    conn.close()

    # Test fixture runs from host as root — emails.db ends up root:root and the
    # email-poller (UID 1000) can't write to it, breaking every email-pipeline
    # test. Chown the file + WAL/shm sidecars so the poller can take over.
    try:
        for f in db_dir.glob("emails.db*"):
            os.chown(f, 1000, 1000)
    except (OSError, AttributeError):
        # Non-root runner or non-Linux — chown not needed/available
        pass


def full_reset(*sources: str):
    """Stop container, clear all DBs + Paperless, preseed sources, restart.

    Sources are pre-seeded with last_checked=now BEFORE the container starts,
    so the email-watcher's first poll sees them and skips first_start events.

    Waits for Claude to be fully ready (all stdio channels attached) before
    returning so the test can immediately push channel events without losing
    them in a partial-startup window.
    """
    stop_claude()
    clear_dbs()
    paperless_wipe()
    if sources:
        preseed_source_state(*sources)
    start_claude()
    wait_healthy()
    wait_claude_ready()


# ---------------------------------------------------------------------------
# Paperless search helpers (thin wrappers for E2E test readability)
# ---------------------------------------------------------------------------


def get_custom_field_lookup() -> dict[int, str]:
    """Fetch custom fields from Paperless and return {id: name} mapping."""
    data = paperless_get("custom_fields", page_size=100)
    return {f["id"]: f["name"] for f in data["results"]}


def paperless_search_documents(query: str) -> list[dict]:
    """Search Paperless documents by title or original_file_name substring.

    Returns a list of minimal document dicts (same shape as
    ``paperless_documents()``).  Returns an empty list if no match.
    """
    q = query.lower()
    all_docs = paperless_documents()
    return [
        d for d in all_docs
        if q in (d.get("title") or "").lower()
        or q in (d.get("original_file_name") or "").lower()
    ]


def paperless_get_document(doc_id: int) -> dict | None:
    """Fetch a single Paperless document by id (enriched shape).

    Delegates to ``paperless_get_by_id`` which returns correspondent_name,
    tag_names, document_type_name, and storage_path_name in addition to the
    raw Paperless fields.  Returns None if the document does not exist.
    """
    return paperless_get_by_id(doc_id)


# ---------------------------------------------------------------------------
# Google Drive helpers for E2E gdrive-scan tests
# ---------------------------------------------------------------------------


_drive_service = None


def _get_drive_credentials():
    """Load Google OAuth credentials with Drive scope from TOKEN_FILE.

    Reuses the same token.json that gmail_service() uses.  The token must
    have been originally authorised with at minimum:
      - https://www.googleapis.com/auth/gmail.send
      - https://www.googleapis.com/auth/drive

    If the existing token.json only has the gmail.send scope the refresh
    will succeed (the token stores granted scopes from the original consent
    screen), but any Drive API call will return 403.  Re-authorise by
    deleting token.json and re-running the auth helper with DRIVE_SCOPES.
    """
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials

    creds = Credentials.from_authorized_user_file(str(TOKEN_FILE), DRIVE_SCOPES)
    if creds.expired and creds.refresh_token:
        creds.refresh(Request())
        TOKEN_FILE.write_text(creds.to_json(), encoding="utf-8")
    return creds


def make_drive_service(credentials):
    """Build a Google Drive v3 service from the given credentials."""
    from googleapiclient.discovery import build

    return build("drive", "v3", credentials=credentials, cache_discovery=False)


def get_drive_service():
    """Lazy-init Google Drive API service (reuses across calls)."""
    global _drive_service
    if _drive_service is not None:
        return _drive_service
    _drive_service = make_drive_service(_get_drive_credentials())
    return _drive_service


class DriveTestClient:
    """Minimal Google Drive client for E2E pipeline tests.

    Provides folder resolution and file upload/listing helpers so tests can
    drop PDFs into the gdrive-watcher watch folder and verify post-processing
    state without depending on the production gmail-mcp container.

    Supports both 2-level (owner/bucket) and 3-level (root/owner/bucket) folder
    hierarchies matching the GDRIVE_ROOT / GDRIVE_OWNERS / GDRIVE_BUCKETS env vars.
    When ``root`` is set the hierarchy is root → owner → bucket; when empty it is
    owner → bucket (backward-compatible with the pre-96 GDRIVE_LEVEL1/LEVEL2 layout).
    """

    def __init__(self, service, owner: str, bucket: str, root: str = ""):
        self.service = service
        self.root = root
        self.owner = owner
        self.bucket = bucket

    def _find_folder(self, name: str, parent_id: str | None = None) -> str | None:
        """Return the Drive folder id for ``name``, optionally scoped to ``parent_id``."""
        q = (
            f"name = '{name}' and mimeType = 'application/vnd.google-apps.folder' "
            "and trashed = false"
        )
        if parent_id:
            q += f" and '{parent_id}' in parents"
        res = self.service.files().list(q=q, fields="files(id,name)").execute()
        files = res.get("files", [])
        return files[0]["id"] if files else None

    def resolve_watch_folder_id(self) -> str:
        """Return the Drive folder id for the bucket (leaf) watch folder.

        When ``root`` is set walks root → owner → bucket (3-level).
        When ``root`` is empty walks owner → bucket (2-level, backward-compat).
        """
        if self.root:
            root_id = self._find_folder(self.root)
            assert root_id, f"root folder '{self.root}' not found in Drive"
            owner_id = self._find_folder(self.owner, parent_id=root_id)
            assert owner_id, f"owner folder '{self.owner}' not found under '{self.root}'"
            bucket_id = self._find_folder(self.bucket, parent_id=owner_id)
            assert bucket_id, (
                f"bucket folder '{self.bucket}' not found under '{self.owner}'"
            )
            return bucket_id
        else:
            owner_id = self._find_folder(self.owner)
            assert owner_id, f"owner folder '{self.owner}' not found in Drive"
            bucket_id = self._find_folder(self.bucket, parent_id=owner_id)
            assert bucket_id, (
                f"bucket folder '{self.bucket}' not found under '{self.owner}'"
            )
            return bucket_id

    def resolve_subfolder_id(self, parent_id: str, name: str) -> str | None:
        """Return the Drive folder id for ``name`` directly inside ``parent_id``."""
        return self._find_folder(name, parent_id=parent_id)

    def upload_file(self, file_path: Path, filename: str, parent_folder_id: str) -> dict:
        """Upload a local file to Drive and return the created file metadata.

        Args:
            file_path: Local path to the file to upload.
            filename: Name to give the file in Drive.
            parent_folder_id: Drive folder id of the target folder.

        Returns:
            Dict with ``id`` and ``name`` of the created Drive file.
        """
        from googleapiclient.http import MediaFileUpload

        media = MediaFileUpload(str(file_path), mimetype="application/pdf")
        return self.service.files().create(
            body={"name": filename, "parents": [parent_folder_id]},
            media_body=media,
            fields="id,name",
        ).execute()

    def list_files(self, folder_id: str) -> list[dict]:
        """List non-trashed files directly inside ``folder_id``.

        Returns a list of dicts with ``id`` and ``name`` keys.
        """
        res = self.service.files().list(
            q=f"'{folder_id}' in parents and trashed = false",
            fields="files(id,name)",
        ).execute()
        return res.get("files", [])
