"""平铺比对: 把单元铺回去, 与原图并排, 检查四个方向的边界。"""

from __future__ import annotations

from typing import Optional, Tuple

import numpy as np
from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import QColor, QPainter, QPen
from PySide6.QtWidgets import QSizePolicy, QWidget

from ..geometry import CellBasis
from ..tiling import tile_region, wrap_error
from .imageview import rgb_to_qimage


class TileCompare(QWidget):
    """左: 原图裁切; 右: 单元平铺回同一坐标; 中间标出单元边界。"""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumSize(300, 200)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        self._left = None
        self._right = None
        self._region: Optional[Tuple[float, float, float, float]] = None
        self._basis: Optional[CellBasis] = None
        self._caption = ""

    def set_data(self, source: np.ndarray, unit_rgb: np.ndarray,
                 basis: CellBasis,
                 region: Optional[Tuple[float, float, float, float]] = None,
                 mask: Optional[np.ndarray] = None) -> None:
        h, w = source.shape[:2]
        if region is None:
            span_x = abs(basis.t1[0]) + abs(basis.t2[0])
            span_y = abs(basis.t1[1]) + abs(basis.t2[1])
            cw = int(min(max(200, 4 * span_x), 720, w))
            ch = int(min(max(200, 4 * span_y), 720, h))
            cx = int(np.clip(round(basis.origin[0]) - cw // 2, 0, max(0, w - cw)))
            cy = int(np.clip(round(basis.origin[1]) - ch // 2, 0, max(0, h - ch)))
            region = (float(cx), float(cy), float(cw), float(ch))
        x, y, cw, ch = region
        x_i, y_i = int(round(x)), int(round(y))
        cw_i, ch_i = int(round(cw)), int(round(ch))
        left = np.asarray(source, dtype=np.float32)[y_i:y_i + ch_i, x_i:x_i + cw_i]
        if left.size == 0:
            self._left = self._right = None
            self.update()
            return
        try:
            right = tile_region(unit_rgb, basis,
                                (float(x_i), float(y_i),
                                 float(left.shape[1]), float(left.shape[0])),
                                unit_mask=mask)
        except Exception:
            right = np.zeros_like(left)
        self._left = rgb_to_qimage(left)
        self._right = rgb_to_qimage(right)
        self._region = (float(x_i), float(y_i), float(left.shape[1]),
                        float(left.shape[0]))
        self._basis = basis
        err = wrap_error(unit_rgb)
        self._caption = (f"接缝误差: 上下 {err['vertical']:.3f} / "
                         f"左右 {err['horizontal']:.3f}   "
                         f"(左=原图, 右=平铺; 洋红点=单元角点)")
        self.update()

    def clear(self) -> None:
        self._left = self._right = None
        self._basis = None
        self.update()

    def paintEvent(self, event) -> None:
        p = QPainter(self)
        p.fillRect(self.rect(), QColor(24, 26, 30))
        if self._left is None or self._right is None:
            p.setPen(QColor(160, 165, 175))
            p.drawText(self.rect(), Qt.AlignCenter,
                       "选定单元后, 这里并排显示原图与铺回的结果")
            return
        area = QRectF(6, 6, self.width() - 12, self.height() - 26)
        src_w = self._left.width()
        src_h = self._left.height()
        aspect = src_w / max(src_h, 1)
        half_w = (area.width() - 6) / 2.0
        draw_h = min(area.height(), half_w / max(aspect, 1e-6))
        draw_w = draw_h * aspect
        if draw_w > half_w:
            draw_w = half_w
            draw_h = draw_w / max(aspect, 1e-6)
        top = area.top() + (area.height() - draw_h) / 2
        left_rect = QRectF(area.left() + (half_w - draw_w) / 2, top, draw_w, draw_h)
        right_rect = QRectF(area.left() + half_w + 6 + (half_w - draw_w) / 2,
                            top, draw_w, draw_h)
        p.drawImage(left_rect, self._left)
        p.drawImage(right_rect, self._right)
        p.setPen(QPen(QColor(255, 255, 255), 1))
        p.drawRect(left_rect)
        p.drawRect(right_rect)
        # 右图上标出单元角点
        if self._basis is not None and self._region is not None:
            self._draw_corners(p, right_rect)
        p.setPen(QColor(200, 205, 215))
        p.drawText(QRectF(6, area.bottom() + 2, self.width() - 12, 20),
                   Qt.AlignHCenter, self._caption)
        p.end()

    def _draw_corners(self, p: QPainter, rect: QRectF) -> None:
        assert self._basis is not None and self._region is not None
        basis = self._basis
        x0, y0, w, h = self._region
        M = basis.matrix
        o = np.array(basis.origin, dtype=float)
        inv = np.linalg.inv(M)
        corners = np.array([[x0, y0], [x0 + w, y0], [x0, y0 + h], [x0 + w, y0 + h]])
        rel = (corners - o) @ inv.T
        i_lo = int(np.floor(rel[:, 0].min())) - 1
        i_hi = int(np.ceil(rel[:, 0].max())) + 1
        j_lo = int(np.floor(rel[:, 1].min())) - 1
        j_hi = int(np.ceil(rel[:, 1].max())) + 1
        total = max(1, (i_hi - i_lo + 1) * (j_hi - j_lo + 1))
        stride = max(1, int(np.ceil(np.sqrt(total / 48.0))))
        count = 0
        for i in range(i_lo, i_hi + 1, stride):
            for j in range(j_lo, j_hi + 1, stride):
                px_, py_ = o + i * M[:, 0] + j * M[:, 1]
                sx = (px_ - x0) / max(w, 1e-9)
                sy = (py_ - y0) / max(h, 1e-9)
                if not (0 <= sx <= 1 and 0 <= sy <= 1):
                    continue
                count += 1
                if count > 48:
                    return
                frac = (abs(px_ - round(px_)) > 1e-6
                        or abs(py_ - round(py_)) > 1e-6)
                color = QColor(255, 90, 90) if frac else QColor(60, 220, 220)
                p.setPen(QPen(color, 2))
                cx = rect.left() + sx * rect.width()
                cy = rect.top() + sy * rect.height()
                p.drawPoint(QPointF(cx, cy))
