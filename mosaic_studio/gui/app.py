"""GUI 启动入口：python -m mosaic_studio 或 mosaic-studio 命令。"""
from __future__ import annotations

import sys

from PySide6.QtWidgets import QApplication

from .. import APP_NAME
from .main_window import MainWindow


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName(APP_NAME)
    app.setOrganizationName("MosaicStudio")
    try:
        app.setStyle("Fusion")
    except Exception:
        pass
    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
