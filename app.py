"""Launch the clipmend desktop tool."""

from __future__ import annotations

import sys
from pathlib import Path

from clipmend.ui.main_window import run


def main() -> int:
    return run(sys.argv)


if __name__ == "__main__":
    raise SystemExit(main())
