"""Pytest configuration and fixtures for E2E pipeline tests.

Prerequisites:
  - Local compose stack running (personal-assistant + paperless)
  - Gmail OAuth token valid (run send-test-email.py once to auth)
  - Outlook auth active (device code flow)
  - pip install pytest requests google-auth google-api-python-client
"""

from __future__ import annotations

import os

import pytest

from .helpers import (
    full_reset,
    paperless_wipe,
    _env,
)


def pytest_configure(config):
    config.addinivalue_line("markers", "gmail: tests using Gmail pipeline")
    config.addinivalue_line("markers", "outlook: tests using Outlook pipeline")
    config.addinivalue_line("markers", "link: tests using download link strategy")
    config.addinivalue_line("markers", "slow: tests that take >60s")
    config.addinivalue_line("markers", "gdrive: end-to-end test against Google Drive watcher path")


@pytest.fixture(scope="module")
def reset_pipeline():
    """Full reset with both sources pre-seeded."""
    full_reset("gmail", "outlook")
    yield


@pytest.fixture
def clean_paperless():
    """Wipe Paperless between tests (without full container restart)."""
    paperless_wipe()
    yield


def _make_drive_client(owner: str, bucket: str):
    """Construct a :class:`DriveTestClient` reading GDRIVE_ROOT from the environment."""
    from .helpers import DriveTestClient, _get_drive_credentials, make_drive_service

    root = _env("GDRIVE_ROOT", "").strip()
    creds = _get_drive_credentials()
    return DriveTestClient(make_drive_service(creds), owner=owner, bucket=bucket, root=root)


def _first(env_var: str, fallback_var: str, default: str) -> str:
    """Return the first comma-separated value of *env_var*, falling back to *fallback_var*."""
    raw = _env(env_var, "") or _env(fallback_var, "")
    first = raw.split(",")[0].strip()
    return first or default


@pytest.fixture
def drive_client():
    """Direct Google Drive API client for gdrive E2E tests (business/first-owner bucket).

    Credentials are loaded from the same token.json used by gmail_service()
    (see helpers._get_drive_credentials).  The token must include the
    https://www.googleapis.com/auth/drive scope — re-authorise if it was
    created with gmail.send only.

    Reads GDRIVE_ROOT / GDRIVE_OWNERS / GDRIVE_BUCKETS (or the legacy
    GDRIVE_LEVEL1 / GDRIVE_LEVEL2 fallbacks) from the environment or .env.
    Only the first value of each comma-separated list is used.
    """
    owner = _first("GDRIVE_OWNERS", "GDRIVE_LEVEL1", "techlab")
    bucket = _first("GDRIVE_BUCKETS", "GDRIVE_LEVEL2", "accounting")
    return _make_drive_client(owner=owner, bucket=bucket)


@pytest.fixture
def personal_drive_client():
    """Drive client scoped to the personal-owner accounting bucket.

    Uses the same root as ``drive_client`` (GDRIVE_ROOT) but resolves
    the ``personal`` owner folder and the first configured bucket.
    Requires the personal sub-tree to exist in Drive (e.g.
    ``_documents_intake_dev/personal/accounting``).
    """
    bucket = _first("GDRIVE_BUCKETS", "GDRIVE_LEVEL2", "accounting")
    return _make_drive_client(owner="personal", bucket=bucket)
