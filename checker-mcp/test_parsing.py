#!/usr/bin/env python3
"""Unit tests for engine.parsing (statement/invoice text parsing).

Split out of test_matching.py (task 102 Phase 3).

Run: python -m pytest test_parsing.py -v
"""

import pytest

from engine.parsing import (
    extract_invoice_amounts,
    normalize_amount,
    parse_movements,
    parse_statement_amount,
)


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
