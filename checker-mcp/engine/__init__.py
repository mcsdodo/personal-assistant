"""Invoice matching engine.

Layered package extracted from the former monolithic match_invoices.py:

  models.py     — enums, dataclasses, skip rules
  parsing.py    — statement text parsing, amount extraction (pure functions)
  matching.py   — 4-pass matching, pair index, skip rules, month arithmetic
  client.py     — PaperlessClient (thin REST wrapper)
  collection.py — collect_month, collect_pl, filter_resolved_unmatched
                  (orchestration over the layers above + Paperless calls)

Import graph (strict):

  models.py     ← parsing.py
              ← matching.py
              ← collection.py
  client.py   ← collection.py
  parsing.py  ← collection.py
  matching.py ← collection.py

Callers (server.py, webapp.py, match_invoices.py CLI, test_matching.py)
import directly from the leaf modules they need.
"""
