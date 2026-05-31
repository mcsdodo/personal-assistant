"""Matching engine — pure functions over parsed movements and invoice docs.

Owns the four-pass matching algorithm, filename-prefix pairing, skip-rule
application, and month arithmetic. No Paperless API calls — operates on
data fetched elsewhere.
"""

from __future__ import annotations

import re
from collections import defaultdict

from .models import SKIP_ACCOUNT_RULES, SKIP_RULES, SkipResult

# ── Skip-rule application ────────────────────────────────────────────────


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


# ── Date key helper ─────────────────────────────────────────────────────────


def _movement_date_key(date_str: str) -> tuple[int, int, int]:
    """Convert "26.05.2026" -> (2026, 5, 26) for sorting; "" -> (0, 0, 0)."""
    if not date_str:
        return (0, 0, 0)
    try:
        day, month, year = date_str.split(".")
        return (int(year), int(month), int(day))
    except (ValueError, AttributeError):
        return (0, 0, 0)


# ── Returned-payment detection ───────────────────────────────────────────────


def detect_returned_payments(movements: list[dict]) -> set[int]:
    """Return indices of movements that are legs of a returned-payment pair.

    A pair = one outgoing (amount < 0) and one incoming (amount > 0) with the
    SAME counterparty account and SAME abs amount, where the outgoing leg is
    dated on or before the incoming leg. Greedy one-to-one matching.
    Movements without an `account` (None) are never paired here.
    """
    # Group (abs_amount_rounded, account) → list of (index, movement)
    groups: dict[tuple, list[tuple[int, dict]]] = defaultdict(list)
    for idx, mov in enumerate(movements):
        if mov.get("account") is None:
            continue
        key = (round(abs(mov["amount"]), 2), mov["account"])
        groups[key].append((idx, mov))

    paired: set[int] = set()

    for group in groups.values():
        outgoing = [
            (idx, mov) for idx, mov in group if mov["amount"] < 0
        ]
        incoming = [
            (idx, mov) for idx, mov in group if mov["amount"] > 0
        ]

        # Sort each list by date ascending (earliest first)
        outgoing.sort(key=lambda x: _movement_date_key(x[1]["date"]))
        incoming.sort(key=lambda x: _movement_date_key(x[1]["date"]))

        used_out: set[int] = set()
        for in_idx, in_mov in incoming:
            in_date_key = _movement_date_key(in_mov["date"])
            # Pick the earliest unused outgoing whose date <= incoming date
            for out_idx, out_mov in outgoing:
                if out_idx in used_out:
                    continue
                if _movement_date_key(out_mov["date"]) <= in_date_key:
                    paired.add(in_idx)
                    paired.add(out_idx)
                    used_out.add(out_idx)
                    break

    return paired


# ── Month arithmetic ─────────────────────────────────────────────────────

#: +/- months for cross-matching window. The window is also used by
#: collect_pl and the CLI to scope which months are pre-processed before
#: the displayed range.
MONTH_WINDOW = 1


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


# ── Invoice pairing (filename prefix + title) ────────────────────────────

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
            for t2, inv2 in entries[i + 1 :]:
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
            for t2, inv2 in entries[i + 1 :]:
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


# ── Four-pass matching ──────────────────────────────────────────────────


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
            if (
                amounts
                and round(abs(amounts[0]), 2) == try_amount
                and signs_compatible(amounts[0])
            ):
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
