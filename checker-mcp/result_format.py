"""Pure presentation helpers for MCP tool responses.

Kept dependency-free (no mcp/uvicorn) so the formatting contract that Claude
consumes can be unit-tested without the server's transport stack.
"""

import re

_ANSI_RE = re.compile(r"\033\[[0-9;]*m")


def _clean_str(s):
    return _ANSI_RE.sub("", s) if isinstance(s, str) else s


def missing_invoices(result: dict) -> list[dict]:
    """{amount, description} for every `status == "missing"` row in a collect_month
    result. Reads the engine's `desc` key (not `description`, which it never emits)."""
    return [
        {"amount": r["amount"], "description": _clean_str(r.get("desc", ""))}
        for r in result.get("rows", [])
        if r.get("status") == "missing"
    ]


def clean_result(result: dict) -> dict:
    """Strip ANSI codes and project collect_month rows onto the MCP response shape."""
    cleaned_rows = []
    for row in result.get("rows", []):
        cleaned_rows.append(
            {
                "status": row.get("status", ""),
                "amount": row.get("amount"),
                "description": _clean_str(row.get("desc", "")),
                "invoice_name": _clean_str(row.get("detail", "")),
                "doc_id": row.get("doc_id"),
                "skip_label": row.get("label", ""),
            }
        )
    return {
        "month": result["month"],
        "header": _clean_str(result.get("header", "")),
        "stats": result["stats"],
        "rows": cleaned_rows,
    }
