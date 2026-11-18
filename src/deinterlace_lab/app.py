"""PySide6 应用入口。"""
from __future__ import annotations

import sys

from PySide6.QtGui import QFont
from PySide6.QtWidgets import QApplication

from .main_window import MainWindow


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("deinterlace-lab")
    # 显式指定系统存在的字体, 避免 "Sans Serif" 回退警告。
    app.setFont(QFont("Helvetica", 10))
    win = MainWindow()
    if len(sys.argv) > 1:
        win.open_file(sys.argv[1])
    win.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
