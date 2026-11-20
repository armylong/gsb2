"""PySide6 GUI package.  Importing it does not create a QApplication."""

from __future__ import annotations


def run() -> int:
    from .main_window import run as _run

    return _run()


__all__ = ["run"]
