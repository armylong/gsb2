"""Application entry point."""

from __future__ import annotations

import sys

from PySide6.QtGui import QFont
from PySide6.QtWidgets import QApplication

from .main_window import MainWindow

APP_STYLE = """
QWidget {
    color: #0b0b0b;
    font-size: 13px;
}
QMainWindow, QDialog {
    background: #f9f9f7;
}
QGroupBox {
    background: #fcfcfb;
    border: 1px solid rgba(11,11,11,0.10);
    border-radius: 10px;
    margin-top: 12px;
    padding: 10px 8px 8px 8px;
    font-weight: 650;
}
QGroupBox::title {
    subcontrol-origin: margin;
    left: 10px;
    padding: 0 4px;
    color: #0b0b0b;
}
QPushButton {
    background: #ffffff;
    border: 1px solid #c9c7bf;
    border-radius: 7px;
    padding: 6px 10px;
}
QPushButton:hover {
    background: #f0efea;
    border-color: #898781;
}
QPushButton:pressed {
    background: #e1e0d9;
}
QPushButton:disabled {
    color: #a5a39c;
    background: #f3f2ee;
}
QComboBox, QSpinBox, QDoubleSpinBox {
    background: #ffffff;
    border: 1px solid #c9c7bf;
    border-radius: 6px;
    padding: 3px 6px;
    min-height: 20px;
}
QSlider::groove:horizontal {
    height: 4px;
    background: #d8d6ce;
    border-radius: 2px;
}
QSlider::sub-page:horizontal {
    background: #2a78d6;
    border-radius: 2px;
}
QSlider::handle:horizontal {
    background: #ffffff;
    border: 2px solid #2a78d6;
    width: 13px;
    height: 13px;
    margin: -7px 0;
    border-radius: 9px;
}
QRadioButton, QCheckBox {
    spacing: 6px;
    padding: 2px 0;
}
QLabel {
    background: transparent;
}
QStatusBar {
    background: #f0efea;
    border-top: 1px solid #e1e0d9;
}
QScrollArea > QWidget > QWidget {
    background: transparent;
}
"""


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("音频位深量化对照实验室")
    app.setOrganizationName("LocalAudioTools")
    app.setStyle("Fusion")
    app.setFont(QFont("system-ui", 10))
    app.setStyleSheet(APP_STYLE)
    window = MainWindow()
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
