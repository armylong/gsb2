"""图像视图: 显示原图、估算区域、重复格点与可拖动的单元角点。"""

from __future__ import annotations

from typing import Optional, Tuple

import numpy as np
from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import (QBrush, QColor, QImage, QPainter, QPen, QPolygonF,
                           QTransform)
from PySide6.QtWidgets import QSizePolicy, QWidget

from ..geometry import CellBasis


def rgb_to_qimage(rgb: np.ndarray) -> QImage:
    arr = np.ascontiguousarray(
        (np.clip(np.asarray(rgb, dtype=np.float32), 0.0, 1.0) * 255.0 + 0.5)
        .astype(np.uint8))
    h, w, _c = arr.shape
    return QImage(arr.data, w, h, 3 * w, QImage.Format_RGB888).copy()


class ImageView(QWidget):
    """交互式图像视图。

    * 左键拖拽 (区域模式): 框选估算区域
    * 左键拖拽 (向量模式): 拖动初始点 O 或向量端点 A / B
    * 滚轮缩放, 中键或空格+左键拖动平移
    """

    regionChanged = Signal(QRectF)
    basisEdited = Signal(QPointF, QPointF, QPointF)   # origin, t1, t2
    cursorMoved = Signal(float, float)

    MODE_REGION = "region"
    MODE_VECTORS = "vectors"

    HANDLE_R = 7.0
    DOT_COLOR = QColor(60, 220, 240, 190)
    GRID_COLOR = QColor(60, 220, 240, 70)
    CELL_COLOR = QColor(255, 220, 80, 230)
    REGION_COLOR = QColor(255, 255, 255, 220)
    ORIGIN_COLOR = QColor(255, 140, 60, 240)
    VEC1_COLOR = QColor(120, 255, 140, 240)
    VEC2_COLOR = QColor(150, 180, 255, 240)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumSize(360, 280)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        self.setMouseTracking(True)
        self.setFocusPolicy(Qt.StrongFocus)

        self._rgb: Optional[np.ndarray] = None
        self._qimage: Optional[QImage] = None
        self.region: Optional[QRectF] = None        # 原图坐标
        self.basis: Optional[CellBasis] = None
        self.mode = self.MODE_VECTORS

        self._zoom = 1.0
        self._ox = 0.0
        self._oy = 0.0
        self._fit_pending = True

        self._drag_handle: Optional[str] = None
        self._drag_region_start: Optional[QPointF] = None
        self._panning = False
        self._pan_last: Optional[QPointF] = None

        self._show_lattice = True
        self._show_cell = True

    # ------------------------------------------------------------------
    # 数据
    # ------------------------------------------------------------------
    def set_image(self, rgb: Optional[np.ndarray]) -> None:
        self._rgb = None if rgb is None else np.asarray(rgb, dtype=np.float32)
        self._qimage = None if self._rgb is None else rgb_to_qimage(self._rgb)
        if self._rgb is not None:
            h, w = self._rgb.shape[:2]
            self.region = QRectF(0.08 * w, 0.08 * h, 0.84 * w, 0.84 * h)
        else:
            self.region = None
        self.basis = None
        self._fit_pending = True
        self.update()

    def set_region(self, rect: Optional[QRectF]) -> None:
        self.region = QRectF(rect) if rect is not None else None
        self.update()

    def set_basis(self, basis: Optional[CellBasis]) -> None:
        self.basis = basis
        self.update()

    def set_mode(self, mode: str) -> None:
        self.mode = mode
        self.update()

    def set_overlay_visible(self, lattice: bool, cell: bool) -> None:
        self._show_lattice = lattice
        self._show_cell = cell
        self.update()

    def fit_to_window(self) -> None:
        if self._rgb is None:
            return
        h, w = self._rgb.shape[:2]
        if w == 0 or h == 0:
            return
        self._zoom = min(self.width() / w, self.height() / h) * 0.97
        self._ox = (self.width() - w * self._zoom) / 2.0
        self._oy = (self.height() - h * self._zoom) / 2.0
        self._fit_pending = False
        self.update()

    # ------------------------------------------------------------------
    # 坐标
    # ------------------------------------------------------------------
    def widget_to_image(self, p: QPointF) -> QPointF:
        return QPointF((p.x() - self._ox) / self._zoom,
                       (p.y() - self._oy) / self._zoom)

    def image_to_widget(self, x: float, y: float) -> QPointF:
        return QPointF(x * self._zoom + self._ox, y * self._zoom + self._oy)

    def _image_size(self) -> Tuple[int, int]:
        if self._rgb is None:
            return (0, 0)
        return (int(self._rgb.shape[1]), int(self._rgb.shape[0]))

    def _clamp_image_point(self, p: QPointF) -> QPointF:
        w, h = self._image_size()
        return QPointF(min(max(p.x(), 0.0), float(w)),
                       min(max(p.y(), 0.0), float(h)))

    # ------------------------------------------------------------------
    # 绘制
    # ------------------------------------------------------------------
    def paintEvent(self, event) -> None:
        painter = QPainter(self)
        painter.fillRect(self.rect(), QColor(28, 30, 34))
        if self._qimage is None:
            painter.setPen(QColor(170, 175, 185))
            painter.drawText(self.rect(), Qt.AlignCenter,
                             "打开一张图片, 或用「示例」菜单载入一张合成纹理")
            return
        if self._fit_pending:
            self.fit_to_window()
        painter.setRenderHint(QPainter.SmoothPixmapTransform, self._zoom < 1.0)
        painter.setTransform(QTransform().translate(self._ox, self._oy)
                             .scale(self._zoom, self._zoom))
        painter.drawImage(QPointF(0, 0), self._qimage)
        painter.resetTransform()

        if self.region is not None:
            self._draw_region(painter)
        if self.basis is not None and self._show_lattice:
            self._draw_lattice(painter)
        if self.basis is not None and self._show_cell:
            self._draw_cell(painter)
        if self.basis is not None:
            self._draw_handles(painter)
        painter.end()

    def _draw_region(self, painter: QPainter) -> None:
        r = self.region
        tl = self.image_to_widget(r.left(), r.top())
        br = self.image_to_widget(r.right(), r.bottom())
        rect = QRectF(tl, br)
        pen = QPen(self.REGION_COLOR, 1.4, Qt.DashLine)
        painter.setPen(pen)
        painter.setBrush(Qt.NoBrush)
        painter.drawRect(rect)
        # 角标
        painter.setPen(Qt.NoPen)
        painter.setBrush(self.REGION_COLOR)
        for p in (rect.topLeft(), rect.topRight(),
                  rect.bottomLeft(), rect.bottomRight()):
            painter.drawRect(QRectF(p.x() - 3, p.y() - 3, 6, 6))

    def _draw_lattice(self, painter: QPainter) -> None:
        basis = self.basis
        assert basis is not None
        w, h = self._image_size()
        M = basis.matrix
        o = np.array(basis.origin)
        # 求覆盖图像需要的格点范围
        inv = np.linalg.inv(M)
        corners = np.array([[0, 0], [w, 0], [0, h], [w, h]], dtype=float)
        rel = (corners - o) @ inv.T
        i_lo = int(np.floor(rel[:, 0].min())) - 1
        i_hi = int(np.ceil(rel[:, 0].max())) + 1
        j_lo = int(np.floor(rel[:, 1].min())) - 1
        j_hi = int(np.ceil(rel[:, 1].max())) + 1
        # 最多画几百个点, 步长自适应
        total = max(1, (i_hi - i_lo + 1) * (j_hi - j_lo + 1))
        stride = max(1, int(np.ceil(np.sqrt(total / 600.0))))

        painter.setPen(Qt.NoPen)
        painter.setBrush(QBrush(self.GRID_COLOR))
        for i in range(i_lo, i_hi + 1, stride):
            for j in range(j_lo, j_hi + 1, stride):
                p = o + i * M[:, 0] + j * M[:, 1]
                sp = self.image_to_widget(p[0], p[1])
                r = 1.6 if self._zoom < 1.5 else 2.2
                painter.drawEllipse(sp, r, r)

    def _draw_cell(self, painter: QPainter) -> None:
        """画当前单元, 并在周围几排位置画出等价的重复单元 (淡色)。"""
        basis = self.basis
        assert basis is not None
        w, h = self._image_size()
        M = basis.matrix
        o = np.array(basis.origin, dtype=float)
        inv = np.linalg.inv(M)
        corners = np.array([[0, 0], [w, 0], [0, h], [w, h]], dtype=float)
        rel = (corners - o) @ inv.T
        i_lo = int(np.floor(rel[:, 0].min()))
        i_hi = int(np.ceil(rel[:, 0].max()))
        j_lo = int(np.floor(rel[:, 1].min()))
        j_hi = int(np.ceil(rel[:, 1].max()))

        painter.save()
        tl = self.image_to_widget(0, 0)
        br = self.image_to_widget(w, h)
        painter.setClipRect(QRectF(tl, br).normalized())
        ghost = QColor(self.CELL_COLOR)
        ghost.setAlpha(70)
        base_corners = basis.corners()
        for i in range(i_lo, i_hi + 1):
            for j in range(j_lo, j_hi + 1):
                if i == 0 and j == 0:
                    continue
                shift = i * M[:, 0] + j * M[:, 1]
                pts = [(x + shift[0], y + shift[1]) for x, y in base_corners]
                painter.setPen(QPen(ghost, 1.0, Qt.DashLine))
                painter.setBrush(Qt.NoBrush)
                painter.drawPolygon(QPolygonF(
                    [self.image_to_widget(x, y) for x, y in pts]))

        painter.restore()
        poly = QPolygonF([self.image_to_widget(x, y) for x, y in base_corners])
        painter.setBrush(Qt.NoBrush)
        painter.setPen(QPen(self.CELL_COLOR, 1.8))
        painter.setBrush(Qt.NoBrush)
        painter.drawPolygon(poly)

    def _draw_handles(self, painter: QPainter) -> None:
        basis = self.basis
        assert basis is not None
        o = basis.origin
        a = (o[0] + basis.t1[0], o[1] + basis.t1[1])
        b = (o[0] + basis.t2[0], o[1] + basis.t2[1])
        so = self.image_to_widget(*o)
        sa = self.image_to_widget(*a)
        sb = self.image_to_widget(*b)

        for tip, color in ((sa, self.VEC1_COLOR), (sb, self.VEC2_COLOR)):
            painter.setPen(QPen(color, 1.6))
            painter.drawLine(so, tip)

        def dot(p: QPointF, color: QColor, label: str) -> None:
            painter.setPen(QPen(QColor(20, 20, 20, 200), 1.2))
            painter.setBrush(QBrush(color))
            painter.drawEllipse(p, self.HANDLE_R, self.HANDLE_R)
            painter.setPen(QColor(255, 255, 255))
            painter.drawText(QRectF(p.x() - 8, p.y() - 8, 16, 16),
                             Qt.AlignCenter, label)

        dot(so, self.ORIGIN_COLOR, "O")
        dot(sa, self.VEC1_COLOR, "1")
        dot(sb, self.VEC2_COLOR, "2")

    # ------------------------------------------------------------------
    # 交互
    # ------------------------------------------------------------------
    def _hit_handle(self, pos: QPointF) -> Optional[str]:
        if self.basis is None:
            return None
        basis = self.basis
        o = basis.origin
        pts = {
            "origin": self.image_to_widget(*o),
            "t1": self.image_to_widget(o[0] + basis.t1[0], o[1] + basis.t1[1]),
            "t2": self.image_to_widget(o[0] + basis.t2[0], o[1] + basis.t2[1]),
        }
        best = None
        best_d = self.HANDLE_R + 4
        for name, p in pts.items():
            d = ((p.x() - pos.x()) ** 2 + (p.y() - pos.y()) ** 2) ** 0.5
            if d <= best_d:
                best, best_d = name, d
        return best

    def mousePressEvent(self, event) -> None:
        pos = QPointF(event.position())
        if event.button() == Qt.MiddleButton or (
                event.button() == Qt.LeftButton
                and event.modifiers() & Qt.AltModifier):
            self._panning = True
            self._pan_last = pos
            self.setCursor(Qt.ClosedHandCursor)
            return
        if event.button() != Qt.LeftButton or self._rgb is None:
            return
        if self.mode == self.MODE_VECTORS:
            handle = self._hit_handle(pos)
            if handle is not None:
                self._drag_handle = handle
                return
            self._panning = True
            self._pan_last = pos
            self.setCursor(Qt.ClosedHandCursor)
            return
        # 区域模式
        self._drag_region_start = self._clamp_image_point(
            self.widget_to_image(pos))

    def mouseMoveEvent(self, event) -> None:
        pos = QPointF(event.position())
        img = self.widget_to_image(pos)
        self.cursorMoved.emit(img.x(), img.y())
        if self._panning and self._pan_last is not None:
            d = pos - self._pan_last
            self._ox += d.x()
            self._oy += d.y()
            self._pan_last = pos
            self.update()
            return
        if self._drag_region_start is not None:
            end = self._clamp_image_point(img)
            self.set_region(QRectF(self._drag_region_start, end).normalized())
            return
        if self._drag_handle is not None and self.basis is not None:
            p = self._clamp_image_point(img)
            basis = self.basis
            if self._drag_handle == "origin":
                new = CellBasis((p.x(), p.y()), basis.t1, basis.t2)
            elif self._drag_handle == "t1":
                t1 = (p.x() - basis.origin[0], p.y() - basis.origin[1])
                new = CellBasis(basis.origin, t1, basis.t2)
            else:
                t2 = (p.x() - basis.origin[0], p.y() - basis.origin[1])
                new = CellBasis(basis.origin, basis.t1, t2)
            if abs(new.area) < 1e-3:
                return
            self.basis = new
            self.basisEdited.emit(
                QPointF(*new.origin), QPointF(*new.t1), QPointF(*new.t2))
            self.update()
            return
        # 悬停光标提示
        if self.mode == self.MODE_VECTORS:
            self.setCursor(Qt.OpenHandCursor
                           if self._hit_handle(pos) is None else Qt.PointingHandCursor)

    def mouseReleaseEvent(self, event) -> None:
        if self._panning:
            self._panning = False
            self._pan_last = None
            self.unsetCursor()
            return
        if self._drag_region_start is not None:
            start = self._drag_region_start
            end = self._clamp_image_point(self.widget_to_image(
                QPointF(event.position())))
            self._drag_region_start = None
            rect = QRectF(start, end).normalized()
            if rect.width() >= 12 and rect.height() >= 12:
                self.set_region(rect)
                self.regionChanged.emit(QRectF(rect))
            else:
                self.update()
            return
        if self._drag_handle is not None:
            self._drag_handle = None

    def wheelEvent(self, event) -> None:
        if self._rgb is None:
            return
        pos = QPointF(event.position())
        before = self.widget_to_image(pos)
        factor = 1.0015 ** event.angleDelta().y()
        new_zoom = min(max(self._zoom * factor, 0.05), 40.0)
        if abs(new_zoom - self._zoom) < 1e-9:
            return
        self._zoom = new_zoom
        self._ox = pos.x() - before.x() * self._zoom
        self._oy = pos.y() - before.y() * self._zoom
        self.update()

    def resizeEvent(self, event) -> None:
        if self._fit_pending:
            self.fit_to_window()
        super().resizeEvent(event)
