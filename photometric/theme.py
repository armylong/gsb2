"""Dark, high-contrast style sheet for the workbench."""
from __future__ import annotations

from PySide6.QtGui import QColor, QFont, QPalette
from PySide6.QtWidgets import QApplication

BG = "#0d1017"
PANEL = "#151a24"
PANEL_ALT = "#1b2130"
BORDER = "#2a3245"
TEXT = "#e6eaf2"
MUTED = "#8b95a7"
ACCENT = "#66d9c2"
ACCENT_DIM = "#2f6f66"
WARN = "#f2c14e"
DANGER = "#ff6b74"
# Status hues: the validated three-slot dark set (all-pairs pass on the panel
# surface).  Neutral greys carry "no problem" / "no estimate", never a hue.
OK = "#0ca30c"
SHADOW_BLUE = "#3987e5"
SAT_PINK = "#d55181"
NONLAMBERT_AMBER = "#c98500"
NONL_AMBER = NONLAMBERT_AMBER
NEUTRAL = "#898781"
CRITICAL = "#d03b3b"
INVALID_COLOR = CRITICAL
WARN_COLOR = "#fab219"
MUTED_COLOR = NEUTRAL

STYLE_SHEET = f"""
QWidget {{
    background: {BG};
    color: {TEXT};
    font-size: 12px;
}}
QMainWindow, QDialog {{ background: {BG}; }}
QGroupBox {{
    background: {PANEL};
    border: 1px solid {BORDER};
    border-radius: 8px;
    margin-top: 14px;
    padding: 10px 10px 8px 10px;
    font-weight: 600;
}}
QGroupBox::title {{
    subcontrol-origin: margin;
    subcontrol-position: top left;
    left: 10px;
    padding: 0 6px;
    color: {ACCENT};
}}
QLabel#Title {{ font-size: 16px; font-weight: 700; }}
QLabel#Subtitle {{ color: {MUTED}; }}
QLabel#Muted {{ color: {MUTED}; }}
QLabel#Card {{ background: {PANEL_ALT}; border-radius: 6px; padding: 8px; }}
QPushButton {{
    background: {PANEL_ALT};
    border: 1px solid {BORDER};
    border-radius: 6px;
    padding: 6px 12px;
}}
QPushButton:hover {{ border-color: {ACCENT}; }}
QPushButton:checked {{ background: {ACCENT_DIM}; border-color: {ACCENT}; }}
QPushButton:disabled {{ color: #566072; border-color: #232a38; }}
QPushButton#Primary {{ background: {ACCENT_DIM}; border-color: {ACCENT}; font-weight: 600; }}
QPushButton#Primary:hover {{ background: #3b8c80; }}
QDoubleSpinBox, QSpinBox, QLineEdit, QComboBox {{
    background: {PANEL_ALT};
    border: 1px solid {BORDER};
    border-radius: 5px;
    padding: 4px 6px;
    selection-background-color: {ACCENT_DIM};
}}
QComboBox::drop-down {{ border: none; width: 18px; }}
QComboBox QAbstractItemView {{
    background: {PANEL_ALT};
    border: 1px solid {BORDER};
    selection-background-color: {ACCENT_DIM};
}}
QSlider::groove:horizontal {{
    height: 5px; background: {BORDER}; border-radius: 2px;
}}
QSlider::handle:horizontal {{
    background: {ACCENT}; width: 14px; margin: -5px 0; border-radius: 7px;
}}
QTabWidget::pane {{ border: 1px solid {BORDER}; border-radius: 8px; top: -1px; }}
QTabBar::tab {{
    background: {PANEL}; color: {MUTED};
    padding: 8px 14px; border: 1px solid {BORDER};
    border-bottom: none; border-top-left-radius: 6px; border-top-right-radius: 6px;
    margin-right: 2px;
}}
QTabBar::tab:selected {{ background: {PANEL_ALT}; color: {TEXT}; }}
QScrollArea {{ border: none; }}
QScrollBar:vertical {{ background: transparent; width: 10px; margin: 2px; }}
QScrollBar::handle:vertical {{ background: {BORDER}; border-radius: 4px; min-height: 24px; }}
QScrollBar::add-line, QScrollBar::sub-line {{ height: 0; width: 0; }}
QScrollBar:horizontal {{ background: transparent; height: 10px; margin: 2px; }}
QScrollBar::handle:horizontal {{ background: {BORDER}; border-radius: 4px; min-width: 24px; }}
QToolTip {{
    background: {PANEL_ALT}; color: {TEXT};
    border: 1px solid {BORDER}; padding: 6px; border-radius: 6px;
}}
QSplitter::handle {{ background: transparent; }}
QFrame#Divider {{ background: {BORDER}; max-height: 1px; }}
QCheckBox::indicator {{
    width: 14px; height: 14px; border-radius: 3px;
    border: 1px solid {BORDER}; background: {PANEL_ALT};
}}
QCheckBox::indicator:checked {{ background: {ACCENT_DIM}; border-color: {ACCENT}; }}
"""


def apply(app: QApplication) -> None:
    app.setStyle("Fusion")
    palette = QPalette()
    palette.setColor(QPalette.ColorRole.Window, QColor(BG))
    palette.setColor(QPalette.ColorRole.WindowText, QColor(TEXT))
    palette.setColor(QPalette.ColorRole.Base, QColor(PANEL))
    palette.setColor(QPalette.ColorRole.AlternateBase, QColor(PANEL_ALT))
    palette.setColor(QPalette.ColorRole.Text, QColor(TEXT))
    palette.setColor(QPalette.ColorRole.Button, QColor(PANEL_ALT))
    palette.setColor(QPalette.ColorRole.ButtonText, QColor(TEXT))
    palette.setColor(QPalette.ColorRole.Highlight, QColor(ACCENT_DIM))
    palette.setColor(QPalette.ColorRole.HighlightedText, QColor("#ffffff"))
    palette.setColor(QPalette.ColorRole.ToolTipBase, QColor(PANEL_ALT))
    palette.setColor(QPalette.ColorRole.ToolTipText, QColor(TEXT))
    app.setPalette(palette)
    app.setStyleSheet(STYLE_SHEET)
    font = QFont()
    font.setPointSize(12)
    app.setFont(font)
