"""GUI 用的纯展示组件：帧画面与行均值曲线。"""
from __future__ import annotations

import numpy as np
from PySide6.QtCore import QPoint, Qt, Signal
from PySide6.QtGui import QColor, QImage, QPainter, QPen
from PySide6.QtWidgets import QLabel, QSizePolicy, QWidget

from ..model import Clip


def numpy_to_qimage(frame: np.ndarray) -> QImage:
    """float32 [H,W,3] -> QImage(RGB888)，深拷贝保证数据生命周期独立。"""
    arr = (np.clip(frame, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)
    h, w, _ = arr.shape
    return QImage(arr.data, w, h, 3 * w, QImage.Format.Format_RGB888).copy()


class ImageViewer(QWidget):
    """显示一帧；支持陈旧遮罩与读出方向、参数指纹标注。"""

    clicked = Signal(int)  # 点击时发出所在行号

    def __init__(self, title: str, parent=None):
        super().__init__(parent)
        self._title = title
        self._qimage: QImage | None = None
        self._clip: Clip | None = None
        self._frame_index = -1
        self._stale = False
        self._stale_reason = ""
        self._signature = ""
        self.setMinimumSize(220, 180)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)

    def show_frame(self, clip: Clip, frame_index: int, stale: bool,
                   stale_reason: str = "") -> None:
        self._clip = clip
        self._frame_index = frame_index
        self._stale = stale
        self._stale_reason = stale_reason
        self._signature = clip.signature
        self._qimage = numpy_to_qimage(clip.frames[frame_index])
        self.update()

    def clear_frame(self, text: str) -> None:
        self._qimage = None
        self._clip = None
        self._stale = True
        self._stale_reason = text
        self._signature = ""
        self.update()

    def mousePressEvent(self, event) -> None:
        if self._clip is None or self._qimage is None:
            return
        rect = self._image_rect()
        if not rect.contains(event.position().toPoint()):
            return
        ry = (event.position().y() - rect.y()) / rect.height()
        self.clicked.emit(int(np.clip(ry * self._clip.params.height,
                                      0, self._clip.params.height - 1)))

    def _image_rect(self):
        if self._qimage is None:
            return self.rect()
        aw, ah = self.width(), self.height()
        scale = min(aw / self._qimage.width(), ah / self._qimage.height())
        dw, dh = int(self._qimage.width() * scale), int(self._qimage.height() * scale)
        x = (aw - dw) // 2
        y = (ah - dh) // 2
        from PySide6.QtCore import QRect
        return QRect(x, y, dw, dh)

    def paintEvent(self, event) -> None:
        p = QPainter(self)
        try:
            self._paint(p)
        finally:
            p.end()

    def _paint(self, p: QPainter) -> None:
        p.fillRect(self.rect(), QColor(18, 18, 22))
        p.setPen(QPen(QColor(200, 200, 200)))
        p.drawText(QPoint(8, 16), self._title)
        if self._qimage is None:
            p.setPen(QPen(QColor(150, 150, 150)))
            p.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter,
                       self._stale_reason or "尚未生成")
            return
        rect = self._image_rect()
        p.drawImage(rect, self._qimage)
        p.setPen(QPen(QColor(110, 110, 110), 1))
        p.drawRect(rect)
        if self._clip is not None:
            prm = self._clip.params
            info = (f"帧 {self._frame_index}/{self._clip.n_frames - 1}"
                    f"  t={self._frame_index / prm.fps:.3f}s"
                    f"  {prm.width}x{prm.height}px"
                    f"  指纹 {self._signature[:10]}")
            p.setPen(QPen(QColor(190, 190, 190)))
            p.drawText(QPoint(rect.x(), rect.bottom() + 16), info)
        if self._stale:
            p.fillRect(rect, QColor(40, 40, 40, 175))
            p.setPen(QPen(QColor(255, 190, 60), 2))
            p.drawRect(rect.adjusted(1, 1, -1, -1))
            p.setPen(QPen(QColor(255, 205, 90)))
            p.drawText(rect, Qt.AlignmentFlag.AlignCenter,
                       f"旧帧 · 参数已改动\n{self._stale_reason}")


class RowPlot(QWidget):
    """逐行平均亮度曲线（闪光时对应被照亮的行带）。"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self._values: np.ndarray | None = None
        self._flash: np.ndarray | None = None
        self._selected = -1
        self.setMinimumHeight(170)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)

    def set_frame(self, clip: Clip, frame_index: int, selected_row: int = -1):
        self._values = clip.row_means[frame_index]
        self._flash = clip.flash_overlap[frame_index]
        self._selected = selected_row
        self.update()

    def set_selected_row(self, row: int) -> None:
        self._selected = row
        self.update()

    def paintEvent(self, event) -> None:
        p = QPainter(self)
        try:
            self._paint(p)
        finally:
            p.end()

    def _paint(self, p: QPainter) -> None:
        p.fillRect(self.rect(), QColor(24, 24, 28))
        if self._values is None:
            p.setPen(QPen(QColor(150, 150, 150)))
            p.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter, "暂无数据")
            return
        h, w = self.height(), self.width()
        left, top, right, bottom = 44, 10, w - 10, h - 24
        n = len(self._values)

        def y_of(row: float) -> float:
            return top + row / max(1, n - 1) * (bottom - top)

        def x_of(v: float) -> float:
            return left + float(np.clip(v, 0, 1)) * (right - left)

        p.setPen(QPen(QColor(90, 90, 90), 1))
        for v in (0.0, 0.25, 0.5, 0.75, 1.0):
            x = x_of(v)
            p.drawLine(QPoint(int(x), top), QPoint(int(x), bottom))
            p.setPen(QPen(QColor(140, 140, 140)))
            p.drawText(QPoint(int(x) - 8, bottom + 16), f"{v:.2f}")
            p.setPen(QPen(QColor(90, 90, 90), 1))
        for r in range(0, n, 25):
            y = int(y_of(r))
            p.drawLine(QPoint(left, y), QPoint(right, y))
            p.setPen(QPen(QColor(140, 140, 140)))
            p.drawText(QPoint(4, y + 4), str(r))
            p.setPen(QPen(QColor(90, 90, 90), 1))

        # 闪光覆盖到的行用底色标出
        if self._flash is not None and self._flash.any():
            for r in range(n):
                if self._flash[r] > 0:
                    alpha = int(120 * min(1.0, self._flash[r]))
                    p.fillRect(left, int(y_of(r)) - 1, right - left, 2,
                               QColor(255, 220, 90, max(30, alpha)))
        pen = QPen(QColor(90, 200, 255), 2)
        p.setPen(pen)
        prev = QPoint(int(x_of(self._values[0])), int(y_of(0)))
        for r in range(1, n):
            cur = QPoint(int(x_of(self._values[r])), int(y_of(r)))
            p.drawLine(prev, cur)
            prev = cur
        if 0 <= self._selected < n:
            p.setPen(QPen(QColor(255, 120, 120), 1, Qt.PenStyle.DashLine))
            y = int(y_of(self._selected))
            p.drawLine(QPoint(left, y), QPoint(right, y))
            p.setPen(QPen(QColor(255, 200, 200)))
            p.drawText(QPoint(right - 150, y - 4),
                       f"行{self._selected} 均值={self._values[self._selected]:.3f}")
        p.setPen(QPen(QColor(200, 200, 200)))
        p.drawText(QPoint(left, top - 1), "行均值亮度（纵向=行号，横向=亮度）")
