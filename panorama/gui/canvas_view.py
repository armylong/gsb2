"""全局画布视图：照片边框、有效像素区域、融合/叠加切换、鬼影标记。"""
from __future__ import annotations

import numpy as np
from PySide6.QtCore import Qt, QPointF
from PySide6.QtGui import QColor, QPainter, QPen, QPixmap
from PySide6.QtWidgets import QLabel

from .. import geometry as geo
from .helpers import cv_to_qpixmap


class CanvasView(QLabel):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setAlignment(Qt.AlignCenter)
        self.setMinimumSize(640, 420)
        self.setStyleSheet("background:#15171a;")
        self._base: QPixmap | None = None
        self._borders: list[np.ndarray] = []  # 每张照片四角（画布坐标）
        self._show_borders = True
        self._show_valid = False
        self._ghost: np.ndarray | None = None

    def set_result(self, canvas_result, globals_H, sizes, order, bounds):
        self._canvas_result = canvas_result
        self._globals_H = globals_H
        self._sizes = sizes
        self._order = order
        self._bounds = bounds
        x0, y0, _, _ = bounds
        self._borders = []
        for pid in order:
            H = globals_H[pid]
            w, h = sizes[pid]
            corners = geo.warp_corners(H, w, h)
            corners[:, 0] -= x0
            corners[:, 1] -= y0
            self._borders.append(corners)
        self._ghost = canvas_result.ghost_map
        self.set_mode(self._mode if hasattr(self, "_mode") else "blend")

    def set_mode(self, mode: str):
        """mode: blend | overlay | valid"""
        self._mode = mode
        cr = getattr(self, "_canvas_result", None)
        if cr is None:
            return
        if mode == "overlay":
            img = cr.overlay
        elif mode == "valid":
            mask = cr.valid_mask
            img = np.stack([mask] * 3, axis=-1)
        else:
            img = cr.canvas
        self._base = cv_to_qpixmap(img)
        self._refresh()

    def set_show_borders(self, on: bool):
        self._show_borders = on
        self._refresh()

    def set_show_ghost(self, on: bool):
        self._show_ghost = on
        self._refresh()

    def _refresh(self):
        if self._base is None:
            self.setText("加入两张以上照片后点击「开始拼接」")
            return
        scaled = self._base.scaled(
            self.size(), Qt.KeepAspectRatio, Qt.SmoothTransformation
        )
        self._scaled = scaled
        sx = scaled.width() / max(self._base.width(), 1)
        sy = scaled.height() / max(self._base.height(), 1)
        ox = (self.width() - scaled.width()) // 2
        oy = (self.height() - scaled.height()) // 2
        canvas = scaled.copy()
        painter = QPainter(canvas)

        if getattr(self, "_show_ghost", False) and self._ghost is not None:
            ghost_rgb = np.zeros(
                (self._ghost.shape[0], self._ghost.shape[1], 4), np.uint8
            )
            ghost_rgb[..., 0] = self._ghost
            ghost_rgb[..., 3] = (self._ghost > 0) * 180
            qghost = cv_to_qpixmap(ghost_rgb).scaled(
                scaled.size(), Qt.IgnoreAspectRatio, Qt.SmoothTransformation
            )
            painter.drawPixmap(0, 0, qghost)

        if self._show_borders:
            colors = [
                QColor(80, 200, 255), QColor(255, 200, 80),
                QColor(160, 255, 120), QColor(255, 120, 200),
                QColor(200, 160, 255), QColor(255, 255, 255),
            ]
            for k, corners in enumerate(self._borders):
                pen = QPen(colors[k % len(colors)], 2)
                painter.setPen(pen)
                pts = [
                    QPointF(c[0] * sx + ox, c[1] * sy + oy)
                    for c in corners
                ]
                for a in range(len(pts)):
                    painter.drawLine(pts[a], pts[(a + 1) % len(pts)])
                painter.drawText(pts[0], f"#{self._order[k]}")
        painter.end()
        self.setPixmap(canvas)

    def resizeEvent(self, ev):
        self._refresh()
        super().resizeEvent(ev)
