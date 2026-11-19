from __future__ import annotations

import sys

from PySide6.QtWidgets import QApplication

from .ui.window import MainWindow


def main() -> int:
    app = QApplication.instance() or QApplication(sys.argv)
    app.setApplicationName("Normal Map Workbench")
    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
