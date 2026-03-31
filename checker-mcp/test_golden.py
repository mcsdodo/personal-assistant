#!/usr/bin/env python3
"""Golden file regression test for invoice matching.

Runs the full matching pipeline and compares against test_golden.json.
Run locally or via: docker exec paperless-checker-web-1 python /app/test_golden.py

To update the golden file after intentional changes:
    python test_golden.py --update
"""

import json
import os
import sys
from datetime import date
from pathlib import Path

from dotenv import load_dotenv

from match_invoices import (
    DOCUMENT_TYPE_STATEMENT,
    INVOICING_TAG_NAME,
    MONTH_WINDOW,
    PAPERLESS_URL,
    TOTAL_AMOUNT_FIELD_NAME,
    PaperlessClient,
    collect_month,
    filter_resolved_unmatched,
    month_offset,
)

GOLDEN_FILE = Path(__file__).parent / "test_golden.json"


def run_matching():
    load_dotenv(Path(__file__).parent / ".env")
    if not os.getenv("PAPERLESS_API_TOKEN"):
        load_dotenv(Path(__file__).parent.parent / ".env")
    token = os.environ["PAPERLESS_API_TOKEN"]

    client = PaperlessClient(PAPERLESS_URL, token)
    tag_map = client.get_all_tags()
    statement_type_id = client.get_document_type_id(DOCUMENT_TYPE_STATEMENT)
    total_amount_field_id = client.get_custom_field_id(TOTAL_AMOUNT_FIELD_NAME)
    invoicing_tag_id = client.get_tag_id(INVOICING_TAG_NAME)

    import re
    statements = client.get_documents(document_type__id=statement_type_id)
    month_tags = set()
    for stmt in statements:
        for tid in stmt.get("tags", []):
            name = tag_map.get(tid, "")
            if re.match(r"\d{4}-\d{2}$", name):
                month_tags.add(name)
    today = date.today()
    month_tags.add(f"{today.year:04d}-{today.month:02d}")
    months = sorted(month_tags)

    doc_cache = {}
    global_matched_ids = set()
    results = [
        collect_month(client, m, statement_type_id, total_amount_field_id,
                      doc_cache, invoicing_tag_id, global_matched_ids)
        for m in reversed(months)
    ]
    results.reverse()
    filter_resolved_unmatched(results)

    output = []
    for r in results:
        month_data = {"month": r["month"], "stats": r["stats"], "rows": []}
        for row in r["rows"]:
            month_data["rows"].append({
                "date": row.get("date", ""),
                "desc": row.get("desc", "").strip(),
                "amount": row.get("amount", "").strip(),
                "status": row["status"],
                "label": row["label"],
                "detail": row.get("detail", ""),
                "doc_id": row.get("doc_id"),
            })
        output.append(month_data)
    return output


def compare(golden, actual):
    diffs = []
    golden_months = {m["month"]: m for m in golden}
    actual_months = {m["month"]: m for m in actual}

    all_months = sorted(set(golden_months) | set(actual_months))
    for month in all_months:
        if month not in golden_months:
            diffs.append(f"  NEW MONTH: {month}")
            continue
        if month not in actual_months:
            diffs.append(f"  MISSING MONTH: {month}")
            continue

        g = golden_months[month]
        a = actual_months[month]

        if g["stats"] != a["stats"]:
            diffs.append(f"  {month} stats: {g['stats']} → {a['stats']}")

        g_rows = g["rows"]
        a_rows = a["rows"]
        max_rows = max(len(g_rows), len(a_rows))
        for i in range(max_rows):
            if i >= len(g_rows):
                diffs.append(f"  {month} row {i}: NEW {a_rows[i]['amount']} {a_rows[i]['status']}")
                continue
            if i >= len(a_rows):
                diffs.append(f"  {month} row {i}: REMOVED {g_rows[i]['amount']} {g_rows[i]['status']}")
                continue
            gr, ar = g_rows[i], a_rows[i]
            if gr != ar:
                changes = []
                for key in ("status", "label", "detail", "doc_id", "amount", "desc"):
                    if gr.get(key) != ar.get(key):
                        changes.append(f"{key}: {gr.get(key)!r} → {ar.get(key)!r}")
                diffs.append(f"  {month} row {i} ({gr['amount']}): {', '.join(changes)}")

    return diffs


def main():
    update_mode = "--update" in sys.argv

    print("Running matching pipeline...")
    actual = run_matching()

    if update_mode:
        GOLDEN_FILE.write_text(json.dumps(actual, indent=2, ensure_ascii=False))
        print(f"Golden file updated: {GOLDEN_FILE}")
        return

    if not GOLDEN_FILE.exists():
        print(f"No golden file found at {GOLDEN_FILE}")
        print("Run with --update to create it.")
        sys.exit(1)

    golden = json.loads(GOLDEN_FILE.read_text())
    diffs = compare(golden, actual)

    if not diffs:
        print("PASS - output matches golden file")
    else:
        print(f"FAIL - {len(diffs)} difference(s):")
        for d in diffs:
            print(d)
        sys.exit(1)


if __name__ == "__main__":
    main()
