"""Caching layer for PaperlessClient.

Two caches:

- ``TTLCache`` — plain TTL, used for lookups whose results change rarely
  (tags, document types, custom fields, storage paths). 10 min TTL.

- ``TagDocCache`` — TTL + synthetic-ETag revalidation for
  ``/api/documents/?tags__id=X``. Paperless DRF emits no ``ETag`` or
  ``Last-Modified`` headers and ignores ``If-None-Match``, so we build a
  logical validator from ``(count, max(modified))`` and probe with
  ``?tags__id=X&ordering=-modified&page_size=1&fields=id,modified``
  (~1.2 KB / ~90 ms vs. a full paginated refetch).

Thread-safe via one ``RLock`` per cache. Single-user internal tool — no
per-key locking / thundering-herd dedup; a rare double-fetch on race is
invisible.

Tests can override the clock by assigning ``cache._time_func = callable``.
"""

from __future__ import annotations

import threading
import time
from typing import Any, Callable


class TTLCache:
    """Thread-safe TTL cache. Pure stdlib, no eviction beyond expiry."""

    def __init__(self, default_ttl: float = 600.0):
        self._lock = threading.RLock()
        self._store: dict[Any, tuple[Any, float]] = {}
        self._default_ttl = default_ttl
        self._time_func: Callable[[], float] | None = None  # test override
        self.hits = 0
        self.misses = 0

    def _now(self) -> float:
        return self._time_func() if self._time_func is not None else time.monotonic()

    def get(self, key: Any) -> Any | None:
        with self._lock:
            entry = self._store.get(key)
            if entry is None:
                self.misses += 1
                return None
            value, expires_at = entry
            if self._now() > expires_at:
                self.misses += 1
                return None
            self.hits += 1
            return value

    def set(self, key: Any, value: Any, ttl: float | None = None) -> None:
        with self._lock:
            self._store[key] = (value, self._now() + (ttl if ttl is not None else self._default_ttl))

    def invalidate(self, key: Any) -> None:
        with self._lock:
            self._store.pop(key, None)

    def clear(self) -> None:
        with self._lock:
            self._store.clear()
            self.hits = 0
            self.misses = 0

    def stats(self) -> dict:
        with self._lock:
            return {"hits": self.hits, "misses": self.misses, "size": len(self._store)}


class TagDocCache:
    """Cache /api/documents/?tags__id=X results with TTL + synthetic-ETag.

    Flow (caller side, in PaperlessClient.get_documents_by_tag):

    1. ``get_fresh(tag_id)`` — fast path while entry is within TTL.
    2. On TTL expiry but entry still present:
       - read ``peek_validator(tag_id)`` to get ``(count, max_modified)``;
       - probe Paperless for the current ``(count, max_modified)``;
       - if they match, ``extend(tag_id)`` (returns the docs atomically);
       - if they don't, fall through to a full refetch + ``set``.
    3. On no entry at all, full fetch + ``set``.
    """

    def __init__(self, ttl: float = 90.0):
        self._lock = threading.RLock()
        self._store: dict[int, dict] = {}
        self._ttl = ttl
        self._time_func: Callable[[], float] | None = None  # test override
        self.fresh_hits = 0
        self.revalidations = 0
        self.misses = 0

    def _now(self) -> float:
        return self._time_func() if self._time_func is not None else time.monotonic()

    def get_fresh(self, tag_id: int) -> list[dict] | None:
        with self._lock:
            entry = self._store.get(tag_id)
            if entry and self._now() <= entry["expires_at"]:
                self.fresh_hits += 1
                return entry["docs"]
            return None

    def peek_validator(self, tag_id: int) -> tuple[int, str] | None:
        with self._lock:
            entry = self._store.get(tag_id)
            if entry is None:
                return None
            return entry["count"], entry["max_modified"]

    def extend(self, tag_id: int, ttl: float | None = None) -> list[dict] | None:
        """Bump TTL on an existing entry and return its docs atomically.

        Returns None if no entry exists. Used by the request path after a
        successful probe (validator hit) and by the pre-heat thread.
        """
        with self._lock:
            entry = self._store.get(tag_id)
            if entry is None:
                return None
            entry["expires_at"] = self._now() + (ttl if ttl is not None else self._ttl)
            self.revalidations += 1
            return entry["docs"]

    def set(self, tag_id: int, docs: list[dict], ttl: float | None = None) -> None:
        with self._lock:
            self._store[tag_id] = {
                "docs": docs,
                "count": len(docs),
                "max_modified": max((d.get("modified", "") for d in docs), default=""),
                "expires_at": self._now() + (ttl if ttl is not None else self._ttl),
            }
            self.misses += 1

    def invalidate(self, tag_id: int) -> None:
        with self._lock:
            self._store.pop(tag_id, None)

    def clear(self) -> None:
        with self._lock:
            self._store.clear()
            self.fresh_hits = 0
            self.revalidations = 0
            self.misses = 0

    def tags(self) -> list[int]:
        with self._lock:
            return list(self._store.keys())

    def stats(self) -> dict:
        with self._lock:
            return {
                "size": len(self._store),
                "fresh_hits": self.fresh_hits,
                "revalidations": self.revalidations,
                "misses": self.misses,
            }
