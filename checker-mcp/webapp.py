#!/usr/bin/env python3
"""Web UI for invoice matching - terminal-style view of statement/invoice matching."""

import io
import json
import logging
import os
import re
import threading
import time
import zipfile
from datetime import date, timedelta
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, Response, jsonify, request as req

from engine.client import PaperlessClient
from engine.collection import collect_month, collect_pl, filter_resolved_unmatched
from engine.matching import MONTH_WINDOW, month_offset
from match_invoices import (
    INCOME_PREFIXES,
    ACCOUNTING_TAG_NAME,
    ACCOUNT_STATEMENT_TAG_NAME,
    FILENAME_NOTE_FIELD_NAME,
    INVOICE_TYPE_NAME,
    PAPERLESS_URL,
    TOTAL_AMOUNT_ALT_FIELD_NAME,
    TOTAL_AMOUNT_FIELD_NAME,
)

app = Flask(__name__)
log = logging.getLogger("checker-mcp.webapp")


# ── Paperless client singleton + lazy env-load ──────────────────────────────

class ConfigError(RuntimeError):
    pass


_client_lock = threading.Lock()
_client: PaperlessClient | None = None


def _get_client() -> PaperlessClient:
    """Module-level lazy singleton. Holding one client across requests keeps
    the lookup + per-tag-doc caches alive instead of being rebuilt per page
    load. .env is read on first call only; readers fail fast if PAPERLESS_*
    is missing."""
    global _client
    with _client_lock:
        if _client is not None:
            return _client
        load_dotenv(Path(__file__).parent / ".env")
        if not os.getenv("PAPERLESS_API_TOKEN"):
            load_dotenv(Path(__file__).parent.parent / ".env")
        token = os.getenv("PAPERLESS_API_TOKEN")
        if not token:
            raise ConfigError("PAPERLESS_API_TOKEN not set")
        if not PAPERLESS_URL:
            raise ConfigError("PAPERLESS_URL not set")
        _client = PaperlessClient(PAPERLESS_URL, token)
        return _client


def _err(msg: str, code: int = 500):
    return (
        f"<pre style='color:#f85149;background:#0d1117;padding:2em'>{_esc(msg)}</pre>",
        code,
    )


def _esc(s):
    return str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _easter_monday(year: int) -> date:
    """Anonymous Gregorian algorithm for Easter Sunday, returns Easter Monday."""
    a = year % 19
    b, c = divmod(year, 100)
    d, e = divmod(b, 4)
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = divmod(c, 4)
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    month, day = divmod(h + l - 7 * m + 114, 31)
    easter_sunday = date(year, month, day + 1)
    return easter_sunday + timedelta(days=1)


def _sk_holidays(year: int) -> set[date]:
    """Return Slovak public holidays for a given year."""
    fixed = [
        (1, 1), (1, 6), (5, 1), (5, 8), (7, 5), (8, 29),
        (9, 1), (9, 15), (11, 1), (11, 17), (12, 24), (12, 25), (12, 26),
    ]
    holidays = {date(year, m, d) for m, d in fixed}
    holidays.add(_easter_monday(year))
    return holidays


def sk_working_days(year: int, month: int) -> int:
    """Count Mon–Fri days in the month that are not Slovak public holidays."""
    holidays = _sk_holidays(year)
    d = date(year, month, 1)
    count = 0
    while d.month == month:
        if d.weekday() < 5 and d not in holidays:
            count += 1
        d += timedelta(days=1)
    return count


def _load_rates() -> list[dict] | None:
    """Load hourly rates (sorted by 'from').

    Sources (in priority order):
    1. PL_RATES env var — JSON string, set via Komodo stack environment.
    2. pl-rates.json in the app dir — local-dev fallback (gitignored, never mounted in prod).

    Returns None if neither source is available, which disables the worked-days column.
    """
    env_rates = os.getenv("PL_RATES")
    if env_rates:
        rates = json.loads(env_rates)
        return sorted(rates, key=lambda r: r["from"])
    path = Path(__file__).parent / "pl-rates.json"
    if path.is_file():
        with open(path, encoding="utf-8") as f:
            rates = json.load(f)
        return sorted(rates, key=lambda r: r["from"])
    return None


def _rate_for_month(rates: list[dict], month_ym: str) -> float | None:
    """Return the hourly rate applicable to month_ym (YYYY-MM)."""
    applicable = [r for r in rates if r["from"] <= month_ym]
    return applicable[-1]["rate"] if applicable else None


@app.route("/")
def index():
    try:
        client = _get_client()
    except ConfigError as e:
        return _err(str(e))
    tag_map = client.get_all_tags()
    acct_stmt_tag = client.get_tag_id(ACCOUNT_STATEMENT_TAG_NAME)
    if acct_stmt_tag is None:
        return _err(f"Tag '{ACCOUNT_STATEMENT_TAG_NAME}' not found")
    accounting_tag = client.get_tag_id(ACCOUNTING_TAG_NAME)
    if accounting_tag is None:
        return _err(f"Tag '{ACCOUNTING_TAG_NAME}' not found")
    invoice_type = client.get_document_type_id(INVOICE_TYPE_NAME)
    if invoice_type is None:
        return _err(f"Document type '{INVOICE_TYPE_NAME}' not found")
    ta_field = client.get_custom_field_id(TOTAL_AMOUNT_FIELD_NAME)
    ta_alt_field = client.get_custom_field_id(TOTAL_AMOUNT_ALT_FIELD_NAME)

    # Discover all months that have account-statement docs — these are the
    # months whose movements claim invoices in global_matched_ids. Matching
    # must run over the full history so the result is independent of the
    # view's display window (partial pre-processing causes window invoices
    # from unprocessed months to steal matches that belong to displayed
    # months — see the cascade reproduced in TestPreProcessingWarmup).
    stmts = client.get_documents_by_tag(acct_stmt_tag)
    stmt_month_tags = set()
    for s in stmts:
        for tid in s.get("tags", []):
            name = tag_map.get(tid, "")
            if re.match(r"\d{4}-\d{2}$", name):
                stmt_month_tags.add(name)
    today = date.today()
    cur = f"{today.year:04d}-{today.month:02d}"
    stmt_month_tags.add(cur)

    # The view selection only chooses which months to display.
    month_param = req.args.get("month")
    all_param = req.args.get("all")
    if month_param:
        display_months = [month_param]
    elif all_param:
        display_months = sorted(stmt_month_tags)
    else:
        display_months = [month_offset(cur, -2), month_offset(cur, -1), cur]

    # Process every statement-tagged month oldest-first. doc_cache and
    # global_matched_ids accumulate across all months so each invoice gets
    # claimed by its rightful statement before later months see it.
    process_months = sorted(stmt_month_tags | set(display_months))
    doc_cache = {}
    global_matched_ids = set()
    all_results = [
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
        for m in process_months
    ]
    filter_resolved_unmatched(all_results)

    display_set = set(display_months)
    results = [r for r in all_results if r["month"] in display_set]
    results.reverse()  # newest on top for display

    totals = {"total": 0, "skipped": 0, "ok": 0, "manual": 0, "missing": 0, "info": 0}
    for r in results:
        for k in totals:
            totals[k] += r["stats"][k]

    return render_page(results, totals, list(reversed(display_months)))


def _storage_path_category(path_template: str) -> str:
    """Extract the category subfolder from a Paperless storage path template.

    Takes the last static path segment before the first Jinja2 expression.
    E.g. 'techlab/invoices/{%- for ... %}/{{ title }}' → 'invoices'
    """
    static_part = path_template.split("{")[0].rstrip("/")
    segments = [s for s in static_part.split("/") if s]
    return segments[-1] if segments else "other"


def _safe_filename(name: str) -> str:
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name).strip()


@app.route("/zip")
def zip_accounting():
    try:
        client = _get_client()
    except ConfigError as e:
        return _err(str(e))

    month = req.args.get("month", "")
    if not re.match(r"^\d{4}-\d{2}$", month):
        return _err("month query param required, format YYYY-MM", 400)

    accounting_tag = client.get_tag_id(ACCOUNTING_TAG_NAME)
    if accounting_tag is None:
        return _err(f"Tag '{ACCOUNTING_TAG_NAME}' not found")
    month_tag = client.get_tag_id(month)
    if month_tag is None:
        return _err(f"Tag '{month}' not found", 404)

    # Build storage_path_id → category subfolder from live Paperless config
    sp_category: dict[int, str] = {
        sp["id"]: _storage_path_category(sp["path"])
        for sp in client.get_storage_paths()
    }

    popis_field_id = client.get_custom_field_id(FILENAME_NOTE_FIELD_NAME)

    docs = client.get_documents(tags__id__all=f"{accounting_tag},{month_tag}")
    if not docs:
        return (
            f"<pre style='color:#8b949e;background:#0d1117;padding:2em'>No documents tagged '{_esc(month)}' + '{ACCOUNTING_TAG_NAME}'</pre>",
            404,
        )

    buf = io.BytesIO()
    used_entries: set[str] = set()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for doc in docs:
            subfolder = sp_category.get(doc.get("storage_path"), "other")

            title = doc.get("title") or f"document-{doc['id']}"
            popis = None
            if popis_field_id is not None:
                for cf in doc.get("custom_fields", []):
                    if cf.get("field") == popis_field_id and cf.get("value"):
                        popis = str(cf["value"])
                        break

            base = _safe_filename(title)
            if popis:
                base = f"{base} - {_safe_filename(popis)}"
            entry = f"{subfolder}/{base}.pdf"
            if entry in used_entries:
                entry = f"{subfolder}/{base} ({doc['id']}).pdf"
            used_entries.add(entry)

            pdf = client.session.get(f"{PAPERLESS_URL}/api/documents/{doc['id']}/download/")
            pdf.raise_for_status()
            zf.writestr(entry, pdf.content)

    buf.seek(0)
    return Response(
        buf.read(),
        mimetype="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{month}.zip"'},
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
.r a{{color:inherit;text-decoration:none}}
.r a:hover{{text-decoration:underline}}
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
    try:
        client = _get_client()
    except ConfigError as e:
        return _err(str(e))
    acct_stmt_tag = client.get_tag_id(ACCOUNT_STATEMENT_TAG_NAME)
    if acct_stmt_tag is None:
        return _err(f"Tag '{ACCOUNT_STATEMENT_TAG_NAME}' not found")
    accounting_tag = client.get_tag_id(ACCOUNTING_TAG_NAME)
    if accounting_tag is None:
        return _err(f"Tag '{ACCOUNTING_TAG_NAME}' not found")
    invoice_type = client.get_document_type_id(INVOICE_TYPE_NAME)
    if invoice_type is None:
        return _err(f"Document type '{INVOICE_TYPE_NAME}' not found")
    ta_field = client.get_custom_field_id(TOTAL_AMOUNT_FIELD_NAME)
    ta_alt_field = client.get_custom_field_id(TOTAL_AMOUNT_ALT_FIELD_NAME)

    # Find years with statement data
    tag_map = client.get_all_tags()
    stmts = client.get_documents_by_tag(acct_stmt_tag)
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
        income_prefixes=INCOME_PREFIXES,
    )
    return render_pl(pl, available_years, hourly_rates=_load_rates())


def _render_year_nav(current: int, years: list[int]) -> str:
    parts = []
    for y in years:
        if y == current:
            parts.append(f'<a class="active">{y}</a>')
        else:
            parts.append(f'<a href="/pl?year={y}">{y}</a>')
    return " &middot; ".join(parts)


def render_pl(pl: dict, available_years: list[int] | None = None, hourly_rates: list[dict] | None = None) -> str:
    year = pl["year"]
    income = pl["income"]
    expenses = pl["expenses"]
    total_exp = pl["total_expenses"]
    net = pl["net_income"]
    excluded = pl["excluded"]

    income_items = pl.get("income_items", [])
    expenses_detail = pl.get("expenses_detail", {})
    excluded_detail = pl.get("excluded_detail", {})

    # daily_rate is computed per-month via _rate_for_month; this flag gates the column
    show_days = bool(hourly_rates)

    # Transpose expenses_detail {cat: {month: amt}} → {month: {cat: amt}}
    exp_by_month: dict[str, dict[str, float]] = {}
    for cat, months in expenses_detail.items():
        for m, v in months.items():
            exp_by_month.setdefault(m, {})[cat] = v

    # Group income items by month; accumulate gross per month for worked-days calc
    income_by_month: dict[str, list[dict]] = {}
    net_by_month: dict[str, float] = {}
    for item in income_items:
        income_by_month.setdefault(item["month"], []).append(item)
        net_by_month[item["month"]] = net_by_month.get(item["month"], 0.0) + item["amount"]

    # All months with any data, filtered to requested year
    year_prefix = f"{year:04d}-"
    all_months = sorted(
        m
        for m in set(list(exp_by_month.keys()) + list(income_by_month.keys()))
        if m.startswith(year_prefix)
    )

    # Working-days totals for the summary row
    total_worked = 0
    total_wd = 0

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

        # Working days for this month
        days_html = ""
        if show_days:
            m_year, m_mon = int(m[:4]), int(m[5:7])
            wd_total = sk_working_days(m_year, m_mon)
            m_rate = _rate_for_month(hourly_rates, m)
            m_gross = m_income[0]["amount"] if m_income else 0.0
            wd_worked = round(m_gross / (m_rate * 8), 2) if (m_gross and m_rate) else 0.0
            total_worked += wd_worked
            total_wd += wd_total
            days_html = f'<span class="pl-days">{wd_worked:.2f}/{wd_total}</span>'

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
                f"{days_html}"
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
                f"{days_html}"
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
    payroll_addback = -pl["expenses"].get("payroll", 0.0)   # flip expense sign → positive
    net_total = net + payroll_addback
    net_total_class = "pos" if net_total >= 0 else "neg"

    # Working-days summary row
    days_summary_html = ""
    if show_days and total_wd:
        pct = round(total_worked / total_wd * 100)
        pct_class = "pos" if pct >= 90 else ("warn" if pct >= 75 else "neg")
        days_summary_html = (
            f'<div class="pl-row">'
            f'<span class="pl-label" style="color:#8b949e">Days worked</span>'
            f'<span class="pl-days-summary {pct_class}">{total_worked:.2f}/{total_wd} &mdash; {pct}%</span>'
            f'</div>'
        )

    if payroll_addback > 0:
        net_block = (
            f'  <div class="pl-row total">\n'
            f'    <span class="pl-label">Net company income</span>\n'
            f'    <span class="pl-amount {net_class}">{net:>12,.2f}</span>\n'
            f'  </div>\n'
            f'  <div class="pl-row sub">\n'
            f'    <span class="pl-label">+ payroll (personal)</span>\n'
            f'    <span class="pl-amount dim">{payroll_addback:>12,.2f}</span>\n'
            f'  </div>\n'
            f'  <div class="pl-row net">\n'
            f'    <span class="pl-label">Net total income</span>\n'
            f'    <span class="pl-amount {net_total_class}">{net_total:>12,.2f}</span>\n'
            f'  </div>'
        )
    else:
        net_block = (
            f'  <div class="pl-row net">\n'
            f'    <span class="pl-label">Net income</span>\n'
            f'    <span class="pl-amount {net_class}">{net:>12,.2f}</span>\n'
            f'  </div>'
        )

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
.pl-row a{{color:#8b949e;text-decoration:none}}
.pl-row a:hover{{text-decoration:underline}}
.pl-month{{min-width:80px;color:#8b949e;margin-right:1em;flex-shrink:0}}
.pl-label{{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}
.pl-gross{{margin-left:1em;font-size:12px;white-space:nowrap;color:#484f58}}
.pl-exp{{margin-left:1em;white-space:nowrap;min-width:100px;text-align:right}}
.pl-days{{margin-left:1em;white-space:nowrap;font-size:12px;min-width:50px;text-align:right;flex-shrink:0}}
.pl-days-summary{{margin-left:auto;white-space:nowrap;font-size:13px;flex-shrink:0}}
.pl-row.total{{border-top:1px solid #30363d;margin-top:.4em;padding-top:.4em;font-weight:bold}}
.pl-row.net{{border-top:2px solid #58a6ff;margin-top:.8em;padding-top:.6em;font-weight:bold;font-size:15px}}
.pl-amount{{text-align:right;min-width:120px;margin-left:auto;flex-shrink:0}}
.pos{{color:#3fb950}}
.neg{{color:#f85149}}
.warn{{color:#e3b341}}
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
{net_block}
{days_summary_html}
</div>
<div class="pl-section">
  <details class="totals-accordion">
    <summary class="pl-row" style="color:#8b949e">
      <span class="pl-label">Excluded (tax, dividends, loan principal)</span>
      <span class="pl-amount">{excluded:>12,.2f}</span>
    </summary>
{excl_cats_html}
  </details>
</div>
</body></html>"""


@app.route("/healthz")
def healthz():
    """Cache stats + client init status. Returns 503 if PAPERLESS_* unset."""
    try:
        client = _get_client()
    except ConfigError as e:
        return jsonify({"status": "error", "msg": str(e)}), 503
    return jsonify(
        {
            "status": "ok",
            "cache": client.cache_stats(),
            "tag_doc_keys": len(client.cached_tag_ids()),
        }
    )


# ── pre-heat thread ─────────────────────────────────────────────────────────

PREHEAT_INTERVAL_S = 90.0


def _preheat_working_set(client: PaperlessClient) -> None:
    """Warm the matching view's working set: tags map + statement docs +
    every month tag that has statement data + the ±1 window around today."""
    tag_map = client.get_all_tags()
    acct_stmt_id = client.get_tag_id(ACCOUNT_STATEMENT_TAG_NAME)
    if acct_stmt_id is None:
        log.warning("preheat: tag %r missing; skipping initial warm", ACCOUNT_STATEMENT_TAG_NAME)
        return
    stmts = client.get_documents_by_tag(acct_stmt_id)
    today = date.today()
    cur = f"{today.year:04d}-{today.month:02d}"
    months = {cur, month_offset(cur, -1), month_offset(cur, 1)}
    for s in stmts:
        for tid in s.get("tags", []):
            name = tag_map.get(tid, "")
            if re.match(r"\d{4}-\d{2}$", name):
                months.add(name)
    warmed = 0
    for m in sorted(months):
        tid = client.get_tag_id(m)
        if tid is None:
            continue
        client.get_documents_by_tag(tid)
        warmed += 1
    log.info("preheat: warmed %d month tag(s) + statement docs (%d stmts)", warmed, len(stmts))


def _revalidate_cached(client: PaperlessClient) -> None:
    """Revalidate every tag currently in the per-tag doc cache. The cached
    method handles probe → extend-or-refetch internally, so we just iterate."""
    for tid in client.cached_tag_ids():
        try:
            client.get_documents_by_tag(tid)
        except Exception:  # noqa: BLE001 — defensive in a daemon loop
            log.exception("preheat: revalidate failed for tag %s", tid)


def _preheat_loop(client: PaperlessClient, interval_s: float) -> None:
    try:
        _preheat_working_set(client)
    except Exception:  # noqa: BLE001
        log.exception("preheat: initial warm failed")
    while True:
        time.sleep(interval_s)
        try:
            _revalidate_cached(client)
        except Exception:  # noqa: BLE001
            log.exception("preheat: revalidation tick failed")


def start_preheat(interval_s: float = PREHEAT_INTERVAL_S) -> threading.Thread | None:
    """Start the daemon pre-heat thread. No-ops (with a warning) if the
    client can't be created — webapp still serves error pages until config
    is fixed."""
    try:
        client = _get_client()
    except ConfigError as e:
        log.warning("preheat: not starting: %s", e)
        return None
    t = threading.Thread(
        target=_preheat_loop,
        args=(client, interval_s),
        daemon=True,
        name="paperless-preheat",
    )
    t.start()
    return t


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    start_preheat()
    app.run(host="0.0.0.0", port=5000)
