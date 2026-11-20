"""Headless verification entry point: ``python verify.py``.

Runs the pytest suite plus the standalone self-check and prints a single summary.
Kept as a separate file because it is the command referenced by the README.
"""

from __future__ import annotations

import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def run(cmd: list[str]) -> int:
    print("$", " ".join(cmd), flush=True)
    return subprocess.call(cmd, cwd=HERE, env={**os.environ, "QT_QPA_PLATFORM": "offscreen"})


def main() -> int:
    py = sys.executable
    checks = [
        [py, "-m", "pytest", "tests", "-q", "-p", "no:cacheprovider"],
        [py, "selfcheck.py"],
    ]
    failures = 0
    for cmd in checks:
        code = run(cmd)
        if code != 0:
            failures += 1
    print()
    if failures:
        print(f"verify.py: {failures} 组检查失败")
        return 1
    print("verify.py: 全部检查通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
