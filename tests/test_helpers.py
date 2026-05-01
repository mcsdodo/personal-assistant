"""Unit tests for tests/helpers.py — no network, no docker, no fixtures."""

from __future__ import annotations

import ssl

import pytest

from .helpers import _retry_on_network_error


def test_retry_succeeds_after_transient_connection_aborted():
    attempts = {"n": 0}

    def flaky():
        attempts["n"] += 1
        if attempts["n"] < 3:
            raise ConnectionAbortedError("simulated TLS reset")
        return "ok"

    result = _retry_on_network_error(flaky, max_attempts=3, base_delay=0)

    assert result == "ok"
    assert attempts["n"] == 3


def test_retry_succeeds_after_transient_ssl_error():
    attempts = {"n": 0}

    def flaky():
        attempts["n"] += 1
        if attempts["n"] < 2:
            raise ssl.SSLError("simulated SSL handshake failure")
        return 42

    result = _retry_on_network_error(flaky, max_attempts=3, base_delay=0)

    assert result == 42
    assert attempts["n"] == 2


def test_retry_raises_after_max_attempts_exhausted():
    attempts = {"n": 0}

    def always_fails():
        attempts["n"] += 1
        raise ConnectionAbortedError("permanent")

    with pytest.raises(ConnectionAbortedError):
        _retry_on_network_error(always_fails, max_attempts=3, base_delay=0)

    assert attempts["n"] == 3


def test_retry_does_not_swallow_unrelated_exceptions():
    attempts = {"n": 0}

    def buggy():
        attempts["n"] += 1
        raise ValueError("not a network error")

    with pytest.raises(ValueError):
        _retry_on_network_error(buggy, max_attempts=3, base_delay=0)

    assert attempts["n"] == 1
