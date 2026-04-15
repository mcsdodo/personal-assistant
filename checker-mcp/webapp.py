#!/usr/bin/env python3
"""Web UI for invoice matching - terminal-style view of statement/invoice matching."""

import os
import re
from datetime import date
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, Response, request as req, stream_with_context

from engine.client import PaperlessClient
from engine.collection import collect_month, collect_pl, filter_resolved_unmatched
from engine.matching import MONTH_WINDOW, month_offset
from match_invoices import (
    ACCOUNTING_TAG_NAME,
    ACCOUNT_STATEMENT_TAG_NAME,
    INVOICE_TYPE_NAME,
    PAPERLESS_URL,
    TOTAL_AMOUNT_ALT_FIELD_NAME,
    TOTAL_AMOUNT_FIELD_NAME,
)

app = Flask(__name__)


def _esc(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


@app.route("/")
def index():
    load_dotenv(Path(__file__).parent / ".env")
    if not os.getenv("PAPERLESS_API_TOKEN"):
        load_dotenv(Path(__file__).parent.parent / ".env")
    token = os.getenv("PAPERLESS_API_TOKEN")
    if not token:
        return (
            "<pre style='color:#f85149;background:#0d1117;padding:2em'>PAPERLESS_API_TOKEN not set</pre>",
            500,
        )
    if not PAPERLESS_URL:
        return (
            "<pre style='color:#f85149;background:#0d1117;padding:2em'>PAPERLESS_URL not set</pre>",
            500,
        )

    client = PaperlessClient(PAPERLESS_URL, token)
    tag_map = client.get_all_tags()
    acct_stmt_tag = client.get_tag_id(ACCOUNT_STATEMENT_TAG_NAME)
    if acct_stmt_tag is None:
        return (
            f"<pre style='color:#f85149;background:#0d1117;padding:2em'>Tag '{ACCOUNT_STATEMENT_TAG_NAME}' not found</pre>",
            500,
        )
    accounting_tag = client.get_tag_id(ACCOUNTING_TAG_NAME)
    if accounting_tag is None:
        return (
            f"<pre style='color:#f85149;background:#0d1117;padding:2em'>Tag '{ACCOUNTING_TAG_NAME}' not found</pre>",
            500,
        )
    invoice_type = client.get_document_type_id(INVOICE_TYPE_NAME)
    if invoice_type is None:
        return (
            f"<pre style='color:#f85149;background:#0d1117;padding:2em'>Document type '{INVOICE_TYPE_NAME}' not found</pre>",
            500,
        )
    ta_field = client.get_custom_field_id(TOTAL_AMOUNT_FIELD_NAME)
    ta_alt_field = client.get_custom_field_id(TOTAL_AMOUNT_ALT_FIELD_NAME)

    # Determine months
    month_param = req.args.get("month")
    all_param = req.args.get("all")
    if month_param:
        months = [month_param]
    elif all_param:
        stmts = client.get_documents(tags__id=acct_stmt_tag)
        month_tags = set()
        for s in stmts:
            for tid in s.get("tags", []):
                name = tag_map.get(tid, "")
                if re.match(r"\d{4}-\d{2}$", name):
                    month_tags.add(name)
        today = date.today()
        month_tags.add(f"{today.year:04d}-{today.month:02d}")
        months = sorted(month_tags)
    else:
        today = date.today()
        cur = f"{today.year:04d}-{today.month:02d}"
        months = [month_offset(cur, -2), month_offset(cur, -1), cur]

    doc_cache = {}
    global_matched_ids = set()
    # Pre-process MONTH_WINDOW months before the display range so their
    # matched invoices enter global_matched_ids.  Without this, window
    # invoices from unprocessed months can steal matches from displayed
    # months' invoices when they share the same amount.
    if not all_param:
        for i in range(MONTH_WINDOW, 0, -1):
            collect_month(
                client,
                month_offset(months[0], -i),
                acct_stmt_tag,
                accounting_tag,
                invoice_type,
                ta_field,
                doc_cache,
                global_matched_ids,
                total_amount_alt_field_id=ta_alt_field,
            )
    # Process oldest-first: same-month invoices are preferred, so older months
    # claim their own invoices before newer months can steal them via window.
    results = [
        collect_month(
            client,
            m,
            acct_stmt_tag,
            accounting_tag,
            invoice_type,
            ta_field,
            doc_cache,
            global_matched_ids,
            total_amount_alt_field_id=ta_alt_field,
        )
        for m in months
    ]
    filter_resolved_unmatched(results)
    results.reverse()  # newest on top for display

    totals = {"total": 0, "skipped": 0, "ok": 0, "manual": 0, "missing": 0, "info": 0}
    for r in results:
        for k in totals:
            totals[k] += r["stats"][k]

    return render_page(results, totals, list(reversed(months)))


@app.route("/zip")
def zip_accounting():
    load_dotenv(Path(__file__).parent / ".env")
    if not os.getenv("PAPERLESS_API_TOKEN"):
        load_dotenv(Path(__file__).parent.parent / ".env")
    token = os.getenv("PAPERLESS_API_TOKEN")
    if not token:
        return (
            "<pre style='color:#f85149;background:#0d1117;padding:2em'>PAPERLESS_API_TOKEN not set</pre>",
            500,
        )
    if not PAPERLESS_URL:
        return (
            "<pre style='color:#f85149;background:#0d1117;padding:2em'>PAPERLESS_URL not set</pre>",
            500,
        )

    month = req.args.get("month", "")
    if not re.match(r"^\d{4}-\d{2}$", month):
        return (
            "<pre style='color:#f85149;background:#0d1117;padding:2em'>month query param required, format YYYY-MM</pre>",
            400,
        )

    client = PaperlessClient(PAPERLESS_URL, token)
    accounting_tag = client.get_tag_id(ACCOUNTING_TAG_NAME)
    if accounting_tag is None:
        return (
            f"<pre style='color:#f85149;background:#0d1117;padding:2em'>Tag '{ACCOUNTING_TAG_NAME}' not found</pre>",
            500,
        )
    month_tag = client.get_tag_id(month)
    if month_tag is None:
        return (
            f"<pre style='color:#f85149;background:#0d1117;padding:2em'>Tag '{_esc(month)}' not found</pre>",
            404,
        )

    docs = client.get_documents(tags__id__all=f"{accounting_tag},{month_tag}")
    ids = [d["id"] for d in docs]
    if not ids:
        return (
            f"<pre style='color:#8b949e;background:#0d1117;padding:2em'>No documents tagged '{_esc(month)}' + '{ACCOUNTING_TAG_NAME}'</pre>",
            404,
        )

    upstream = client.session.post(
        f"{PAPERLESS_URL.rstrip('/')}/api/documents/bulk_download/",
        json={"documents": ids, "content": "archive", "compression": "deflated"},
        stream=True,
    )
    if upstream.status_code != 200:
        body = upstream.text[:500]
        upstream.close()
        return (
            f"<pre style='color:#f85149;background:#0d1117;padding:2em'>Paperless returned {upstream.status_code}: {_esc(body)}</pre>",
            502,
        )

    filename = f"{month}-accounting.zip"

    def generate():
        try:
            for chunk in upstream.iter_content(chunk_size=65536):
                if chunk:
                    yield chunk
        finally:
            upstream.close()

    return Response(
        stream_with_context(generate()),
        mimetype="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


def render_page(results, totals, months_display):
    sections = []
    for m in results:
        if not m["header"]:
            continue
        hdr_id = m.get("header_doc_id")
        if hdr_id:
            hdr_html = f'<a href="{PAPERLESS_URL}/documents/{hdr_id}/details" target="_blank">{_esc(m["header"])}</a>'
        else:
            hdr_html = _esc(m["header"])
        month_ym = m.get("month")
        zip_html = (
            f' <a class="zip" href="/zip?month={_esc(month_ym)}" title="Download ZIP of accounting docs tagged {_esc(month_ym)}">[zip]</a>'
            if month_ym
            else ""
        )
        sections.append(f'<div class="mh">{hdr_html}{zip_html}</div>')
        for r in m["rows"]:
            cls = r["status"]
            date_s = (r["date"] or "").ljust(10)
            paired = r.get("paired_docs")
            if paired:
                links = []
                for d in paired:
                    links.append(
                        f'<a href="{PAPERLESS_URL}/documents/{d["doc_id"]}/details" target="_blank">{_esc(d["title"])}</a>'
                    )
                detail_part = f"  [{' + '.join(links)}]"
            else:
                detail = r.get("detail", "")
                doc_id = r.get("doc_id")
                if doc_id and detail:
                    detail_html = f'<a href="{PAPERLESS_URL}/documents/{doc_id}/details" target="_blank">{_esc(detail)}</a>'
                else:
                    detail_html = _esc(detail)
                detail_part = f"  [{detail_html}]" if detail else ""
            sections.append(
                f'<div class="r {cls}">'
                f'<span class="d">{_esc(date_s)}</span>  '
                f'<span class="n">{_esc(r["desc"])}</span>  '
                f'<span class="a">{_esc(r["amount"])}</span>  '
                f'<span class="l">{_esc(r["label"])}</span>'
                f"{detail_part}</div>"
            )

    body = "\n".join(sections)
    months_str = ", ".join(months_display)

    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Invoice Matcher</title>
<style>
*{{margin:0;padding:0;box-sizing:border-box}}
body{{
  background:#0d1117;color:#c9d1d9;
  font-family:'Cascadia Mono','Fira Code','JetBrains Mono',Consolas,Monaco,monospace;
  font-size:13px;line-height:1.6;padding:1.5em 2em;
}}
.top{{display:flex;align-items:baseline;gap:2em;margin-bottom:.3em}}
h1{{color:#58a6ff;font-size:15px;font-weight:600}}
.nav a{{color:#58a6ff;text-decoration:none;font-size:12px}}
.nav a:hover{{text-decoration:underline}}
.nav a.active{{color:#c9d1d9;text-decoration:underline}}
.info{{color:#484f58;margin-bottom:1.2em;font-size:12px}}
.mh{{color:#e2e4e8;font-weight:bold;margin-top:1.4em;margin-bottom:.2em;font-size:13px}}
.mh a{{color:inherit;text-decoration:none}}.mh a:hover{{text-decoration:underline}}
.mh a.zip{{color:#58a6ff;font-weight:normal;margin-left:.6em}}
.mh a.zip:hover{{text-decoration:underline}}
.r{{white-space:pre;padding:1px 0}}
.r.ok{{color:#3fb950}}
.r.manual,.r.pending{{color:#d29922}}
.r.missing{{color:#f85149}}
.r.unaccounted{{color:#f0883e}}
.r.info{{color:#8b949e}}
.r.cancelled{{color:#484f58;text-decoration:line-through;text-decoration-color:#484f58}}
.r.skipped{{color:#484f58}}
.r a{{color:inherit;text-decoration:underline;text-decoration-style:dotted}}
.r a:hover{{text-decoration-style:solid;opacity:.8}}
.sum{{
  margin-top:1.4em;padding-top:.8em;border-top:1px solid #21262d;
  font-weight:bold;color:#e2e4e8;font-size:13px;
}}
.sum .ok{{color:#3fb950}}.sum .ma{{color:#d29922}}.sum .mi{{color:#f85149}}.sum .in{{color:#8b949e}}.sum .sk{{color:#484f58}}
</style></head><body>
<div class="top">
  <h1>Invoice Matcher</h1>
  <div class="nav">
    <a href="/">Default</a> &middot;
    <a href="/?all=1">All months</a> &middot;
    <a href="/pl">P&amp;L</a>
  </div>
</div>
<div class="info">Months: {_esc(months_str)} &nbsp;|&nbsp; Window: &plusmn;{MONTH_WINDOW} month(s)</div>
{body}
<div class="sum">
TOTAL: {totals["total"]} movements, \
<span class="sk">{totals["skipped"]} skipped</span>, \
<span class="ok">{totals["ok"]} OK</span>, \
<span class="ma">{totals["manual"]} manual check</span>, \
<span class="mi">{totals["missing"]} missing</span>, \
<span class="in">{totals["info"]} next statement</span>
</div>
</body></html>"""


@app.route("/pl")
def profit_loss():
    load_dotenv(Path(__file__).parent / ".env")
    if not os.getenv("PAPERLESS_API_TOKEN"):
        load_dotenv(Path(__file__).parent.parent / ".env")
    token = os.getenv("PAPERLESS_API_TOKEN")
    if not token:
        return (
            "<pre style='color:#f85149;background:#0d1117;padding:2em'>PAPERLESS_API_TOKEN not set</pre>",
            500,
        )
    if not PAPERLESS_URL:
        return (
            "<pre style='color:#f85149;background:#0d1117;padding:2em'>PAPERLESS_URL not set</pre>",
            500,
        )

    client = PaperlessClient(PAPERLESS_URL, token)
    acct_stmt_tag = client.get_tag_id(ACCOUNT_STATEMENT_TAG_NAME)
    if acct_stmt_tag is None:
        return (
            f"<pre style='color:#f85149;background:#0d1117;padding:2em'>Tag '{ACCOUNT_STATEMENT_TAG_NAME}' not found</pre>",
            500,
        )
    accounting_tag = client.get_tag_id(ACCOUNTING_TAG_NAME)
    if accounting_tag is None:
        return (
            f"<pre style='color:#f85149;background:#0d1117;padding:2em'>Tag '{ACCOUNTING_TAG_NAME}' not found</pre>",
            500,
        )
    invoice_type = client.get_document_type_id(INVOICE_TYPE_NAME)
    if invoice_type is None:
        return (
            f"<pre style='color:#f85149;background:#0d1117;padding:2em'>Document type '{INVOICE_TYPE_NAME}' not found</pre>",
            500,
        )
    ta_field = client.get_custom_field_id(TOTAL_AMOUNT_FIELD_NAME)
    ta_alt_field = client.get_custom_field_id(TOTAL_AMOUNT_ALT_FIELD_NAME)

    # Find years with statement data
    tag_map = client.get_all_tags()
    stmts = client.get_documents(tags__id=acct_stmt_tag)
    years_with_data = set()
    for s in stmts:
        for tid in s.get("tags", []):
            name = tag_map.get(tid, "")
            if re.match(r"\d{4}-\d{2}$", name):
                years_with_data.add(int(name[:4]))
    years_with_data.add(date.today().year)
    available_years = sorted(years_with_data)

    year = int(req.args.get("year", date.today().year - 1))
    pl = collect_pl(
        client,
        year,
        acct_stmt_tag,
        accounting_tag,
        invoice_type,
        ta_field,
        total_amount_alt_field_id=ta_alt_field,
    )
    return render_pl(pl, available_years)


def _render_year_nav(current: int, years: list[int]) -> str:
    parts = []
    for y in years:
        if y == current:
            parts.append(f'<a class="active">{y}</a>')
        else:
            parts.append(f'<a href="/pl?year={y}">{y}</a>')
    return " &middot; ".join(parts)


def render_pl(pl: dict, available_years: list[int] | None = None) -> str:
    year = pl["year"]
    income = pl["income"]
    expenses = pl["expenses"]
    total_exp = pl["total_expenses"]
    net = pl["net_income"]
    excluded = pl["excluded"]

    income_items = pl.get("income_items", [])
    expenses_detail = pl.get("expenses_detail", {})
    excluded_detail = pl.get("excluded_detail", {})

    # Transpose expenses_detail {cat: {month: amt}} → {month: {cat: amt}}
    exp_by_month: dict[str, dict[str, float]] = {}
    for cat, months in expenses_detail.items():
        for m, v in months.items():
            exp_by_month.setdefault(m, {})[cat] = v

    # Group income items by month
    income_by_month: dict[str, list[dict]] = {}
    for item in income_items:
        income_by_month.setdefault(item["month"], []).append(item)

    # All months with any data, filtered to requested year
    year_prefix = f"{year:04d}-"
    all_months = sorted(
        m
        for m in set(list(exp_by_month.keys()) + list(income_by_month.keys()))
        if m.startswith(year_prefix)
    )

    # Build month rows
    month_rows_html = []
    for m in all_months:
        m_income = income_by_month.get(m, [])
        m_expenses = exp_by_month.get(m, {})
        m_exp_total = sum(m_expenses.values())

        # Expense detail rows for accordion
        exp_detail_rows = "\n".join(
            f'<div class="pl-row detail">'
            f'<span class="pl-label">{_esc(cat)}</span>'
            f'<span class="pl-amount neg">{amt:>12,.2f}</span>'
            f"</div>"
            for cat, amt in sorted(m_expenses.items(), key=lambda x: x[1])
        )

        if m_income:
            # First income item goes in the summary row
            first = m_income[0]
            label = first["label"]
            doc_id = first.get("doc_id")
            if doc_id:
                label_html = f'<a href="{PAPERLESS_URL}/documents/{doc_id}/details" target="_blank">{_esc(label)}</a>'
            else:
                label_html = _esc(label)
            gross = first.get("gross")
            gross_html = (
                f'<span class="pl-gross dim">({gross:,.2f} gross)</span>'
                if gross
                else ""
            )
            exp_html = (
                f'<span class="pl-exp neg">{m_exp_total:>10,.2f}</span>'
                if m_exp_total
                else ""
            )

            # Additional income items for this month (inside accordion)
            extra_income = ""
            for item in m_income[1:]:
                elabel = item["label"]
                edoc = item.get("doc_id")
                if edoc:
                    elabel_html = f'<a href="{PAPERLESS_URL}/documents/{edoc}/details" target="_blank">{_esc(elabel)}</a>'
                else:
                    elabel_html = _esc(elabel)
                egross = item.get("gross")
                egross_html = (
                    f'<span class="pl-gross dim">({egross:,.2f} gross)</span>'
                    if egross
                    else ""
                )
                extra_income += (
                    f'<div class="pl-row detail income-extra">'
                    f'<span class="pl-label">{elabel_html}</span>'
                    f'<span class="pl-amount pos">{item["amount"]:>12,.2f}</span>'
                    f"{egross_html}"
                    f"</div>"
                )

            month_rows_html.append(
                f'<details class="month-accordion">'
                f'<summary class="pl-row month-row">'
                f'<span class="pl-month">{_esc(m)}</span>'
                f'<span class="pl-label">{label_html}</span>'
                f'<span class="pl-amount pos">{first["amount"]:>12,.2f}</span>'
                f"{gross_html}"
                f"{exp_html}"
                f"</summary>"
                f"{extra_income}"
                f"{exp_detail_rows}"
                f"</details>"
            )
        elif m_expenses:
            # Expense-only month (no income)
            month_rows_html.append(
                f'<details class="month-accordion">'
                f'<summary class="pl-row month-row no-income">'
                f'<span class="pl-month">{_esc(m)}</span>'
                f'<span class="pl-label dim">(no income)</span>'
                f'<span class="pl-exp neg">{m_exp_total:>10,.2f}</span>'
                f"</summary>"
                f"{exp_detail_rows}"
                f"</details>"
            )

    months_html = "\n".join(month_rows_html)

    # Totals: expenses accordion with per-category breakdown
    exp_cat_rows = "\n".join(
        f'<div class="pl-row detail">'
        f'<span class="pl-label">{_esc(cat)}</span>'
        f'<span class="pl-amount neg">{amt:>12,.2f}</span>'
        f"</div>"
        for cat, amt in expenses.items()
    )

    # Excluded accordion with per-category breakdown
    excl_cat_rows = []
    for cat, months in excluded_detail.items():
        cat_total = sum(months.values())
        excl_cat_rows.append(
            f'<div class="pl-row detail">'
            f'<span class="pl-label">{_esc(cat)}</span>'
            f'<span class="pl-amount dim">{cat_total:>12,.2f}</span>'
            f"</div>"
        )
    excl_cats_html = "\n".join(excl_cat_rows)

    net_class = "pos" if net >= 0 else "neg"

    return f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>P&amp;L {year}</title>
<style>
*{{margin:0;padding:0;box-sizing:border-box}}
body{{
  background:#0d1117;color:#c9d1d9;
  font-family:'Cascadia Mono','Fira Code','JetBrains Mono',Consolas,Monaco,monospace;
  font-size:14px;line-height:1.8;padding:2em 3em;
}}
.top{{display:flex;align-items:baseline;gap:2em;margin-bottom:1.5em}}
h1{{color:#58a6ff;font-size:16px;font-weight:600}}
.nav a{{color:#58a6ff;text-decoration:none;font-size:12px}}
.nav a:hover{{text-decoration:underline}}
.pl-section{{margin-bottom:1.2em}}
.pl-row{{display:flex;align-items:baseline;padding:2px 0;max-width:1000px}}
.pl-row.sub{{padding-left:2em;color:#8b949e}}
.pl-row a{{color:#8b949e;text-decoration:underline;text-decoration-style:dotted}}
.pl-row a:hover{{text-decoration-style:solid;opacity:.8}}
.pl-month{{min-width:80px;color:#484f58;margin-right:1em;flex-shrink:0}}
.pl-label{{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}
.pl-gross{{margin-left:1em;font-size:12px;white-space:nowrap;color:#484f58}}
.pl-exp{{margin-left:1em;white-space:nowrap;min-width:100px;text-align:right}}
.pl-row.total{{border-top:1px solid #30363d;margin-top:.4em;padding-top:.4em;font-weight:bold}}
.pl-row.net{{border-top:2px solid #58a6ff;margin-top:.8em;padding-top:.6em;font-weight:bold;font-size:15px}}
.pl-amount{{text-align:right;min-width:120px;margin-left:auto;flex-shrink:0}}
.pos{{color:#3fb950}}
.neg{{color:#f85149}}
.dim{{color:#484f58}}
.month-accordion{{margin:0}}
.month-accordion summary{{cursor:pointer;list-style:none;color:#8b949e}}
.month-accordion summary::-webkit-details-marker{{display:none}}
.month-accordion summary::before{{content:'▸ ';color:#484f58;font-size:12px}}
.month-accordion[open] summary::before{{content:'▾ '}}
.month-accordion .pl-row.detail{{padding-left:calc(80px + 1em + 1.2em);color:#484f58;font-size:13px}}
.month-accordion .income-extra{{color:#8b949e}}
.month-accordion .income-extra a{{color:#8b949e}}
.month-row.no-income .pl-label{{flex:1}}
.totals-accordion summary{{cursor:pointer;list-style:none}}
.totals-accordion summary::-webkit-details-marker{{display:none}}
.totals-accordion summary::before{{content:'▸ ';color:#484f58}}
.totals-accordion[open] summary::before{{content:'▾ '}}
.totals-accordion .pl-row.detail{{padding-left:2em;color:#484f58;font-size:13px}}
.year-nav{{margin-bottom:1em;font-size:12px}}
.year-nav a{{color:#58a6ff;text-decoration:none;margin:0 .5em}}
.year-nav a:hover{{text-decoration:underline}}
.year-nav a.active{{color:#c9d1d9;font-weight:bold;text-decoration:none}}
</style></head><body>
<div class="top">
  <h1>Profit &amp; Loss {year}</h1>
  <div class="nav">
    <a href="/">Matching</a> &middot;
    <a href="/?all=1">All months</a> &middot;
    <a href="/pl">P&amp;L</a>
  </div>
</div>
<div class="year-nav">
{_render_year_nav(year, available_years or [year])}
</div>
<div class="pl-section">
{months_html}
</div>
<div class="pl-section">
  <div class="pl-row">
    <span class="pl-label">Income</span>
    <span class="pl-amount pos">{income:>12,.2f}</span>
  </div>
  <details class="totals-accordion">
    <summary class="pl-row">
      <span class="pl-label">Expenses</span>
      <span class="pl-amount neg">{total_exp:>12,.2f}</span>
    </summary>
{exp_cat_rows}
  </details>
  <div class="pl-row net">
    <span class="pl-label">Net income</span>
    <span class="pl-amount {net_class}">{net:>12,.2f}</span>
  </div>
</div>
<div class="pl-section">
  <details class="totals-accordion">
    <summary class="pl-row dim">
      <span class="pl-label">Excluded (tax, dividends, loan principal)</span>
      <span class="pl-amount dim">{excluded:>12,.2f}</span>
    </summary>
{excl_cats_html}
  </details>
</div>
</body></html>"""


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
