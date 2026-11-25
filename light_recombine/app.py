"""启动入口: python -m light_recombine.app [--example]"""

from __future__ import annotations

import argparse
import sys

from PySide6.QtWidgets import QApplication

from .gui.main_window import MainWindow


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="灯光通道重组检查窗口")
    parser.add_argument("--example", action="store_true",
                        help="启动时直接载入内置几何示例")
    args = parser.parse_args(argv)

    app = QApplication(sys.argv)
    win = MainWindow(start_with_example=args.example)
    win.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
