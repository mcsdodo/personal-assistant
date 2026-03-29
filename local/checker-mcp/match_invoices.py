#!/usr/bin/env python3
"""Match account statement movements against invoices in Paperless-ngx.

Usage:
    python match_invoices.py              # current + previous month
    python match_invoices.py --all        # all months
    python match_invoices.py --month 2026-01  # single month
"""

import argparse
import os
import re
import sys
from dataclasses import dataclass
from enum import Enum, auto
from pathlib import Path

import requests

# ── Colors ─────────────────────────────────────────────────────────────────

GREEN = "\033[32m"
RED = "\033[31m"
YELLOW = "\033[33m"
DIM = "\033[2m"
BOLD = "\033[1m"
RESET = "\033[0m"
from dotenv import load_dotenv

# ── Configuration ──────────────────────────────────────────────────────────

# PAPERLESS_URL = "http://localhost:8010"
PAPERLESS_URL = "https://documents.lacny.me"
DOCUMENT_TYPE_STATEMENT = "Account Statement"
INVOICING_TAG_NAME = "invoicing"  # only docs with this tag are matched
MONTH_WINDOW = 1  # +/- months for cross-matching
TOTAL_AMOUNT_FIELD_NAME = "total_amount"  # Paperless custom field name
TOTAL_AMOUNT_ALT_FIELD_NAME = "total_amount_alt"  # alt amount for split payments


class PLCategory(Enum):
    EXPENSE = auto()
    EXCLUDED = auto()


class SkipReason(Enum):
    BANK_FEE = auto()
    LOAN_PRINCIPAL = auto()
    LOAN_INTEREST = auto()
    TAX = auto()
    TAX_REFUND = auto()
    INSURANCE = auto()
    PAYROLL = auto()
    DIVIDEND = auto()
    DIVIDEND_TAX = auto()
    PERSONAL_ACCOUNT = auto()
    STATE_TREASURY = auto()


@dataclass
class SkipRule:
    pattern: str
    reason: SkipReason
    pl_category: PLCategory


@dataclass
class SkipResult:
    reason: SkipReason
    pl_category: PLCategory

    @property
    def label(self) -> str:
        return self.reason.name.lower().replace("_", " ")


# Checked against raw_block text. Keywords are case-insensitive, accounts are exact.
# Order matters: first match wins (e.g. dividend rules before personal account).
SKIP_RULES = [
    # Bank fees
    SkipRule("Transakčná daň", SkipReason.BANK_FEE, PLCategory.EXPENSE),
    SkipRule("Poplatky za transakcie", SkipReason.BANK_FEE, PLCategory.EXPENSE),
    SkipRule("Poplatok za balík", SkipReason.BANK_FEE, PLCategory.EXPENSE),
    SkipRule("POPLATOK - SPRAVA UVERU", SkipReason.BANK_FEE, PLCategory.EXPENSE),
    # Loan
    SkipRule("SPLATKA ISTINY", SkipReason.LOAN_PRINCIPAL, PLCategory.EXCLUDED),
    SkipRule("SPLATKA UROKU", SkipReason.LOAN_INTEREST, PLCategory.EXPENSE),
    # Dividends (must be before personal account rules)
    SkipRule("podielu na zisku", SkipReason.DIVIDEND, PLCategory.EXCLUDED),
    SkipRule("dan z dividend", SkipReason.DIVIDEND_TAX, PLCategory.EXCLUDED),
    # Taxes
    SkipRule("DPH", SkipReason.TAX, PLCategory.EXCLUDED),
    SkipRule("daň z príjmov", SkipReason.TAX, PLCategory.EXCLUDED),
    SkipRule("dan z prijmov", SkipReason.TAX, PLCategory.EXCLUDED),
    SkipRule("vratka DB DzZČ", SkipReason.TAX_REFUND, PLCategory.EXCLUDED),
    # Insurance
    SkipRule("poistenie", SkipReason.INSURANCE, PLCategory.EXPENSE),
    # Payroll
    SkipRule("mzda", SkipReason.PAYROLL, PLCategory.EXPENSE),
    SkipRule("stravne", SkipReason.PAYROLL, PLCategory.EXPENSE),
]

SKIP_ACCOUNT_RULES = [
    SkipRule("2938452410", SkipReason.PAYROLL, PLCategory.EXPENSE),
    SkipRule("SPSRSKBA", SkipReason.STATE_TREASURY, PLCategory.EXCLUDED),
]

# ── Paperless API helpers ──────────────────────────────────────────────────

class PaperlessClient:
    def __init__(self, url: str, token: str):
        self.url = url.rstrip("/")
        self.session = requests.Session()
        self.session.headers["Authorization"] = f"Token {token}"

    def _get_paginated(self, endpoint: str, params: dict | None = None) -> list[dict]:
        """Fetch all pages from a paginated API endpoint."""
        results = []
        url = f"{self.url}{endpoint}"
        params = dict(params or {})
        params.setdefault("page_size", 100)
        while url:
            resp = self.session.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()
            results.extend(data.get("results", []))
            url = data.get("next")
            params = {}  # next URL already contains params
        return results

    def get_document_type_id(self, name: str) -> int | None:
        """Resolve document type name to ID."""
        types = self._get_paginated("/api/document_types/")
        for dt in types:
            if dt["name"] == name:
                return dt["id"]
        return None

    def get_custom_field_id(self, name: str) -> int | None:
        """Resolve custom field name to ID."""
        fields = self._get_paginated("/api/custom_fields/")
        for f in fields:
            if f["name"] == name:
                return f["id"]
        return None

    def get_all_tags(self) -> dict[int, str]:
        """Return {tag_id: tag_name} mapping. Cached after first call."""
        if not hasattr(self, "_tag_cache"):
            tags = self._get_paginated("/api/tags/")
            self._tag_cache = {t["id"]: t["name"] for t in tags}
        return self._tag_cache

    def get_tag_id(self, name: str) -> int | None:
        """Resolve tag name to ID using cached tags."""
        for tid, tname in self.get_all_tags().items():
            if tname == name:
                return tid
        return None

    def get_documents(self, **filters) -> list[dict]:
        """Fetch documents with given filters."""
        return self._get_paginated("/api/documents/", params=filters)

    def get_document(self, doc_id: int) -> dict:
        """Fetch a single document by ID."""
        resp = self.session.get(f"{self.url}/api/documents/{doc_id}/")
        resp.raise_for_status()
        return resp.json()


# ── Statement parsing ──────────────────────────────────────────────────────

# Matches amounts like: 70.07, 70.07-, 7,619.85, 1,063.02-
# At end of line (statement format uses dot-decimal)
RE_STATEMENT_AMOUNT = re.compile(r"(\d{1,3}(?:,\d{3})*\.\d{2})(-)?\s*$")

# Page break: separator + header lines + separator + column header + separator
# Entire section must be removed (including separators) to keep movements intact.
RE_PAGE_BREAK = re.compile(
    r"-{20,}\n"
    r"Mena EUR.*\n"
    r"Podnikateľský účet.*\n"
    r"-{20,}\n"
    r"Dátum sprac\..*Suma\s*\n"
    r"-{20,}",
)

# Opening balance line
RE_OPENING_BALANCE = re.compile(r"Posledný výpis")

# Foreign currency original amount: "Orig. suma: 100.00- CZK"
RE_ORIG_AMOUNT = re.compile(
    r"Orig\. suma:\s*(\d{1,3}(?:,\d{3})*\.\d{2})-?\s*(?:CZK|USD|HUF|PLN)"
)


def parse_statement_amount(amount_str: str) -> float:
    """Parse statement amount like '7,619.85' -> 7619.85."""
    return float(amount_str.replace(",", ""))


def parse_movements(content: str) -> list[dict]:
    """Parse a Tatra Banka account statement into movements.

    Returns list of dicts: {date, description, amount, raw_block}
    amount is signed: negative for debits, positive for credits.
    """
    # Replace page-break sections with a single separator
    content = RE_PAGE_BREAK.sub("----", content)

    # Split on separator lines
    separator = re.compile(r"-{4,}")
    blocks = separator.split(content)

    # Merge continuation blocks (no date+amount on first line) into previous movement
    merged_blocks = []
    for block in blocks:
        block = block.strip()
        if not block:
            continue
        first_line = block.split("\n")[0].strip()
        has_amount = RE_STATEMENT_AMOUNT.search(first_line)
        if has_amount or not merged_blocks:
            merged_blocks.append(block)
        else:
            # Continuation of previous movement (split by page break)
            merged_blocks[-1] += "\n" + block

    movements = []
    for block in merged_blocks:
        lines = block.split("\n")
        first_line = lines[0].strip()

        # Skip opening balance line, but check remaining lines for a movement
        # (first real movement can follow opening balance without a separator)
        if RE_OPENING_BALANCE.search(first_line):
            # Find the first movement line after the opening balance
            found = False
            for j, line in enumerate(lines[1:], 1):
                line = line.strip()
                m2 = RE_STATEMENT_AMOUNT.search(line)
                if m2 and re.match(r"\d{2}\.\d{2}\.\d{4}", line):
                    # Re-process this block starting from the movement line
                    block = "\n".join(lines[j:])
                    first_line = line
                    found = True
                    break
            if not found:
                continue

        # Try to extract amount from first line
        m = RE_STATEMENT_AMOUNT.search(first_line)
        if not m:
            continue

        amount_val = parse_statement_amount(m.group(1))
        if m.group(2) == "-":
            amount_val = -amount_val

        # Extract date (DD.MM.YYYY at start of line)
        date_match = re.match(r"(\d{2}\.\d{2}\.\d{4})", first_line)
        date_str = date_match.group(1) if date_match else ""

        # Description is the text between date and amount on first line
        desc = first_line
        if date_match:
            desc = desc[len(date_match.group(0)):].strip()
        desc = RE_STATEMENT_AMOUNT.sub("", desc).strip()

        # Extract foreign currency original amount if present
        orig_match = RE_ORIG_AMOUNT.search(block)
        orig_amount = parse_statement_amount(orig_match.group(1)) if orig_match else None

        movements.append({
            "date": date_str,
            "description": desc,
            "amount": amount_val,
            "orig_amount": orig_amount,
            "raw_block": block,
        })

    return movements


def skip_reason(movement: dict) -> SkipResult | None:
    """Return skip result with reason and P&L category, or None if movement should be matched."""
    text = movement["raw_block"]
    text_lower = text.lower()
    for rule in SKIP_RULES:
        if rule.pattern.lower() in text_lower:
            return SkipResult(rule.reason, rule.pl_category)
    for rule in SKIP_ACCOUNT_RULES:
        if rule.pattern in text:
            return SkipResult(rule.reason, rule.pl_category)
    return None


# ── Invoice amount extraction ─────────────────────────────────────────────

# Base amount patterns (no space-thousands - safe for OCR table layouts)
RE_AMOUNT = re.compile(
    r"(?<!\d)"  # not preceded by digit
    r"(\d{1,3}(?:\.\d{3})*,\d{2}"  # comma-decimal: 1.063,02
    r"|\d{1,3}(?:,\d{3})*\.\d{2})"  # dot-decimal: 1,063.02
    r"(?!\d)"  # not followed by digit
    r"(?!\.\d)"  # not followed by .digit (would be a date like 24.09.2025)
)

# Space-thousands amounts near total keywords (spolu, celkom, úhradu, EUR, €)
# These are safe because the keyword context disambiguates from table columns.
RE_TOTAL_AMOUNT = re.compile(
    r"(?:spolu|celkom|celkem|úhrad[ue]|total|summe|gesamt|betrag|netto|brutto|amount|balance|due|EUR|USD|€|\$)\D{0,15}"
    r"(\d{1,3}(?:[\s.]\d{3})+,\d{2}"  # comma-decimal with space/dot thousands: 7 619,85
    r"|\d{1,3}(?:,\d{3})+\.\d{2})",   # dot-decimal with comma thousands: 7,619.85
    re.IGNORECASE,
)

# Whole-number amounts next to currency symbols/codes (no decimals)
# E.g. "230 Kč", "CZK 230", "€ 50", "100 EUR"
RE_CURRENCY_AMOUNT = re.compile(
    r"(?:EUR|USD|CZK|HUF|PLN|Kč|€|\$) ?(\d{2,5})(?![.,]\d)"            # currency before: "CZK 230"
    r"|(?<![.,\d\w])(\d{2,5})(?![.,]\d) ?(?:EUR|USD|CZK|HUF|PLN|Kč|€|\$)",  # currency after: "230 Kč"
    re.IGNORECASE,
)

# Years to filter out from whole-number currency matches


def normalize_amount(amount_str: str) -> float:
    """Normalize any amount string to a float.

    Handles:
        70,07 -> 70.07
        1 063,02 -> 1063.02
        1.063,02 -> 1063.02
        70.07 -> 70.07
        1,063.02 -> 1063.02
    """
    s = amount_str.strip()
    if "," in s and "." in s:
        # Determine which is the decimal separator (rightmost)
        if s.rfind(",") > s.rfind("."):
            # comma is decimal: 1.063,02
            s = s.replace(".", "").replace(",", ".")
        else:
            # dot is decimal: 1,063.02
            s = s.replace(",", "")
    elif "," in s:
        # Only comma -> it's the decimal separator: 70,07 or 1 063,02
        s = s.replace(" ", "").replace(",", ".")
    else:
        # Only dot or no separator: 70.07
        s = s.replace(" ", "")
    return float(s)


def extract_invoice_amounts(content: str, year: int = 0) -> list[float]:
    """Extract all unique amounts from invoice text, sorted descending.

    year: statement year (e.g. 2025) - used to filter out year numbers from
    whole-number currency matches.
    """
    amounts = set()
    # Base extraction (no space-thousands, safe for tables)
    for m in RE_AMOUNT.findall(content):
        try:
            amounts.add(round(normalize_amount(m), 2))
        except ValueError:
            continue
    # Also extract space-thousands amounts near total keywords
    for m in RE_TOTAL_AMOUNT.findall(content):
        try:
            amounts.add(round(normalize_amount(m), 2))
        except ValueError:
            continue
    # Whole-number amounts next to currency codes (e.g. "230 Kč", "CZK 230")
    # Skip years and values that are the decimal part of already-extracted amounts
    skip_years = {float(year - 1), float(year), float(year + 1)} if year else set()
    decimal_parts = {int(round(a % 1 * 100)) for a in amounts}  # e.g. 34.89 -> 89
    for groups in RE_CURRENCY_AMOUNT.findall(content):
        val = groups[0] or groups[1]
        if val:
            fval = float(val)
            if fval not in skip_years and int(fval) not in decimal_parts:
                amounts.add(fval)
    return sorted(amounts, reverse=True)


# ── Month arithmetic ──────────────────────────────────────────────────────

def month_offset(yyyy_mm: str, offset: int) -> str:
    """Add offset months to YYYY-MM string."""
    year, month = int(yyyy_mm[:4]), int(yyyy_mm[5:7])
    month += offset
    while month > 12:
        month -= 12
        year += 1
    while month < 1:
        month += 12
        year -= 1
    return f"{year:04d}-{month:02d}"


def get_month_window(yyyy_mm: str, window: int = MONTH_WINDOW) -> list[str]:
    """Return list of YYYY-MM strings in the matching window."""
    return [month_offset(yyyy_mm, i) for i in range(-window, window + 1)]


# ── Invoice pairing ──────────────────────────────────────────────────────

RE_FILENAME_PREFIX = re.compile(r"^([A-Za-z0-9]{1,8})_")


def extract_prefix(name: str) -> str:
    """Extract prefix before first underscore (e.g. '20260115' from '20260115_Faktura_Alza.pdf')."""
    stem = name.rsplit(".", 1)[0] if "." in name else name
    m = RE_FILENAME_PREFIX.match(stem)
    return m.group(1) if m else ""


def _pair_keys(inv: dict) -> list[str]:
    """Return grouping keys for pairing: numeric filename prefix and title."""
    keys = []
    prefix = extract_prefix(inv.get("original_file_name", ""))
    if prefix and prefix.isdigit():
        keys.append(f"file:{prefix}")
    title = inv.get("title", "").strip()
    if title:
        keys.append(f"title:{title}")
    return keys


def build_pair_index(invoice_docs: list[dict]) -> dict[int, dict]:
    """Build bidirectional map {doc_id: paired_invoice} for filename-paired invoices.

    Two invoices are paired when they share the same grouping key (filename
    prefix OR title) and the same primary amount, with exactly 2 documents
    matching those criteria.  Title matching also pairs docs where one title
    is a prefix of the other (e.g. 'fa_regaly' and 'fa_regaly_zalohova').
    """
    from collections import defaultdict
    groups = defaultdict(list)
    for inv in invoice_docs:
        amt = round(inv["_amounts"][0], 2) if inv.get("_amounts") else None
        if amt is None:
            continue
        for key in _pair_keys(inv):
            groups[(key, amt)].append(inv)

    # Also group by title prefix: if title A is a prefix of title B (same amount),
    # add both to a group keyed by the shorter title.
    title_amts = {}  # {(title, amt): inv}
    for inv in invoice_docs:
        amt = round(inv["_amounts"][0], 2) if inv.get("_amounts") else None
        title = inv.get("title", "").strip()
        if amt is not None and title:
            title_amts.setdefault(amt, []).append((title, inv))
    for amt, entries in title_amts.items():
        for i, (t1, inv1) in enumerate(entries):
            for t2, inv2 in entries[i+1:]:
                if inv1["id"] == inv2["id"]:
                    continue
                if t1.startswith(t2) or t2.startswith(t1):
                    shorter = t1 if len(t1) <= len(t2) else t2
                    key = (f"title:{shorter}", amt)
                    if inv1 not in groups[key]:
                        groups[key].append(inv1)
                    if inv2 not in groups[key]:
                        groups[key].append(inv2)

    # Cross-sign pairing: same key, same abs amount, opposite signs (invoice + dobropis)
    abs_groups = defaultdict(list)
    for inv in invoice_docs:
        amt = round(inv["_amounts"][0], 2) if inv.get("_amounts") else None
        if amt is None:
            continue
        abs_amt = round(abs(amt), 2)
        for key in _pair_keys(inv):
            abs_groups[(key, abs_amt)].append(inv)
    # Also check title prefixes for cross-sign
    for abs_amt, entries in title_amts.items():
        neg_abs = round(abs(abs_amt), 2)
        for i, (t1, inv1) in enumerate(entries):
            for t2, inv2 in entries[i+1:]:
                if inv1["id"] == inv2["id"]:
                    continue
                if t1.startswith(t2) or t2.startswith(t1):
                    shorter = t1 if len(t1) <= len(t2) else t2
                    key = (f"title:{shorter}", neg_abs)
                    if inv1 not in abs_groups[key]:
                        abs_groups[key].append(inv1)
                    if inv2 not in abs_groups[key]:
                        abs_groups[key].append(inv2)

    for key, group in abs_groups.items():
        if len(group) == 2 and group[0]["id"] != group[1]["id"]:
            amts = [round(g["_amounts"][0], 2) for g in group if g.get("_amounts")]
            if len(amts) == 2 and amts[0] * amts[1] < 0:  # opposite signs
                groups[key] = group  # add to main groups for pairing

    pair_map = {}
    for key, group in groups.items():
        if len(group) == 2 and group[0]["id"] != group[1]["id"]:
            # Don't pair docs with identical titles (recurring invoices)
            if group[0].get("title", "").strip() == group[1].get("title", "").strip():
                continue
            pair_map.setdefault(group[0]["id"], group[1])
            pair_map.setdefault(group[1]["id"], group[0])
    return pair_map


# ── Matching engine ───────────────────────────────────────────────────────

def find_matching_invoice(
    amount: float,
    invoices: list[dict],
    orig_amount: float | None = None,
    exclude_ids: set | None = None,
) -> tuple[str, dict | None, bool]:
    """Try to match an amount against invoice amounts.

    Sign-aware: negative movement (debit/payment) prefers positive invoice,
    positive movement (credit/refund) prefers negative invoice (credit note/dobropis).

    exclude_ids: set of invoice doc IDs already matched (each invoice matched once).

    Returns (status, matched_invoice, is_primary_match).
    status: 'OK', 'MANUAL CHECK', or 'MISSING INVOICE'
    """
    abs_amount = round(abs(amount), 2)
    amounts_to_try = [abs_amount]
    if orig_amount is not None:
        amounts_to_try.append(round(abs(orig_amount), 2))
    _exclude = exclude_ids or set()

    # Sign compatibility: debit (negative) → positive invoice,
    # credit (positive) → negative invoice (dobropis)
    def signs_compatible(inv_amt: float) -> bool:
        return (amount < 0 and inv_amt > 0) or (amount > 0 and inv_amt < 0)

    # First pass: primary amount with correct sign
    for try_amount in amounts_to_try:
        for inv in invoices:
            if inv["id"] in _exclude:
                continue
            amounts = inv["_amounts"]
            if amounts and round(abs(amounts[0]), 2) == try_amount and signs_compatible(amounts[0]):
                return "OK", inv, True

    # Second pass: primary amount, any sign (invoices without signed amounts)
    for try_amount in amounts_to_try:
        for inv in invoices:
            if inv["id"] in _exclude:
                continue
            amounts = inv["_amounts"]
            if amounts and round(abs(amounts[0]), 2) == try_amount:
                return "OK", inv, True

    # Third pass: secondary amount with sign preference
    for try_amount in amounts_to_try:
        for inv in invoices:
            if inv["id"] in _exclude:
                continue
            for inv_amt in inv["_amounts"]:
                if round(abs(inv_amt), 2) == try_amount and signs_compatible(inv_amt):
                    return "MANUAL CHECK", inv, False

    # Fourth pass: secondary amount, any sign
    for try_amount in amounts_to_try:
        for inv in invoices:
            if inv["id"] in _exclude:
                continue
            if try_amount in [round(abs(a), 2) for a in inv["_amounts"]]:
                return "MANUAL CHECK", inv, False

    return "MISSING INVOICE", None, False


# ── Data collection ───────────────────────────────────────────────────────

def collect_month(client: PaperlessClient, yyyy_mm: str,
                  statement_type_id: int, total_amount_field_id: int | None,
                  doc_cache: dict, invoicing_tag_id: int | None = None,
                  global_matched_ids: set | None = None,
                  total_amount_alt_field_id: int | None = None) -> dict:
    """Process one month, return structured data."""
    result = {"month": yyyy_mm, "header": "", "header_doc_id": None, "rows": [],
              "stats": {"total": 0, "skipped": 0, "ok": 0, "manual": 0, "missing": 0, "info": 0}}

    tag_id = client.get_tag_id(yyyy_mm)
    if tag_id is None:
        result["header"] = f"No tag found for {yyyy_mm}, skipping."
        return result

    statements = client.get_documents(tags__id=tag_id, document_type__id=statement_type_id)

    # Fetch invoices for this month + window (only docs with "invoicing" tag)
    # Ordered oldest-first so older unclaimed invoices are matched before same-month.
    # Real-world pattern: invoices issued month M, paid in month M+1.
    invoice_docs, seen_ids = [], set()
    for wm in get_month_window(yyyy_mm):
        wm_tag_id = client.get_tag_id(wm)
        if wm_tag_id is None:
            continue
        if wm_tag_id not in doc_cache:
            doc_cache[wm_tag_id] = client.get_documents(tags__id=wm_tag_id)
        for doc in doc_cache[wm_tag_id]:
            if doc["id"] not in seen_ids and doc.get("document_type") != statement_type_id:
                if invoicing_tag_id is None or invoicing_tag_id in doc.get("tags", []):
                    seen_ids.add(doc["id"])
                    invoice_docs.append(doc)

    # Extract amounts (priority: total_amount custom field > regex)
    for inv in invoice_docs:
        if "_amounts" not in inv:
            total = None
            alt = None
            for cf in inv.get("custom_fields", []):
                if total_amount_field_id and cf["field"] == total_amount_field_id and cf["value"] is not None:
                    total = round(float(cf["value"]), 2)
                if total_amount_alt_field_id and cf["field"] == total_amount_alt_field_id and cf["value"] is not None:
                    alt = round(float(cf["value"]), 2)
            inv["_amounts"] = [total] if total is not None else \
                extract_invoice_amounts(inv.get("content", ""), year=int(yyyy_mm[:4]))
            inv["_alt_amount"] = alt

    stats = result["stats"]

    if not statements:
        month_invoices = sorted(
            [inv for inv in invoice_docs if tag_id in inv.get("tags", [])],
            key=lambda d: d.get("original_file_name", d.get("title", "")),
        )
        if not month_invoices:
            result["header"] = f"No statement or invoices for {yyyy_mm}."
            return result
        result["header"] = f"=== {yyyy_mm} (no statement yet) ==="
        for inv in month_invoices:
            stats["total"] += 1
            stats["manual"] += 1
            amt = inv["_amounts"][0] if inv.get("_amounts") else 0.0
            result["rows"].append({
                "date": "", "desc": inv["title"][:40].ljust(40),
                "amount": f"{amt:>10.2f} ", "status": "pending",
                "label": "PENDING", "detail": "no statement", "doc_id": inv["id"],
            })
        return result

    matched_ids = set(global_matched_ids) if global_matched_ids is not None else set()
    for stmt in statements:
        result["header"] = f"=== {yyyy_mm} (vypis doc #{stmt['id']}) ==="
        result["header_doc_id"] = stmt["id"]
        for mov in parse_movements(stmt.get("content", "")):
            stats["total"] += 1
            date_str = mov["date"] or ""
            desc = mov["description"][:40].ljust(40)
            amt_val = mov["amount"]
            amt_str = f"{abs(amt_val):>10.2f}{'-' if amt_val < 0 else '+'}"

            skip = skip_reason(mov)
            if skip:
                stats["skipped"] += 1
                result["rows"].append({"date": date_str, "desc": desc, "amount": amt_str,
                                       "status": "skipped", "label": "SKIPPED", "detail": skip.label})
                continue

            status, matched, _ = find_matching_invoice(amt_val, invoice_docs, mov.get("orig_amount"), exclude_ids=matched_ids)
            inv_title = matched["title"] if matched else ""
            doc_id = matched["id"] if matched else None
            if matched:
                matched_ids.add(matched["id"])

            if status == "OK":
                stats["ok"] += 1
                result["rows"].append({"date": date_str, "desc": desc, "amount": amt_str,
                                       "status": "ok", "label": "OK", "detail": inv_title, "doc_id": doc_id})
            elif status == "MANUAL CHECK":
                stats["manual"] += 1
                result["rows"].append({"date": date_str, "desc": desc, "amount": amt_str,
                                       "status": "manual", "label": "MANUAL CHECK", "detail": inv_title, "doc_id": doc_id})
            else:
                stats["missing"] += 1
                result["rows"].append({"date": date_str, "desc": desc, "amount": amt_str,
                                       "status": "missing", "label": "MISSING INVOICE", "detail": ""})

    # Alt-amount matching: invoices with total_amount_alt can match a second row
    alt_invs = {inv["id"]: inv for inv in invoice_docs if inv.get("_alt_amount") is not None}
    if alt_invs:
        for row in result["rows"]:
            if row["status"] != "missing":
                continue
            raw = row["amount"].strip()
            sign = -1 if raw.endswith("-") else 1
            abs_val = round(float(raw.rstrip("+-")), 2)
            mov_amount = sign * abs_val
            for inv in alt_invs.values():
                alt = inv["_alt_amount"]
                if round(abs(alt), 2) == round(abs(mov_amount), 2):
                    row["status"] = "ok"
                    row["label"] = "OK"
                    row["detail"] = inv["title"]
                    row["doc_id"] = inv["id"]
                    stats["missing"] -= 1
                    stats["ok"] += 1
                    break

    # Detect cancelled movement pairs: +X and -X both MISSING → mark as CANCELLED
    missing_rows = [r for r in result["rows"] if r["status"] == "missing"]
    missing_by_amt = {}
    for r in missing_rows:
        # Parse amount back from display string (e.g. "  4.90-" → -4.90)
        raw = r["amount"].strip()
        sign = -1 if raw.endswith("-") else 1
        abs_val = round(float(raw.rstrip("+-")), 2)
        missing_by_amt.setdefault(abs_val, {"pos": [], "neg": []})
        missing_by_amt[abs_val]["pos" if sign > 0 else "neg"].append(r)
    for abs_val, sides in missing_by_amt.items():
        pairs = min(len(sides["pos"]), len(sides["neg"]))
        for i in range(pairs):
            for r in (sides["pos"][i], sides["neg"][i]):
                r["status"] = "cancelled"
                r["label"] = "CANCELLED"
                r["detail"] = "offset by reverse movement"
                stats["missing"] -= 1
                stats["skipped"] += 1

    # Mark paired docs of matched invoices as matched too
    # Use all invoice_docs (not just month_invoices) so cross-month window pairs are found
    pair_map = build_pair_index(invoice_docs)
    for mid in list(matched_ids):
        if mid in pair_map:
            matched_ids.add(pair_map[mid]["id"])

    # Propagate matches (including paired docs) to global set so later months won't re-match
    if global_matched_ids is not None:
        global_matched_ids.update(matched_ids)

    # Unmatched invoices tagged with this month
    unmatched = sorted(
        [inv for inv in invoice_docs
         if inv["id"] not in matched_ids and tag_id in inv.get("tags", [])],
        key=lambda d: d.get("original_file_name", d.get("title", "")),
    )

    # Detect cancelled pairs: invoice + credit note that cancel each other out
    unmatched_amounts = {}
    for inv in unmatched:
        amt = inv["_amounts"][0] if inv.get("_amounts") else 0.0
        abs_amt = round(abs(amt), 2)
        unmatched_amounts.setdefault(abs_amt, []).append(inv)
    cancelled_ids = set()
    for abs_amt, group in unmatched_amounts.items():
        pos = [i for i in group if i["_amounts"] and i["_amounts"][0] > 0]
        neg = [i for i in group if i["_amounts"] and i["_amounts"][0] < 0]
        pairs = min(len(pos), len(neg))
        for i in range(pairs):
            cancelled_ids.add(pos[i]["id"])
            cancelled_ids.add(neg[i]["id"])

    for inv in unmatched:
        stats["total"] += 1
        stats["info"] += 1
        amt = inv["_amounts"][0] if inv.get("_amounts") else 0.0
        if inv["id"] in cancelled_ids:
            result["rows"].append({
                "date": "", "desc": inv["title"][:40].ljust(40),
                "amount": f"{amt:>10.2f} ", "status": "cancelled",
                "label": "CANCELLED", "detail": "offset by credit note", "doc_id": inv["id"],
            })
        else:
            result["rows"].append({
                "date": "", "desc": inv["title"][:40].ljust(40),
                "amount": f"{amt:>10.2f} ", "status": "info",
                "label": "NEXT STATEMENT", "detail": "not in this statement", "doc_id": inv["id"],
            })

    # Enrich rows with paired document info
    for row in result["rows"]:
        doc_id = row.get("doc_id")
        if doc_id and doc_id in pair_map:
            paired = pair_map[doc_id]
            matched_inv = next((inv for inv in invoice_docs if inv["id"] == doc_id), None)
            if matched_inv:
                row["paired_docs"] = [
                    {"title": matched_inv["title"], "doc_id": matched_inv["id"]},
                    {"title": paired["title"], "doc_id": paired["id"]},
                ]

    return result


def filter_resolved_unmatched(results: list[dict]) -> None:
    """Resolve 'NEXT STATEMENT' entries against the next month's statement.

    - If matched in month+1 → remove (it's accounted for)
    - If month+1 has a statement but invoice NOT matched → escalate to MISSING
    - If month+1 has no statement yet → keep as NEXT STATEMENT (unknown)
    """
    # Build {month: set(matched_doc_ids)} for months that have statement data
    matched_by_month = {}
    # Track which months have a statement (header_doc_id set)
    months_with_statement = set()
    for r in results:
        if r.get("header_doc_id"):
            months_with_statement.add(r["month"])
        ids = set()
        for row in r["rows"]:
            if row["status"] in ("ok", "manual") and row.get("doc_id"):
                ids.add(row["doc_id"])
        matched_by_month[r["month"]] = ids

    for r in results:
        next_month = month_offset(r["month"], 1)
        next_has_statement = next_month in months_with_statement
        if not next_has_statement:
            continue
        next_matched = matched_by_month.get(next_month, set())
        filtered = []
        for row in r["rows"]:
            if row["status"] == "info" and row.get("doc_id"):
                if row["doc_id"] in next_matched:
                    # Matched in next statement → remove
                    r["stats"]["total"] -= 1
                    r["stats"]["info"] -= 1
                    continue
                else:
                    # Next statement exists but invoice not there → unaccounted
                    # (likely paid cash or private money)
                    row["status"] = "unaccounted"
                    row["label"] = "NOT IN STATEMENTS"
                    row["detail"] = "not in this or next statement"
                    r["stats"]["info"] -= 1
                    r["stats"]["missing"] += 1
            filtered.append(row)
        r["rows"] = filtered


# ── P&L collection ────────────────────────────────────────────────────────

def collect_pl(client: PaperlessClient, year: int,
               statement_type_id: int, total_amount_field_id: int | None,
               invoicing_tag_id: int | None,
               total_amount_alt_field_id: int | None = None) -> dict:
    """Collect P&L data for a given year.

    Returns dict with income, expenses (by category), excluded totals.
    Uses accrual basis: invoices attributed by their month tag, not payment date.
    """
    # Include next year's first months to catch Dec invoices paid in Jan/Feb
    months = [f"{year:04d}-{m:02d}" for m in range(1, 13)]
    months.append(f"{year + 1:04d}-01")
    months.append(f"{year + 1:04d}-02")
    doc_cache = {}
    global_matched_ids = set()

    # Process oldest-first: same-month invoices preferred over window invoices
    results = [
        collect_month(client, m, statement_type_id, total_amount_field_id,
                      doc_cache, invoicing_tag_id, global_matched_ids,
                      total_amount_alt_field_id=total_amount_alt_field_id)
        for m in months
    ]
    filter_resolved_unmatched(results)

    # Build invoice month tag lookup: {doc_id: YYYY-MM from tags}
    tag_map = client.get_all_tags()
    invoice_month_cache = {}

    def get_invoice_month(doc_id: int) -> str | None:
        if doc_id in invoice_month_cache:
            return invoice_month_cache[doc_id]
        doc = client.get_document(doc_id)
        for tid in doc.get("tags", []):
            name = tag_map.get(tid, "")
            if re.match(r"\d{4}-\d{2}$", name):
                invoice_month_cache[doc_id] = name
                return name
        invoice_month_cache[doc_id] = None
        return None

    # Collect all matched doc IDs to detect cross-sign pairs (invoice + dobropis)
    matched_doc_ids = set()
    for r in results:
        for row in r["rows"]:
            if row["status"] in ("ok", "manual") and row.get("doc_id"):
                matched_doc_ids.add(row["doc_id"])

    # Build pair index from all cached invoices to find cross-sign pairs
    all_invoices = []
    seen = set()
    for docs in doc_cache.values():
        for doc in docs:
            if doc["id"] not in seen and "_amounts" in doc:
                seen.add(doc["id"])
                all_invoices.append(doc)
    pair_map = build_pair_index(all_invoices)

    # Find cancelled pairs: both sides matched AND opposite signs
    cancelled_doc_ids = set()
    for doc_id in matched_doc_ids:
        if doc_id in pair_map:
            paired = pair_map[doc_id]
            if paired["id"] in matched_doc_ids:
                # Check opposite signs
                doc_inv = next((d for d in all_invoices if d["id"] == doc_id), None)
                if doc_inv and doc_inv.get("_amounts") and paired.get("_amounts"):
                    if doc_inv["_amounts"][0] * paired["_amounts"][0] < 0:
                        cancelled_doc_ids.add(doc_id)
                        cancelled_doc_ids.add(paired["id"])

    income = 0.0
    income_items: list[dict] = []
    expenses_by_category: dict[str, float] = {}
    expenses_detail: dict[str, dict[str, float]] = {}  # {category: {month: amount}}
    excluded = 0.0
    excluded_detail: dict[str, dict[str, float]] = {}  # {category: {month: amount}}

    for r in results:
        statement_month = r["month"]
        for row in r["rows"]:
            status = row["status"]
            raw = row["amount"].strip()
            sign = -1 if raw.endswith("-") else 1
            abs_val = float(raw.rstrip("+-"))
            amount = sign * abs_val

            if status == "skipped":
                detail = row.get("detail", "")
                pl_cat = _detail_to_pl_category(detail)
                if pl_cat == PLCategory.EXCLUDED:
                    excluded += amount
                    excluded_detail.setdefault(detail, {})
                    excluded_detail[detail].setdefault(statement_month, 0.0)
                    excluded_detail[detail][statement_month] += amount
                else:
                    expenses_by_category.setdefault(detail, 0.0)
                    expenses_by_category[detail] += amount
                    expenses_detail.setdefault(detail, {})
                    expenses_detail[detail].setdefault(statement_month, 0.0)
                    expenses_detail[detail][statement_month] += amount

            elif status in ("ok", "manual"):
                doc_id = row.get("doc_id")

                # Skip cross-sign cancelled pairs (invoice + dobropis)
                if doc_id and doc_id in cancelled_doc_ids:
                    continue

                # Skip POS reversals (návrat) — always paired with a debit
                desc_lower = row.get("desc", "").lower()
                if "návrat" in desc_lower or "navrat" in desc_lower:
                    continue

                inv_month = None
                if doc_id:
                    inv_month = get_invoice_month(doc_id)
                    attr_year = int(inv_month[:4]) if inv_month else int(statement_month[:4])
                    if attr_year != year:
                        continue

                if amount > 0:
                    # Deduct VAT: 23% from 2025+, 20% before
                    attr_month = inv_month or statement_month
                    vat_rate = 1.23 if attr_month >= "2025-01" else 1.20
                    net_amount = round(amount / vat_rate, 2)
                    income += net_amount
                    income_items.append({
                        "month": attr_month,
                        "label": row.get("detail", "") or row["desc"].strip(),
                        "amount": net_amount,
                        "gross": round(amount, 2),
                        "doc_id": doc_id,
                    })
                else:
                    expenses_by_category.setdefault("invoiced", 0.0)
                    expenses_by_category["invoiced"] += amount
                    attr_month_exp = inv_month or statement_month
                    expenses_detail.setdefault("invoiced", {})
                    expenses_detail["invoiced"].setdefault(attr_month_exp, 0.0)
                    expenses_detail["invoiced"][attr_month_exp] += amount

            elif status == "missing":
                pass  # unmatched movements excluded — no invoice to attribute

            elif status == "cancelled":
                pass

    # Add income from unmatched invoices with known income prefixes (e.g. Techlab_).
    # Two-stage: statement-matched income is already counted above; here we add
    # invoices that are known income by title prefix even without statement confirmation.
    INCOME_PREFIXES = ("techlab",)
    for r in results:
        for row in r["rows"]:
            if row["status"] not in ("info", "pending"):
                continue
            doc_id = row.get("doc_id")
            if not doc_id or doc_id in matched_doc_ids or doc_id in cancelled_doc_ids:
                continue
            # Skip if paired with a cross-sign invoice (unmatched cancelled pair)
            if doc_id in pair_map:
                paired = pair_map[doc_id]
                doc_inv = next((d for d in all_invoices if d["id"] == doc_id), None)
                if doc_inv and doc_inv.get("_amounts") and paired.get("_amounts"):
                    if doc_inv["_amounts"][0] * paired["_amounts"][0] < 0:
                        continue

            title = row.get("desc", "").strip().lower()
            if not any(title.startswith(p) for p in INCOME_PREFIXES):
                continue

            raw = row["amount"].strip()
            sign = -1 if raw.endswith("-") else 1
            abs_val = float(raw.rstrip("+-"))
            amount = sign * abs_val

            if amount <= 0:
                continue

            inv_month = get_invoice_month(doc_id)
            attr_year = int(inv_month[:4]) if inv_month else int(r["month"][:4])
            if attr_year != year:
                continue

            attr_month = inv_month or r["month"]
            vat_rate = 1.23 if attr_month >= "2025-01" else 1.20
            net_amount = round(amount / vat_rate, 2)
            income += net_amount
            income_items.append({
                "month": attr_month,
                "label": row["desc"].strip(),
                "amount": net_amount,
                "gross": round(amount, 2),
                "doc_id": doc_id,
            })

    total_expenses = sum(expenses_by_category.values())

    return {
        "year": year,
        "income": round(income, 2),
        "income_items": sorted(income_items, key=lambda x: (x["month"], -x["amount"])),
        "expenses": {k: round(v, 2) for k, v in sorted(expenses_by_category.items(), key=lambda x: x[1])},
        "expenses_detail": {k: {m: round(v, 2) for m, v in sorted(months.items())}
                            for k, months in expenses_detail.items()},
        "total_expenses": round(total_expenses, 2),
        "net_income": round(income + total_expenses, 2),
        "excluded": round(excluded, 2),
        "excluded_detail": {k: {m: round(v, 2) for m, v in sorted(months.items())}
                            for k, months in excluded_detail.items()},
    }


# Map skip detail labels back to PLCategory
_PL_CATEGORY_BY_LABEL = {}
for _rule in SKIP_RULES:
    _label = SkipResult(_rule.reason, _rule.pl_category).label
    _PL_CATEGORY_BY_LABEL[_label] = _rule.pl_category
for _rule in SKIP_ACCOUNT_RULES:
    _label = SkipResult(_rule.reason, _rule.pl_category).label
    _PL_CATEGORY_BY_LABEL[_label] = _rule.pl_category


def _detail_to_pl_category(detail: str) -> PLCategory:
    return _PL_CATEGORY_BY_LABEL.get(detail, PLCategory.EXPENSE)


# ── CLI output ────────────────────────────────────────────────────────────

def print_results(results: list[dict]) -> None:
    """Print colored CLI output for all months."""
    CYAN = "\033[36m"
    for m in results:
        hdr = m.get("header", "")
        if not hdr:
            continue
        if not m["rows"]:
            print(f"\n  {hdr}")
            continue
        print(f"\n{BOLD}{hdr}{RESET}")
        for r in m["rows"]:
            date_s = r["date"].ljust(10) if r["date"] else "          "
            line = f"  {date_s}  {r['desc']}  {r['amount']}"
            if r.get("paired_docs"):
                titles = " + ".join(d["title"] for d in r["paired_docs"])
                detail = f"  [{titles}]"
            else:
                detail = f"  [{r['detail']}]" if r.get("detail") else ""
            if r["status"] == "ok":
                print(f"{GREEN}{line}  {r['label']}{detail}{RESET}")
            elif r["status"] in ("manual", "pending"):
                print(f"{YELLOW}{line}  {r['label']}{detail}{RESET}")
            elif r["status"] == "missing":
                print(f"{RED}{line}  {r['label']}{RESET}")
            elif r["status"] == "unaccounted":
                ORANGE = "\033[38;5;208m"
                print(f"{ORANGE}{line}  {r['label']}{detail}{RESET}")
            elif r["status"] == "cancelled":
                print(f"{DIM}{line}  {r['label']}{detail}{RESET}")
            elif r["status"] == "info":
                print(f"{CYAN}{line}  {r['label']}{detail}{RESET}")
            elif r["status"] == "skipped":
                print(f"{DIM}{line}  {r['label']}{detail}{RESET}")


# ── Main ──────────────────────────────────────────────────────────────────

def main():
    load_dotenv(Path(__file__).parent / ".env")
    # Also try parent .env if token not found
    if not os.getenv("PAPERLESS_API_TOKEN"):
        load_dotenv(Path(__file__).parent.parent / ".env")

    token = os.getenv("PAPERLESS_API_TOKEN")
    if not token:
        print("Error: PAPERLESS_API_TOKEN not set in .env", file=sys.stderr)
        sys.exit(1)

    parser = argparse.ArgumentParser(description="Match statement movements to invoices")
    parser.add_argument("--month", help="Process single month (YYYY-MM).")
    parser.add_argument("--all", action="store_true", help="Process all months. Default: current + previous month.")
    args = parser.parse_args()

    client = PaperlessClient(PAPERLESS_URL, token)
    tag_map = client.get_all_tags()

    statement_type_id = client.get_document_type_id(DOCUMENT_TYPE_STATEMENT)
    if statement_type_id is None:
        print(f"Error: document type '{DOCUMENT_TYPE_STATEMENT}' not found", file=sys.stderr)
        sys.exit(1)

    total_amount_field_id = client.get_custom_field_id(TOTAL_AMOUNT_FIELD_NAME)
    total_amount_alt_field_id = client.get_custom_field_id(TOTAL_AMOUNT_ALT_FIELD_NAME)
    invoicing_tag_id = client.get_tag_id(INVOICING_TAG_NAME)
    if invoicing_tag_id is None:
        print(f"Warning: tag '{INVOICING_TAG_NAME}' not found, matching all documents", file=sys.stderr)

    if args.month:
        months = [args.month]
    elif args.all:
        # Process all months that have statements + current month
        statements = client.get_documents(document_type__id=statement_type_id)
        month_tags = set()
        for stmt in statements:
            for tid in stmt.get("tags", []):
                name = tag_map.get(tid, "")
                if re.match(r"\d{4}-\d{2}$", name):
                    month_tags.add(name)
        from datetime import date
        today = date.today()
        month_tags.add(f"{today.year:04d}-{today.month:02d}")
        months = sorted(month_tags)
    else:
        # Default: 2 months back + previous + current
        # Current month likely has no statement yet (invoices shown as pending)
        from datetime import date
        today = date.today()
        current = f"{today.year:04d}-{today.month:02d}"
        previous = month_offset(current, -1)
        before_that = month_offset(current, -2)
        months = [before_that, previous, current]

    if not months:
        print("No months to process.")
        sys.exit(0)

    print(f"Processing months: {', '.join(months)}")
    print(f"Matching window: +/-{MONTH_WINDOW} month(s)")

    doc_cache = {}
    global_matched_ids = set()
    # Pre-process MONTH_WINDOW months before the display range so their
    # matched invoices enter global_matched_ids.  Without this, window
    # invoices from unprocessed months can steal matches from displayed
    # months' invoices when they share the same amount.
    if not args.all:
        for i in range(MONTH_WINDOW, 0, -1):
            collect_month(client, month_offset(months[0], -i), statement_type_id,
                          total_amount_field_id, doc_cache, invoicing_tag_id,
                          global_matched_ids,
                          total_amount_alt_field_id=total_amount_alt_field_id)
    # Process oldest-first: same-month invoices are preferred, so older months
    # claim their own invoices before newer months can steal them via window.
    results = [collect_month(client, m, statement_type_id, total_amount_field_id, doc_cache, invoicing_tag_id, global_matched_ids, total_amount_alt_field_id=total_amount_alt_field_id) for m in months]
    filter_resolved_unmatched(results)

    totals = {"total": 0, "skipped": 0, "ok": 0, "manual": 0, "missing": 0, "info": 0}
    for r in results:
        for k in totals:
            totals[k] += r["stats"][k]

    print_results(results)

    CYAN = "\033[36m"
    print(f"\n{BOLD}{'='*70}")
    print(f"TOTAL: {totals['total']} movements, "
          f"{DIM}{totals['skipped']} skipped{RESET}{BOLD}, "
          f"{GREEN}{totals['ok']} OK{RESET}{BOLD}, "
          f"{YELLOW}{totals['manual']} MANUAL CHECK{RESET}{BOLD}, "
          f"{RED}{totals['missing']} MISSING INVOICE{RESET}{BOLD}, "
          f"{CYAN}{totals['info']} NEXT STATEMENT{RESET}")


if __name__ == "__main__":
    main()
