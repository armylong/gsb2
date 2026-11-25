"""QApplication 组装入口。"""

from __future__ import annotations

import sys

from PySide6.QtWidgets import QApplication

from . import PROJECT_SR
from .main_window import MainWindow
from .mixer import ProjectState


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv if argv is None else argv
    app = QApplication(argv)
    app.setApplicationName("cue lab")
    app.setOrganizationName("cue-lab")
    # 空工程启动; 内置示例在菜单「内置示例」里一键载入
    window = MainWindow(ProjectState(sr=PROJECT_SR, test_end=6.0))
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
