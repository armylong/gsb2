"""Qt application bootstrap."""

from __future__ import annotations

import sys

from PySide6.QtCore import Qt
from PySide6.QtGui import QColor, QPalette
from PySide6.QtWidgets import QApplication

from . import __version__


_STYLE = """
QWidget { background: #1e2026; color: #d6dae2; }
QMainWindow::separator { background: #2c2f37; width: 4px; height: 4px; }
QToolBar { background: #23262d; border: 0; padding: 3px; spacing: 4px; }
QToolButton { background: transparent; color: #d6dae2; padding: 6px 9px;
              border-radius: 4px; }
QToolButton:hover { background: #323641; }
QToolButton:checked { background: #2f4a6d; }
QStatusBar { background: #23262d; color: #9aa3b2; }
QMenuBar { background: #23262d; }
QMenuBar::item:selected { background: #323641; }
QMenu { background: #262a32; border: 1px solid #343945; }
QMenu::item:selected { background: #2f4a6d; }
QDockWidget { titlebar-close-icon: none; titlebar-normal-icon: none;
              font-weight: 600; }
QDockWidget::title { background: #23262d; padding: 6px 8px;
                     border-bottom: 1px solid #2f333c; }
QGroupBox { border: 1px solid #30343d; border-radius: 5px; margin-top: 14px;
            background: #21242b; }
QGroupBox::title { subcontrol-origin: margin; left: 10px; padding: 0 4px;
                   color: #aeb6c4; font-weight: 600; }
QPushButton { background: #2c3038; border: 1px solid #3a3f4a; border-radius: 4px;
              padding: 5px 10px; }
QPushButton:hover { background: #353a45; }
QPushButton:pressed { background: #2a2e37; }
QPushButton:disabled { color: #6a7280; border-color: #2c3038; }
QLineEdit, QSpinBox, QDoubleSpinBox, QComboBox { background: #191b20;
    border: 1px solid #343945; border-radius: 4px; padding: 4px 6px;
    selection-background-color: #2f4a6d; }
QComboBox QAbstractItemView { background: #262a32; selection-background-color: #2f4a6d; }
QListWidget, QTableWidget, QTreeWidget { background: #1b1d22;
    alternate-background-color: #1f2228; border: 1px solid #2e323b;
    gridline-color: #2a2e36; selection-background-color: #2f4a6d; }
QHeaderView::section { background: #262a32; color: #aeb6c4; border: 0;
    border-right: 1px solid #30343d; border-bottom: 1px solid #30343d;
    padding: 4px 6px; }
QScrollBar:vertical { background: #1b1d22; width: 11px; }
QScrollBar::handle:vertical { background: #3a3f4a; border-radius: 5px;
    min-height: 24px; }
QScrollBar:horizontal { background: #1b1d22; height: 11px; }
QScrollBar::handle:horizontal { background: #3a3f4a; border-radius: 5px;
    min-width: 24px; }
QScrollBar::add-line, QScrollBar::sub-line { width: 0; height: 0; }
QTabBar::tab { background: #23262d; padding: 6px 12px; border: 1px solid #30343d; }
QTabBar::tab:selected { background: #2f4a6d; }
QCheckBox::indicator, QRadioButton::indicator { width: 14px; height: 14px; }
QCheckBox::indicator:checked { background: #4f8fd6; border: 1px solid #7fb0e8;
    border-radius: 3px; }
QRadioButton::indicator:checked { background: #4f8fd6; border: 1px solid #7fb0e8;
    border-radius: 7px; }
QCheckBox::indicator:unchecked, QRadioButton::indicator:unchecked {
    background: #1b1d22; border: 1px solid #4a505c; border-radius: 3px; }
QRadioButton::indicator:unchecked { border-radius: 7px; }
QToolTip { background: #262a32; color: #d6dae2; border: 1px solid #3a3f4a; }
"""


def create_app(argv: list[str] | None = None) -> QApplication:
    existing = QApplication.instance()
    if isinstance(existing, QApplication):
        return existing
    QApplication.setAttribute(Qt.AA_DontShowIconsInMenus, False)
    app = QApplication(argv if argv is not None else sys.argv)
    app.setApplicationName("FlatField Studio")
    app.setApplicationVersion(__version__)
    app.setStyle("Fusion")
    palette = app.palette()
    palette.setColor(QPalette.Window, QColor("#1e2026"))
    palette.setColor(QPalette.WindowText, QColor("#d6dae2"))
    palette.setColor(QPalette.Base, QColor("#191b20"))
    palette.setColor(QPalette.AlternateBase, QColor("#1f2228"))
    palette.setColor(QPalette.Text, QColor("#d6dae2"))
    palette.setColor(QPalette.Button, QColor("#2c3038"))
    palette.setColor(QPalette.ButtonText, QColor("#d6dae2"))
    palette.setColor(QPalette.Highlight, QColor("#2f4a6d"))
    palette.setColor(QPalette.HighlightedText, QColor("#ffffff"))
    app.setPalette(palette)
    app.setStyleSheet(_STYLE)
    return app


def main() -> int:
    app = create_app()
    from .ui.main_window import MainWindow

    window = MainWindow()
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
