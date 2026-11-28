"""程序入口: ``python -m repeatcell``。"""

from __future__ import annotations

import sys


def main(argv=None) -> int:
    from PySide6.QtWidgets import QApplication
    from .ui.mainwindow import MainWindow

    app = QApplication(argv if argv is not None else sys.argv)
    app.setApplicationName("重复单元测量窗")
    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
