"""Statement parsing and amount extraction.

Pure functions over text — no Paperless dependency. Operates on the
content of statements and invoices fetched elsewhere.
"""

from __future__ import annotations

import re

# ── Statement parsing ────────────────────────────────────────────────────

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

# Counterparty account on transfer first lines, e.g. "1111/000000-1372371018"
RE_COUNTERPARTY_ACCOUNT = re.compile(r"(\d{4}/\d{6}-\d+)")


def parse_statement_amount(amount_str: str) -> float:
    """Parse statement amount like '7,619.85' -> 7619.85."""
    return float(amount_str.replace(",", ""))


def parse_movements(content: str) -> list[dict]:
    """Parse a Tatra Banka account statement into movements.

    Returns list of dicts: {date, description, amount, raw_block, orig_amount}
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
            desc = desc[len(date_match.group(0)) :].strip()
        desc = RE_STATEMENT_AMOUNT.sub("", desc).strip()

        # Extract foreign currency original amount if present
        orig_match = RE_ORIG_AMOUNT.search(block)
        orig_amount = (
            parse_statement_amount(orig_match.group(1)) if orig_match else None
        )

        # Extract counterparty account from transfer first lines
        acct_match = RE_COUNTERPARTY_ACCOUNT.search(first_line)

        movements.append(
            {
                "date": date_str,
                "description": desc,
                "amount": amount_val,
                "orig_amount": orig_amount,
                "account": acct_match.group(1) if acct_match else None,
                "raw_block": block,
            }
        )

    return movements


# ── Invoice amount extraction ────────────────────────────────────────────

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
    r"|\d{1,3}(?:,\d{3})+\.\d{2})",  # dot-decimal with comma thousands: 7,619.85
    re.IGNORECASE,
)

# Whole-number amounts next to currency symbols/codes (no decimals)
# E.g. "230 Kč", "CZK 230", "€ 50", "100 EUR"
RE_CURRENCY_AMOUNT = re.compile(
    r"(?:EUR|USD|CZK|HUF|PLN|Kč|€|\$) ?(\d{2,5})(?![.,]\d)"  # currency before: "CZK 230"
    r"|(?<![.,\d\w])(\d{2,5})(?![.,]\d) ?(?:EUR|USD|CZK|HUF|PLN|Kč|€|\$)",  # currency after: "230 Kč"
    re.IGNORECASE,
)


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
