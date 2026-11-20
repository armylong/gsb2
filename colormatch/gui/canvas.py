"""可缩放、可框选矩形的图像画布。

职责：
  - 显示 float RGB 图像（自动等比缩放到控件大小）
  - 在图像上叠加各采样矩形，当前选中的采样高亮、白点采样加白边
  - 鼠标拖拽新建/替换当前图像上的采样矩形（发 rectDrawn 信号，坐标为图像像素）
"""
from __future__ import annotations

import numpy as np
from PySide6.QtCore import Qt, Signal, QPoint, QRect
from PySide6.QtGui import QImage, QPixmap, QPainter, QPen, QColor, QFont
from PySide6.QtWidgets import QWidget

from ..core import Rect


def float_rgb_to_qpixmap(img_f: np.ndarray) -> QPixmap:
    arr = np.rint(np.clip(img_f, 0.0, 1.0) * 255.0).astype(np.uint8)
    h, w, _ = arr.shape
    # numpy 行优先连续内存 -> QImage
    qimg = QImage(arr.tobytes(), w, h, 3 * w, QImage.Format.Format_RGB888).copy()
    return QPixmap.fromImage(qimg)


class ImageCanvas(QWidget):
    rectDrawn = Signal(str, Rect)  # image_id, 图像像素坐标下的矩形

    def __init__(self, image_id: str, title: str, parent=None):
        super().__init__(parent)
        self.image_id = image_id
        self.title = title
        self._pixmap: QPixmap | None = None
        self._img_w = self._img_h = 0
        self._scale = 1.0
        self._offset = QPoint(0, 0)
        self._drag_start: QPoint | None = None
        self._drag_now: QPoint | None = None
        self.setMinimumSize(300, 300)
        self.setMouseTracking(True)
        # sample_id -> (Rect, is_white)
        self.rectangles: dict[str, tuple[Rect, bool]] = {}
        self.selected_sample_id: str | None = None

    def set_image(self, img_f: np.ndarray) -> None:
        self._pixmap = float_rgb_to_qpixmap(img_f)
        self._img_h, self._img_w = img_f.shape[:2]
        self._recompute_geometry()
        self.update()

    def set_rectangles(self, rects: dict[str, tuple[Rect, bool]], selected_id: str | None) -> None:
        self.rectangles = rects
        self.selected_sample_id = selected_id
        self.update()

    # ------------------------------------------------------------------
    def _recompute_geometry(self) -> None:
        if self._pixmap is None:
            return
        cw, ch = max(1, self.width()), max(1, self.height())
        self._scale = min(cw / self._img_w, ch / self._img_h)
        dw = int(self._img_w * self._scale)
        dh = int(self._img_h * self._scale)
        self._offset = QPoint((cw - dw) // 2, (ch - dh) // 2)

    def resizeEvent(self, event) -> None:
        self._recompute_geometry()
        super().resizeEvent(event)

    def _to_image_rect(self, p_widget: QPoint) -> tuple[int, int]:
        x = (p_widget.x() - self._offset.x()) / self._scale
        y = (p_widget.y() - self._offset.y()) / self._scale
        return int(round(x)), int(round(y))

    def _to_widget_rect(self, r: Rect) -> QRect:
        return QRect(
            self._offset.x() + int(r.x * self._scale),
            self._offset.y() + int(r.y * self._scale),
            max(1, int(r.w * self._scale)),
            max(1, int(r.h * self._scale)),
        )

    # ------------------------------------------------------------------
    def mousePressEvent(self, event) -> None:
        if event.button() == Qt.MouseButton.LeftButton and self._pixmap is not None:
            self._drag_start = event.position().toPoint()
            self._drag_now = self._drag_start

    def mouseMoveEvent(self, event) -> None:
        if self._drag_start is not None:
            self._drag_now = event.position().toPoint()
            self.update()

    def mouseReleaseEvent(self, event) -> None:
        if event.button() != Qt.MouseButton.LeftButton or self._drag_start is None:
            return
        p0, p1 = self._drag_start, event.position().toPoint()
        self._drag_start = self._drag_now = None
        if (p1 - p0).manhattanLength() < 6:  # 视作点击而非拖拽
            self.update()
            return
        x0, y0 = self._to_image_rect(p0)
        x1, y1 = self._to_image_rect(p1)
        rect = Rect(
            x=max(0, min(x0, x1)),
            y=max(0, min(y0, y1)),
            w=abs(x1 - x0),
            h=abs(y1 - y0),
        ).clamped(self._img_w, self._img_h)
        if rect.area > 0:
            self.rectDrawn.emit(self.image_id, rect)
        self.update()

    # ------------------------------------------------------------------
    def paintEvent(self, event) -> None:
        painter = QPainter(self)
        painter.fillRect(self.rect(), QColor(45, 45, 48))
        if self._pixmap is None:
            painter.setPen(QColor(180, 180, 180))
            painter.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter, "（无图像）")
            return

        target = QRect(self._offset, self._pixmap.size() * self._scale)
        painter.drawPixmap(target, self._pixmap)

        font = QFont()
        font.setPointSize(9)
        painter.setFont(font)
        for sid, (rect, is_white) in self.rectangles.items():
            is_selected = sid == self.selected_sample_id
            pen = QPen(QColor(255, 210, 0) if is_selected else QColor(0, 220, 255))
            pen.setWidth(3 if is_selected else 2)
            painter.setPen(pen)
            painter.drawRect(self._to_widget_rect(rect))
            if is_white:  # 白点再加一圈白色外框
                pen_w = QPen(QColor(255, 255, 255))
                pen_w.setWidth(1)
                painter.setPen(pen_w)
                wr = self._to_widget_rect(rect).adjusted(2, 2, -2, -2)
                painter.drawRect(wr)

        if self._drag_start is not None and self._drag_now is not None:
            painter.setPen(QPen(QColor(255, 255, 255), 1, Qt.PenStyle.DashLine))
            painter.drawRect(QRect(self._drag_start, self._drag_now).normalized())

        painter.setPen(QColor(230, 230, 230))
        painter.drawText(8, 16, f"{self.title}  ({self._img_w}×{self._img_h})")
        painter.end()
