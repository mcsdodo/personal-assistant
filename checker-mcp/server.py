"""Checker MCP — wraps match_invoices.py as MCP tools over Streamable HTTP."""

import os
from datetime import date

import uvicorn
from mcp.server.fastmcp import FastMCP

# match_invoices.py is copied into the same directory at Docker build time
from match_invoices import (
    ACCOUNTING_TAG_NAME,
    ACCOUNT_STATEMENT_TAG_NAME,
    INVOICE_TYPE_NAME,
    TOTAL_AMOUNT_ALT_FIELD_NAME,
    TOTAL_AMOUNT_FIELD_NAME,
    PaperlessClient,
    collect_month,
    collect_pl,
    filter_resolved_unmatched,
    month_offset,
)

mcp = FastMCP("checker")

# ── Lazy singleton client ─────────────────────────────────────────────────


class _ClientHolder:
    """Lazy-init Paperless client and resolved IDs."""

    _instance = None

    def __init__(self):
        url = os.environ["PAPERLESS_URL"]
        token = os.environ["PAPERLESS_API_TOKEN"]
        self.client = PaperlessClient(url, token)
        self.acct_stmt_tag_id = self.client.get_tag_id(ACCOUNT_STATEMENT_TAG_NAME)
        self.accounting_tag_id = self.client.get_tag_id(ACCOUNTING_TAG_NAME)
        self.invoice_type_id = self.client.get_document_type_id(INVOICE_TYPE_NAME)
        self.total_amount_field_id = self.client.get_custom_field_id(
            TOTAL_AMOUNT_FIELD_NAME
        )
        self.total_amount_alt_field_id = self.client.get_custom_field_id(
            TOTAL_AMOUNT_ALT_FIELD_NAME
        )

    @classmethod
    def get(cls):
        if cls._instance is None:
            cls._instance = cls()
        return cls._instance


def _holder():
    return _ClientHolder.get()


# ── Tools ─────────────────────────────────────────────────────────────────


@mcp.tool()
def match_invoices(month: str) -> dict:
    """Match bank statement movements against invoices for a given month.

    Args:
        month: Month in YYYY-MM format (e.g. "2026-03").

    Returns structured results with rows (status, amount, invoice name) and stats.
    """
    h = _holder()
    doc_cache = {}
    global_matched_ids = set()
    result = collect_month(
        h.client,
        month,
        h.acct_stmt_tag_id,
        h.accounting_tag_id,
        h.invoice_type_id,
        h.total_amount_field_id,
        doc_cache,
        global_matched_ids,
        total_amount_alt_field_id=h.total_amount_alt_field_id,
    )
    return _clean_result(result)


@mcp.tool()
def match_invoices_range(month_from: str, month_to: str) -> list[dict]:
    """Match invoices for a range of months (inclusive).

    Args:
        month_from: Start month YYYY-MM.
        month_to: End month YYYY-MM.

    Returns list of monthly results with cross-month resolution applied.
    """
    h = _holder()
    months = []
    m = month_from
    while m <= month_to:
        months.append(m)
        m = month_offset(m, 1)

    doc_cache = {}
    global_matched_ids = set()
    results = [
        collect_month(
            h.client,
            m,
            h.acct_stmt_tag_id,
            h.accounting_tag_id,
            h.invoice_type_id,
            h.total_amount_field_id,
            doc_cache,
            global_matched_ids,
            total_amount_alt_field_id=h.total_amount_alt_field_id,
        )
        for m in months
    ]
    filter_resolved_unmatched(results)
    return [_clean_result(r) for r in results]


@mcp.tool()
def get_pl_summary(year: int) -> dict:
    """Get annual profit & loss summary (accrual basis).

    Args:
        year: Calendar year (e.g. 2025).

    Returns income, expenses by category, excluded totals, and net income.
    """
    h = _holder()
    return collect_pl(
        h.client,
        year,
        h.acct_stmt_tag_id,
        h.accounting_tag_id,
        h.invoice_type_id,
        h.total_amount_field_id,
        total_amount_alt_field_id=h.total_amount_alt_field_id,
    )


@mcp.tool()
def get_month_status(month: str | None = None) -> dict:
    """Quick status overview for a month — how many matched, missing, pending.

    Args:
        month: Month in YYYY-MM format. Defaults to current month.
    """
    if month is None:
        today = date.today()
        month = f"{today.year:04d}-{today.month:02d}"

    h = _holder()
    doc_cache = {}
    global_matched_ids = set()
    result = collect_month(
        h.client,
        month,
        h.acct_stmt_tag_id,
        h.accounting_tag_id,
        h.invoice_type_id,
        h.total_amount_field_id,
        doc_cache,
        global_matched_ids,
        total_amount_alt_field_id=h.total_amount_alt_field_id,
    )
    return {
        "month": month,
        "stats": result["stats"],
        "has_statement": bool(result["header_doc_id"]),
        "missing_invoices": [
            {"amount": r["amount"], "description": r.get("description", "")}
            for r in result["rows"]
            if r["status"] == "missing"
        ],
    }


# ── Helpers ───────────────────────────────────────────────────────────────


def _clean_result(result: dict) -> dict:
    """Strip ANSI codes and internal fields from collect_month output."""
    import re

    ansi_re = re.compile(r"\033\[[0-9;]*m")

    def clean_str(s):
        return ansi_re.sub("", s) if isinstance(s, str) else s

    cleaned_rows = []
    for row in result.get("rows", []):
        cleaned_rows.append(
            {
                "status": row.get("status", ""),
                "amount": row.get("amount"),
                "description": clean_str(row.get("description", "")),
                "invoice_name": clean_str(row.get("invoice_name", "")),
                "doc_id": row.get("doc_id"),
                "skip_label": row.get("skip_label", ""),
            }
        )
    return {
        "month": result["month"],
        "header": clean_str(result.get("header", "")),
        "stats": result["stats"],
        "rows": cleaned_rows,
    }


# ── Entrypoint ────────────────────────────────────────────────────────────

if __name__ == "__main__":
    app = mcp.streamable_http_app()

    # ASGI wrapper: health endpoint + Host header rewrite for FastMCP DNS rebinding
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
            headers = list(scope.get("headers", []))
            scope["headers"] = [
                (k, b"localhost:8001") if k == b"host" else (k, v) for k, v in headers
            ]
        await app(scope, receive, send)

    uvicorn.run(passthrough, host="0.0.0.0", port=8001)
