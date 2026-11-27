"""启动入口：python run.py"""
from __future__ import annotations

import os
import sys

# 兼容 python -I 等不把脚本目录加入 sys.path 的启动方式
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PySide6.QtWidgets import QApplication  # noqa: E402

from entrance_reverb.main_window import MainWindow  # noqa: E402


def main() -> int:
    app = QApplication(sys.argv)
    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
