"""Tests for result_format.clean_result (the MCP tool-response projection)."""

from result_format import clean_result, missing_invoices


def _engine_row():
    # Shape emitted by engine/collection.py: date/desc/amount/status/label/detail/doc_id
    return {
        "rows": [
            {
                "date": "2026-03-25",
                "desc": "\033[32mFAKTURA 12345\033[0m".ljust(40),
                "amount": "123.45",
                "status": "ok",
                "label": "OK",
                "detail": "Anthropic PBC — invoice #12345",
                "doc_id": 411,
            }
        ],
        "month": "2026-03",
        "header": "\033[1mMarch 2026\033[0m",
        "stats": {"ok": 1, "missing": 0},
    }


def test_maps_engine_row_keys_to_response_fields():
    """description/invoice_name/skip_label must be populated from the engine's
    desc/detail/label keys — not the same-named keys the engine never emits."""
    row = clean_result(_engine_row())["rows"][0]
    assert row["status"] == "ok"
    assert row["amount"] == "123.45"
    assert row["doc_id"] == 411
    assert row["description"].strip() == "FAKTURA 12345"
    assert row["invoice_name"] == "Anthropic PBC — invoice #12345"
    assert row["skip_label"] == "OK"


def test_missing_invoices_projects_desc_with_amount():
    """get_month_status' missing list must read the engine's `desc` key, not the
    `description` key the engine never emits (same bug class as clean_result)."""
    result = {
        "rows": [
            {"status": "ok", "amount": "10.00", "desc": "paid thing"},
            {"status": "missing", "amount": "55.50", "desc": "UNPAID FAKTURA 999"},
            {"status": "missing", "amount": "12.00", "desc": "another missing"},
        ],
    }
    missing = missing_invoices(result)
    assert len(missing) == 2
    assert missing[0] == {"amount": "55.50", "description": "UNPAID FAKTURA 999"}
    assert missing[1]["description"] == "another missing"


def test_strips_ansi_codes():
    cleaned = clean_result(_engine_row())
    assert "\033[" not in cleaned["header"]
    assert "\033[" not in cleaned["rows"][0]["description"]


def test_clean_result_forwards_bundle_docs():
    result = {
        "month": "2026-03", "header": "", "stats": {},
        "rows": [{"status": "ok", "amount": "120.00-", "desc": "x", "detail": "final",
                  "doc_id": 3, "label": "OK",
                  "bundle_docs": [{"title": "proforma", "doc_id": 1}]}],
    }
    out = clean_result(result)
    assert out["rows"][0]["bundle_docs"] == [{"title": "proforma", "doc_id": 1}]
