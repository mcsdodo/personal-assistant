#!/usr/bin/env python3
"""Shared fixtures, mock builders, and test helpers for the checker-mcp test suite.

Split out of test_matching.py (task 102 Phase 3) so test_parsing.py,
test_matching.py, and test_collection.py can share the same mock
PaperlessClient builders and document factories.
"""

from unittest.mock import MagicMock

from engine.collection import (
    collect_month,
    collect_pl,
    filter_resolved_unmatched,
)
from engine.matching import MONTH_WINDOW, month_offset


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
RECEIPT_DATETIME_FIELD_ID = 52


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
    rd_field_id=RECEIPT_DATETIME_FIELD_ID,
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
        receipt_datetime_field_id=rd_field_id,
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
    client, year, alt_field_id=TOTAL_AMOUNT_ALT_FIELD_ID, income_prefixes=("techlab",)
):
    """Shorthand for collect_pl with test defaults.

    income_prefixes defaults to ("techlab",) so the existing income-prefix
    mechanism tests keep their meaning; pass income_prefixes=() to test the
    production default (no accrual fallback).
    """
    return collect_pl(
        client,
        year,
        TAG_IDS["account-statement"],
        TAG_IDS["accounting"],
        INVOICE_TYPE_ID,
        TOTAL_AMOUNT_FIELD_ID,
        total_amount_alt_field_id=alt_field_id,
        income_prefixes=income_prefixes,
    )


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
