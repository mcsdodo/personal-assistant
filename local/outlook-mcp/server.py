"""Outlook MCP — read emails via Microsoft Graph API.

Auth: MSAL device code flow. On startup, if no cached token, prints URL + code
in container logs. User enters the code at the URL, server continues automatically.
"""

import os
import threading
from pathlib import Path

import msal
import requests
import uvicorn
from mcp.server.fastmcp import FastMCP

GRAPH_BASE = "https://graph.microsoft.com/v1.0"
SCOPES = ["Mail.Read"]

mcp_server = FastMCP("outlook")


# ── Auth ──────────────────────────────────────────────────────────────────

def _token_cache_path() -> Path:
    return Path(os.environ.get("TOKEN_CACHE_PATH", "/data/token_cache.json"))


def _load_cache() -> msal.SerializableTokenCache:
    cache = msal.SerializableTokenCache()
    path = _token_cache_path()
    if path.exists():
        cache.deserialize(path.read_text())
    return cache


def _save_cache(cache: msal.SerializableTokenCache):
    if cache.has_state_changed:
        path = _token_cache_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(cache.serialize())


def _get_app_and_cache():
    client_id = os.environ["AZURE_CLIENT_ID"]
    tenant_id = os.environ.get("AZURE_TENANT_ID", "common")
    cache = _load_cache()
    app = msal.PublicClientApplication(
        client_id,
        authority=f"https://login.microsoftonline.com/{tenant_id}",
        token_cache=cache,
    )
    return app, cache


def get_access_token() -> str:
    """Get access token. Uses cache, falls back to device code flow."""
    app, cache = _get_app_and_cache()

    accounts = app.get_accounts()
    if accounts:
        result = app.acquire_token_silent(SCOPES, account=accounts[0])
        if result and "access_token" in result:
            _save_cache(cache)
            return result["access_token"]

    # Device code flow — prints URL+code to stdout (visible in docker logs)
    flow = app.initiate_device_flow(scopes=SCOPES)
    if "user_code" not in flow:
        raise RuntimeError(f"Device flow failed: {flow.get('error_description')}")

    print(f"\n{'='*60}", flush=True)
    print(f"OUTLOOK AUTH REQUIRED", flush=True)
    print(f"{'='*60}", flush=True)
    print(f"  1. Open:  {flow['verification_uri']}", flush=True)
    print(f"  2. Enter: {flow['user_code']}", flush=True)
    print(f"  Waiting for you to complete sign-in...", flush=True)
    print(f"{'='*60}\n", flush=True)

    result = app.acquire_token_by_device_flow(flow)
    if "access_token" not in result:
        raise RuntimeError(f"Auth failed: {result.get('error_description')}")

    _save_cache(cache)
    print("Outlook: authenticated successfully!\n", flush=True)
    return result["access_token"]


def _session() -> requests.Session:
    token = get_access_token()
    s = requests.Session()
    s.headers["Authorization"] = f"Bearer {token}"
    return s


# ── Tools ─────────────────────────────────────────────────────────────────

@mcp_server.tool()
def list_emails(top: int = 20, sender: str | None = None, folder: str | None = None) -> list[dict]:
    """List recent emails from Outlook.

    Args:
        top: Number of emails to fetch (default 20).
        sender: Filter by sender email (partial match).
        folder: Mail folder name (default: Inbox).
    """
    s = _session()
    if folder:
        folder_id = _find_folder(s, folder)
        if not folder_id:
            return [{"error": f"Folder '{folder}' not found"}]
        url = f"{GRAPH_BASE}/me/mailFolders/{folder_id}/messages"
    else:
        url = f"{GRAPH_BASE}/me/messages"

    params = {
        "$top": top,
        "$select": "id,subject,from,toRecipients,receivedDateTime,hasAttachments,bodyPreview",
        "$orderby": "receivedDateTime desc",
    }
    if sender:
        params["$filter"] = f"contains(from/emailAddress/address, '{sender}')"

    resp = s.get(url, params=params)
    resp.raise_for_status()

    return [
        {
            "id": m["id"],
            "sender": m.get("from", {}).get("emailAddress", {}).get("address", ""),
            "to": ", ".join(
                r.get("emailAddress", {}).get("address", "")
                for r in m.get("toRecipients", [])
            ) or None,
            "subject": m.get("subject", ""),
            "received_at": m.get("receivedDateTime", ""),
            "has_attachments": m.get("hasAttachments", False),
            "preview": m.get("bodyPreview", "")[:200],
        }
        for m in resp.json().get("value", [])
    ]


@mcp_server.tool()
def get_email(message_id: str) -> dict:
    """Get full email content including body.

    Args:
        message_id: Outlook message ID.
    """
    s = _session()
    resp = s.get(f"{GRAPH_BASE}/me/messages/{message_id}",
                 params={"$select": "id,subject,from,receivedDateTime,body,hasAttachments"})
    resp.raise_for_status()
    msg = resp.json()
    return {
        "id": msg["id"],
        "sender": msg.get("from", {}).get("emailAddress", {}).get("address", ""),
        "subject": msg.get("subject", ""),
        "received_at": msg.get("receivedDateTime", ""),
        "body_html": msg.get("body", {}).get("content", ""),
        "has_attachments": msg.get("hasAttachments", False),
    }


@mcp_server.tool()
def get_attachments(message_id: str) -> list[dict]:
    """List attachments on an email.

    Args:
        message_id: Outlook message ID.
    """
    s = _session()
    resp = s.get(f"{GRAPH_BASE}/me/messages/{message_id}/attachments")
    resp.raise_for_status()
    return [
        {
            "id": a["id"],
            "name": a.get("name", ""),
            "content_type": a.get("contentType", ""),
            "size": a.get("size", 0),
        }
        for a in resp.json().get("value", [])
    ]


@mcp_server.tool()
def download_attachment(message_id: str, attachment_id: str) -> dict:
    """Download an email attachment. Returns base64-encoded content.

    Args:
        message_id: Outlook message ID.
        attachment_id: Attachment ID.
    """
    import base64
    s = _session()
    resp = s.get(f"{GRAPH_BASE}/me/messages/{message_id}/attachments/{attachment_id}")
    resp.raise_for_status()
    att = resp.json()
    return {
        "name": att.get("name", ""),
        "content_type": att.get("contentType", ""),
        "size": att.get("size", 0),
        "content_base64": att.get("contentBytes", ""),
    }


# ── Helpers ───────────────────────────────────────────────────────────────

def _find_folder(s: requests.Session, name: str) -> str | None:
    resp = s.get(f"{GRAPH_BASE}/me/mailFolders", params={"$top": 100})
    resp.raise_for_status()
    for f in resp.json().get("value", []):
        if f["displayName"].lower() == name.lower():
            return f["id"]
    return None



# ── Startup ───────────────────────────────────────────────────────────────

def _startup_auth():
    """Authenticate at startup. Blocks until complete if interactive flow needed."""
    if not os.environ.get("AZURE_CLIENT_ID"):
        print("Outlook: DISABLED (AZURE_CLIENT_ID not set)", flush=True)
        return
    try:
        get_access_token()
        print("Outlook: OK (authenticated)", flush=True)
    except Exception as e:
        print(f"Outlook: auth failed — {e}", flush=True)


if __name__ == "__main__":
    # Auth runs in background thread so server starts immediately
    # if token is cached, it resolves instantly. If not, device code flow
    # prints URL+code in logs and polls until user completes.
    auth_thread = threading.Thread(target=_startup_auth, daemon=True)
    auth_thread.start()

    app = mcp_server.streamable_http_app()

    # ASGI wrapper: health endpoint + Host header rewrite for FastMCP DNS rebinding
    async def passthrough(scope, receive, send):
        if scope["type"] == "http":
            path = scope.get("path", "")
            if path == "/health":
                await send({"type": "http.response.start", "status": 200, "headers": [[b"content-type", b"text/plain"]]})
                await send({"type": "http.response.body", "body": b"ok"})
                return
            headers = list(scope.get("headers", []))
            scope["headers"] = [
                (k, b"localhost:8002") if k == b"host" else (k, v)
                for k, v in headers
            ]
        await app(scope, receive, send)

    uvicorn.run(passthrough, host="0.0.0.0", port=8002)
