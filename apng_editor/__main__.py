"""Entry point: ``python -m apng_editor``."""

from __future__ import annotations

import sys


def main() -> int:
    from PySide6.QtWidgets import QApplication

    from apng_editor.ui.main_window import MainWindow

    app = QApplication(sys.argv)
    app.setApplicationName("APNG 逐帧合成小工具")
    window = MainWindow()
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
