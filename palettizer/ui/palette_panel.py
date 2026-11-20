"""Palette panel: swatches with locks, edit/delete and live usage counts."""

from __future__ import annotations

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QColor, QFont, QPainter, QPen
from PySide6.QtWidgets import (
    QHBoxLayout,
    QLabel,
    QPushButton,
    QScrollArea,
    QSizePolicy,
    QToolButton,
    QVBoxLayout,
    QWidget,
)

from ..palette import Palette

ROW_HEIGHT = 34
PALETTE_LIST_MIN = 190
PALETTE_LIST_MAX = 330
LOCK_ON = "\U0001F512"  # closed padlock
LOCK_OFF = "\U0001F513"  # open padlock


class Swatch(QWidget):
    """Clickable colour chip that paints a checkerboard behind alpha."""

    clicked = Signal()

    def __init__(self, color: tuple[int, int, int], parent=None):
        super().__init__(parent)
        self.color = tuple(color)
        self.setFixedSize(52, ROW_HEIGHT - 8)
        self.setCursor(Qt.PointingHandCursor)
        self.setToolTip("点击修改颜色")

    def paintEvent(self, event):  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing, False)
        r = self.rect().adjusted(0, 0, -1, -1)
        cell = 6
        for y in range(0, r.height(), cell):
            for x in range(0, r.width(), cell):
                dark = ((x // cell) + (y // cell)) % 2 == 0
                p.fillRect(r.x() + x, r.y() + y, min(cell, r.width() - x), min(cell, r.height() - y),
                           QColor(48, 48, 52) if dark else QColor(64, 64, 70))
        p.fillRect(r, QColor(*self.color))
        p.setPen(QPen(QColor(90, 90, 96), 1))
        p.setBrush(Qt.NoBrush)
        p.drawRect(r)
        p.end()

    def mouseReleaseEvent(self, event):  # noqa: N802
        if event.button() == Qt.LeftButton and self.rect().contains(event.position().toPoint()):
            self.clicked.emit()


class PaletteRow(QWidget):
    editRequested = Signal(int)
    lockToggled = Signal(int, bool)
    deleteRequested = Signal(int)

    def __init__(self, index: int, color, locked: bool, count: int, total: int, parent=None):
        super().__init__(parent)
        self.index = index
        self.setFixedHeight(ROW_HEIGHT)
        lay = QHBoxLayout(self)
        lay.setContentsMargins(4, 2, 4, 2)
        lay.setSpacing(6)

        self.swatch = Swatch(color)
        self.swatch.clicked.connect(lambda: self.editRequested.emit(self.index))
        lay.addWidget(self.swatch)

        header = QLabel(f"#{index}")
        header.setFixedWidth(30)
        header.setStyleSheet("color:#9aa0aa;")
        header.setAttribute(Qt.WA_TransparentForMouseEvents, True)
        lay.addWidget(header)

        hexlabel = QLabel("#%02X%02X%02X" % tuple(color))
        mono = QFont("Menlo")
        mono.setStyleHint(QFont.Monospace)
        mono.setPointSize(10)
        hexlabel.setFont(mono)
        hexlabel.setMinimumWidth(78)
        hexlabel.setAttribute(Qt.WA_TransparentForMouseEvents, True)
        lay.addWidget(hexlabel)

        bar = UsageBar(count, total)
        lay.addWidget(bar, 1)

        countlabel = QLabel(str(count))
        countlabel.setFixedWidth(44)
        countlabel.setAlignment(Qt.AlignRight | Qt.AlignVCenter)
        countlabel.setStyleSheet("color:#c8ccd4;")
        countlabel.setAttribute(Qt.WA_TransparentForMouseEvents, True)
        lay.addWidget(countlabel)

        self.lock_btn = QToolButton()
        self.lock_btn.setText(LOCK_ON if locked else LOCK_OFF)
        self.lock_btn.setCheckable(True)
        self.lock_btn.setChecked(locked)
        self.lock_btn.setToolTip("锁定后自动生成不会改动该颜色")
        self.lock_btn.setFixedSize(26, 24)
        self.lock_btn.toggled.connect(
            lambda checked: self._on_lock_toggled(checked)
        )
        lay.addWidget(self.lock_btn)

        self.del_btn = QToolButton()
        self.del_btn.setText("✕")
        self.del_btn.setToolTip("删除颜色（锁定颜色不可删除）")
        self.del_btn.setFixedSize(24, 24)
        self.del_btn.setEnabled(not locked)
        self.del_btn.clicked.connect(lambda: self.deleteRequested.emit(self.index))
        lay.addWidget(self.del_btn)

    def _on_lock_toggled(self, checked: bool) -> None:
        self.lock_btn.setText(LOCK_ON if checked else LOCK_OFF)
        self.del_btn.setEnabled(not checked)
        self.lockToggled.emit(self.index, checked)


class UsageBar(QWidget):
    def __init__(self, count: int, total: int, parent=None):
        super().__init__(parent)
        self.count = count
        self.total = max(1, total)
        self.setMinimumWidth(50)
        self.setFixedHeight(10)

    def paintEvent(self, event):  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing, False)
        p.fillRect(self.rect(), QColor(52, 52, 58))
        frac = min(1.0, self.count / self.total)
        w = int(self.width() * frac)
        p.fillRect(0, 0, w, self.height(), QColor(97, 168, 255))
        p.end()


class PalettePanel(QWidget):
    colorEditRequested = Signal(int)
    lockToggled = Signal(int, bool)
    deleteRequested = Signal(int)
    addRequested = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.setSpacing(4)

        self.header = QLabel("调色板")
        self.header.setStyleSheet("font-weight:600; color:#dfe3ea;")
        outer.addWidget(self.header)

        self.summary = QLabel("尚无调色板")
        self.summary.setWordWrap(True)
        self.summary.setStyleSheet("color:#9aa0aa; font-size:11px;")
        self.summary.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Preferred)
        self.summary.setMinimumWidth(0)
        outer.addWidget(self.summary)

        # The palette list gets its own bounded scroll region so the pixel
        # inspector below stays visible even with 32 colours.  The host
        # advertises a minimum height per row (set in refresh) so rows are
        # never squeezed into overlapping strips.
        self.scroll = QScrollArea()
        self.scroll.setWidgetResizable(True)
        self.scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.scroll.setMinimumHeight(PALETTE_LIST_MIN)
        self.scroll.setMaximumHeight(PALETTE_LIST_MAX)
        self.list_host = QWidget()
        self.list_layout = QVBoxLayout(self.list_host)
        self.list_layout.setContentsMargins(0, 0, 0, 0)
        self.list_layout.setSpacing(1)
        self.list_layout.addStretch(1)
        self.scroll.setWidget(self.list_host)
        outer.addWidget(self.scroll, 1)

        add = QPushButton("＋ 添加颜色（手工指定）")
        add.clicked.connect(self.addRequested)
        outer.addWidget(add)

    def refresh(self, palette: Palette, counts, transparent_count: int,
                limit_note: str = "") -> None:
        while self.list_layout.count() > 1:
            item = self.list_layout.takeAt(0)
            w = item.widget()
            if w is not None:
                # Detach immediately; deleteLater alone leaves the old rows
                # painted on top of the new ones until the event loop runs.
                w.setParent(None)
                w.deleteLater()
        n = len(palette)
        counts = list(counts) if counts is not None else [0] * n
        max_count = max(counts) if counts else 0
        for i in range(n):
            row = PaletteRow(
                i,
                palette.colors[i],
                palette.locked[i],
                int(counts[i]) if i < len(counts) else 0,
                max(1, max_count),
            )
            row.editRequested.connect(self.colorEditRequested)
            row.lockToggled.connect(self.lockToggled)
            row.deleteRequested.connect(self.deleteRequested)
            self.list_layout.insertWidget(self.list_layout.count() - 1, row)
        if n == 0:
            empty = QLabel("没有可见颜色（图像可能全透明）")
            empty.setStyleSheet("color:#8a8f98; padding:12px;")
            empty.setAlignment(Qt.AlignCenter)
            self.list_layout.insertWidget(0, empty)

        # The outer side panel scrolls; this list simply reports its natural
        # height so rows are never compressed or overlapped.
        rows = max(1, n)
        self.list_host.setMinimumHeight(rows * ROW_HEIGHT + 4)

        used = sum(1 for c in counts[:n] if c > 0)
        parts = [f"可见颜色 {n}/{palette.capacity}", f"实际使用 {used} 色",
                 f"透明像素 {transparent_count}"]
        self.summary.setText(" · ".join(parts) + (f"\n{limit_note}" if limit_note else ""))
        self.header.setText("调色板（点击色块改色）")
