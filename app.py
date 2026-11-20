"""Entry point: ``python -m app`` or ``python app.py``."""

from __future__ import annotations

import sys


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv if argv is None else argv)
    from PySide6 import QtCore, QtWidgets

    QtCore.QCoreApplication.setAttribute(QtCore.Qt.AA_ShareOpenGLContexts, True)
    app = QtWidgets.QApplication(argv)
    app.setApplicationName("ScribbleMatte")
    app.setApplicationDisplayName("ScribbleMatte · 静物抠图")
    app.setOrganizationName("ScribbleMatte")

    from ui.main_window import MainWindow

    window = MainWindow()
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
