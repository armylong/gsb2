"""Application entry point.

Run with ``python -m audio_matcher`` (or ``audio-matcher`` once installed).
"""

from __future__ import annotations

import sys


def main(argv: list[str] | None = None) -> int:
    from PySide6.QtWidgets import QApplication

    from .ui.main_window import MainWindow

    app = QApplication(argv if argv is not None else sys.argv)
    app.setApplicationName("Interview Loudness Matcher")
    app.setOrganizationName("audio-matcher")
    window = MainWindow()
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
