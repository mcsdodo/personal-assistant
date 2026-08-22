# checker-mcp

Invoice matching and P&L. One container, **two processes** -- FastMCP on `:8001/mcp` in the
background and the Flask web UI as PID 1 on `:5000` (see [entrypoint.sh](entrypoint.sh)).

| File | What it owns |
|---|---|
| [server.py](server.py) | FastMCP wrapper over the engine. Lazy-init `PaperlessClient` singleton + field-ID resolution. Rewrites the Host header to pass DNS rebinding protection under Docker networking. |
| [webapp.py](webapp.py) | Flask UI: matching view (terminal-style, status `ok`/`missing`/`manual`/`info`) and P&L view. Query params `?month=2026-03`, `?all`, `?year=2026`. |
| [match_invoices.py](match_invoices.py) | CLI entry point **and the shared configuration constants** (`PAPERLESS_URL`, `ACCOUNTING_TAG_NAME`, `ACCOUNT_STATEMENT_TAG_NAME`, `INVOICE_TYPE_NAME`, `TOTAL_AMOUNT_FIELD_NAME`, `TOTAL_AMOUNT_ALT_FIELD_NAME`), which `server.py` and `webapp.py` import rather than re-declaring. |
| [engine/](engine/) | The matching engine, layered. |

## The engine is strictly layered -- keep it that way

Strict layering: `models` has no dependencies; `parsing`, `matching` and `client` depend only on `models`.
`collection` depends on all four. A new import that crosses those lines is the thing to catch
in review.

| Module | Owns |
|---|---|
| [engine/models.py](engine/models.py) | `PLCategory`, `SkipReason`, `SkipRule`, `SkipResult`, `SKIP_RULES`, `SKIP_ACCOUNT_RULES` (loaded from the `SKIP_PAYROLL_ACCOUNTS` env var) |
| [engine/parsing.py](engine/parsing.py) | Statement parsing regexes and `parse_movements()` (Tatra Banka format). Every movement dict carries an `"account"` key -- the counterparty account token, or `None` for POS/ATM/fee rows. Invoice amount extraction, `normalize_amount()`, `extract_invoice_amounts()`. |
| [engine/matching.py](engine/matching.py) | `MONTH_WINDOW`, `get_month_window()`, `skip_reason()`, `detect_returned_payments()`, `build_pair_index()` (filename prefix + title prefix + cross-sign), `find_matching_invoice()` (4-pass: primary+sign, primary, secondary+sign, secondary) |
| [engine/client.py](engine/client.py) | `PaperlessClient` -- paginated REST wrapper for documents, tags, custom fields, document types |
| [engine/collection.py](engine/collection.py) | `collect_month()` and `collect_pl()` orchestration |

## Returned payments are detected once, before matching

`collect_month()` flattens the month's movements and calls `detect_returned_payments()`
**before** any matching. A returned-payment pair is keyed on absolute amount plus counterparty
account, with the outgoing leg dated on or before the incoming one; movements with
`account=None` are skipped. Both legs are marked `status="cancelled"` / `label="RETURNED"`
so **neither consumes an invoice** -- which is the point, and why the call has to come first.

`collect_pl()` already skips `cancelled` rows, so RETURNED legs are excluded from P&L for
free.

**Known limitation, stated so nobody re-derives it:** cross-month returns -- payment in one
statement, return in the next -- are **not** detected here. The older amount-only
post-matching detector still covers those, but only when both legs come out `MISSING`.

## Ordering a bundle

`_invoice_order_date` in [engine/collection.py](engine/collection.py) prefers the
`receipt_datetime` custom field -- the LLM-extracted **issue** date -- and only falls back to
Paperless's own `created`, which is a label-blind OCR guess. Every surface (matching view,
P&L, MCP tools, CLI) is threaded with `receipt_datetime_field_id` so they all pick the same
primary. Reasoning and the tie-break rule:
[docs/uc2-invoice-matching.md](../docs/uc2-invoice-matching.md).
