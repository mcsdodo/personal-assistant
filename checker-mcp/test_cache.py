#!/usr/bin/env python3
"""Unit tests for engine.cache + PaperlessClient cache integration.

Run: python -m pytest test_cache.py -v
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from engine.cache import TagDocCache, TTLCache
from engine.client import PaperlessClient


# ═════════════════════════════════════════════════════════════════════════════
# TTLCache
# ═════════════════════════════════════════════════════════════════════════════


class _Clock:
    def __init__(self, t: float = 0.0):
        self.t = t

    def __call__(self) -> float:
        return self.t


def _ttl(default_ttl=60.0):
    c = TTLCache(default_ttl=default_ttl)
    c._time_func = _Clock()
    return c, c._time_func


def _tagdoc(ttl=60.0):
    c = TagDocCache(ttl=ttl)
    c._time_func = _Clock()
    return c, c._time_func


def test_ttlcache_fresh_hit():
    c, clock = _ttl()
    c.set("k", "v")
    clock.t = 59.0
    assert c.get("k") == "v"
    assert c.stats()["hits"] == 1


def test_ttlcache_expiry():
    c, clock = _ttl()
    c.set("k", "v")
    clock.t = 61.0
    assert c.get("k") is None
    assert c.stats()["misses"] == 1


def test_ttlcache_invalidate():
    c = TTLCache(default_ttl=60.0)
    c.set("k", "v")
    c.invalidate("k")
    assert c.get("k") is None


def test_ttlcache_per_call_ttl_override():
    c, clock = _ttl(default_ttl=10.0)
    c.set("k", "v", ttl=300.0)
    clock.t = 100.0
    assert c.get("k") == "v"  # 100s < 300s


# ═════════════════════════════════════════════════════════════════════════════
# TagDocCache
# ═════════════════════════════════════════════════════════════════════════════


def _doc(doc_id, modified="2026-01-01T00:00:00+00:00"):
    return {"id": doc_id, "modified": modified, "tags": []}


def test_tagdoc_empty_cache():
    c = TagDocCache(ttl=60.0)
    assert c.get_fresh(1) is None
    assert c.peek_validator(1) is None


def test_tagdoc_fresh_hit():
    c, clock = _tagdoc()
    docs = [_doc(1), _doc(2)]
    c.set(99, docs)
    clock.t = 30.0
    assert c.get_fresh(99) == docs
    assert c.stats()["fresh_hits"] == 1


def test_tagdoc_expired_but_validator_available():
    """After TTL expiry, get_fresh returns None but peek_validator still works."""
    c, clock = _tagdoc()
    c.set(99, [_doc(1, "2026-01-01T00:00:00+00:00"), _doc(2, "2026-02-01T00:00:00+00:00")])
    clock.t = 61.0
    assert c.get_fresh(99) is None
    assert c.peek_validator(99) == (2, "2026-02-01T00:00:00+00:00")


def test_tagdoc_extend_after_expiry():
    """Successful revalidation extends TTL and atomically returns docs."""
    c, clock = _tagdoc()
    docs = [_doc(1)]
    c.set(99, docs)
    clock.t = 61.0
    assert c.get_fresh(99) is None
    returned = c.extend(99)
    assert returned == docs
    assert c.get_fresh(99) == docs
    assert c.stats()["revalidations"] == 1


def test_tagdoc_set_computes_validator():
    """validator = (count, max(modified))."""
    c = TagDocCache(ttl=60.0)
    c.set(
        99,
        [
            _doc(1, "2025-12-31T00:00:00+00:00"),
            _doc(2, "2026-03-15T12:00:00+00:00"),
            _doc(3, "2026-01-01T00:00:00+00:00"),
        ],
    )
    assert c.peek_validator(99) == (3, "2026-03-15T12:00:00+00:00")


def test_tagdoc_empty_list_validator():
    c = TagDocCache(ttl=60.0)
    c.set(99, [])
    assert c.peek_validator(99) == (0, "")


def test_tagdoc_invalidate():
    c = TagDocCache(ttl=60.0)
    c.set(99, [_doc(1)])
    c.invalidate(99)
    assert c.get_fresh(99) is None
    assert c.peek_validator(99) is None


def test_tagdoc_extend_returns_none_when_missing():
    c = TagDocCache(ttl=60.0)
    assert c.extend(99) is None
    assert c.stats()["revalidations"] == 0


# ═════════════════════════════════════════════════════════════════════════════
# PaperlessClient cache integration (mocked session)
# ═════════════════════════════════════════════════════════════════════════════


def _make_client():
    """PaperlessClient with mocked session.get + injected clocks.

    Returns ``(client, session.get mock, clock)``. The same clock drives both
    the lookup cache and the per-tag doc cache.
    """
    client = PaperlessClient("http://paperless", "tok")
    client.session.get = MagicMock()
    clock = _Clock()
    client._lookup_cache._time_func = clock
    client._tag_doc_cache._time_func = clock
    return client, client.session.get, clock


def _list_response(docs, count=None):
    """Build a Paperless paginated list response (single page)."""
    mock = MagicMock()
    mock.json.return_value = {
        "count": count if count is not None else len(docs),
        "next": None,
        "results": docs,
    }
    mock.raise_for_status = MagicMock()
    return mock


def _probe_response(count, latest_modified):
    """Probe shape: {count, next, results: [{id, modified}]}."""
    results = [{"id": 1, "modified": latest_modified}] if count > 0 else []
    mock = MagicMock()
    mock.json.return_value = {"count": count, "next": None, "results": results}
    mock.raise_for_status = MagicMock()
    return mock


def test_get_documents_by_tag_first_call_full_fetch():
    client, session_get, _ = _make_client()
    session_get.return_value = _list_response(
        [_doc(1, "2026-03-01T00:00:00+00:00"), _doc(2, "2026-03-02T00:00:00+00:00")]
    )
    docs = client.get_documents_by_tag(99)
    assert len(docs) == 2
    assert session_get.call_count == 1


def test_get_documents_by_tag_second_call_within_ttl_no_http():
    client, session_get, clock = _make_client()
    session_get.return_value = _list_response([_doc(1, "2026-03-01T00:00:00+00:00")])
    client.get_documents_by_tag(99)
    session_get.reset_mock()
    clock.t = 30.0  # within 90s TTL
    docs = client.get_documents_by_tag(99)
    assert len(docs) == 1
    assert session_get.call_count == 0


def test_get_documents_by_tag_validator_hit_only_probes():
    """Past TTL, validator unchanged → 1 probe call, no full fetch."""
    client, session_get, clock = _make_client()
    session_get.return_value = _list_response(
        [_doc(1, "2026-03-01T00:00:00+00:00"), _doc(2, "2026-03-02T00:00:00+00:00")]
    )
    client.get_documents_by_tag(99)
    session_get.reset_mock()
    clock.t = 200.0  # past 90s TTL
    session_get.return_value = _probe_response(2, "2026-03-02T00:00:00+00:00")
    docs = client.get_documents_by_tag(99)
    assert len(docs) == 2
    assert session_get.call_count == 1  # probe only
    # And verify the call was the probe shape, not a full list.
    call_params = session_get.call_args.kwargs.get("params") or session_get.call_args[1].get("params", {})
    assert call_params.get("page_size") == 1
    assert call_params.get("ordering") == "-modified"


def test_get_documents_by_tag_validator_miss_count_refetches():
    client, session_get, clock = _make_client()
    session_get.return_value = _list_response([_doc(1, "2026-03-01T00:00:00+00:00")])
    client.get_documents_by_tag(99)
    session_get.reset_mock()
    clock.t = 200.0
    # Probe sees count=2 (new doc added), then refetch returns 2 docs.
    session_get.side_effect = [
        _probe_response(2, "2026-03-05T00:00:00+00:00"),
        _list_response(
            [_doc(1, "2026-03-01T00:00:00+00:00"), _doc(2, "2026-03-05T00:00:00+00:00")]
        ),
    ]
    docs = client.get_documents_by_tag(99)
    assert len(docs) == 2
    assert session_get.call_count == 2  # probe + full refetch


def test_get_documents_by_tag_validator_miss_modified_refetches():
    client, session_get, clock = _make_client()
    session_get.return_value = _list_response(
        [_doc(1, "2026-03-01T00:00:00+00:00"), _doc(2, "2026-03-02T00:00:00+00:00")]
    )
    client.get_documents_by_tag(99)
    session_get.reset_mock()
    clock.t = 200.0
    # Probe sees same count but a newer max_modified → existing doc was edited.
    session_get.side_effect = [
        _probe_response(2, "2026-03-10T00:00:00+00:00"),
        _list_response(
            [_doc(1, "2026-03-01T00:00:00+00:00"), _doc(2, "2026-03-10T00:00:00+00:00")]
        ),
    ]
    docs = client.get_documents_by_tag(99)
    assert len(docs) == 2
    # Validator update visible to subsequent calls.
    assert client._tag_doc_cache.peek_validator(99) == (2, "2026-03-10T00:00:00+00:00")
    assert session_get.call_count == 2


def test_lookup_caches_share_across_calls():
    """tags / document_types / custom_fields / storage_paths are TTL-cached."""
    client, session_get, _ = _make_client()
    session_get.return_value = _list_response(
        [{"id": 1, "name": "Invoice"}, {"id": 2, "name": "Receipt"}]
    )
    client.get_document_type_id("Invoice")
    client.get_document_type_id("Receipt")
    # Second call must not hit HTTP.
    assert session_get.call_count == 1


def test_tag_cache_survives_across_calls():
    """get_all_tags caches across calls (was already cached per-instance — assert it)."""
    client, session_get, _ = _make_client()
    session_get.return_value = _list_response(
        [{"id": 1, "name": "accounting"}, {"id": 2, "name": "2026-03"}]
    )
    client.get_all_tags()
    client.get_all_tags()
    assert session_get.call_count == 1


# ═════════════════════════════════════════════════════════════════════════════
# /pl N+1 fix verification
# ═════════════════════════════════════════════════════════════════════════════


def test_get_document_falls_through_no_cache():
    """get_document(doc_id) is intentionally uncached — it's the fallback in
    collect_pl. Asserts we don't accidentally start caching individual docs.
    """
    client, session_get, _ = _make_client()
    session_get.return_value.json.return_value = {"id": 1, "tags": [99]}
    client.get_document(1)
    client.get_document(1)
    assert session_get.call_count == 2
