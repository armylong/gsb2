"""python -m polanalyzer 启动入口."""

from __future__ import annotations

import sys

from PySide6.QtWidgets import QApplication

from .app.main_window import MainWindow


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("偏振照片分析")
    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
