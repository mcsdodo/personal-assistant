"""Outlook MCP — read emails via Microsoft Graph API.

Auth: MSAL device code flow. On startup, if no cached token, prints URL + code
in container logs. User enters the code at the URL, server continues automatically.
"""

import json
import os
import threading
from pathlib import Path

import msal
import requests
import uvicorn
from mcp.server.fastmcp import FastMCP

GRAPH_BASE = "https://graph.microsoft.com/v1.0"
SCOPES = ["Mail.Read"]
HTTP_TIMEOUT = 30  # seconds — prevents infinite hangs on Azure AD / Graph API

mcp_server = FastMCP("outlook")


# ── Auth ──────────────────────────────────────────────────────────────────

# Singleton MSAL app + cache — created once at startup, reused for all calls.
# Avoids re-fetching Azure AD OpenID discovery on every tool invocation
# (the old code created a new PublicClientApplication per call, whose __init__
# makes a sync HTTP request to /.well-known/openid-configuration — when Azure
# was slow this blocked the event loop for 16+ minutes, killing health checks).
_msal_app: msal.PublicClientApplication | None = None
_msal_cache: msal.SerializableTokenCache | None = None
_msal_lock = threading.Lock()


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


class _TimeoutSession(requests.Session):
    """requests.Session with a default timeout on every request."""

    def request(self, *args, **kwargs):  # type: ignore[override]
        kwargs.setdefault("timeout", HTTP_TIMEOUT)
        return super().request(*args, **kwargs)


def _get_app_and_cache():
    """Return cached MSAL app + token cache (created once, reused)."""
    global _msal_app, _msal_cache
    if _msal_app is not None and _msal_cache is not None:
        return _msal_app, _msal_cache

    with _msal_lock:
        # Double-check after acquiring lock
        if _msal_app is not None and _msal_cache is not None:
            return _msal_app, _msal_cache

        client_id = os.environ["AZURE_CLIENT_ID"]
        tenant_id = os.environ.get("AZURE_TENANT_ID", "common")
        cache = _load_cache()
        app = msal.PublicClientApplication(
            client_id,
            authority=f"https://login.microsoftonline.com/{tenant_id}",
            token_cache=cache,
            http_client=_TimeoutSession(),
        )
        _msal_app = app
        _msal_cache = cache
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

    print(f"\n{'=' * 60}", flush=True)
    print(f"OUTLOOK AUTH REQUIRED", flush=True)
    print(f"{'=' * 60}", flush=True)
    print(f"  1. Open:  {flow['verification_uri']}", flush=True)
    print(f"  2. Enter: {flow['user_code']}", flush=True)
    print(f"  Waiting for you to complete sign-in...", flush=True)
    print(f"{'=' * 60}\n", flush=True)

    result = app.acquire_token_by_device_flow(flow)
    if "access_token" not in result:
        raise RuntimeError(f"Auth failed: {result.get('error_description')}")

    _save_cache(cache)
    print("Outlook: authenticated successfully!\n", flush=True)
    return result["access_token"]


def _session() -> requests.Session:
    token = get_access_token()
    s = _TimeoutSession()
    s.headers["Authorization"] = f"Bearer {token}"
    return s


# ── Tools ─────────────────────────────────────────────────────────────────


@mcp_server.tool()
def list_emails(
    top: int = 20,
    sender: str | None = None,
    folder: str | None = None,
    received_after: str | None = None,
) -> str:
    """List recent emails from Outlook. Returns a JSON array.

    Args:
        top: Number of emails to fetch (default 20).
        sender: Filter by sender email (partial match).
        folder: Mail folder name (default: Inbox).
        received_after: ISO datetime — only return emails received after this time.
    """
    s = _session()
    if folder:
        folder_id = _find_folder(s, folder)
        if not folder_id:
            return json.dumps([{"error": f"Folder '{folder}' not found"}])
        url = f"{GRAPH_BASE}/me/mailFolders/{folder_id}/messages"
    else:
        url = f"{GRAPH_BASE}/me/messages"

    params = {
        "$top": top,
        "$select": "id,subject,from,toRecipients,receivedDateTime,hasAttachments,bodyPreview",
        "$orderby": "receivedDateTime desc",
    }
    filters = []
    if sender:
        filters.append(f"contains(from/emailAddress/address, '{sender}')")
    if received_after:
        filters.append(f"receivedDateTime ge {received_after}")
    if filters:
        params["$filter"] = " and ".join(filters)

    resp = s.get(url, params=params)
    resp.raise_for_status()

    return json.dumps([
        {
            "id": m["id"],
            "sender": m.get("from", {}).get("emailAddress", {}).get("address", ""),
            "to": ", ".join(
                r.get("emailAddress", {}).get("address", "")
                for r in m.get("toRecipients", [])
            )
            or None,
            "subject": m.get("subject", ""),
            "received_at": m.get("receivedDateTime", ""),
            "has_attachments": m.get("hasAttachments", False),
            "preview": m.get("bodyPreview", "")[:200],
        }
        for m in resp.json().get("value", [])
    ])


@mcp_server.tool()
def get_email(message_id: str) -> dict:
    """Get full email content including body.

    Args:
        message_id: Outlook message ID.
    """
    s = _session()
    resp = s.get(
        f"{GRAPH_BASE}/me/messages/{message_id}",
        params={"$select": "id,subject,from,receivedDateTime,body,hasAttachments"},
    )
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
def get_attachments(message_id: str) -> str:
    """List attachments on an email. Returns a JSON array.

    Args:
        message_id: Outlook message ID.
    """
    s = _session()
    resp = s.get(f"{GRAPH_BASE}/me/messages/{message_id}/attachments")
    resp.raise_for_status()
    return json.dumps([
        {
            "id": a["id"],
            "name": a.get("name", ""),
            "content_type": a.get("contentType", ""),
            "size": a.get("size", 0),
        }
        for a in resp.json().get("value", [])
    ])


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

    # RFC 7591-conformant rejection of OAuth Dynamic Client Registration.
    # Claude Code's MCP SDK speculatively probes /register on first connect; if the
    # server returns a non-JSON 404, the SDK's parseErrorResponse blows up trying
    # to JSON.parse "Not Found" and decorates the /mcp menu with bogus
    # "Re-authenticate" / "Clear authentication" entries (claude-code#34008).
    # Returning a valid OAuth error JSON makes the SDK surface a clean error
    # instead of a JSON-parse exception.
    OAUTH_REGISTER_REJECT = (
        b'{"error":"invalid_client_metadata",'
        b'"error_description":"This MCP server does not support OAuth"}'
    )

    # ASGI wrapper: health endpoint + OAuth /register stub + Host header rewrite
    async def passthrough(scope, receive, send):
        if scope["type"] == "http":
            path = scope.get("path", "")
            if path == "/health":
                await send(
                    {
                        "type": "http.response.start",
                        "status": 200,
                        "headers": [[b"content-type", b"text/plain"]],
                    }
                )
                await send({"type": "http.response.body", "body": b"ok"})
                return
            if path == "/register" and scope.get("method") == "POST":
                await send(
                    {
                        "type": "http.response.start",
                        "status": 400,
                        "headers": [[b"content-type", b"application/json"]],
                    }
                )
                await send({"type": "http.response.body", "body": OAUTH_REGISTER_REJECT})
                return
            headers = list(scope.get("headers", []))
            scope["headers"] = [
                (k, b"localhost:8002") if k == b"host" else (k, v) for k, v in headers
            ]
        await app(scope, receive, send)

    uvicorn.run(passthrough, host="0.0.0.0", port=8002)
