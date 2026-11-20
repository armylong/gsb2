"""图形界面启动入口。"""

from __future__ import annotations

import sys


def main() -> int:
    from PySide6.QtWidgets import QApplication

    from .gui import MainWindow

    app = QApplication(sys.argv)
    app.setApplicationName("TDOA Lab")
    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
