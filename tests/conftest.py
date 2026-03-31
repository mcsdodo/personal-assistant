"""Pytest configuration and fixtures for E2E pipeline tests.

Prerequisites:
  - Local compose stack running (personal-assistant + paperless)
  - Gmail OAuth token valid (run send-test-email.py once to auth)
  - Outlook auth active (device code flow)
  - pip install pytest requests google-auth google-api-python-client
"""

from __future__ import annotations

import pytest

from .helpers import (
    full_reset,
    wait_source_ready,
    paperless_wipe,
)


def pytest_configure(config):
    config.addinivalue_line("markers", "gmail: tests using Gmail pipeline")
    config.addinivalue_line("markers", "outlook: tests using Outlook pipeline")
    config.addinivalue_line("markers", "link: tests using download link strategy")
    config.addinivalue_line("markers", "slow: tests that take >60s")


@pytest.fixture(scope="module")
def reset_pipeline():
    """Full reset: stop container, clear DBs + Paperless, restart, wait for ready."""
    full_reset()
    wait_source_ready("gmail")
    wait_source_ready("outlook")
    yield


@pytest.fixture(scope="module")
def reset_pipeline_gmail_only():
    """Reset and wait for Gmail source ready."""
    full_reset()
    wait_source_ready("gmail")
    yield


@pytest.fixture(scope="module")
def reset_pipeline_outlook_only():
    """Reset and wait for Outlook source ready."""
    full_reset()
    wait_source_ready("outlook")
    yield


@pytest.fixture
def clean_paperless():
    """Wipe Paperless between tests (without full container restart)."""
    paperless_wipe()
    yield
