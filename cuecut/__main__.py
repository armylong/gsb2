"""Entry point: ``python -m cuecut`` or ``python -m cuecut.gui``."""

from __future__ import annotations

import sys


def main() -> int:
    from .gui.app import main as gui_main

    return gui_main(sys.argv)


if __name__ == "__main__":
    raise SystemExit(main())
