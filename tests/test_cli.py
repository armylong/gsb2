"""End-to-end CLI tests: export -> reload -> verify, and the epsilon scan."""

from __future__ import annotations

import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _run(*args: str) -> subprocess.CompletedProcess:
    env = dict(os.environ, PYTHONPATH=ROOT)
    return subprocess.run(
        [sys.executable, "-m", "pathcheck", "--cli", *args],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
    )


def test_check_export_verify_roundtrip(tmp_path):
    out = tmp_path / "out"
    res = _run(
        "check", "--sample", "metaballs", "--eps", "0.5",
        "--out", str(out), "--scale", "1",
    )
    assert res.returncode == 0, res.stdout + res.stderr
    json_path = out / "metaballs.paths.json"
    ref = out / "metaballs.reference.png"
    assert json_path.exists() and ref.exists()
    assert (out / "metaballs.rebuild.png").exists()
    assert (out / "metaballs.diff.png").exists()

    res2 = _run("verify", str(json_path), "--mask", str(ref))
    assert res2.returncode == 0, res2.stdout + res2.stderr
    assert "组件 6 -> 6" in res2.stdout or "组件 6 ->" in res2.stdout


def test_aggressive_eps_fails_with_nonzero_exit(tmp_path):
    res = _run(
        "check", "--sample", "bridges", "--eps", "1.5",
        "--out", str(tmp_path / "bad"), "--scale", "1",
    )
    assert res.returncode == 2, res.stdout + res.stderr
    assert "[E] raster.components" in res.stdout


def test_scan_reports_first_failure():
    res = _run("scan", "--samples", "bridges", "--methods", "rdp", "--max-eps", "4")
    assert res.returncode == 0
    assert "raster.components" in res.stdout
