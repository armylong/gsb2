"""Shared helpers for the test suite."""

from __future__ import annotations

import os
import tempfile

from pcaprecon import samplegen
from pcaprecon.analyzer import analyze
from pcaprecon.config import Config


def analyze_fixture(name: str, config: Config | None = None):
    tmp = tempfile.mkdtemp(prefix="pcaprecon_test_")
    path = os.path.join(tmp, f"{name}.pcap")
    samplegen.SCENARIOS[name](path)
    return analyze(path, config or Config()), path


def session(result, index: int = 0):
    return result.sessions[index]


def messages(result, direction: str | None = None):
    out = [m for s in result.sessions for m in s.messages]
    if direction:
        out = [m for m in out if m.direction == direction]
    return out


def anomaly_codes(result):
    return [a.code for a in result.anomalies]
