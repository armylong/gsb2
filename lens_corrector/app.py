"""桌面应用入口：python -m lens_corrector.app"""

from __future__ import annotations

import sys
from PySide6.QtWidgets import QApplication

from .main_window import MainWindow


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("镜头畸变校正工具")
    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
