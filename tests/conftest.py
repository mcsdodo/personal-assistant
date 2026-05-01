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


@pytest.fixture
def drive_client():
    """Direct Google Drive API client for gdrive E2E tests.

    Credentials are loaded from the same token.json used by gmail_service()
    (see helpers._get_drive_credentials).  The token must include the
    https://www.googleapis.com/auth/drive scope — re-authorise if it was
    created with gmail.send only.

    GDRIVE_LEVEL1 and GDRIVE_LEVEL2 are read from the environment (or .env).
    Only the first value of GDRIVE_LEVEL2 is used (comma-separated list).
    """
    from .helpers import DriveTestClient, _get_drive_credentials, make_drive_service

    level1 = _env("GDRIVE_LEVEL1", "").split(",")[0].strip()
    level2 = _env("GDRIVE_LEVEL2", "").split(",")[0].strip()
    creds = _get_drive_credentials()
    return DriveTestClient(make_drive_service(creds), level1, level2)
