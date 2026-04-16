"""Shared helpers for personal-assistant E2E pipeline tests.

Provides: Gmail sending, Paperless API, email-watcher DB polling, container management.
"""

from __future__ import annotations

import base64
import mimetypes
import os
import subprocess
import time
from dataclasses import dataclass
from email.mime.base import MIMEBase
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email import encoders
from email.utils import formatdate
from pathlib import Path

import requests

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

    creds = Credentials.from_authorized_user_file(str(TOKEN_FILE), GMAIL_SCOPES)
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
    result = (
        gmail_service()
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
    result = (
        gmail_service()
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


def paperless_wipe():
    """Delete all documents, correspondents, tags, and document types."""
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

    The workflow MCP is a stdio channel (no HTTP endpoint), so tests can't
    hit it via `requests`. Instead we exec a bun one-liner inside the
    `personal-assistant-claude` container that imports the exported
    `handleProvideGuidance` from `/app/channels/workflow-mcp.ts` and
    invokes it against the live `workflow.db`. This matches the side
    effects the real MCP tool would produce (adds `guidance_applied`
    event, flips job state from `awaiting_user_guidance` → `queued`,
    stores any `decrypt_password` under a separate `guidance_password`
    event so passwords don't leak into regular audit logs).

    The worker's next `workerTick()` picks up the requeued job and
    resumes the pipeline.
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


def stop_claude():
    """Stop the claude-code container."""
    subprocess.run(
        f"cd {PA_STACK} && {COMPOSE_CMD} stop claude-code",
        shell=True,
        capture_output=True,
        timeout=60,
    )


def start_claude():
    """Start the claude-code container."""
    subprocess.run(
        f"cd {PA_STACK} && {COMPOSE_CMD} start claude-code",
        shell=True,
        capture_output=True,
        timeout=60,
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


def wait_healthy(timeout: int = 90):
    """Wait for the email-watcher health endpoint."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            r = requests.get("http://localhost:9465/health", timeout=3)
            if r.status_code == 200:
                return
        except requests.ConnectionError:
            pass
        time.sleep(5)
    raise TimeoutError(f"Container not healthy within {timeout}s")


def wait_claude_ready(timeout: int = 180):
    """Wait until the claude-code container reports `healthy` AND all 5 stdio
    channel subprocesses are spawned. The :9465 health endpoint only verifies
    email-watcher is up — Claude itself can still be in the middle of its
    startup race (Claude Code v2.1.92 sometimes flaps stdio MCP spawns).
    Without this extra wait, channel notifications pushed by workflow-mcp can
    be dropped because Claude isn't yet attached to the workflow stdio MCP.
    """
    expected_channels = (
        "email-watcher.ts",
        "gdrive-watcher.ts",
        "workflow-mcp.ts",
        "telegram/server.ts",
        "file-ops.ts",
    )
    deadline = time.time() + timeout
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
            # 2. all 5 stdio channel subprocesses spawned.
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
                if not missing:
                    # 3. give the workflow stdio MCP an extra moment to attach
                    #    its notification handler so an early channel push
                    #    doesn't get dropped.
                    time.sleep(5)
                    return
            except Exception:
                pass

        time.sleep(5)

    raise TimeoutError(
        f"Claude not fully ready within {timeout}s "
        f"(missing channels: {missing if 'missing' in locals() else 'unknown'})"
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
