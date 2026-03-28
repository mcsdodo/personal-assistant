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
    wait_seed_complete,
    paperless_wipe,
    GMAIL_TO,
    OUTLOOK_TO,
)


def pytest_configure(config):
    config.addinivalue_line("markers", "gmail: tests using Gmail pipeline")
    config.addinivalue_line("markers", "outlook: tests using Outlook pipeline")
    config.addinivalue_line("markers", "link: tests using download link strategy")
    config.addinivalue_line("markers", "slow: tests that take >60s")


@pytest.fixture(scope="module")
def reset_pipeline():
    """Full reset: stop container, clear DBs + Paperless, restart, wait for seed.

    Shared per test module so we don't restart for every test.
    After seed, tests send emails and verify results.
    """
    full_reset()
    # Wait for both sources to seed
    wait_seed_complete("gmail", timeout=90)
    wait_seed_complete("outlook", timeout=90)
    yield
    # No teardown — leave state for debugging failed tests


@pytest.fixture(scope="module")
def reset_pipeline_gmail_only():
    """Reset and wait for Gmail seed only (faster for Gmail-only tests)."""
    full_reset()
    wait_seed_complete("gmail", timeout=90)
    yield


@pytest.fixture(scope="module")
def reset_pipeline_outlook_only():
    """Reset and wait for Outlook seed only."""
    full_reset()
    wait_seed_complete("outlook", timeout=90)
    yield


@pytest.fixture
def clean_paperless():
    """Wipe Paperless between tests (without full container restart)."""
    paperless_wipe()
    yield
