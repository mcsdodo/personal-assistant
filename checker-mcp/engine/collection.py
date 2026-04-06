"""Collection / orchestration layer.

`collect_month`, `collect_pl`, and `filter_resolved_unmatched` are the
top-level entry points the delivery layers (server.py, webapp.py,
match_invoices.py CLI) call. They fetch from PaperlessClient and combine
parsing + matching + skip rules into result dicts.

Per Phase 5 plan: this module moved out of the monolith *as-is*. Internal
cleanup of `collect_month` and `collect_pl` (breaking the 308/236 line
functions into smaller pieces) is a separate follow-on. Moving them
without rewriting them is the whole point of this phase.
"""

from __future__ import annotations

import re

from .client import PaperlessClient
from .matching import (
    build_pair_index,
    find_matching_invoice,
    get_month_window,
    month_offset,
    skip_reason,
)
from .models import PLCategory, SKIP_ACCOUNT_RULES, SKIP_RULES, SkipResult
from .parsing import extract_invoice_amounts, parse_movements


def collect_month(
    client: PaperlessClient,
    yyyy_mm: str,
    acct_stmt_tag_id: int,
    accounting_tag_id: int,
    invoice_type_id: int,
    total_amount_field_id: int | None,
    doc_cache: dict,
    global_matched_ids: set | None = None,
    total_amount_alt_field_id: int | None = None,
) -> dict:
    """Process one month, return structured data."""
    result = {
        "month": yyyy_mm,
        "header": "",
        "header_doc_id": None,
        "rows": [],
        "stats": {
            "total": 0,
            "skipped": 0,
            "ok": 0,
            "manual": 0,
            "missing": 0,
            "info": 0,
        },
    }

    tag_id = client.get_tag_id(yyyy_mm)
    if tag_id is None:
        result["header"] = f"No tag found for {yyyy_mm}, skipping."
        return result

    # Statements: identified by account-statement tag (not document type)
    if tag_id not in doc_cache:
        doc_cache[tag_id] = client.get_documents(tags__id=tag_id)
    statements = [d for d in doc_cache[tag_id] if acct_stmt_tag_id in d.get("tags", [])]

    # Fetch invoices for this month + window
    # Three-part filter: accounting tag + Invoice type + NOT account-statement
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
            if (
                doc["id"] not in seen_ids
                and accounting_tag_id in doc.get("tags", [])
                and doc.get("document_type") == invoice_type_id
                and acct_stmt_tag_id not in doc.get("tags", [])
            ):
                seen_ids.add(doc["id"])
                invoice_docs.append(doc)

    # Extract amounts (priority: total_amount custom field > regex)
    for inv in invoice_docs:
        if "_amounts" not in inv:
            total = None
            alt = None
            for cf in inv.get("custom_fields", []):
                if (
                    total_amount_field_id
                    and cf["field"] == total_amount_field_id
                    and cf["value"] is not None
                ):
                    total = round(float(cf["value"]), 2)
                if (
                    total_amount_alt_field_id
                    and cf["field"] == total_amount_alt_field_id
                    and cf["value"] is not None
                ):
                    alt = round(float(cf["value"]), 2)
            inv["_amounts"] = (
                [total]
                if total is not None
                else extract_invoice_amounts(
                    inv.get("content", ""), year=int(yyyy_mm[:4])
                )
            )
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
            result["rows"].append(
                {
                    "date": "",
                    "desc": inv["title"][:40].ljust(40),
                    "amount": f"{amt:>10.2f} ",
                    "status": "pending",
                    "label": "PENDING",
                    "detail": "no statement",
                    "doc_id": inv["id"],
                }
            )
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
                result["rows"].append(
                    {
                        "date": date_str,
                        "desc": desc,
                        "amount": amt_str,
                        "status": "skipped",
                        "label": "SKIPPED",
                        "detail": skip.label,
                    }
                )
                continue

            status, matched, _ = find_matching_invoice(
                amt_val, invoice_docs, mov.get("orig_amount"), exclude_ids=matched_ids
            )
            inv_title = matched["title"] if matched else ""
            doc_id = matched["id"] if matched else None
            if matched:
                matched_ids.add(matched["id"])

            if status == "OK":
                stats["ok"] += 1
                result["rows"].append(
                    {
                        "date": date_str,
                        "desc": desc,
                        "amount": amt_str,
                        "status": "ok",
                        "label": "OK",
                        "detail": inv_title,
                        "doc_id": doc_id,
                    }
                )
            elif status == "MANUAL CHECK":
                stats["manual"] += 1
                result["rows"].append(
                    {
                        "date": date_str,
                        "desc": desc,
                        "amount": amt_str,
                        "status": "manual",
                        "label": "MANUAL CHECK",
                        "detail": inv_title,
                        "doc_id": doc_id,
                    }
                )
            else:
                stats["missing"] += 1
                result["rows"].append(
                    {
                        "date": date_str,
                        "desc": desc,
                        "amount": amt_str,
                        "status": "missing",
                        "label": "MISSING INVOICE",
                        "detail": "",
                    }
                )

    # Alt-amount matching: invoices with total_amount_alt can match a second row
    alt_invs = {
        inv["id"]: inv for inv in invoice_docs if inv.get("_alt_amount") is not None
    }
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
        [
            inv
            for inv in invoice_docs
            if inv["id"] not in matched_ids and tag_id in inv.get("tags", [])
        ],
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
            result["rows"].append(
                {
                    "date": "",
                    "desc": inv["title"][:40].ljust(40),
                    "amount": f"{amt:>10.2f} ",
                    "status": "cancelled",
                    "label": "CANCELLED",
                    "detail": "offset by credit note",
                    "doc_id": inv["id"],
                }
            )
        else:
            result["rows"].append(
                {
                    "date": "",
                    "desc": inv["title"][:40].ljust(40),
                    "amount": f"{amt:>10.2f} ",
                    "status": "info",
                    "label": "NEXT STATEMENT",
                    "detail": "not in this statement",
                    "doc_id": inv["id"],
                }
            )

    # Enrich rows with paired document info
    for row in result["rows"]:
        doc_id = row.get("doc_id")
        if doc_id and doc_id in pair_map:
            paired = pair_map[doc_id]
            matched_inv = next(
                (inv for inv in invoice_docs if inv["id"] == doc_id), None
            )
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


# ── P&L collection ───────────────────────────────────────────────────────


def collect_pl(
    client: PaperlessClient,
    year: int,
    acct_stmt_tag_id: int,
    accounting_tag_id: int,
    invoice_type_id: int,
    total_amount_field_id: int | None,
    total_amount_alt_field_id: int | None = None,
) -> dict:
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
                    attr_year = (
                        int(inv_month[:4]) if inv_month else int(statement_month[:4])
                    )
                    if attr_year != year:
                        continue

                if amount > 0:
                    # Deduct VAT: 23% from 2025+, 20% before
                    attr_month = inv_month or statement_month
                    vat_rate = 1.23 if attr_month >= "2025-01" else 1.20
                    net_amount = round(amount / vat_rate, 2)
                    income += net_amount
                    income_items.append(
                        {
                            "month": attr_month,
                            "label": row.get("detail", "") or row["desc"].strip(),
                            "amount": net_amount,
                            "gross": round(amount, 2),
                            "doc_id": doc_id,
                        }
                    )
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
            income_items.append(
                {
                    "month": attr_month,
                    "label": row["desc"].strip(),
                    "amount": net_amount,
                    "gross": round(amount, 2),
                    "doc_id": doc_id,
                }
            )

    total_expenses = sum(expenses_by_category.values())

    return {
        "year": year,
        "income": round(income, 2),
        "income_items": sorted(income_items, key=lambda x: (x["month"], -x["amount"])),
        "expenses": {
            k: round(v, 2)
            for k, v in sorted(expenses_by_category.items(), key=lambda x: x[1])
        },
        "expenses_detail": {
            k: {m: round(v, 2) for m, v in sorted(months_dict.items())}
            for k, months_dict in expenses_detail.items()
        },
        "total_expenses": round(total_expenses, 2),
        "net_income": round(income + total_expenses, 2),
        "excluded": round(excluded, 2),
        "excluded_detail": {
            k: {m: round(v, 2) for m, v in sorted(months_dict.items())}
            for k, months_dict in excluded_detail.items()
        },
    }


# Map skip detail labels back to PLCategory
_PL_CATEGORY_BY_LABEL: dict[str, PLCategory] = {}
for _rule in SKIP_RULES:
    _label = SkipResult(_rule.reason, _rule.pl_category).label
    _PL_CATEGORY_BY_LABEL[_label] = _rule.pl_category
for _rule in SKIP_ACCOUNT_RULES:
    _label = SkipResult(_rule.reason, _rule.pl_category).label
    _PL_CATEGORY_BY_LABEL[_label] = _rule.pl_category


def _detail_to_pl_category(detail: str) -> PLCategory:
    return _PL_CATEGORY_BY_LABEL.get(detail, PLCategory.EXPENSE)
