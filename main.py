"""启动入口：python main.py"""

from __future__ import annotations

import sys

from PySide6.QtWidgets import QApplication

from compressor.ui.main_window import MainWindow


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("动态压缩实验工具")
    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
