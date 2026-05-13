#!/usr/bin/env python3
"""Match account statement movements against invoices in Paperless-ngx.

CLI entry point. All matching logic lives in the `engine/` package; this
file owns argument parsing, terminal rendering, and the high-level command
flow. The five engine modules (`models`, `parsing`, `matching`, `client`,
`collection`) are independently testable.

Usage:
    python match_invoices.py              # current + previous month
    python match_invoices.py --all        # all months
    python match_invoices.py --month 2026-01  # single month
"""

import argparse
import os
import re
import sys
from pathlib import Path

from dotenv import load_dotenv

from engine.client import PaperlessClient
from engine.collection import collect_month, filter_resolved_unmatched
from engine.matching import MONTH_WINDOW, month_offset

# ── Colors ─────────────────────────────────────────────────────────────────

GREEN = "\033[32m"
RED = "\033[31m"
YELLOW = "\033[33m"
DIM = "\033[2m"
BOLD = "\033[1m"
RESET = "\033[0m"

# ── Configuration constants (also imported by server.py and webapp.py) ────

PAPERLESS_URL = os.environ.get("PAPERLESS_URL", "")
ACCOUNTING_TAG_NAME = "accounting"  # docs in bookkeeping cycle (both directions)
ACCOUNT_STATEMENT_TAG_NAME = "account-statement"  # bank statements
INVOICE_TYPE_NAME = "Invoice"  # only Invoice-typed docs are matched as candidates
TOTAL_AMOUNT_FIELD_NAME = "total_amount"  # Paperless custom field name
TOTAL_AMOUNT_ALT_FIELD_NAME = "total_amount_alt"  # alt amount for split payments
FILENAME_NOTE_FIELD_NAME = "filename_note"  # optional label appended to filename in ZIP exports


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

    if not PAPERLESS_URL:
        print("Error: PAPERLESS_URL not set", file=sys.stderr)
        sys.exit(1)

    token = os.getenv("PAPERLESS_API_TOKEN")
    if not token:
        print("Error: PAPERLESS_API_TOKEN not set in .env", file=sys.stderr)
        sys.exit(1)

    parser = argparse.ArgumentParser(
        description="Match statement movements to invoices"
    )
    parser.add_argument("--month", help="Process single month (YYYY-MM).")
    parser.add_argument(
        "--all",
        action="store_true",
        help="Process all months. Default: current + previous month.",
    )
    args = parser.parse_args()

    client = PaperlessClient(PAPERLESS_URL, token)
    tag_map = client.get_all_tags()

    acct_stmt_tag_id = client.get_tag_id(ACCOUNT_STATEMENT_TAG_NAME)
    if acct_stmt_tag_id is None:
        print(
            f"Error: tag '{ACCOUNT_STATEMENT_TAG_NAME}' not found",
            file=sys.stderr,
        )
        sys.exit(1)

    accounting_tag_id = client.get_tag_id(ACCOUNTING_TAG_NAME)
    if accounting_tag_id is None:
        print(
            f"Error: tag '{ACCOUNTING_TAG_NAME}' not found",
            file=sys.stderr,
        )
        sys.exit(1)

    invoice_type_id = client.get_document_type_id(INVOICE_TYPE_NAME)
    if invoice_type_id is None:
        print(
            f"Error: document type '{INVOICE_TYPE_NAME}' not found",
            file=sys.stderr,
        )
        sys.exit(1)

    total_amount_field_id = client.get_custom_field_id(TOTAL_AMOUNT_FIELD_NAME)
    total_amount_alt_field_id = client.get_custom_field_id(TOTAL_AMOUNT_ALT_FIELD_NAME)

    if args.month:
        months = [args.month]
    elif args.all:
        # Process all months that have statements + current month
        statements = client.get_documents(tags__id=acct_stmt_tag_id)
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
            collect_month(
                client,
                month_offset(months[0], -i),
                acct_stmt_tag_id,
                accounting_tag_id,
                invoice_type_id,
                total_amount_field_id,
                doc_cache,
                global_matched_ids,
                total_amount_alt_field_id=total_amount_alt_field_id,
            )
    # Process oldest-first: same-month invoices are preferred, so older months
    # claim their own invoices before newer months can steal them via window.
    results = [
        collect_month(
            client,
            m,
            acct_stmt_tag_id,
            accounting_tag_id,
            invoice_type_id,
            total_amount_field_id,
            doc_cache,
            global_matched_ids,
            total_amount_alt_field_id=total_amount_alt_field_id,
        )
        for m in months
    ]
    filter_resolved_unmatched(results)

    totals = {"total": 0, "skipped": 0, "ok": 0, "manual": 0, "missing": 0, "info": 0}
    for r in results:
        for k in totals:
            totals[k] += r["stats"][k]

    print_results(results)

    CYAN = "\033[36m"
    print(f"\n{BOLD}{'=' * 70}")
    print(
        f"TOTAL: {totals['total']} movements, "
        f"{DIM}{totals['skipped']} skipped{RESET}{BOLD}, "
        f"{GREEN}{totals['ok']} OK{RESET}{BOLD}, "
        f"{YELLOW}{totals['manual']} MANUAL CHECK{RESET}{BOLD}, "
        f"{RED}{totals['missing']} MISSING INVOICE{RESET}{BOLD}, "
        f"{CYAN}{totals['info']} NEXT STATEMENT{RESET}"
    )


if __name__ == "__main__":
    main()
