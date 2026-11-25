"""盲听台包入口。"""
from __future__ import annotations

import sys

from PySide6.QtWidgets import QApplication, QMessageBox

from .audio import AudioError, check_toolchain
from .main_window import MainWindow


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("blindabx")
    try:
        check_toolchain()
    except AudioError as exc:
        QMessageBox.critical(None, "ffmpeg 不可用", f"{exc}\n请先安装 ffmpeg 并加入 PATH。")
        return 2
    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
