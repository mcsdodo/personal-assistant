"""PaperlessClient — thin REST wrapper around the Paperless-ngx API.

Caching strategy (see ``engine/cache.py``):

- Lookup endpoints (``/api/tags/``, ``/api/document_types/``,
  ``/api/custom_fields/``, ``/api/storage_paths/``) are TTL-cached (10 min)
  via ``TTLCache``. These change rarely.

- ``/api/documents/?tags__id=X`` is cached per tag with TTL (90 s) + a
  synthetic-ETag revalidation built from ``(count, max(modified))``.
  Paperless's DRF endpoints emit no ``ETag``/``Last-Modified`` and ignore
  ``If-None-Match``, so we approximate with the cheapest probe DRF allows:
  ``?ordering=-modified&page_size=1&fields=id,modified`` (~1.2 KB / ~90 ms).

The generic ``get_documents(**filters)`` path is intentionally **not** cached
— it's used for multi-tag-AND queries (e.g. ``/zip``) where the synthetic
validator wouldn't apply cleanly. Use ``get_documents_by_tag(tag_id)`` for
the cached path.
"""

from __future__ import annotations

import requests

from .cache import TagDocCache, TTLCache


LOOKUP_TTL = 600.0   # tags, document types, custom fields, storage paths
TAG_DOC_TTL = 90.0   # per-tag document lists


class PaperlessClient:
    def __init__(self, url: str, token: str):
        self.url = url.rstrip("/")
        self.session = requests.Session()
        self.session.headers["Authorization"] = f"Token {token}"
        self._lookup_cache = TTLCache(default_ttl=LOOKUP_TTL)
        self._tag_doc_cache = TagDocCache(ttl=TAG_DOC_TTL)

    # ── core HTTP ────────────────────────────────────────────────────────

    def _get_paginated(self, endpoint: str, params: dict | None = None) -> list[dict]:
        """Fetch all pages from a paginated API endpoint."""
        results = []
        url = f"{self.url}{endpoint}"
        params = dict(params or {})
        params.setdefault("page_size", 100)
        while url:
            resp = self.session.get(url, params=params)
            resp.raise_for_status()
            data = resp.json()
            results.extend(data.get("results", []))
            url = data.get("next")
            params = {}  # next URL already contains params
        return results

    def _cached_paginated(self, endpoint: str, ttl: float = LOOKUP_TTL) -> list[dict]:
        """TTL-cached variant of ``_get_paginated`` (no params, no validator)."""
        cached = self._lookup_cache.get(endpoint)
        if cached is not None:
            return cached
        data = self._get_paginated(endpoint)
        self._lookup_cache.set(endpoint, data, ttl=ttl)
        return data

    # ── lookups (TTL-cached) ─────────────────────────────────────────────

    def get_document_type_id(self, name: str) -> int | None:
        for dt in self._cached_paginated("/api/document_types/"):
            if dt["name"] == name:
                return dt["id"]
        return None

    def get_custom_field_id(self, name: str) -> int | None:
        for f in self._cached_paginated("/api/custom_fields/"):
            if f["name"] == name:
                return f["id"]
        return None

    def get_all_tags(self) -> dict[int, str]:
        cached = self._lookup_cache.get("__tags_map__")
        if cached is not None:
            return cached
        tags = self._get_paginated("/api/tags/")
        mapping = {t["id"]: t["name"] for t in tags}
        self._lookup_cache.set("__tags_map__", mapping, ttl=LOOKUP_TTL)
        return mapping

    def get_tag_id(self, name: str) -> int | None:
        for tid, tname in self.get_all_tags().items():
            if tname == name:
                return tid
        return None

    def get_storage_paths(self) -> list[dict]:
        return self._cached_paginated("/api/storage_paths/")

    # ── documents ────────────────────────────────────────────────────────

    def get_documents(self, **filters) -> list[dict]:
        """Generic uncached document fetch. Use for multi-filter queries.

        For single-tag queries prefer ``get_documents_by_tag(tag_id)`` —
        it's TTL-cached with synthetic-ETag revalidation.
        """
        return self._get_paginated("/api/documents/", params=filters)

    def get_documents_by_tag(self, tag_id: int) -> list[dict]:
        """Cached fetch of all documents tagged with ``tag_id``.

        TTL fast path → probe revalidation (validator hit extends TTL,
        miss triggers full refetch) → full fetch on cold cache.
        """
        cached = self._tag_doc_cache.get_fresh(tag_id)
        if cached is not None:
            return cached

        validator = self._tag_doc_cache.peek_validator(tag_id)
        if validator is not None:
            probe = self._probe_tag(tag_id)
            if probe == validator:
                extended = self._tag_doc_cache.extend(tag_id)
                if extended is not None:
                    return extended

        docs = self._get_paginated("/api/documents/", params={"tags__id": tag_id})
        self._tag_doc_cache.set(tag_id, docs)
        return docs

    def _probe_tag(self, tag_id: int) -> tuple[int, str]:
        """Cheap (count, max_modified) probe for tag-scoped doc list.

        DRF returns the total count in the envelope; ordering=-modified
        puts the latest-modified doc first; fields=id,modified projects
        away the rest. ~1.2 KB / ~90 ms per probe.
        """
        resp = self.session.get(
            f"{self.url}/api/documents/",
            params={
                "tags__id": tag_id,
                "ordering": "-modified",
                "page_size": 1,
                "fields": "id,modified",
            },
        )
        resp.raise_for_status()
        data = resp.json()
        count = int(data.get("count", 0))
        results = data.get("results") or []
        max_mod = results[0]["modified"] if results else ""
        return count, max_mod

    def get_document(self, doc_id: int) -> dict:
        """Fetch a single document by ID. Intentionally uncached — used as
        a fallback in collect_pl after the doc_cache lookup misses."""
        resp = self.session.get(f"{self.url}/api/documents/{doc_id}/")
        resp.raise_for_status()
        return resp.json()

    # ── cache controls ──────────────────────────────────────────────────

    def invalidate_tag(self, tag_id: int) -> None:
        self._tag_doc_cache.invalidate(tag_id)

    def cache_stats(self) -> dict:
        return {
            "lookup": self._lookup_cache.stats(),
            "tag_docs": self._tag_doc_cache.stats(),
        }

    def cached_tag_ids(self) -> list[int]:
        return self._tag_doc_cache.tags()
