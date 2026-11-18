"""Render the main window offscreen to a PNG for visual inspection."""

from __future__ import annotations

import os
import sys

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtWidgets import QApplication  # noqa: E402


def main(path: str = "/tmp/apng_editor_window.png") -> int:
    app = QApplication(sys.argv)
    from apng_editor.ui.main_window import MainWindow

    window = MainWindow()
    window.resize(1280, 860)
    window.show()
    app.processEvents()
    # Give layout a moment to settle in the offscreen backend.
    for _ in range(5):
        app.processEvents()
    window.grab().save(path)
    print(path)
    return 0


if __name__ == "__main__":
    sys.exit(main(*(sys.argv[1:] or [])))
