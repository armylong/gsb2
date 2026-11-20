"""命令行入口。

    python -m alpha_lab             启动图形界面
    python -m alpha_lab --selftest  只跑数值自检 (无需显示器)
    python -m alpha_lab --smoke     离屏构建一次主窗口, 验证 GUI 可启动
"""

from __future__ import annotations

import sys


def main() -> int:
    args = set(sys.argv[1:])

    if "--selftest" in args:
        from . import selftest

        return selftest.main()

    if "--smoke" in args:
        import os

        os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
        from PySide6.QtCore import QTimer
        from PySide6.QtWidgets import QApplication

        from .app import MainWindow

        app = QApplication([])
        win = MainWindow()
        win.show()
        QTimer.singleShot(300, app.quit)
        app.exec()
        print("SMOKE OK: 主窗口构建并运行正常")
        return 0

    from PySide6.QtWidgets import QApplication

    from .app import MainWindow

    app = QApplication(sys.argv)
    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
