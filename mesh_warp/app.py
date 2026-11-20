"""Application entry point and headless-friendly startup helpers."""

from __future__ import annotations

import sys


def main(argv: list[str] | None = None) -> int:
    from .gui.main_window import run

    return run(argv if argv is not None else sys.argv)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main(sys.argv))
