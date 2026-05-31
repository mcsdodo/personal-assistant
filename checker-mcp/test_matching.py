#!/usr/bin/env python3
"""Unit tests for invoice matching with mocked Paperless API.

Run: python -m pytest test_matching.py -v
"""

import pytest
from unittest.mock import MagicMock, patch

from engine.collection import (
    collect_month,
    collect_pl,
    filter_resolved_unmatched,
)
from engine.matching import (
    MONTH_WINDOW,
    build_pair_index,
    extract_prefix,
    find_matching_invoice,
    get_month_window,
    month_offset,
    skip_reason,
)
from engine.models import (
    PLCategory,
    SKIP_ACCOUNT_RULES,
    SkipReason,
    SkipRule,
)
from engine.parsing import (
    extract_invoice_amounts,
    normalize_amount,
    parse_movements,
    parse_statement_amount,
)


# ═════════════════════════════════════════════════════════════════════════════
# Test fixtures and helpers
# ═════════════════════════════════════════════════════════════════════════════

TAG_IDS = {
    "2025-11": 99,
    "2025-12": 100,
    "2026-01": 101,
    "2026-02": 102,
    "2026-03": 103,
    "2026-04": 104,
    "2026-05": 105,
    "accounting": 200,
    "account-statement": 201,
}
INVOICE_TYPE_ID = 99  # document_type for invoices
DOCUMENT_TYPE_ID = 10  # document_type for Document (statements, worklogs)
TOTAL_AMOUNT_FIELD_ID = 50
TOTAL_AMOUNT_ALT_FIELD_ID = 51


def _make_statement(doc_id, month_tag, content):
    """Create a mock statement document."""
    return {
        "id": doc_id,
        "title": f"Statement {month_tag}",
        "document_type": DOCUMENT_TYPE_ID,
        "tags": [TAG_IDS[month_tag], TAG_IDS["accounting"], TAG_IDS["account-statement"]],
        "content": content,
        "custom_fields": [],
    }


def _make_invoice(doc_id, title, filename, month_tag, amount):
    """Create a mock invoice document with a total_amount custom field."""
    return {
        "id": doc_id,
        "title": title,
        "original_file_name": filename,
        "document_type": 99,
        "tags": [TAG_IDS[month_tag], TAG_IDS["accounting"]],
        "content": "",
        "custom_fields": [
            {"field": TOTAL_AMOUNT_FIELD_ID, "value": str(amount)},
        ],
    }


def _make_invoice_alt(doc_id, title, filename, month_tag, amount, alt_amount):
    """Create a mock invoice with both total_amount and total_amount_alt fields."""
    return {
        "id": doc_id,
        "title": title,
        "original_file_name": filename,
        "document_type": 99,
        "tags": [TAG_IDS[month_tag], TAG_IDS["accounting"]],
        "content": "",
        "custom_fields": [
            {"field": TOTAL_AMOUNT_FIELD_ID, "value": str(amount)},
            {"field": TOTAL_AMOUNT_ALT_FIELD_ID, "value": str(alt_amount)},
        ],
    }


def _make_invoice_no_field(doc_id, title, filename, month_tag, content):
    """Create a mock invoice without total_amount field (amount extracted from content)."""
    return {
        "id": doc_id,
        "title": title,
        "original_file_name": filename,
        "document_type": 99,
        "tags": [TAG_IDS[month_tag], TAG_IDS["accounting"]],
        "content": content,
        "custom_fields": [],
    }


def _stmt(*movements):
    """Build minimal Tatra Banka statement text from (date, desc, amount) tuples."""
    lines = []
    for date, desc, amount in movements:
        sign = "-" if amount < 0 else ""
        lines.append(f"{date} {desc}  {abs(amount):,.2f}{sign}")
        lines.append("----")
    return "\n".join(lines)


def _mock_client(documents_by_tag):
    """Create a mock PaperlessClient that returns documents by tag ID."""
    client = MagicMock()
    tag_map = {v: k for k, v in TAG_IDS.items()}
    client.get_all_tags.return_value = tag_map
    client.get_tag_id.side_effect = lambda name: TAG_IDS.get(name)

    def get_documents(**filters):
        tag_id = filters.get("tags__id")
        type_id = filters.get("document_type__id")
        docs = documents_by_tag.get(tag_id, [])
        if type_id is not None:
            docs = [d for d in docs if d.get("document_type") == type_id]
        return docs

    client.get_documents.side_effect = get_documents
    # Mirror the cached path so collect_month tests don't have to know about
    # the cache layer — they just provide {tag_id: [docs]} and get_documents_by_tag
    # behaves identically to get_documents(tags__id=tag_id).
    client.get_documents_by_tag.side_effect = lambda tag_id: documents_by_tag.get(tag_id, [])
    return client


def _collect(
    client,
    month,
    doc_cache=None,
    global_matched_ids=None,
    alt_field_id=TOTAL_AMOUNT_ALT_FIELD_ID,
):
    """Shorthand for collect_month with defaults."""
    return collect_month(
        client,
        month,
        TAG_IDS["account-statement"],
        TAG_IDS["accounting"],
        INVOICE_TYPE_ID,
        TOTAL_AMOUNT_FIELD_ID,
        doc_cache if doc_cache is not None else {},
        global_matched_ids,
        total_amount_alt_field_id=alt_field_id,
    )


def _process_months(client, months):
    """Replicate the webapp's oldest-first processing with shared global_matched_ids."""
    doc_cache = {}
    global_matched_ids = set()
    results = [
        collect_month(
            client,
            m,
            TAG_IDS["account-statement"],
            TAG_IDS["accounting"],
            INVOICE_TYPE_ID,
            TOTAL_AMOUNT_FIELD_ID,
            doc_cache,
            global_matched_ids,
            total_amount_alt_field_id=TOTAL_AMOUNT_ALT_FIELD_ID,
        )
        for m in months
    ]
    filter_resolved_unmatched(results)
    return results


def _process_months_with_warmup(client, months):
    """Like _process_months but pre-processes MONTH_WINDOW months before the range.

    Replicates the webapp fix: pre-process earlier months to populate
    global_matched_ids so window invoices from unprocessed months
    can't steal matches.
    """
    doc_cache = {}
    global_matched_ids = set()
    for i in range(MONTH_WINDOW, 0, -1):
        collect_month(
            client,
            month_offset(months[0], -i),
            TAG_IDS["account-statement"],
            TAG_IDS["accounting"],
            INVOICE_TYPE_ID,
            TOTAL_AMOUNT_FIELD_ID,
            doc_cache,
            global_matched_ids,
            total_amount_alt_field_id=TOTAL_AMOUNT_ALT_FIELD_ID,
        )
    results = [
        collect_month(
            client,
            m,
            TAG_IDS["account-statement"],
            TAG_IDS["accounting"],
            INVOICE_TYPE_ID,
            TOTAL_AMOUNT_FIELD_ID,
            doc_cache,
            global_matched_ids,
            total_amount_alt_field_id=TOTAL_AMOUNT_ALT_FIELD_ID,
        )
        for m in months
    ]
    filter_resolved_unmatched(results)
    return results


def _matched_doc_ids(result):
    """Get set of doc IDs from OK/manual matched rows."""
    return {
        row["doc_id"]
        for row in result["rows"]
        if row["status"] in ("ok", "manual") and row.get("doc_id")
    }


# ═════════════════════════════════════════════════════════════════════════════
# Pure function tests
# ═════════════════════════════════════════════════════════════════════════════


class TestParseStatementAmount:
    def test_simple(self):
        assert parse_statement_amount("70.07") == 70.07

    def test_thousands(self):
        assert parse_statement_amount("7,619.85") == 7619.85

    def test_large(self):
        assert parse_statement_amount("1,234,567.89") == 1234567.89


class TestNormalizeAmount:
    def test_comma_decimal(self):
        assert normalize_amount("70,07") == 70.07

    def test_dot_thousands_comma_decimal(self):
        assert normalize_amount("1.063,02") == 1063.02

    def test_comma_thousands_dot_decimal(self):
        assert normalize_amount("1,063.02") == 1063.02

    def test_space_thousands_comma_decimal(self):
        assert normalize_amount("1 063,02") == 1063.02

    def test_dot_decimal_simple(self):
        assert normalize_amount("70.07") == 70.07


class TestMonthOffset:
    def test_zero_offset(self):
        assert month_offset("2026-01", 0) == "2026-01"

    def test_positive(self):
        assert month_offset("2026-01", 1) == "2026-02"

    def test_negative(self):
        assert month_offset("2026-03", -1) == "2026-02"

    def test_year_rollover_forward(self):
        assert month_offset("2025-12", 1) == "2026-01"

    def test_year_rollover_backward(self):
        assert month_offset("2026-01", -1) == "2025-12"

    def test_multi_month_forward(self):
        assert month_offset("2025-11", 3) == "2026-02"

    def test_multi_month_backward(self):
        assert month_offset("2026-02", -3) == "2025-11"


class TestGetMonthWindow:
    def test_default_window(self):
        result = get_month_window("2026-02")
        assert result == ["2026-01", "2026-02", "2026-03"]

    def test_window_zero(self):
        assert get_month_window("2026-02", window=0) == ["2026-02"]

    def test_year_boundary(self):
        result = get_month_window("2026-01")
        assert result == ["2025-12", "2026-01", "2026-02"]


class TestExtractPrefix:
    def test_date_prefix(self):
        assert extract_prefix("20260115_Faktura_Alza.pdf") == "20260115"

    def test_short_prefix(self):
        assert extract_prefix("fa_regaly.pdf") == "fa"

    def test_no_underscore(self):
        assert extract_prefix("invoice.pdf") == ""

    def test_no_extension(self):
        assert extract_prefix("20260106_fa_ai") == "20260106"

    def test_long_prefix_capped_at_8(self):
        assert extract_prefix("123456789_rest.pdf") == ""

    def test_exact_8_chars(self):
        assert extract_prefix("12345678_rest.pdf") == "12345678"


class TestExtractInvoiceAmounts:
    def test_comma_decimal(self):
        amounts = extract_invoice_amounts("Celková suma: 70,07 EUR")
        assert 70.07 in amounts

    def test_dot_decimal(self):
        amounts = extract_invoice_amounts("Total: 70.07")
        assert 70.07 in amounts

    def test_space_thousands_near_keyword(self):
        amounts = extract_invoice_amounts("Spolu k úhrade: 7 619,85 EUR")
        assert 7619.85 in amounts

    def test_currency_whole_number(self):
        amounts = extract_invoice_amounts("Cena: 230 Kč", year=2026)
        assert 230.0 in amounts

    def test_year_numbers_filtered(self):
        amounts = extract_invoice_amounts("Rok 2026, celkom 50,00 EUR", year=2026)
        assert 2026.0 not in amounts
        assert 50.0 in amounts

    def test_sorted_descending(self):
        amounts = extract_invoice_amounts("10,00 EUR\n50,00 EUR\n30,00 EUR")
        assert amounts == sorted(amounts, reverse=True)

    def test_empty_content(self):
        assert extract_invoice_amounts("") == []


class TestParseMovements:
    def test_single_debit(self):
        content = "08.01.2026 POS nákup  70.07-\n----"
        movs = parse_movements(content)
        assert len(movs) == 1
        assert movs[0]["date"] == "08.01.2026"
        assert movs[0]["amount"] == -70.07
        assert "POS nákup" in movs[0]["description"]

    def test_single_credit(self):
        content = "15.01.2026 Inkaso  1,500.00\n----"
        movs = parse_movements(content)
        assert len(movs) == 1
        assert movs[0]["amount"] == 1500.00

    def test_multiple_movements(self):
        content = "08.01.2026 First  70.07-\n----\n09.01.2026 Second  100.00\n----"
        movs = parse_movements(content)
        assert len(movs) == 2
        assert movs[0]["amount"] == -70.07
        assert movs[1]["amount"] == 100.00

    def test_opening_balance_skipped(self):
        content = "Posledný výpis  5,000.00\n----\n08.01.2026 Real  50.00-\n----"
        movs = parse_movements(content)
        assert len(movs) == 1
        assert movs[0]["description"] == "Real"

    def test_movement_after_opening_balance_in_same_block(self):
        """First movement immediately follows opening balance with no separator."""
        content = (
            "----\n"
            "Posledný výpis 28.02.2025  3,479.62\n"
            "04.03.2025 EUR NÁVRAT POS 01.03.2025  69.47\n"
            "Číslo karty: 400000******1234\n"
            "----\n"
            "04.03.2025 EUR NÁKUP POS  69.47-\n"
            "----"
        )
        movs = parse_movements(content)
        amounts = [m["amount"] for m in movs]
        assert 69.47 in amounts, "Credit 69.47 after opening balance must be parsed"
        assert -69.47 in amounts, "Debit 69.47 must be parsed"

    def test_foreign_currency_orig_amount(self):
        content = "08.01.2026 INT NÁKUP POS  90.00-\nOrig. suma: 100.00- CZK\n----"
        movs = parse_movements(content)
        assert len(movs) == 1
        assert movs[0]["amount"] == -90.00
        assert movs[0]["orig_amount"] == 100.00

    def test_continuation_block_merged(self):
        """Blocks without date+amount on first line merge into previous."""
        content = (
            "08.01.2026 Purchase  50.00-\n"
            "----\n"
            "Extra detail line about the purchase\n"
            "----\n"
            "09.01.2026 Another  30.00-\n"
            "----"
        )
        movs = parse_movements(content)
        assert len(movs) == 2
        assert "Extra detail" in movs[0]["raw_block"]

    def test_empty_content(self):
        assert parse_movements("") == []

    def test_page_break_removed(self):
        content = (
            "08.01.2026 Before break  50.00-\n"
            "----------------------\n"
            "Mena EUR blah\n"
            "Podnikateľský účet blah\n"
            "----------------------\n"
            "Dátum sprac. blah Suma\n"
            "----------------------\n"
            "09.01.2026 After break  30.00-\n"
            "----"
        )
        movs = parse_movements(content)
        assert len(movs) == 2

    def test_transfer_carries_account(self):
        content = "22.05.2026 Platba 1111/000000-1372371018  914.91-\n----"
        movs = parse_movements(content)
        assert len(movs) == 1
        assert movs[0]["account"] == "1111/000000-1372371018"

    def test_pos_atm_fee_have_no_account(self):
        for content in [
            "08.01.2026 POS nákup  73.65-\n----",
            "08.01.2026 Výber z bankomatu  2,000.00-\n----",
            "08.01.2026 Transakčná daň  0.03-\n----",
        ]:
            movs = parse_movements(content)
            assert len(movs) == 1
            assert movs[0]["account"] is None

    def test_returned_payment_both_legs_share_account(self):
        content = (
            "22.05.2026 Platba 1111/000000-1372371018  914.91-\n"
            "----\n"
            "25.05.2026 Vrátenie 1111/000000-1372371018  914.91\n"
            "----"
        )
        movs = parse_movements(content)
        assert len(movs) == 2
        assert movs[0]["account"] == "1111/000000-1372371018"
        assert movs[1]["account"] == "1111/000000-1372371018"
        assert movs[0]["account"] == movs[1]["account"]


class TestSkipReason:
    def test_bank_fee(self):
        mov = {"raw_block": "Transakčná daň za obdobie"}
        result = skip_reason(mov)
        assert result is not None
        assert result.reason.name == "BANK_FEE"

    def test_loan_principal(self):
        mov = {"raw_block": "SPLATKA ISTINY"}
        result = skip_reason(mov)
        assert result is not None
        assert result.reason.name == "LOAN_PRINCIPAL"

    def test_case_insensitive(self):
        mov = {"raw_block": "transakčná daň za obdobie"}
        assert skip_reason(mov) is not None

    def test_payroll_account(self):
        rules_with_acct = [
            SkipRule("1234567890", SkipReason.PAYROLL, PLCategory.EXPENSE),
        ] + SKIP_ACCOUNT_RULES
        # skip_reason() reads SKIP_ACCOUNT_RULES from engine.matching's
        # imported namespace, not engine.models. Patching engine.models has
        # no effect because matching.py imported the symbol at module load.
        with patch("engine.matching.SKIP_ACCOUNT_RULES", rules_with_acct):
            mov = {"raw_block": "Prevod na účet 1234567890"}
            result = skip_reason(mov)
            assert result is not None
            assert result.reason.name == "PAYROLL"

    def test_account_rules_exact_match(self):
        """Account rules are exact (not case-insensitive)."""
        mov = {"raw_block": "Transfer SPSRSKBA reference"}
        assert skip_reason(mov) is not None

    def test_no_skip(self):
        mov = {"raw_block": "Regular purchase at a shop"}
        assert skip_reason(mov) is None

    def test_dividend_before_personal_account(self):
        """Dividend rules must match before personal account rules (order matters)."""
        mov = {"raw_block": "Výplata podielu na zisku 1234567890"}
        result = skip_reason(mov)
        assert result.reason.name == "DIVIDEND"


class TestFindMatchingInvoice:
    """Test the 4-pass matching engine."""

    def _inv(self, doc_id, primary_amount, *secondary_amounts):
        """Create a minimal invoice dict with amounts."""
        return {
            "id": doc_id,
            "title": f"inv_{doc_id}",
            "_amounts": [primary_amount, *secondary_amounts],
        }

    def test_exact_primary_sign_aware(self):
        """Pass 1: primary amount with correct sign (debit → positive invoice)."""
        inv = self._inv(1, 100.00)
        status, matched, is_primary = find_matching_invoice(-100.00, [inv])
        assert status == "OK"
        assert matched["id"] == 1
        assert is_primary is True

    def test_credit_matches_negative_invoice(self):
        """Pass 1: credit movement → negative invoice (dobropis)."""
        inv = self._inv(1, -50.00)
        status, matched, _ = find_matching_invoice(50.00, [inv])
        assert status == "OK"
        assert matched["id"] == 1

    def test_primary_any_sign(self):
        """Pass 2: primary amount, any sign (when sign doesn't match but amount does)."""
        inv = self._inv(1, 100.00)
        # Positive movement, positive invoice — signs not compatible for pass 1
        # but pass 2 matches any sign
        status, _, _ = find_matching_invoice(100.00, [inv])
        assert status == "OK"

    def test_secondary_amount_manual_check(self):
        """Pass 3/4: secondary amount → MANUAL CHECK."""
        inv = self._inv(1, 200.00, 100.00)
        status, matched, is_primary = find_matching_invoice(-100.00, [inv])
        assert status == "MANUAL CHECK"
        assert matched["id"] == 1
        assert is_primary is False

    def test_no_match_missing(self):
        """No matching invoice → MISSING INVOICE."""
        inv = self._inv(1, 200.00)
        status, matched, _ = find_matching_invoice(-100.00, [inv])
        assert status == "MISSING INVOICE"
        assert matched is None

    def test_exclude_ids(self):
        """Already-matched invoices are excluded."""
        inv = self._inv(1, 100.00)
        status, _, _ = find_matching_invoice(-100.00, [inv], exclude_ids={1})
        assert status == "MISSING INVOICE"

    def test_orig_amount_fallback(self):
        """Foreign currency: try orig_amount if primary doesn't match."""
        inv = self._inv(1, 100.00)  # CZK amount in invoice
        # EUR amount is 90, but orig CZK is 100
        status, matched, _ = find_matching_invoice(-90.00, [inv], orig_amount=100.00)
        assert status == "OK"
        assert matched["id"] == 1

    def test_first_invoice_wins(self):
        """When multiple invoices match, first one wins."""
        inv_a = self._inv(1, 100.00)
        inv_b = self._inv(2, 100.00)
        _, matched, _ = find_matching_invoice(-100.00, [inv_a, inv_b])
        assert matched["id"] == 1

    def test_sign_aware_prefers_compatible(self):
        """Pass 1 (sign-compatible) beats pass 2 (any sign)."""
        inv_pos = self._inv(1, 100.00)  # positive = correct for debit
        inv_neg = self._inv(2, -100.00)  # negative = wrong sign for debit
        _, matched, _ = find_matching_invoice(-100.00, [inv_neg, inv_pos])
        assert matched["id"] == 1  # pos invoice chosen over neg

    def test_empty_invoices(self):
        status, _, _ = find_matching_invoice(-100.00, [])
        assert status == "MISSING INVOICE"

    def test_invoice_with_no_amounts(self):
        inv = {"id": 1, "title": "empty", "_amounts": []}
        status, _, _ = find_matching_invoice(-100.00, [inv])
        assert status == "MISSING INVOICE"


class TestBuildPairIndex:
    def _inv(self, doc_id, title, filename, amount):
        return {
            "id": doc_id,
            "title": title,
            "original_file_name": filename,
            "_amounts": [amount],
        }

    def test_filename_prefix_pairing(self):
        """Two docs with same prefix and amount → paired."""
        a = self._inv(1, "20260106_fa_ai", "20260106_fa_ai.pdf", 90.0)
        b = self._inv(2, "20260106_doklad_ai", "20260106_doklad_ai.pdf", 90.0)
        pair_map = build_pair_index([a, b])
        assert pair_map[1]["id"] == 2
        assert pair_map[2]["id"] == 1

    def test_same_prefix_different_amount_not_paired(self):
        a = self._inv(1, "20260106_fa", "20260106_fa.pdf", 90.0)
        b = self._inv(2, "20260106_doklad", "20260106_doklad.pdf", 50.0)
        pair_map = build_pair_index([a, b])
        assert 1 not in pair_map
        assert 2 not in pair_map

    def test_three_docs_same_key_not_paired(self):
        """Pairing requires exactly 2 docs per key."""
        a = self._inv(1, "a", "20260106_a.pdf", 90.0)
        b = self._inv(2, "b", "20260106_b.pdf", 90.0)
        c = self._inv(3, "c", "20260106_c.pdf", 90.0)
        pair_map = build_pair_index([a, b, c])
        # With 3 docs on the same file prefix key, none get paired by that key
        # (title keys might still pair if titles match)
        for doc_id in (1, 2, 3):
            assert doc_id not in pair_map

    def test_text_filename_prefix_not_paired(self):
        """Text prefix like 'Techlab' is a vendor name, not a pair indicator."""
        a = self._inv(1, "Techlab_JL_202501", "Techlab_JL_202501.pdf", 9918.72)
        b = self._inv(2, "Techlab_JL_202502", "Techlab_JL_202502.pdf", 9918.72)
        pair_map = build_pair_index([a, b])
        assert 1 not in pair_map
        assert 2 not in pair_map

    def test_numeric_filename_prefix_paired(self):
        """Numeric prefix like '20260106' (date) is a valid pair indicator."""
        a = self._inv(1, "20260106_fa_ai", "20260106_fa_ai.pdf", 90.0)
        b = self._inv(2, "20260106_doklad_ai", "20260106_doklad_ai.pdf", 90.0)
        pair_map = build_pair_index([a, b])
        assert pair_map[1]["id"] == 2

    def test_identical_titles_not_paired(self):
        """Recurring invoices with same title + same amount must NOT pair."""
        a = self._inv(1, "fa_ucto", "202507_fa_ucto.pdf", 196.80)
        b = self._inv(2, "fa_ucto", "202508_fa_ucto.pdf", 196.80)
        pair_map = build_pair_index([a, b])
        assert 1 not in pair_map
        assert 2 not in pair_map

    def test_title_prefix_pairing(self):
        """Title 'fa_regaly' pairs with 'fa_regaly_zalohova' (prefix match)."""
        a = self._inv(1, "fa_regaly", "a.pdf", 100.0)
        b = self._inv(2, "fa_regaly_zalohova", "b.pdf", 100.0)
        pair_map = build_pair_index([a, b])
        assert pair_map[1]["id"] == 2

    def test_cross_sign_pairing(self):
        """Invoice (+90) and dobropis (-90) with same prefix → paired."""
        a = self._inv(1, "20260106_fa", "20260106_fa.pdf", 90.0)
        b = self._inv(2, "20260106_dobropis", "20260106_dobropis.pdf", -90.0)
        pair_map = build_pair_index([a, b])
        assert pair_map[1]["id"] == 2
        assert pair_map[2]["id"] == 1

    def test_no_amounts_skipped(self):
        a = {"id": 1, "title": "x", "original_file_name": "x_a.pdf", "_amounts": []}
        b = {"id": 2, "title": "y", "original_file_name": "x_b.pdf", "_amounts": [90.0]}
        pair_map = build_pair_index([a, b])
        assert not pair_map


# ═════════════════════════════════════════════════════════════════════════════
# Integration tests (mocked Paperless API)
# ═════════════════════════════════════════════════════════════════════════════


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


def _mock_client_for_pl(documents_by_tag):
    """Create a mock client suitable for collect_pl (needs get_document too)."""
    client = _mock_client(documents_by_tag)

    # Build a flat doc lookup for get_document calls
    all_docs = {}
    for docs in documents_by_tag.values():
        for doc in docs:
            all_docs[doc["id"]] = doc

    client.get_document.side_effect = lambda doc_id: all_docs.get(doc_id, {})
    return client


def _collect_pl(
    client, year, alt_field_id=TOTAL_AMOUNT_ALT_FIELD_ID
):
    """Shorthand for collect_pl with test defaults."""
    return collect_pl(
        client,
        year,
        TAG_IDS["account-statement"],
        TAG_IDS["accounting"],
        INVOICE_TYPE_ID,
        TOTAL_AMOUNT_FIELD_ID,
        total_amount_alt_field_id=alt_field_id,
    )


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


def _process_with_full_history(client, all_months, display_months):
    """New default-view behavior: process the full statement history,
    return only the months selected for display.

    Replicates webapp.py index() processing. The view selection only
    controls which months render; matching always runs on the full set.
    """
    doc_cache = {}
    global_matched_ids = set()
    all_results = [
        collect_month(
            client,
            m,
            TAG_IDS["account-statement"],
            TAG_IDS["accounting"],
            INVOICE_TYPE_ID,
            TOTAL_AMOUNT_FIELD_ID,
            doc_cache,
            global_matched_ids,
            total_amount_alt_field_id=TOTAL_AMOUNT_ALT_FIELD_ID,
        )
        for m in all_months
    ]
    filter_resolved_unmatched(all_results)
    display_set = set(display_months)
    return [r for r in all_results if r["month"] in display_set]


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
