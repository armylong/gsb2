"""python -m idxpng 启动入口。"""

from __future__ import annotations

import os
import sys


def main() -> int:
    from PySide6.QtCore import QTimer
    from PySide6.QtWidgets import QApplication

    from .main_window import MainWindow

    app = QApplication(sys.argv)
    app.setApplicationName("索引色 PNG 编辑器")
    app.setOrganizationName("idxpng-tools")
    win = MainWindow()
    win.show()

    # 启动自检钩子: IDXPNG_AUTO_QUIT_MS=1500 python -m idxpng
    auto_quit = os.environ.get("IDXPNG_AUTO_QUIT_MS")
    if auto_quit:
        QTimer.singleShot(int(auto_quit), app.quit)

    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
