"""PaperlessClient — thin REST wrapper around the Paperless-ngx API.

No domain logic. Used by collection.py and the CLI/server/webapp delivery
layers to fetch documents, tags, custom fields, and document types.
"""

from __future__ import annotations

import requests


class PaperlessClient:
    def __init__(self, url: str, token: str):
        self.url = url.rstrip("/")
        self.session = requests.Session()
        self.session.headers["Authorization"] = f"Token {token}"

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

    def get_document_type_id(self, name: str) -> int | None:
        """Resolve document type name to ID."""
        types = self._get_paginated("/api/document_types/")
        for dt in types:
            if dt["name"] == name:
                return dt["id"]
        return None

    def get_custom_field_id(self, name: str) -> int | None:
        """Resolve custom field name to ID."""
        fields = self._get_paginated("/api/custom_fields/")
        for f in fields:
            if f["name"] == name:
                return f["id"]
        return None

    def get_all_tags(self) -> dict[int, str]:
        """Return {tag_id: tag_name} mapping. Cached after first call."""
        if not hasattr(self, "_tag_cache"):
            tags = self._get_paginated("/api/tags/")
            self._tag_cache = {t["id"]: t["name"] for t in tags}
        return self._tag_cache

    def get_tag_id(self, name: str) -> int | None:
        """Resolve tag name to ID using cached tags."""
        for tid, tname in self.get_all_tags().items():
            if tname == name:
                return tid
        return None

    def get_documents(self, **filters) -> list[dict]:
        """Fetch documents with given filters."""
        return self._get_paginated("/api/documents/", params=filters)

    def get_document(self, doc_id: int) -> dict:
        """Fetch a single document by ID."""
        resp = self.session.get(f"{self.url}/api/documents/{doc_id}/")
        resp.raise_for_status()
        return resp.json()

    def get_storage_paths(self) -> list[dict]:
        """Fetch all storage paths."""
        return self._get_paginated("/api/storage_paths/")
