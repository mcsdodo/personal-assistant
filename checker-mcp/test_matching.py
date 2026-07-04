#!/usr/bin/env python3
"""Unit tests for engine.matching (core matching engine, month windows, pairing).

Split out of test_matching.py (task 102 Phase 3) — this file keeps the
core matching-layer tests; parsing and orchestration tests moved to
test_parsing.py / test_collection.py respectively.

Run: python -m pytest test_matching.py -v
"""

import pytest
from unittest.mock import patch

from engine.matching import (
    build_pair_index,
    detect_returned_payments,
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
from match_invoices import parse_income_prefixes


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




def _mov(date: str, amount: float, account: str | None) -> dict:
    """Minimal movement dict for TestReturnedPayments tests."""
    return {
        "date": date,
        "amount": amount,
        "account": account,
        "description": "",
        "orig_amount": None,
        "raw_block": "",
    }


class TestReturnedPayments:
    """Unit tests for detect_returned_payments (pure helper)."""

    ACCT = "1111/000000-1372371018"

    def test_basic_pair_both_indices_returned(self):
        """Outgoing before incoming, same account + amount → both indices returned."""
        movs = [
            _mov("22.05.2026", -914.91, self.ACCT),
            _mov("26.05.2026", +914.91, self.ACCT),
        ]
        assert detect_returned_payments(movs) == {0, 1}

    def test_different_accounts_no_pair(self):
        """Same amount, different counterparty accounts → no pair."""
        movs = [
            _mov("22.05.2026", -914.91, self.ACCT),
            _mov("26.05.2026", +914.91, "2222/000000-9999999999"),
        ]
        assert detect_returned_payments(movs) == set()

    def test_two_outgoings_no_incoming_no_pair(self):
        """Two outgoings, no incoming — nothing to pair with."""
        movs = [
            _mov("22.05.2026", -914.91, self.ACCT),
            _mov("23.05.2026", -914.91, self.ACCT),
        ]
        assert detect_returned_payments(movs) == set()

    def test_incoming_before_outgoing_no_pair(self):
        """Incoming dated before outgoing → date guard blocks the pair."""
        movs = [
            _mov("22.05.2026", +914.91, self.ACCT),  # incoming, earlier
            _mov("26.05.2026", -914.91, self.ACCT),  # outgoing, later
        ]
        assert detect_returned_payments(movs) == set()

    def test_orphan_incoming_not_paired(self):
        """Valid pair exists (indices 1 & 2); orphan incoming at index 0 (no earlier outgoing)."""
        movs = [
            _mov("20.05.2026", +914.91, self.ACCT),  # idx 0: incoming with no earlier outgoing
            _mov("22.05.2026", -914.91, self.ACCT),  # idx 1: outgoing
            _mov("26.05.2026", +914.91, self.ACCT),  # idx 2: incoming — pairs with idx 1
        ]
        result = detect_returned_payments(movs)
        assert result == {1, 2}

    def test_none_account_never_paired(self):
        """account=None on both legs → no pair even if amounts match perfectly."""
        movs = [
            _mov("22.05.2026", -914.91, None),
            _mov("26.05.2026", +914.91, None),
        ]
        assert detect_returned_payments(movs) == set()

    def test_multiple_equal_pairs_all_indices_returned(self):
        """Two outgoings + two incomings, all same account+amount, outs before ins → all four paired."""
        movs = [
            _mov("21.05.2026", -914.91, self.ACCT),  # idx 0: out1
            _mov("22.05.2026", -914.91, self.ACCT),  # idx 1: out2
            _mov("25.05.2026", +914.91, self.ACCT),  # idx 2: in1
            _mov("26.05.2026", +914.91, self.ACCT),  # idx 3: in2
        ]
        assert detect_returned_payments(movs) == {0, 1, 2, 3}


# ═════════════════════════════════════════════════════════════════════════════
# parse_income_prefixes tests
# ═════════════════════════════════════════════════════════════════════════════


class TestParseIncomePrefixes:
    """PL_INCOME_PREFIXES parsing: comma-separated, case-insensitive, graceful empty."""

    def test_none_returns_empty_tuple(self):
        assert parse_income_prefixes(None) == ()

    def test_empty_string_returns_empty_tuple(self):
        assert parse_income_prefixes("") == ()

    def test_whitespace_only_returns_empty_tuple(self):
        assert parse_income_prefixes("   ") == ()

    def test_single_prefix(self):
        assert parse_income_prefixes("sygic") == ("sygic",)

    def test_lowercased(self):
        assert parse_income_prefixes("Sygic") == ("sygic",)

    def test_comma_separated_and_trimmed(self):
        assert parse_income_prefixes(" Sygic , Techlab ") == ("sygic", "techlab")

    def test_blank_segments_dropped(self):
        assert parse_income_prefixes("sygic,,techlab,") == ("sygic", "techlab")
