#!/usr/bin/env python3
"""Unit tests for engine.collection (collect_month / collect_pl orchestration).

Split out of test_matching.py (task 102 Phase 3) — this file covers the
collection/orchestration layer; pure parsing and core matching-engine
tests moved to test_parsing.py / test_matching.py respectively.

Shared mock builders, document factories, and collect_pl helpers live in
conftest.py.

Run: python -m pytest test_collection.py -v
"""

import pytest
from unittest.mock import MagicMock

from engine.collection import (
    collect_month,
    filter_resolved_unmatched,
)
from engine.matching import MONTH_WINDOW, month_offset

from conftest import (
    INVOICE_TYPE_ID,
    RECEIPT_DATETIME_FIELD_ID,
    TAG_IDS,
    TOTAL_AMOUNT_FIELD_ID,
    TX_GROUP_FIELD_ID,
    _collect,
    _collect_pl,
    _make_bundle_invoice,
    _make_invoice,
    _make_invoice_alt,
    _make_invoice_no_field,
    _make_statement,
    _matched_doc_ids,
    _mock_client,
    _mock_client_for_pl,
    _process_months,
    _process_months_with_warmup,
    _process_with_full_history,
    _stmt,
)


class TestCollectMonthBasicMatching:
    """Basic single-month matching scenarios."""

    def test_single_movement_matched_ok(self):
        stmt = _make_statement(
            900,
            "2026-01",
            _stmt(
                ("08.01.2026", "POS purchase", -70.07),
            ),
        )
        inv = _make_invoice(1, "inv_shop", "inv_shop.pdf", "2026-01", 70.07)
        client = _mock_client(
            {
                TAG_IDS["2025-12"]: [],
                TAG_IDS["2026-01"]: [stmt, inv],
                TAG_IDS["2026-02"]: [],
            }
        )
        result = _collect(client, "2026-01")
        assert result["stats"]["ok"] == 1
        assert result["rows"][0]["status"] == "ok"
        assert result["rows"][0]["doc_id"] == 1

    def test_multiple_movements_matched(self):
        stmt = _make_statement(
            900,
            "2026-01",
            _stmt(
                ("08.01.2026", "Purchase A", -50.00),
                ("09.01.2026", "Purchase B", -100.00),
            ),
        )
        inv_a = _make_invoice(1, "inv_a", "inv_a.pdf", "2026-01", 50.00)
        inv_b = _make_invoice(2, "inv_b", "inv_b.pdf", "2026-01", 100.00)
        client = _mock_client(
            {
                TAG_IDS["2025-12"]: [],
                TAG_IDS["2026-01"]: [stmt, inv_a, inv_b],
                TAG_IDS["2026-02"]: [],
            }
        )
        result = _collect(client, "2026-01")
        assert result["stats"]["ok"] == 2

    def test_missing_invoice(self):
        stmt = _make_statement(
            900,
            "2026-01",
            _stmt(
                ("08.01.2026", "Unmatched purchase", -99.99),
            ),
        )
        client = _mock_client(
            {
                TAG_IDS["2025-12"]: [],
                TAG_IDS["2026-01"]: [stmt],
                TAG_IDS["2026-02"]: [],
            }
        )
        result = _collect(client, "2026-01")
        assert result["stats"]["missing"] == 1
        assert result["rows"][0]["status"] == "missing"

    def test_skipped_movement(self):
        stmt = _make_statement(
            900,
            "2026-01",
            _stmt(
                ("08.01.2026", "Transakčná daň za obdobie", -5.00),
            ),
        )
        client = _mock_client(
            {
                TAG_IDS["2025-12"]: [],
                TAG_IDS["2026-01"]: [stmt],
                TAG_IDS["2026-02"]: [],
            }
        )
        result = _collect(client, "2026-01")
        assert result["stats"]["skipped"] == 1
        assert result["rows"][0]["status"] == "skipped"

    def test_no_tag_found(self):
        client = MagicMock()
        client.get_tag_id.return_value = None
        result = collect_month(
            client, "2099-01", TAG_IDS["account-statement"], TAG_IDS["accounting"],
            INVOICE_TYPE_ID, TOTAL_AMOUNT_FIELD_ID, {},
        )
        assert "No tag found" in result["header"]
        assert result["rows"] == []

    def test_no_statement_or_invoices(self):
        client = _mock_client(
            {
                TAG_IDS["2025-12"]: [],
                TAG_IDS["2026-01"]: [],
                TAG_IDS["2026-02"]: [],
            }
        )
        result = _collect(client, "2026-01")
        assert "No statement or invoices" in result["header"]


class TestCollectMonthPending:
    """Month with invoices but no statement yet."""

    def test_invoices_shown_as_pending(self):
        inv = _make_invoice(1, "inv_pending", "inv.pdf", "2026-01", 50.00)
        client = _mock_client(
            {
                TAG_IDS["2025-12"]: [],
                TAG_IDS["2026-01"]: [inv],
                TAG_IDS["2026-02"]: [],
            }
        )
        result = _collect(client, "2026-01")
        assert result["stats"]["manual"] == 1
        assert result["rows"][0]["status"] == "pending"
        assert result["rows"][0]["label"] == "PENDING"

    def test_pending_only_shows_month_tagged_invoices(self):
        """Invoice from window month shouldn't show as pending in current month."""
        inv_jan = _make_invoice(1, "jan_inv", "jan.pdf", "2026-01", 50.00)
        inv_feb = _make_invoice(2, "feb_inv", "feb.pdf", "2026-02", 80.00)
        client = _mock_client(
            {
                TAG_IDS["2025-12"]: [],
                TAG_IDS["2026-01"]: [inv_jan],
                TAG_IDS["2026-02"]: [inv_feb],
                TAG_IDS["2026-03"]: [],
            }
        )
        # Feb has no statement — should only show feb_inv as pending, not jan_inv
        result = _collect(client, "2026-02")
        assert len(result["rows"]) == 1
        assert result["rows"][0]["doc_id"] == 2

    def test_pending_date_from_receipt_datetime(self):
        """Pending row date comes from the receipt_datetime custom field."""
        inv = _make_invoice(1, "inv", "inv.pdf", "2026-01", 50.00)
        inv["custom_fields"].append(
            {"field": RECEIPT_DATETIME_FIELD_ID, "value": "2026-01-15T13:45:00"}
        )
        inv["created"] = "2026-01-20T00:00:00+01:00"
        client = _mock_client({TAG_IDS["2026-01"]: [inv]})
        result = _collect(client, "2026-01")
        assert result["rows"][0]["date"] == "2026-01-15"

    def test_pending_date_falls_back_to_created(self):
        """Without receipt_datetime, the row date comes from `created`."""
        inv = _make_invoice(1, "inv", "inv.pdf", "2026-01", 50.00)
        inv["created"] = "2026-01-20T00:00:00+01:00"
        client = _mock_client({TAG_IDS["2026-01"]: [inv]})
        result = _collect(client, "2026-01")
        assert result["rows"][0]["date"] == "2026-01-20"

    def test_pending_rows_sorted_oldest_first(self):
        """Pending rows order ascending by date; blank dates sort last."""
        inv_a = _make_invoice(1, "inv_a", "a.pdf", "2026-01", 10.00)
        inv_a["created"] = "2026-01-20T00:00:00+01:00"
        inv_b = _make_invoice(2, "inv_b", "b.pdf", "2026-01", 20.00)
        inv_b["custom_fields"].append(
            {"field": RECEIPT_DATETIME_FIELD_ID, "value": "2026-01-05"}
        )
        inv_c = _make_invoice(3, "inv_c", "c.pdf", "2026-01", 30.00)  # no date at all
        client = _mock_client({TAG_IDS["2026-01"]: [inv_a, inv_b, inv_c]})
        result = _collect(client, "2026-01")
        assert [r["doc_id"] for r in result["rows"]] == [2, 1, 3]
        assert [r["date"] for r in result["rows"]] == ["2026-01-05", "2026-01-20", ""]


class TestCollectMonthCancelledMovements:
    """Cancelled movement pairs: +X and -X both MISSING → CANCELLED."""

    def test_opposite_missing_movements_cancel(self):
        stmt = _make_statement(
            900,
            "2026-01",
            _stmt(
                ("08.01.2026", "Charge", -50.00),
                ("09.01.2026", "Reversal", 50.00),
            ),
        )
        client = _mock_client(
            {
                TAG_IDS["2025-12"]: [],
                TAG_IDS["2026-01"]: [stmt],
                TAG_IDS["2026-02"]: [],
            }
        )
        result = _collect(client, "2026-01")
        cancelled = [r for r in result["rows"] if r["status"] == "cancelled"]
        assert len(cancelled) == 2
        assert result["stats"]["missing"] == 0

    def test_non_matching_amounts_not_cancelled(self):
        stmt = _make_statement(
            900,
            "2026-01",
            _stmt(
                ("08.01.2026", "Charge", -50.00),
                ("09.01.2026", "Different", 60.00),
            ),
        )
        client = _mock_client(
            {
                TAG_IDS["2025-12"]: [],
                TAG_IDS["2026-01"]: [stmt],
                TAG_IDS["2026-02"]: [],
            }
        )
        result = _collect(client, "2026-01")
        assert result["stats"]["missing"] == 2
        cancelled = [r for r in result["rows"] if r["status"] == "cancelled"]
        assert len(cancelled) == 0


class TestCollectMonthCancelledInvoices:
    """Cancelled invoice pairs: unmatched positive + negative invoices → CANCELLED."""

    def test_unmatched_invoice_and_credit_note_cancel(self):
        stmt = _make_statement(
            900,
            "2026-01",
            _stmt(
                ("08.01.2026", "Some purchase", -30.00),
            ),
        )
        inv_purchase = _make_invoice(1, "inv_purchase", "inv.pdf", "2026-01", 30.00)
        inv_pos = _make_invoice(10, "inv_pos", "inv_pos.pdf", "2026-01", 200.00)
        inv_neg = _make_invoice(11, "dobropis", "dobropis.pdf", "2026-01", -200.00)
        client = _mock_client(
            {
                TAG_IDS["2025-12"]: [],
                TAG_IDS["2026-01"]: [stmt, inv_purchase, inv_pos, inv_neg],
                TAG_IDS["2026-02"]: [],
            }
        )
        result = _collect(client, "2026-01")
        cancelled = [r for r in result["rows"] if r["status"] == "cancelled"]
        cancelled_ids = {r["doc_id"] for r in cancelled}
        assert {10, 11} == cancelled_ids


class TestCollectMonthUnmatchedInvoices:
    """Unmatched invoices → NEXT STATEMENT."""

    def test_unmatched_invoice_shown_as_next_statement(self):
        stmt = _make_statement(
            900,
            "2026-01",
            _stmt(
                ("08.01.2026", "Purchase", -50.00),
            ),
        )
        inv_matched = _make_invoice(1, "inv_matched", "m.pdf", "2026-01", 50.00)
        inv_extra = _make_invoice(2, "inv_extra", "e.pdf", "2026-01", 999.00)
        client = _mock_client(
            {
                TAG_IDS["2025-12"]: [],
                TAG_IDS["2026-01"]: [stmt, inv_matched, inv_extra],
                TAG_IDS["2026-02"]: [],
            }
        )
        result = _collect(client, "2026-01")
        info_rows = [r for r in result["rows"] if r["status"] == "info"]
        assert len(info_rows) == 1
        assert info_rows[0]["doc_id"] == 2

    def test_unmatched_only_for_current_month_tag(self):
        """Invoices from window months don't show as unmatched for current month."""
        stmt = _make_statement(
            900,
            "2026-02",
            _stmt(
                ("08.02.2026", "Purchase", -50.00),
            ),
        )
        inv_matched = _make_invoice(1, "inv", "inv.pdf", "2026-02", 50.00)
        # This invoice is tagged 2026-01 — in Feb's window but not Feb's month
        inv_jan = _make_invoice(2, "jan_extra", "j.pdf", "2026-01", 888.00)
        client = _mock_client(
            {
                TAG_IDS["2026-01"]: [inv_jan],
                TAG_IDS["2026-02"]: [stmt, inv_matched],
                TAG_IDS["2026-03"]: [],
            }
        )
        result = _collect(client, "2026-02")
        info_rows = [r for r in result["rows"] if r["status"] == "info"]
        assert len(info_rows) == 0


class TestCollectMonthCrossWindowMatching:
    """Invoices from adjacent months are included via the ±1 month window."""

    def test_invoice_from_previous_month_matches(self):
        """Invoice tagged Dec matches Jan movement (within window)."""
        stmt = _make_statement(
            900,
            "2026-01",
            _stmt(
                ("05.01.2026", "Late payment", -120.00),
            ),
        )
        inv_dec = _make_invoice(1, "dec_invoice", "dec.pdf", "2025-12", 120.00)
        client = _mock_client(
            {
                TAG_IDS["2025-11"]: [],
                TAG_IDS["2025-12"]: [inv_dec],
                TAG_IDS["2026-01"]: [stmt],
                TAG_IDS["2026-02"]: [],
            }
        )
        result = _collect(client, "2026-01")
        assert result["stats"]["ok"] == 1
        assert result["rows"][0]["doc_id"] == 1

    def test_invoice_from_next_month_matches(self):
        """Invoice tagged Feb matches Jan movement (within window)."""
        stmt = _make_statement(
            900,
            "2026-01",
            _stmt(
                ("28.01.2026", "Early invoice", -80.00),
            ),
        )
        inv_feb = _make_invoice(1, "feb_invoice", "feb.pdf", "2026-02", 80.00)
        client = _mock_client(
            {
                TAG_IDS["2025-12"]: [],
                TAG_IDS["2026-01"]: [stmt],
                TAG_IDS["2026-02"]: [inv_feb],
                TAG_IDS["2026-03"]: [],
            }
        )
        result = _collect(client, "2026-01")
        assert result["stats"]["ok"] == 1


class TestCollectMonthAmountSources:
    """Amount extraction: custom field vs regex from content."""

    def test_custom_field_preferred(self):
        stmt = _make_statement(
            900,
            "2026-01",
            _stmt(
                ("08.01.2026", "Purchase", -50.00),
            ),
        )
        inv = _make_invoice(1, "inv", "inv.pdf", "2026-01", 50.00)
        # Also put a different amount in content to verify field wins
        inv["content"] = "Total: 99.99 EUR"
        client = _mock_client(
            {
                TAG_IDS["2025-12"]: [],
                TAG_IDS["2026-01"]: [stmt, inv],
                TAG_IDS["2026-02"]: [],
            }
        )
        result = _collect(client, "2026-01")
        assert result["stats"]["ok"] == 1

    def test_regex_fallback_when_no_field(self):
        stmt = _make_statement(
            900,
            "2026-01",
            _stmt(
                ("08.01.2026", "Purchase", -75.50),
            ),
        )
        inv = _make_invoice_no_field(
            1, "inv", "inv.pdf", "2026-01", "Celkom k úhrade: 75,50 EUR"
        )
        client = _mock_client(
            {
                TAG_IDS["2025-12"]: [],
                TAG_IDS["2026-01"]: [stmt, inv],
                TAG_IDS["2026-02"]: [],
            }
        )
        result = _collect(client, "2026-01")
        assert result["stats"]["ok"] == 1


class TestCollectMonthAccountingTagFilter:
    """Only documents with the 'accounting' tag should participate."""

    def test_doc_without_accounting_tag_excluded(self):
        stmt = _make_statement(
            900,
            "2026-01",
            _stmt(
                ("08.01.2026", "Purchase", -50.00),
            ),
        )
        inv = _make_invoice(1, "inv", "inv.pdf", "2026-01", 50.00)
        # Remove the accounting tag — doc should be excluded from matching
        inv["tags"] = [TAG_IDS["2026-01"]]
        client = _mock_client(
            {
                TAG_IDS["2025-12"]: [],
                TAG_IDS["2026-01"]: [stmt, inv],
                TAG_IDS["2026-02"]: [],
            }
        )
        result = _collect(client, "2026-01")
        assert result["stats"]["missing"] == 1


class TestCollectMonthPairedDocsEnrichment:
    """Rows matched to paired invoices show both docs."""

    def test_paired_docs_shown(self):
        stmt = _make_statement(
            900,
            "2026-01",
            _stmt(
                ("08.01.2026", "Purchase", -90.00),
            ),
        )
        fa = _make_invoice(1, "20260106_fa", "20260106_fa.pdf", "2026-01", 90.00)
        doklad = _make_invoice(
            2, "20260106_doklad", "20260106_doklad.pdf", "2026-01", 90.00
        )
        client = _mock_client(
            {
                TAG_IDS["2025-12"]: [],
                TAG_IDS["2026-01"]: [stmt, fa, doklad],
                TAG_IDS["2026-02"]: [],
            }
        )
        result = _collect(client, "2026-01")
        ok_row = result["rows"][0]
        assert ok_row["status"] == "ok"
        assert ok_row.get("paired_docs") is not None
        paired_ids = {d["doc_id"] for d in ok_row["paired_docs"]}
        assert paired_ids == {1, 2}


class TestCollectMonthGlobalMatchedIds:
    """global_matched_ids prevents double-matching across months."""

    def test_invoice_not_rematched_in_second_month(self):
        """Same-amount movements in two months: invoice matched once."""
        jan_stmt = _make_statement(
            900,
            "2026-01",
            _stmt(
                ("08.01.2026", "Purchase", -50.00),
            ),
        )
        feb_stmt = _make_statement(
            901,
            "2026-02",
            _stmt(
                ("08.02.2026", "Purchase", -50.00),
            ),
        )
        inv = _make_invoice(1, "inv", "inv.pdf", "2026-01", 50.00)
        client = _mock_client(
            {
                TAG_IDS["2025-12"]: [],
                TAG_IDS["2026-01"]: [jan_stmt, inv],
                TAG_IDS["2026-02"]: [feb_stmt],
                TAG_IDS["2026-03"]: [],
            }
        )
        results = _process_months(client, ["2026-01", "2026-02"])
        all_matched = []
        for r in results:
            for row in r["rows"]:
                if row["status"] in ("ok", "manual") and row.get("doc_id"):
                    all_matched.append(row["doc_id"])
        assert all_matched.count(1) == 1

    def test_global_ids_propagated(self):
        """After processing, global_matched_ids contains all matched doc IDs."""
        stmt = _make_statement(
            900,
            "2026-01",
            _stmt(
                ("08.01.2026", "Purchase", -50.00),
            ),
        )
        inv = _make_invoice(1, "inv", "inv.pdf", "2026-01", 50.00)
        client = _mock_client(
            {
                TAG_IDS["2025-12"]: [],
                TAG_IDS["2026-01"]: [stmt, inv],
                TAG_IDS["2026-02"]: [],
            }
        )
        global_ids = set()
        _collect(client, "2026-01", global_matched_ids=global_ids)
        assert 1 in global_ids


class TestAltAmountMatching:
    """Invoice with total_amount_alt matches two statement rows."""

    def test_invoice_matches_both_primary_and_alt_amount(self):
        """Invoice paid in two parts (card + transfer) matches both rows."""
        stmt = _make_statement(
            900,
            "2026-01",
            _stmt(
                ("08.01.2026", "EUR NÁKUP POS", -165.24),
                ("08.01.2026", "EUR NÁKUP POS", -6.26),
            ),
        )
        inv = _make_invoice_alt(
            244, "fa_hotel", "fa_hotel.pdf", "2026-01", 165.24, 6.26
        )
        client = _mock_client(
            {
                TAG_IDS["2025-12"]: [],
                TAG_IDS["2026-01"]: [stmt, inv],
                TAG_IDS["2026-02"]: [],
            }
        )
        result = _collect(client, "2026-01")
        ok_rows = [r for r in result["rows"] if r["status"] == "ok"]
        assert len(ok_rows) == 2, f"Both amounts should match, got {result['stats']}"
        matched_ids = {r["doc_id"] for r in ok_rows}
        assert 244 in matched_ids

    def test_alt_amount_matches_across_months(self):
        """Primary matched in Aug, alt amount matched in Sep (cross-month)."""
        aug_stmt = _make_statement(
            900,
            "2026-01",
            _stmt(
                ("22.01.2026", "EUR NÁKUP POS", -165.24),
            ),
        )
        sep_stmt = _make_statement(
            901,
            "2026-02",
            _stmt(
                ("01.02.2026", "EUR NÁKUP POS", -6.26),
            ),
        )
        inv = _make_invoice_alt(
            244, "fa_hotel", "fa_hotel.pdf", "2026-01", 165.24, 6.26
        )
        client = _mock_client(
            {
                TAG_IDS["2025-12"]: [],
                TAG_IDS["2026-01"]: [aug_stmt, inv],
                TAG_IDS["2026-02"]: [sep_stmt],
                TAG_IDS["2026-03"]: [],
            }
        )
        results = _process_months(client, ["2026-01", "2026-02"])
        jan_ok = [r for r in results[0]["rows"] if r["status"] == "ok"]
        feb_ok = [r for r in results[1]["rows"] if r["status"] == "ok"]
        assert len(jan_ok) == 1, "Primary amount should match in Jan"
        assert len(feb_ok) == 1, "Alt amount should match in Feb"

    def test_invoice_without_alt_still_matches_once(self):
        """Normal invoice (no alt) should still only match one row."""
        stmt = _make_statement(
            900,
            "2026-01",
            _stmt(
                ("08.01.2026", "Purchase A", -50.00),
                ("09.01.2026", "Purchase B", -50.00),
            ),
        )
        inv = _make_invoice(1, "inv", "inv.pdf", "2026-01", 50.00)
        client = _mock_client(
            {
                TAG_IDS["2025-12"]: [],
                TAG_IDS["2026-01"]: [stmt, inv],
                TAG_IDS["2026-02"]: [],
            }
        )
        result = _collect(client, "2026-01")
        assert result["stats"]["ok"] == 1
        assert result["stats"]["missing"] == 1


class TestCollectMonthForeignCurrency:
    """Foreign currency orig_amount matching."""

    def test_orig_amount_matches(self):
        content = "08.01.2026 INT NÁKUP POS EUR  90.00-\nOrig. suma: 100.00- CZK\n----"
        stmt = _make_statement(900, "2026-01", content)
        inv = _make_invoice(1, "inv_czk", "inv.pdf", "2026-01", 100.00)
        client = _mock_client(
            {
                TAG_IDS["2025-12"]: [],
                TAG_IDS["2026-01"]: [stmt, inv],
                TAG_IDS["2026-02"]: [],
            }
        )
        result = _collect(client, "2026-01")
        assert result["stats"]["ok"] == 1


# ═════════════════════════════════════════════════════════════════════════════
# Multi-month pipeline tests
# ═════════════════════════════════════════════════════════════════════════════


class TestOlderInvoicePreference:
    """Older unclaimed invoices are preferred over same-month invoices.

    Real-world pattern: invoices issued month M, paid in month M+1.
    With oldest-first processing, each month claims its own invoices first.
    Unclaimed older invoices are picked up by the next month's payment.
    """

    def test_three_months_each_has_own_invoice_and_payment(self):
        """Dec, Jan, Feb each have 90.00 movement and own 90.00 invoice.

        With oldest-first, each month claims its own invoice before later months see it.
        """
        dec_stmt = _make_statement(
            898,
            "2025-12",
            _stmt(
                ("09.12.2025", "INT NÁKUP POS EUR", -90.00),
            ),
        )
        jan_stmt = _make_statement(
            900,
            "2026-01",
            _stmt(
                ("08.01.2026", "INT NÁKUP POS EUR", -90.00),
            ),
        )
        feb_stmt = _make_statement(
            901,
            "2026-02",
            _stmt(
                ("09.02.2026", "INT NÁKUP POS EUR", -90.00),
            ),
        )
        dec_inv = _make_invoice(
            10, "202512_fa_sw", "202512_fa_sw.pdf", "2025-12", 90.00
        )
        jan_inv = _make_invoice(
            20, "20260106_fa_ai", "20260106_fa_ai.pdf", "2026-01", 90.00
        )
        feb_inv = _make_invoice(
            30, "20260205_fa_ai", "20260205_fa_ai.pdf", "2026-02", 90.00
        )
        client = _mock_client(
            {
                TAG_IDS["2025-11"]: [],
                TAG_IDS["2025-12"]: [dec_stmt, dec_inv],
                TAG_IDS["2026-01"]: [jan_stmt, jan_inv],
                TAG_IDS["2026-02"]: [feb_stmt, feb_inv],
                TAG_IDS["2026-03"]: [],
            }
        )
        results = _process_months(client, ["2025-12", "2026-01", "2026-02"])
        dec_matched = _matched_doc_ids(results[0])
        jan_matched = _matched_doc_ids(results[1])
        feb_matched = _matched_doc_ids(results[2])
        assert dec_inv["id"] in dec_matched, "Dec should match its own invoice"
        assert jan_inv["id"] in jan_matched, "Jan should match its own invoice"
        assert feb_inv["id"] in feb_matched, "Feb should match its own invoice"

    def test_unclaimed_older_invoice_matched_by_next_month(self):
        """Invoice issued Jan (no Jan payment), paid in Feb. Feb also has own invoice.

        Feb payment should match Jan's older unclaimed invoice.
        Feb's own invoice should be NEXT STATEMENT (awaiting March payment).
        """
        jan_stmt = _make_statement(
            900,
            "2026-01",
            _stmt(
                ("08.01.2026", "Different purchase", -50.00),
            ),
        )
        feb_stmt = _make_statement(
            901,
            "2026-02",
            _stmt(
                ("08.02.2026", "Recurring payment", -90.00),
            ),
        )
        jan_inv = _make_invoice(1, "jan_recurring", "jan.pdf", "2026-01", 90.00)
        feb_inv = _make_invoice(2, "feb_recurring", "feb.pdf", "2026-02", 90.00)
        client = _mock_client(
            {
                TAG_IDS["2025-12"]: [],
                TAG_IDS["2026-01"]: [jan_stmt, jan_inv],
                TAG_IDS["2026-02"]: [feb_stmt, feb_inv],
                TAG_IDS["2026-03"]: [],
            }
        )
        results = _process_months(client, ["2026-01", "2026-02"])
        feb_matched = _matched_doc_ids(results[1])
        assert 1 in feb_matched, (
            "Feb should match Jan's unclaimed invoice (older first)"
        )
        # Feb's own invoice should be unmatched (awaiting March)
        feb_info = [r for r in results[1]["rows"] if r.get("doc_id") == 2]
        assert any(r["status"] in ("info", "unaccounted") for r in feb_info), (
            "Feb's own invoice should be NEXT STATEMENT"
        )

    def test_window_invoice_used_when_no_same_month_match(self):
        """If no same-month invoice matches, window invoice should still work."""
        stmt = _make_statement(
            900,
            "2026-02",
            _stmt(
                ("08.02.2026", "Purchase", -90.00),
            ),
        )
        jan_inv = _make_invoice(1, "jan_inv", "jan.pdf", "2026-01", 90.00)
        client = _mock_client(
            {
                TAG_IDS["2026-01"]: [jan_inv],
                TAG_IDS["2026-02"]: [stmt],
                TAG_IDS["2026-03"]: [],
            }
        )
        result = _collect(client, "2026-02")
        assert result["stats"]["ok"] == 1
        assert result["rows"][0]["doc_id"] == 1

    def test_jan_claims_own_then_feb_missing(self):
        """Jan has payment + invoice. Feb has same-amount payment but no invoice → MISSING."""
        jan_stmt = _make_statement(
            900,
            "2026-01",
            _stmt(
                ("08.01.2026", "Purchase", -90.00),
            ),
        )
        feb_stmt = _make_statement(
            901,
            "2026-02",
            _stmt(
                ("08.02.2026", "Purchase", -90.00),
            ),
        )
        jan_inv = _make_invoice(1, "jan_inv", "jan.pdf", "2026-01", 90.00)
        client = _mock_client(
            {
                TAG_IDS["2025-12"]: [],
                TAG_IDS["2026-01"]: [jan_stmt, jan_inv],
                TAG_IDS["2026-02"]: [feb_stmt],
                TAG_IDS["2026-03"]: [],
            }
        )
        results = _process_months(client, ["2026-01", "2026-02"])
        jan_matched = _matched_doc_ids(results[0])
        assert 1 in jan_matched, "Jan should claim its own invoice"
        feb_statuses = [r["status"] for r in results[1]["rows"] if r.get("date")]
        assert "missing" in feb_statuses, "Feb should show MISSING (no invoice)"


class TestPairedInvoiceDoubleMatching:
    """Regression: paired docs (invoice + receipt) must not match in two months."""

    @pytest.fixture()
    def setup(self):
        jan_stmt = _make_statement(
            900,
            "2026-01",
            _stmt(
                ("08.01.2026", "INT NÁKUP POS EUR", -90.00),
            ),
        )
        feb_stmt = _make_statement(
            901,
            "2026-02",
            _stmt(
                ("09.02.2026", "INT NÁKUP POS EUR", -90.00),
            ),
        )
        fa = _make_invoice(
            322, "20260106_fa_ai", "20260106_fa_ai.pdf", "2026-01", 90.00
        )
        doklad = _make_invoice(
            332, "20260106_doklad_ai", "20260106_doklad_ai.pdf", "2026-01", 90.00
        )
        docs = {
            TAG_IDS["2025-12"]: [],
            TAG_IDS["2026-01"]: [jan_stmt, fa, doklad],
            TAG_IDS["2026-02"]: [feb_stmt],
            TAG_IDS["2026-03"]: [],
        }
        return _mock_client(docs), fa, doklad

    def test_paired_invoice_matched_only_once(self, setup):
        client, fa, _ = setup
        results = _process_months(client, ["2026-01", "2026-02"])
        matched_by_month = {}
        for r in results:
            ids = set()
            for row in r["rows"]:
                if row["status"] in ("ok", "manual") and row.get("doc_id"):
                    ids.add(row["doc_id"])
                    for pd in row.get("paired_docs") or []:
                        ids.add(pd["doc_id"])
            matched_by_month[r["month"]] = ids
        months = [m for m, ids in matched_by_month.items() if fa["id"] in ids]
        assert len(months) <= 1

    def test_each_movement_matches_distinct_doc(self, setup):
        client, _, _ = setup
        results = _process_months(client, ["2026-01", "2026-02"])
        doc_ids = [
            row["doc_id"]
            for r in results
            for row in r["rows"]
            if row["status"] in ("ok", "manual")
            and row.get("date")
            and row.get("doc_id")
        ]
        assert len(doc_ids) == len(set(doc_ids))


class TestFilterResolvedUnmatched:
    """Cross-month resolution of NEXT STATEMENT entries."""

    def _make_results(self, jan_rows, feb_rows, jan_header_doc=900, feb_header_doc=901):
        return [
            {
                "month": "2026-01",
                "header_doc_id": jan_header_doc,
                "rows": jan_rows,
                "stats": {
                    "total": len(jan_rows),
                    "skipped": 0,
                    "ok": 0,
                    "manual": 0,
                    "missing": 0,
                    "info": sum(1 for r in jan_rows if r["status"] == "info"),
                },
            },
            {
                "month": "2026-02",
                "header_doc_id": feb_header_doc,
                "rows": feb_rows,
                "stats": {
                    "total": len(feb_rows),
                    "skipped": 0,
                    "ok": 0,
                    "manual": 0,
                    "missing": 0,
                    "info": sum(1 for r in feb_rows if r["status"] == "info"),
                },
            },
        ]

    def test_resolved_in_next_month_removed(self):
        """Invoice unmatched in Jan, matched in Feb → removed from Jan."""
        jan_rows = [
            {
                "status": "info",
                "doc_id": 1,
                "label": "NEXT STATEMENT",
                "detail": "not in this statement",
                "amount": "50.00 ",
            },
        ]
        feb_rows = [
            {
                "status": "ok",
                "doc_id": 1,
                "label": "OK",
                "detail": "inv",
                "amount": "50.00-",
                "date": "08.02.2026",
            },
        ]
        results = self._make_results(jan_rows, feb_rows)
        filter_resolved_unmatched(results)
        assert len(results[0]["rows"]) == 0
        assert results[0]["stats"]["info"] == 0

    def test_not_in_next_month_escalated(self):
        """Invoice unmatched in Jan, Feb has statement but no match → NOT IN STATEMENTS."""
        jan_rows = [
            {
                "status": "info",
                "doc_id": 1,
                "label": "NEXT STATEMENT",
                "detail": "not in this statement",
                "amount": "50.00 ",
            },
        ]
        feb_rows = [
            {
                "status": "ok",
                "doc_id": 99,
                "label": "OK",
                "detail": "other",
                "amount": "30.00-",
                "date": "08.02.2026",
            },
        ]
        results = self._make_results(jan_rows, feb_rows)
        filter_resolved_unmatched(results)
        assert results[0]["rows"][0]["status"] == "unaccounted"
        assert results[0]["rows"][0]["label"] == "NOT IN STATEMENTS"

    def test_no_next_statement_keeps_info(self):
        """No Feb statement → Jan's NEXT STATEMENT kept as-is."""
        jan_rows = [
            {
                "status": "info",
                "doc_id": 1,
                "label": "NEXT STATEMENT",
                "detail": "not in this statement",
                "amount": "50.00 ",
            },
        ]
        results = self._make_results(jan_rows, [], feb_header_doc=None)
        filter_resolved_unmatched(results)
        assert results[0]["rows"][0]["status"] == "info"


class TestDocCache:
    """doc_cache should be shared across months to avoid redundant API calls."""

    def test_doc_cache_reused(self):
        """Second month reuses cached docs from first month's window fetch."""
        jan_stmt = _make_statement(
            900,
            "2026-01",
            _stmt(
                ("08.01.2026", "Purchase", -50.00),
            ),
        )
        feb_stmt = _make_statement(
            901,
            "2026-02",
            _stmt(
                ("08.02.2026", "Purchase", -50.00),
            ),
        )
        inv = _make_invoice(1, "inv", "inv.pdf", "2026-01", 50.00)
        docs = {
            TAG_IDS["2025-12"]: [],
            TAG_IDS["2026-01"]: [jan_stmt, inv],
            TAG_IDS["2026-02"]: [feb_stmt],
            TAG_IDS["2026-03"]: [],
        }
        client = _mock_client(docs)
        doc_cache = {}
        global_ids = set()
        _collect(client, "2026-02", doc_cache=doc_cache, global_matched_ids=global_ids)
        _collect(client, "2026-01", doc_cache=doc_cache, global_matched_ids=global_ids)

        # Count calls for tag 2026-01 docs — should be fetched only once
        calls = [
            c
            for c in client.get_documents_by_tag.call_args_list
            if c.args and c.args[0] == TAG_IDS["2026-01"]
        ]
        assert len(calls) == 1


class TestMixedStatuses:
    """End-to-end scenario with mixed ok, skipped, missing, cancelled, pending."""

    def test_mixed_statement(self):
        content = _stmt(
            ("08.01.2026", "Regular purchase", -50.00),
            ("09.01.2026", "Transakčná daň za obdobie", -3.00),
            ("10.01.2026", "Unknown vendor", -777.77),
            ("11.01.2026", "Charge refund", -25.00),
            ("12.01.2026", "Charge refund reversal", 25.00),
        )
        stmt = _make_statement(900, "2026-01", content)
        inv = _make_invoice(1, "inv_purchase", "inv.pdf", "2026-01", 50.00)
        client = _mock_client(
            {
                TAG_IDS["2025-12"]: [],
                TAG_IDS["2026-01"]: [stmt, inv],
                TAG_IDS["2026-02"]: [],
            }
        )
        result = _collect(client, "2026-01")
        stats = result["stats"]
        assert stats["ok"] == 1  # 50.00 matched
        assert (
            stats["skipped"] >= 1
        )  # bank fee + cancelled movements counted as skipped
        assert stats["missing"] >= 0
        # Total rows should account for all 5 movements + any unmatched invoices
        assert stats["total"] >= 5




# ═════════════════════════════════════════════════════════════════════════════
# collect_pl tests
# ═════════════════════════════════════════════════════════════════════════════


class TestCollectPLNoNPlusOne:
    """P&L must not fetch each matched invoice individually — tags are read
    from the doc_cache list response. Regression guard for the N+1 in
    get_invoice_month that hit Paperless once per matched invoice before
    the doc_cache-backed index was introduced.
    """

    def test_get_document_not_called_for_cached_invoices(self):
        content = _stmt(
            ("11.01.2026", "Payment 1", 1000.00),
            ("12.01.2026", "Payment 2", 500.00),
            ("13.01.2026", "Vendor bill", -200.00),
        )
        stmt = _make_statement(1, "2026-01", content)
        inv1 = _make_invoice(10, "Techlab_001", "Techlab_001.pdf", "2026-01", 1000.00)
        inv2 = _make_invoice(11, "Techlab_002", "Techlab_002.pdf", "2026-01", 500.00)
        inv3 = _make_invoice(12, "vendor_bill", "vendor.pdf", "2026-01", 200.00)
        client = _mock_client_for_pl(
            {
                TAG_IDS["2025-12"]: [],
                TAG_IDS["2026-01"]: [stmt, inv1, inv2, inv3],
                TAG_IDS["2026-02"]: [],
            }
        )
        _collect_pl(client, 2026)
        assert client.get_document.call_count == 0, (
            "collect_pl should read tags from doc_cache, never from get_document"
        )


class TestCollectPLMatchedIncome:
    """P&L includes income from invoices matched to statement payments."""

    def test_matched_invoice_appears_as_income(self):
        """A positive matched invoice shows as income in P&L."""
        content = _stmt(("11.01.2026", "Payment received", 1000.00))
        stmt = _make_statement(1, "2026-01", content)
        inv = _make_invoice(10, "Techlab_001", "Techlab_001.pdf", "2026-01", 1000.00)
        client = _mock_client_for_pl(
            {
                TAG_IDS["2025-12"]: [],
                TAG_IDS["2026-01"]: [stmt, inv],
                TAG_IDS["2026-02"]: [],
            }
        )
        pl = _collect_pl(client, 2026)
        assert pl["income"] > 0
        assert len(pl["income_items"]) == 1
        item = pl["income_items"][0]
        assert item["month"] == "2026-01"
        assert item["doc_id"] == 10
        assert item["gross"] == 1000.00
        # VAT deducted: 1000 / 1.23 = 813.01
        assert item["amount"] == round(1000.00 / 1.23, 2)

    def test_expenses_from_matched_negative_invoice(self):
        """A negative matched invoice counts as invoiced expense."""
        content = _stmt(("11.01.2026", "Outgoing payment", -500.00))
        stmt = _make_statement(1, "2026-01", content)
        inv = _make_invoice(10, "vendor_bill", "vendor.pdf", "2026-01", 500.00)
        client = _mock_client_for_pl(
            {
                TAG_IDS["2025-12"]: [],
                TAG_IDS["2026-01"]: [stmt, inv],
                TAG_IDS["2026-02"]: [],
            }
        )
        pl = _collect_pl(client, 2026)
        assert "invoiced" in pl["expenses"]
        assert pl["expenses"]["invoiced"] == -500.00


class TestCollectPLUnmatchedIncome:
    """P&L includes income from unmatched Techlab invoices (known income prefix)."""

    def test_unmatched_techlab_counted_as_income(self):
        """An unmatched Techlab invoice counts as regular income."""
        content = _stmt(("11.01.2026", "Some other payment", -50.00))
        stmt = _make_statement(1, "2026-01", content)
        inv = _make_invoice(20, "Techlab_002", "Techlab_002.pdf", "2026-01", 5000.00)
        client = _mock_client_for_pl(
            {
                TAG_IDS["2025-12"]: [],
                TAG_IDS["2026-01"]: [stmt, inv],
                TAG_IDS["2026-02"]: [],
            }
        )
        pl = _collect_pl(client, 2026)
        assert pl["income"] == round(5000.00 / 1.23, 2)
        assert len(pl["income_items"]) == 1
        assert pl["income_items"][0]["doc_id"] == 20
        assert pl["income_items"][0]["gross"] == 5000.00

    def test_no_statement_techlab_counted_as_income(self):
        """Techlab invoice for a month with no statement counts as income."""
        inv = _make_invoice(30, "Techlab_003", "Techlab_003.pdf", "2026-02", 8000.00)
        client = _mock_client_for_pl(
            {
                TAG_IDS["2025-12"]: [],
                TAG_IDS["2026-01"]: [],
                TAG_IDS["2026-02"]: [inv],
                TAG_IDS["2026-03"]: [],
            }
        )
        pl = _collect_pl(client, 2026)
        assert pl["income"] == round(8000.00 / 1.23, 2)
        assert len(pl["income_items"]) == 1
        assert pl["income_items"][0]["month"] == "2026-02"

    def test_non_techlab_unmatched_not_income(self):
        """Non-Techlab unmatched invoices are NOT income (could be expenses)."""
        inv = _make_invoice(40, "fa_ucto", "fa_ucto.pdf", "2026-01", 200.00)
        client = _mock_client_for_pl(
            {
                TAG_IDS["2025-12"]: [],
                TAG_IDS["2026-01"]: [inv],
                TAG_IDS["2026-02"]: [],
            }
        )
        pl = _collect_pl(client, 2026)
        assert pl["income"] == 0.0
        assert len(pl["income_items"]) == 0

    def test_matched_techlab_not_duplicated(self):
        """A Techlab invoice matched to a payment appears only once."""
        content = _stmt(("11.01.2026", "Payment received", 1000.00))
        stmt = _make_statement(1, "2026-01", content)
        inv = _make_invoice(10, "Techlab_001", "Techlab_001.pdf", "2026-01", 1000.00)
        client = _mock_client_for_pl(
            {
                TAG_IDS["2025-12"]: [],
                TAG_IDS["2026-01"]: [stmt, inv],
                TAG_IDS["2026-02"]: [],
            }
        )
        pl = _collect_pl(client, 2026)
        assert len(pl["income_items"]) == 1

    def test_both_matched_and_unmatched_summed(self):
        """Matched + unmatched Techlab invoices both count in income total."""
        content = _stmt(("11.01.2026", "Payment received", 1000.00))
        stmt = _make_statement(1, "2026-01", content)
        matched_inv = _make_invoice(
            10, "Techlab_001", "Techlab_001.pdf", "2026-01", 1000.00
        )
        unmatched_inv = _make_invoice(
            20, "Techlab_002", "Techlab_002.pdf", "2026-02", 5000.00
        )
        client = _mock_client_for_pl(
            {
                TAG_IDS["2025-12"]: [],
                TAG_IDS["2026-01"]: [stmt, matched_inv],
                TAG_IDS["2026-02"]: [unmatched_inv],
                TAG_IDS["2026-03"]: [],
            }
        )
        pl = _collect_pl(client, 2026)
        expected = round(1000.00 / 1.23, 2) + round(5000.00 / 1.23, 2)
        assert pl["income"] == expected
        assert len(pl["income_items"]) == 2

    def test_label_uses_invoice_title(self):
        """Income label shows the invoice title, not status text."""
        inv = _make_invoice(30, "Techlab_003", "Techlab_003.pdf", "2026-02", 8000.00)
        client = _mock_client_for_pl(
            {
                TAG_IDS["2025-12"]: [],
                TAG_IDS["2026-01"]: [],
                TAG_IDS["2026-02"]: [inv],
                TAG_IDS["2026-03"]: [],
            }
        )
        pl = _collect_pl(client, 2026)
        assert len(pl["income_items"]) == 1
        assert "Techlab_003" in pl["income_items"][0]["label"]


class TestCollectPLMonthlyBreakdown:
    """Expenses and excluded have per-month breakdowns."""

    def test_expenses_have_monthly_breakdown(self):
        """Each expense category has per-month amounts."""
        jan_content = _stmt(
            ("09.01.2026", "Transakčná daň", -3.00),
            ("10.01.2026", "POS nákup", -50.00),
        )
        feb_content = _stmt(
            ("09.02.2026", "Transakčná daň", -5.00),
        )
        jan_stmt = _make_statement(1, "2026-01", jan_content)
        feb_stmt = _make_statement(2, "2026-02", feb_content)
        jan_inv = _make_invoice(10, "vendor", "vendor.pdf", "2026-01", 50.00)
        client = _mock_client_for_pl(
            {
                TAG_IDS["2025-12"]: [],
                TAG_IDS["2026-01"]: [jan_stmt, jan_inv],
                TAG_IDS["2026-02"]: [feb_stmt],
                TAG_IDS["2026-03"]: [],
            }
        )
        pl = _collect_pl(client, 2026)
        # Bank fee should have monthly breakdown
        bank_fee = pl["expenses_detail"]["bank fee"]
        assert bank_fee["2026-01"] == -3.00
        assert bank_fee["2026-02"] == -5.00
        # Invoiced expense
        invoiced = pl["expenses_detail"]["invoiced"]
        assert invoiced["2026-01"] == -50.00

    def test_excluded_has_monthly_breakdown(self):
        """Excluded items have per-month amounts."""
        jan_content = _stmt(
            ("09.01.2026", "Platba DPH januar", -100.00),
        )
        feb_content = _stmt(
            ("09.02.2026", "Platba DPH februar", -200.00),
        )
        jan_stmt = _make_statement(1, "2026-01", jan_content)
        feb_stmt = _make_statement(2, "2026-02", feb_content)
        client = _mock_client_for_pl(
            {
                TAG_IDS["2025-12"]: [],
                TAG_IDS["2026-01"]: [jan_stmt],
                TAG_IDS["2026-02"]: [feb_stmt],
                TAG_IDS["2026-03"]: [],
            }
        )
        pl = _collect_pl(client, 2026)
        assert "excluded_detail" in pl
        assert pl["excluded"] == -300.00
        # Tax should have per-month entries
        total_monthly = sum(
            sum(months.values()) for months in pl["excluded_detail"].values()
        )
        assert total_monthly == -300.00




# ═════════════════════════════════════════════════════════════════════════════
# Pre-processing warmup (default view fix)
# ═════════════════════════════════════════════════════════════════════════════


class TestPreProcessingWarmup:
    """Default view must pre-process months before the display range.

    Without pre-processing, window invoices from unprocessed months can
    steal matches when they share the same amount as displayed months'
    invoices.  The fix: run collect_month on MONTH_WINDOW months before
    the display range to populate global_matched_ids.
    """

    def _setup_same_amount_scenario(self):
        """Dec and Jan both have 90.00 invoice + 90.00 payment.

        Feb has a statement (needed for filter_resolved_unmatched).
        """
        dec_stmt = _make_statement(
            898,
            "2025-12",
            _stmt(
                ("09.12.2025", "Recurring service", -90.00),
            ),
        )
        jan_stmt = _make_statement(
            900,
            "2026-01",
            _stmt(
                ("08.01.2026", "Recurring service", -90.00),
            ),
        )
        feb_stmt = _make_statement(
            901,
            "2026-02",
            _stmt(
                ("09.02.2026", "Something else", -50.00),
            ),
        )
        dec_inv = _make_invoice(10, "Dec SaaS", "dec_saas.pdf", "2025-12", 90.00)
        jan_inv = _make_invoice(20, "Jan SaaS", "jan_saas.pdf", "2026-01", 90.00)
        client = _mock_client(
            {
                TAG_IDS["2025-11"]: [],
                TAG_IDS["2025-12"]: [dec_stmt, dec_inv],
                TAG_IDS["2026-01"]: [jan_stmt, jan_inv],
                TAG_IDS["2026-02"]: [feb_stmt],
                TAG_IDS["2026-03"]: [],
            }
        )
        return client, jan_inv

    def test_without_warmup_window_invoice_steals_match(self):
        """Bug: without pre-processing Dec, Dec's invoice steals Jan's match.

        Processing only [Jan, Feb, Mar]:
        - Jan's window includes Dec invoices (MONTH_WINDOW=1)
        - Dec invoice (90.00) appears before Jan invoice (oldest-first)
        - Dec invoice steals Jan's 90.00 payment
        - Jan's own invoice is unmatched → NEXT STATEMENT → NOT IN STATEMENTS
        """
        client, jan_inv = self._setup_same_amount_scenario()
        results = _process_months(client, ["2026-01", "2026-02", "2026-03"])
        jan_matched = _matched_doc_ids(results[0])
        assert jan_inv["id"] not in jan_matched, (
            "Bug: without warmup, Jan's invoice should be stolen by Dec's"
        )

    def test_with_warmup_correct_match(self):
        """Fix: pre-processing Dec claims Dec's invoice, Jan matches correctly."""
        client, jan_inv = self._setup_same_amount_scenario()
        results = _process_months_with_warmup(client, ["2026-01", "2026-02", "2026-03"])
        jan_matched = _matched_doc_ids(results[0])
        assert jan_inv["id"] in jan_matched, (
            "With warmup, Jan's invoice should correctly match Jan's payment"
        )

    def test_warmup_does_not_appear_in_results(self):
        """Pre-processed months must not appear in the displayed results."""
        client, _ = self._setup_same_amount_scenario()
        results = _process_months_with_warmup(client, ["2026-01", "2026-02", "2026-03"])
        result_months = [r["month"] for r in results]
        assert "2025-12" not in result_months, (
            "Pre-processed month should not be in results"
        )
        assert result_months == ["2026-01", "2026-02", "2026-03"]




class TestFullHistoryProcessing:
    """Default view must process the full statement history, not just the
    display window — otherwise window invoices from unprocessed months
    cascade-steal matches that belong to displayed months.

    Real-world reproducer: monthly Anthropic subscription. Each month has
    one 90.00 invoice and one 90.00- statement movement. With MONTH_WINDOW=1
    warmup, the warmup month's window reaches one month further back,
    pulling that invoice in. It gets iterated first (oldest-first) and
    steals the warmup month's match, cascading forward until the newest
    invoice has nothing to match against.
    """

    def _setup_cascade_scenario(self):
        """5 months (Dec 2025 → Apr 2026), each with own 90.00- payment and own 90.00 invoice."""
        stmts_invs = {}
        for i, ym in enumerate(
            ["2025-12", "2026-01", "2026-02", "2026-03", "2026-04"]
        ):
            day = "06" if ym != "2026-04" else "08"
            stmts_invs[ym] = (
                _make_statement(
                    800 + i,
                    ym,
                    _stmt(
                        (f"{day}.{ym[5:7]}.{ym[:4]}", "INT NÁKUP POS EUR", -90.00),
                    ),
                ),
                _make_invoice(
                    900 + i, f"Anthropic-{i:04d}", f"inv_{ym}.pdf", ym, 90.00
                ),
            )
        client = _mock_client(
            {
                TAG_IDS["2025-11"]: [],
                TAG_IDS["2025-12"]: list(stmts_invs["2025-12"]),
                TAG_IDS["2026-01"]: list(stmts_invs["2026-01"]),
                TAG_IDS["2026-02"]: list(stmts_invs["2026-02"]),
                TAG_IDS["2026-03"]: list(stmts_invs["2026-03"]),
                TAG_IDS["2026-04"]: list(stmts_invs["2026-04"]),
                TAG_IDS["2026-05"]: [],
            }
        )
        return client, {ym: stmts_invs[ym][1] for ym in stmts_invs}

    def test_warmup_alone_causes_cascade(self):
        """Old default-view behavior (warmup only) cascade-mismatches every month."""
        client, invs = self._setup_cascade_scenario()
        # Display Feb–Apr with MONTH_WINDOW=1 warmup → only Jan pre-processed.
        # Jan's window pulls Dec invoice → cascade through Feb, Mar, Apr.
        results = _process_months_with_warmup(
            client, ["2026-02", "2026-03", "2026-04"]
        )
        apr_matched = _matched_doc_ids(results[2])
        assert invs["2026-04"]["id"] not in apr_matched, (
            "Bug: warmup-only causes April invoice to be stolen via cascade"
        )

    def test_full_history_matches_each_month_to_own_invoice(self):
        """New behavior: process all months, display only the window — no cascade."""
        client, invs = self._setup_cascade_scenario()
        results = _process_with_full_history(
            client,
            ["2025-12", "2026-01", "2026-02", "2026-03", "2026-04"],
            ["2026-02", "2026-03", "2026-04"],
        )
        # Each displayed month must match its own invoice
        feb_matched = _matched_doc_ids(results[0])
        mar_matched = _matched_doc_ids(results[1])
        apr_matched = _matched_doc_ids(results[2])
        assert invs["2026-02"]["id"] in feb_matched
        assert invs["2026-03"]["id"] in mar_matched
        assert invs["2026-04"]["id"] in apr_matched

    def test_display_window_does_not_change_matches(self):
        """Same matches regardless of how many months are displayed."""
        client, invs = self._setup_cascade_scenario()
        all_months = ["2025-12", "2026-01", "2026-02", "2026-03", "2026-04"]
        wide = _process_with_full_history(client, all_months, all_months)
        narrow_client, _ = self._setup_cascade_scenario()
        narrow = _process_with_full_history(
            narrow_client, all_months, ["2026-03", "2026-04"]
        )
        # The two displayed months in `narrow` must have identical matches
        # to the same months in `wide`.
        wide_by_month = {r["month"]: _matched_doc_ids(r) for r in wide}
        narrow_by_month = {r["month"]: _matched_doc_ids(r) for r in narrow}
        for m in ["2026-03", "2026-04"]:
            assert wide_by_month[m] == narrow_by_month[m], (
                f"Matches for {m} differ between display windows"
            )


# ═════════════════════════════════════════════════════════════════════════════
# Returned-payment pair detection
# ═════════════════════════════════════════════════════════════════════════════




# ═════════════════════════════════════════════════════════════════════════════
# collect_month: returned-payment cancellation integration tests (Phase 3)
# ═════════════════════════════════════════════════════════════════════════════


class TestCollectMonthReturnedPayments:
    """Integration tests: detect_returned_payments wired into collect_month.

    The returned-payment detector must run BEFORE invoice matching so that
    bounced transfer legs never consume invoices.
    """

    ACCT = "1111/000000-1372371018"

    def _make_client_with_returned_pair(self):
        """2026-05 statement: outgoing -914.91 (22.05) + incoming +914.91 (26.05),
        both carrying the same account token.  Plus invoice #470 for 914.91.
        """
        content = _stmt(
            ("22.05.2026", f"Platba {self.ACCT}", -914.91),
            ("26.05.2026", f"Vrátenie {self.ACCT}", +914.91),
        )
        stmt = _make_statement(500, "2026-05", content)
        inv = _make_invoice(470, "twd SK - 26003063", "twd.pdf", "2026-05", 914.91)
        return _mock_client(
            {
                TAG_IDS["2026-04"]: [],
                TAG_IDS["2026-05"]: [stmt, inv],
                TAG_IDS["2026-06"] if "2026-06" in TAG_IDS else 999: [],
            }
        )

    def test_proof_both_legs_cancelled_as_returned(self):
        """Both legs of the bounced transfer must be RETURNED, not OK or missing."""
        client = self._make_client_with_returned_pair()
        result = _collect(client, "2026-05")

        returned_rows = [r for r in result["rows"] if r.get("label") == "RETURNED"]
        assert len(returned_rows) == 2, (
            f"Expected 2 RETURNED rows, got {len(returned_rows)}: "
            f"{[(r['status'], r['label'], r['amount']) for r in result['rows']]}"
        )
        for row in returned_rows:
            assert row["status"] == "cancelled", (
                f"RETURNED row should have status='cancelled', got {row['status']!r}"
            )

    def test_proof_invoice_not_consumed_appears_as_info(self):
        """Invoice #470 must NOT be consumed by the bounced transfer — it should be info."""
        client = self._make_client_with_returned_pair()
        result = _collect(client, "2026-05")

        inv_rows = [r for r in result["rows"] if r.get("doc_id") == 470]
        assert len(inv_rows) == 1, (
            f"Expected exactly 1 row for invoice #470, got {len(inv_rows)}"
        )
        assert inv_rows[0]["status"] == "info", (
            f"Invoice #470 should be 'info' (not consumed), got {inv_rows[0]['status']!r}"
        )

    def test_proof_zero_missing_rows(self):
        """Incoming +914.91 must NOT be spuriously flagged MISSING INVOICE."""
        client = self._make_client_with_returned_pair()
        result = _collect(client, "2026-05")

        missing_rows = [r for r in result["rows"] if r["status"] == "missing"]
        assert len(missing_rows) == 0, (
            f"Expected 0 missing rows, got {len(missing_rows)}: "
            f"{[(r['label'], r['amount']) for r in missing_rows]}"
        )
        assert result["stats"]["missing"] == 0

    def test_regression_lone_payment_with_account_token_still_matches_invoice(self):
        """A lone outgoing with an account token (no matching incoming) must match normally."""
        acct = "3333/000000-1234567890"
        content = _stmt(
            ("10.05.2026", f"Platba {acct}", -250.00),
        )
        stmt = _make_statement(501, "2026-05", content)
        inv = _make_invoice(471, "inv_lone", "inv_lone.pdf", "2026-05", 250.00)
        client = _mock_client(
            {
                TAG_IDS["2026-04"]: [],
                TAG_IDS["2026-05"]: [stmt, inv],
            }
        )
        result = _collect(client, "2026-05")
        assert result["stats"]["ok"] == 1, (
            f"Lone outgoing with account token should match invoice as OK, "
            f"got stats={result['stats']}"
        )
        assert result["rows"][0]["status"] == "ok"

    def test_regression_equal_amounts_different_accounts_not_returned(self):
        """Outgoing -300 (acct A) and incoming +300 (acct B) must NOT be RETURNED."""
        acct_a = "1111/000000-1111111111"
        acct_b = "2222/000000-2222222222"
        content = _stmt(
            ("10.05.2026", f"Platba {acct_a}", -300.00),
            ("12.05.2026", f"Prijem {acct_b}", +300.00),
        )
        stmt = _make_statement(502, "2026-05", content)
        client = _mock_client(
            {
                TAG_IDS["2026-04"]: [],
                TAG_IDS["2026-05"]: [stmt],
                TAG_IDS["2026-06"] if "2026-06" in TAG_IDS else 999: [],
            }
        )
        result = _collect(client, "2026-05")

        for row in result["rows"]:
            assert row.get("label") != "RETURNED", (
                f"Different-account pair must not be labelled RETURNED: {row}"
            )


# ═════════════════════════════════════════════════════════════════════════════
# Phase 4: P&L test — returned pair contributes 0 to income/expenses
# ═════════════════════════════════════════════════════════════════════════════


class TestCollectPLReturnedPayments:
    """P&L must not count either leg of a returned-payment pair."""

    ACCT = "1111/000000-1372371018"

    def test_returned_pair_contributes_zero_to_pl(self):
        """Returned pair: neither leg counted in expenses or income."""
        content = _stmt(
            ("22.05.2026", f"Platba {self.ACCT}", -914.91),
            ("26.05.2026", f"Vrátenie {self.ACCT}", +914.91),
        )
        stmt = _make_statement(500, "2026-05", content)
        inv = _make_invoice(470, "twd SK - 26003063", "twd.pdf", "2026-05", 914.91)
        client = _mock_client_for_pl(
            {
                TAG_IDS["2026-04"]: [],
                TAG_IDS["2026-05"]: [stmt, inv],
            }
        )
        pl = _collect_pl(client, 2026)

        # Both legs are status="cancelled" (RETURNED) → P&L skips them
        assert "invoiced" not in pl["expenses"] or pl["expenses"].get("invoiced", 0) == 0, (
            f"RETURNED outgoing must not add to invoiced expenses: "
            f"expenses={pl['expenses']}"
        )
        # Incoming +914.91 is cancelled (RETURNED), NOT a matched invoice row
        # twd SK invoice does not start with "techlab" → no income
        assert pl["income"] == 0.0, (
            f"RETURNED incoming must not add income: income={pl['income']}"
        )


# ═════════════════════════════════════════════════════════════════════════════
# collect_pl income_prefixes parameter tests
# ═════════════════════════════════════════════════════════════════════════════


class TestCollectPLIncomePrefixesParam:
    """collect_pl income_prefixes is configurable; default () = no accrual fallback."""

    def test_default_empty_prefixes_no_accrual_income(self):
        """With income_prefixes=(), an unmatched invoice is NOT counted as income."""
        inv = _make_invoice(20, "Techlab_002", "Techlab_002.pdf", "2026-01", 5000.00)
        client = _mock_client_for_pl(
            {
                TAG_IDS["2025-12"]: [],
                TAG_IDS["2026-01"]: [inv],
                TAG_IDS["2026-02"]: [],
            }
        )
        pl = _collect_pl(client, 2026, income_prefixes=())
        assert pl["income"] == 0.0
        assert len(pl["income_items"]) == 0

    def test_custom_prefix_sygic_counted_as_income(self):
        """An unmatched Sygic invoice counts as income when 'sygic' is configured."""
        inv = _make_invoice(
            50, "Sygic a. s. - VS202600005", "sygic.pdf", "2026-05", 10073.70
        )
        client = _mock_client_for_pl(
            {
                TAG_IDS["2026-04"]: [],
                TAG_IDS["2026-05"]: [inv],
            }
        )
        pl = _collect_pl(client, 2026, income_prefixes=("sygic",))
        assert pl["income"] == round(10073.70 / 1.23, 2)
        assert len(pl["income_items"]) == 1
        assert pl["income_items"][0]["doc_id"] == 50
        assert pl["income_items"][0]["gross"] == 10073.70

    def test_prefix_match_is_title_case_insensitive(self):
        """A lowercased prefix matches an upper-case document title."""
        inv = _make_invoice(
            60, "SYGIC A. S. - VS202600006", "sygic.pdf", "2026-05", 1230.00
        )
        client = _mock_client_for_pl(
            {
                TAG_IDS["2026-04"]: [],
                TAG_IDS["2026-05"]: [inv],
            }
        )
        pl = _collect_pl(client, 2026, income_prefixes=("sygic",))
        assert pl["income"] == round(1230.00 / 1.23, 2)
        assert len(pl["income_items"]) == 1

    def test_non_matching_prefix_not_income(self):
        """An invoice whose title doesn't start with any configured prefix is excluded."""
        inv = _make_invoice(70, "Alza.cz - FV123", "alza.pdf", "2026-05", 200.00)
        client = _mock_client_for_pl(
            {
                TAG_IDS["2026-04"]: [],
                TAG_IDS["2026-05"]: [inv],
            }
        )
        pl = _collect_pl(client, 2026, income_prefixes=("sygic",))
        assert pl["income"] == 0.0
        assert len(pl["income_items"]) == 0


class TestTxGroupBundling:
    """tx_group collapses a proforma+payment+final bundle to one line."""

    def _bundle_client(self):
        # One payment movement; three docs share tx_group "VS42", same amount.
        stmt = _make_statement(
            900, "2026-03", _stmt(("10.03.2026", "Vendor payment", -120.00))
        )
        proforma = _make_bundle_invoice(1, "proforma_vendor", "proforma.pdf", "2026-03", 120.00, "VS42", "2026-03-01")
        payment = _make_bundle_invoice(2, "payment_conf", "payment.pdf", "2026-03", 120.00, "VS42", "2026-03-05")
        final = _make_bundle_invoice(3, "final_invoice", "final.pdf", "2026-03", 120.00, "VS42", "2026-03-09")
        return _mock_client({
            TAG_IDS["2026-02"]: [],
            TAG_IDS["2026-03"]: [stmt, proforma, payment, final],
            TAG_IDS["2026-04"]: [],
        })

    def test_bundle_collapses_to_single_matched_line(self):
        result = _collect(self._bundle_client(), "2026-03")
        # Exactly one row references the bundle; no info/pending/missing siblings.
        doc_rows = [r for r in result["rows"] if r.get("doc_id") in {1, 2, 3}]
        assert len(doc_rows) == 1
        assert doc_rows[0]["status"] == "ok"
        assert result["stats"]["info"] == 0
        assert result["stats"]["missing"] == 0

    def test_primary_is_latest_dated_doc(self):
        result = _collect(self._bundle_client(), "2026-03")
        doc_rows = [r for r in result["rows"] if r.get("doc_id") in {1, 2, 3}]
        assert doc_rows[0]["doc_id"] == 3  # final invoice, latest created

    def test_single_member_group_is_noop(self):
        stmt = _make_statement(900, "2026-03", _stmt(("10.03.2026", "x", -50.00)))
        lone = _make_bundle_invoice(7, "lone", "lone.pdf", "2026-03", 50.00, "VSlone", "2026-03-02")
        client = _mock_client({
            TAG_IDS["2026-02"]: [], TAG_IDS["2026-03"]: [stmt, lone], TAG_IDS["2026-04"]: [],
        })
        result = _collect(client, "2026-03")
        assert result["stats"]["ok"] == 1
        assert {r["doc_id"] for r in result["rows"] if r.get("doc_id")} == {7}

    def test_tx_group_field_none_is_inert(self):
        # With tx_group_field_id=None all three docs are independent -> the two
        # unmatched siblings surface as info rows (pre-feature behaviour).
        result = _collect(self._bundle_client(), "2026-03", tx_group_field_id=None)
        assert result["stats"]["info"] == 2
