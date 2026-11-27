#!/usr/bin/env python3
"""Pitch Lab 启动入口。"""

import sys

from PySide6.QtWidgets import QApplication

from pitch_lab.main_window import MainWindow


def main() -> int:
    app = QApplication(sys.argv)
    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
