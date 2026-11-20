"""Command-line entry points.

    python -m parallax_lab           # open the GUI
    python -m parallax_lab --verify  # run the numeric verification, no display
"""

from __future__ import annotations

import sys


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if "--verify" in argv:
        from .verify import run_all
        return 0 if run_all() else 1
    from .app import main as gui_main
    return gui_main([sys.argv[0], *argv])


if __name__ == "__main__":
    sys.exit(main())
