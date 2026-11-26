"""Entry point: ``python -m cropkit [image-or-project]``."""

from __future__ import annotations

import sys


def main() -> int:
    from cropkit.ui.mainwindow import run

    return run(sys.argv)


if __name__ == "__main__":
    raise SystemExit(main())
