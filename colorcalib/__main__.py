"""启动入口：python -m colorcalib 或 python main.py"""

from __future__ import annotations

import sys

from PySide6.QtWidgets import QApplication

from .gui.mainwindow import MainWindow


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("颜色校准")
    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
