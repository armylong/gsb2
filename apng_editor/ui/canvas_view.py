"""Canvas preview widgets (checkerboard backdrop, tile outline)."""

from __future__ import annotations

import numpy as np
from PySide6.QtCore import QRect, Qt
from PySide6.QtGui import (
    QBrush,
    QColor,
    QFont,
    QImage,
    QPainter,
    QPen,
    QPixmap,
)
from PySide6.QtWidgets import QSizePolicy, QWidget

from ..imaging import checkerboard


def qimage_from_rgba(pixels: np.ndarray) -> QImage:
    """Copy an RGBA uint8 array into a QImage."""

    array = np.ascontiguousarray(pixels, dtype=np.uint8)
    height, width = array.shape[:2]
    image = QImage(
        array.data, width, height, width * 4, QImage.Format.Format_RGBA8888
    )
    return image.copy()


def _checker_brush(cell: int = 8) -> QBrush:
    board = checkerboard(2 * cell, 2 * cell, cell=cell, light=210, dark=170)
    return QBrush(QPixmap.fromImage(qimage_from_rgba_rgb(board)))


def qimage_from_rgba_rgb(rgb: np.ndarray) -> QImage:
    array = np.ascontiguousarray(rgb, dtype=np.uint8)
    height, width = array.shape[:2]
    image = QImage(
        array.data, width, height, width * 3, QImage.Format.Format_RGB888
    )
    return image.copy()


class CanvasPreview(QWidget):
    """Shows an RGBA canvas over a checkerboard, optionally with an outline.

    The pixel image is always drawn with nearest-neighbour scaling so that
    individual semi-transparent pixels remain inspectable.
    """

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._image: QImage | None = None
        self._outline: tuple[int, int, int, int] | None = None
        self._outline_label = ""
        self._canvas_size = (1, 1)
        self._empty_text = "（无画面）"
        self._brush = _checker_brush()
        self.setMinimumSize(180, 180)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self.setToolTip("透明区域由棋盘格表示；棋盘格只属于界面，不会写入导出文件")

    def set_canvas_size(self, width: int, height: int) -> None:
        self._canvas_size = (max(1, int(width)), max(1, int(height)))
        self.update()

    def set_image(self, pixels: np.ndarray | None) -> None:
        self._image = None if pixels is None else qimage_from_rgba(pixels)
        self.update()

    def set_outline(
        self,
        rect: tuple[int, int, int, int] | None,
        label: str = "",
    ) -> None:
        self._outline = rect
        self._outline_label = label
        self.update()

    def _target_rect(self) -> QRect:
        cw, ch = self._canvas_size
        avail_w = max(1, self.width() - 24)
        avail_h = max(1, self.height() - 24)
        scale = min(avail_w / cw, avail_h / ch)
        if scale >= 1.0:
            scale = max(1.0, float(int(scale)))
        draw_w = max(1, int(round(cw * scale)))
        draw_h = max(1, int(round(ch * scale)))
        x = (self.width() - draw_w) // 2
        y = (self.height() - draw_h) // 2
        return QRect(x, y, draw_w, draw_h)

    def paintEvent(self, event) -> None:  # noqa: N802 (Qt naming)
        painter = QPainter(self)
        painter.fillRect(self.rect(), QColor(48, 48, 52))
        target = self._target_rect()
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(self._brush)
        painter.drawRect(target)

        if self._image is not None:
            painter.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, False)
            painter.drawImage(target, self._image)
        else:
            painter.setPen(QColor(220, 220, 220))
            font = QFont()
            font.setPointSize(11)
            painter.setFont(font)
            painter.drawText(target, Qt.AlignmentFlag.AlignCenter, self._empty_text)

        cw, ch = self._canvas_size
        scale_x = target.width() / cw
        scale_y = target.height() / ch

        painter.setBrush(Qt.BrushStyle.NoBrush)
        painter.setPen(QPen(QColor(90, 90, 96), 1))
        painter.drawRect(target)
        painter.setPen(QPen(QColor(90, 90, 96, 90), 1, Qt.PenStyle.DotLine))
        for gx in range(1, cw):
            x = target.left() + int(round(gx * scale_x))
            painter.drawLine(x, target.top(), x, target.bottom())
        for gy in range(1, ch):
            y = target.top() + int(round(gy * scale_y))
            painter.drawLine(target.left(), y, target.right(), y)
        painter.setPen(QPen(QColor(90, 90, 96), 1))
        painter.drawRect(target)

        if self._outline is not None:
            x0, y0, x1, y1 = self._outline
            box = QRect(
                target.left() + int(round(x0 * scale_x)),
                target.top() + int(round(y0 * scale_y)),
                max(1, int(round((x1 - x0) * scale_x))),
                max(1, int(round((y1 - y0) * scale_y))),
            )
            painter.setPen(QPen(QColor(255, 72, 72), 2))
            painter.drawRect(box)
            if self._outline_label:
                painter.setPen(QColor(255, 235, 235))
                painter.setBrush(QColor(120, 20, 20, 200))
                metrics = painter.fontMetrics()
                text_w = metrics.horizontalAdvance(self._outline_label) + 8
                text_h = metrics.height() + 4
                label_rect = QRect(
                    box.left(),
                    max(target.top(), box.top() - text_h),
                    text_w,
                    text_h,
                )
                painter.drawRect(label_rect)
                painter.drawText(
                    label_rect, Qt.AlignmentFlag.AlignCenter, self._outline_label
                )

        painter.end()
