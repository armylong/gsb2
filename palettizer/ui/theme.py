"""Single dark theme shared by the app entry point and tests/screenshots."""

from __future__ import annotations

STYLESHEET = """
QWidget { background:#222226; color:#d7dbe2; }
QGroupBox { border:1px solid #3a3a42; border-radius:6px; margin-top:14px; padding-top:6px; }
QGroupBox::title { subcontrol-origin:margin; left:8px; padding:0 4px; color:#aeb5c0; }
QPushButton { background:#34343c; border:1px solid #45454f; border-radius:4px; padding:4px 8px; }
QPushButton:hover { background:#3d3d47; }
QPushButton:pressed { background:#2c2c34; }
QPushButton:checked { background:#3a4d68; border-color:#5b7ba6; }
QPushButton:disabled { color:#6c6f76; }
QComboBox, QSpinBox, QPlainTextEdit, QTableWidget {
    background:#2b2b31; border:1px solid #3d3d45; border-radius:4px; padding:2px;
}
QHeaderView::section { background:#303038; border:none; padding:3px; }
QScrollArea { border:none; }
QScrollArea > QWidget > QWidget { background:#222226; }
QSlider::groove:horizontal { height:5px; background:#3a3a42; border-radius:2px; }
QSlider::handle:horizontal { width:13px; margin:-5px 0; background:#7aa5dd; border-radius:6px; }
QMenuBar, QMenu { background:#2a2a30; }
QMenuBar::item:selected, QMenu::item:selected { background:#3a4d68; }
QToolTip { background:#2f2f36; color:#dfe3ea; border:1px solid #4a4a55; }
"""


def apply_theme(app, font_size: int = 12) -> None:
    from PySide6.QtGui import QFont

    app.setStyle("Fusion")
    app.setFont(QFont(app.font().family(), font_size))
    app.setStyleSheet(STYLESHEET)
