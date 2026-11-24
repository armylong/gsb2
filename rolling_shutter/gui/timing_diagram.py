"""各行曝光时段时序图：每行一条曝光窗横线，可点选查询。"""
from __future__ import annotations

import numpy as np
from PySide6.QtCore import QPoint, QRect, Qt, Signal
from PySide6.QtGui import QColor, QPainter, QPen
from PySide6.QtWidgets import QSizePolicy, QWidget

from ..model import Clip, MODE_GLOBAL, MODE_ROLLING


class TimingDiagram(QWidget):
    """横轴为时间（本帧窗口），纵轴为行号；点击某行发出 rowSelected。"""

    rowSelected = Signal(int)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._clip: Clip | None = None
        self._frame = 0
        self._selected = -1
        self.setMinimumHeight(170)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)

    def set_frame(self, clip: Clip, frame_index: int, selected_row: int = -1):
        self._clip = clip
        self._frame = frame_index
        self._selected = selected_row
        self.update()

    def set_selected_row(self, row: int) -> None:
        self._selected = row
        self.update()

    def _margins(self):
        return 46, 12, self.width() - 12, self.height() - 26

    def mousePressEvent(self, event) -> None:
        if self._clip is None:
            return
        left, top, right, bottom = self._margins()
        if not (left <= event.position().x() <= right
                and top <= event.position().y() <= bottom):
            return
        h = self._clip.params.height
        row = int((event.position().y() - top) / (bottom - top) * h)
        self.rowSelected.emit(int(np.clip(row, 0, h - 1)))

    def paintEvent(self, event) -> None:
        p = QPainter(self)
        try:
            self._paint(p)
        finally:
            p.end()

    def _paint(self, p: QPainter) -> None:
        p.fillRect(self.rect(), QColor(24, 24, 28))
        if self._clip is None:
            p.setPen(QPen(QColor(150, 150, 150)))
            p.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter, "暂无数据")
            return
        clip = self._clip
        prm = clip.params
        h = prm.height
        left, top, right, bottom = self._margins()
        t0 = self._frame / prm.fps
        t1 = t0 + prm.frame_period
        span = max(t1 - t0, 1e-9)

        def x_of(t: float) -> float:
            return left + (t - t0) / span * (right - left)

        def y_of(r: float) -> float:
            return top + r / max(1, h - 1) * (bottom - top)

        p.setPen(QPen(QColor(90, 90, 90), 1))
        steps = 5
        for i in range(steps + 1):
            t = t0 + span * i / steps
            x = int(x_of(t))
            p.drawLine(QPoint(x, top), QPoint(x, bottom))
            p.setPen(QPen(QColor(140, 140, 140)))
            p.drawText(QPoint(x - 18, bottom + 16),
                       f"{(t - t0) * 1000:.1f}ms")
            p.setPen(QPen(QColor(90, 90, 90), 1))
        for r in range(0, h, 25):
            y = int(y_of(r))
            p.drawLine(QPoint(left, y), QPoint(right, y))
            p.setPen(QPen(QColor(140, 140, 140)))
            p.drawText(QPoint(6, y + 4), str(r))
            p.setPen(QPen(QColor(90, 90, 90), 1))

        # 闪光时间窗（黄色竖带）
        if prm.flash_enabled:
            fs, fe = prm.flash_start, prm.flash_start + prm.flash_duration
            if fe > t0 and fs < t1:
                x1, x2 = int(x_of(max(fs, t0))), int(x_of(min(fe, t1)))
                p.fillRect(QRect(x1, top, max(1, x2 - x1), bottom - top),
                           QColor(255, 210, 70, 70))

        wins = clip.windows[self._frame]
        reads = clip.readout_starts[self._frame]
        for r in range(h):
            y = int(y_of(r))
            a, b = float(wins[r, 0]), float(wins[r, 1])
            p.setPen(QPen(QColor(90, 200, 255), 1))
            p.drawLine(QPoint(int(x_of(a)), y), QPoint(int(x_of(b)), y))
            p.setPen(QPen(QColor(255, 120, 120)))
            p.drawPoint(QPoint(int(x_of(float(reads[r]))), y))
        if 0 <= self._selected < h:
            y = int(y_of(self._selected))
            p.setPen(QPen(QColor(255, 255, 255), 1, Qt.PenStyle.DashLine))
            p.drawLine(QPoint(left, y), QPoint(right, y))
            a, b = wins[self._selected]
            rd = reads[self._selected]
            p.setPen(QPen(QColor(255, 220, 220)))
            p.drawText(
                QPoint(left + 6, top + 14),
                f"行{self._selected}: 曝光 {a * 1000:.2f}~{b * 1000:.2f}ms"
                f"  读出 {rd * 1000:.2f}ms"
                f"  闪光覆盖 {clip.flash_overlap[self._frame, self._selected]:.2f}")
        mode_text = ("滚动快门（蓝=曝光窗，红点=逐行读出）"
                     if clip.mode == MODE_ROLLING
                     else "全局快门（蓝=统一曝光窗，红点=读出排队，不影响成像）")
        p.setPen(QPen(QColor(200, 200, 200)))
        p.drawText(QPoint(left, top - 2),
                   f"{mode_text}  方向={prm.readout_direction}")
