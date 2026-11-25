"""Small shared UI pieces: section headers, legend chips and stat cards."""
from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtGui import QColor, QPainter, QPen
from PySide6.QtWidgets import (QFrame, QHBoxLayout, QLabel, QSizePolicy,
                               QVBoxLayout, QWidget)

from .. import theme


class SectionTitle(QLabel):
    def __init__(self, text: str, parent=None):
        super().__init__(text, parent)
        self.setStyleSheet(
            f"color:{theme.MUTED}; font-size:11px; font-weight:700; "
            "letter-spacing:1px; padding-top:2px;"
        )


class Swatch(QWidget):
    """A small colour chip for legends (shape + colour, never colour alone)."""

    def __init__(self, colour: str, blocked: bool = False, parent=None):
        super().__init__(parent)
        self._colour = QColor(colour)
        self._blocked = blocked
        self.setFixedSize(12, 12)

    def paintEvent(self, event):
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        if self._blocked:
            painter.setPen(QPen(self._colour, 2))
            painter.drawLine(3, 9, 9, 3)
        else:
            painter.setPen(Qt.PenStyle.NoPen)
            painter.setBrush(self._colour)
            painter.drawEllipse(1, 1, 10, 10)


class LegendChip(QWidget):
    """A swatch plus a text label; keeps identity out of colour alone."""

    def __init__(self, colour: str, text: str, blocked: bool = False,
                 detail: str = "", parent=None):
        super().__init__(parent)
        row = QHBoxLayout(self)
        row.setContentsMargins(0, 0, 0, 0)
        row.setSpacing(6)
        row.addWidget(Swatch(colour, blocked=blocked))
        label = QLabel(text)
        label.setStyleSheet(f"color:{theme.TEXT}; font-size:11px;")
        row.addWidget(label)
        if detail:
            extra = QLabel(detail)
            extra.setStyleSheet(f"color:{theme.MUTED}; font-size:11px;")
            row.addWidget(extra)
        self._detail = None
        if detail:
            self._detail = extra
        row.addStretch(1)

    def set_detail(self, text: str) -> None:
        if self._detail is not None:
            self._detail.setText(text)


class StatCard(QFrame):
    def __init__(self, title: str, parent=None):
        super().__init__(parent)
        self.setObjectName("Card")
        self.setStyleSheet(
            f"QFrame#Card {{ background:{theme.PANEL_ALT}; border-radius:6px; }}"
        )
        layout = QVBoxLayout(self)
        layout.setContentsMargins(10, 8, 10, 8)
        layout.setSpacing(2)
        self._title = QLabel(title)
        self._title.setStyleSheet(f"color:{theme.MUTED}; font-size:10px;")
        self._value = QLabel("—")
        self._value.setStyleSheet(f"color:{theme.TEXT}; font-size:17px; font-weight:700;")
        self._hint = QLabel("")
        self._hint.setStyleSheet(f"color:{theme.MUTED}; font-size:10px;")
        self._hint.setWordWrap(True)
        layout.addWidget(self._title)
        layout.addWidget(self._value)
        layout.addWidget(self._hint)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Maximum)

    def set_value(self, value: str, hint: str = "", colour: str | None = None) -> None:
        self._value.setText(value)
        self._hint.setText(hint)
        self._value.setStyleSheet(
            f"color:{colour or theme.TEXT}; font-size:17px; font-weight:700;"
        )


class Divider(QFrame):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setObjectName("Divider")
        self.setFixedHeight(1)
        self.setStyleSheet(f"background:{theme.BORDER};")
