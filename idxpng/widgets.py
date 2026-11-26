"""同步平移/缩放的像素画布。

两个 PixelCanvas 共享同一个 ViewState, 因此原图与现图的缩放倍数和偏移
完全一致; 由变换参数可以把鼠标位置精确反算成像素坐标, 供双版本索引对照。
"""

from __future__ import annotations

import math
from typing import Optional

from PySide6.QtCore import QLineF, QObject, QPoint, QRectF, Qt, Signal
from PySide6.QtGui import (
    QColor,
    QMouseEvent,
    QPainter,
    QPaintEvent,
    QPen,
    QWheelEvent,
)
from PySide6.QtWidgets import QWidget

MIN_SCALE = 0.05
MAX_SCALE = 96.0


class ViewState(QObject):
    """两张画布共享的视图变换: scale = 每像素对应的屏幕像素数。"""

    changed = Signal()

    def __init__(self) -> None:
        super().__init__()
        self.scale = 24.0
        self.ox = 0.0
        self.oy = 0.0

    def set_transform(self, scale: float, ox: float, oy: float) -> None:
        self.scale = max(MIN_SCALE, min(MAX_SCALE, scale))
        self.ox, self.oy = ox, oy
        self.changed.emit()

    def zoom_at(self, x: float, y: float, factor: float) -> None:
        ix = (x - self.ox) / self.scale
        iy = (y - self.oy) / self.scale
        new_scale = max(MIN_SCALE, min(MAX_SCALE, self.scale * factor))
        self.ox = x - ix * new_scale
        self.oy = y - iy * new_scale
        self.scale = new_scale
        self.changed.emit()

    def pan(self, dx: float, dy: float) -> None:
        self.ox += dx
        self.oy += dy
        self.changed.emit()

    def fit(self, image_w: int, image_h: int, view_w: int, view_h: int) -> None:
        if image_w <= 0 or image_h <= 0:
            return
        scale = min(max(view_w - 28, 40) / image_w, max(view_h - 28, 40) / image_h)
        scale = max(MIN_SCALE, min(MAX_SCALE, scale))
        self.scale = scale
        self.ox = (view_w - image_w * scale) / 2.0
        self.oy = (view_h - image_h * scale) / 2.0
        self.changed.emit()

    def actual_size(self, image_w: int, image_h: int, view_w: int, view_h: int) -> None:
        self.scale = 1.0
        self.ox = (view_w - image_w) / 2.0
        self.oy = (view_h - image_h) / 2.0
        self.changed.emit()


class PixelCanvas(QWidget):
    """最近邻缩放、棋盘格底、可拖拽平移、点击取像素的画布。"""

    pixelClicked = Signal(int, int)
    hoverPixel = Signal(object)  # tuple[int,int] | None

    def __init__(self, state: ViewState, placeholder: str = "") -> None:
        super().__init__()
        self.state = state
        self.placeholder = placeholder
        self._image = None  # QImage | None
        # 需要描边的高亮像素集合(图像坐标), 只描与非选中像素交界的边
        self.outline_cells: set[tuple[int, int]] = set()
        self.setMinimumSize(200, 180)
        self.setMouseTracking(True)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.setAutoFillBackground(False)

        self._press_pos: Optional[QPoint] = None
        self._last_pos: Optional[QPoint] = None
        self._dragged = False

        self.state.changed.connect(self.update)

    def set_image(self, image) -> None:
        self._image = image
        self.update()

    def set_outline_cells(self, cells) -> None:
        self.outline_cells = set(cells or ())
        self.update()

    def has_image(self) -> bool:
        return self._image is not None and not self._image.isNull()

    # ---- 坐标换算 -------------------------------------------------------
    def pixel_at(self, pos: QPoint) -> Optional[tuple[int, int]]:
        if not self.has_image():
            return None
        ix = int(math.floor((pos.x() - self.state.ox) / self.state.scale))
        iy = int(math.floor((pos.y() - self.state.oy) / self.state.scale))
        if 0 <= ix < self._image.width() and 0 <= iy < self._image.height():
            return ix, iy
        return None

    def zoom_center(self, factor: float) -> None:
        self.state.zoom_at(self.width() / 2.0, self.height() / 2.0, factor)

    # ---- 绘制 -----------------------------------------------------------
    def paintEvent(self, event: QPaintEvent) -> None:  # noqa: N802 (Qt 命名)
        p = QPainter(self)
        p.fillRect(self.rect(), QColor("#26262c"))

        if not self.has_image():
            p.setPen(QColor("#9a9aa5"))
            p.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter, self.placeholder or "暂无图像")
            p.end()
            return

        iw, ih = self._image.width(), self._image.height()
        s = self.state.scale
        target = QRectF(self.state.ox, self.state.oy, iw * s, ih * s)

        # 棋盘格 + 索引图(关闭平滑 -> 硬边像素)
        p.save()
        p.setClipRect(target)
        self._paint_checker(p, target)
        p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, False)
        p.drawImage(target, self._image)
        p.restore()

        # 高倍时画像素网格
        if s >= 8:
            self._paint_grid(p, iw, ih, s)

        # 高亮索引的矢量交界描边(黑色外衬 + 亮黄主线)
        if s >= 3 and self.outline_cells:
            self._paint_outline(p)

        pen = QPen(QColor(0, 0, 0, 180))
        pen.setWidth(1)
        p.setPen(pen)
        p.drawRect(target.adjusted(0.5, 0.5, -0.5, -0.5))
        p.end()

    def _paint_checker(self, p: QPainter, target: QRectF, cell: int = 12) -> None:
        """以图像原点为相位画棋盘格(只画与控件相交的可见格)。"""
        p.fillRect(target, QColor("#ffffff"))
        visible = target.intersected(QRectF(self.rect()))
        if visible.isEmpty():
            return
        ox, oy = self.state.ox, self.state.oy
        kx0 = math.floor((visible.left() - ox) / cell)
        kx1 = math.ceil((visible.right() - ox) / cell)
        ky0 = math.floor((visible.top() - oy) / cell)
        ky1 = math.ceil((visible.bottom() - oy) / cell)
        gray = QColor("#cfcfd6")
        for ky in range(ky0, ky1):
            for kx in range(kx0, kx1):
                if (kx + ky) % 2 == 0:
                    p.fillRect(QRectF(ox + kx * cell, oy + ky * cell, cell, cell), gray)

    def _paint_grid(self, p: QPainter, iw: int, ih: int, s: float) -> None:
        pen = QPen(QColor(0, 0, 0, 65))
        pen.setWidth(1)
        p.setPen(pen)

        vx0 = max(0, int(math.floor((0 - self.state.ox) / s)))
        vx1 = min(iw, int(math.ceil((self.width() - self.state.ox) / s)))
        vy0 = max(0, int(math.floor((0 - self.state.oy) / s)))
        vy1 = min(ih, int(math.ceil((self.height() - self.state.oy) / s)))

        for ix in range(vx0, vx1 + 1):
            x = self.state.ox + ix * s
            p.drawLine(int(x), max(0, int(self.state.oy)),
                        int(x), min(self.height(), int(self.state.oy + ih * s)))
        for iy in range(vy0, vy1 + 1):
            y = self.state.oy + iy * s
            p.drawLine(max(0, int(self.state.ox)), int(y),
                       min(self.width(), int(self.state.ox + iw * s)), int(y))

    def _paint_outline(self, p: QPainter) -> None:
        """在高亮像素与其他像素的交界边上画双层描边。"""
        cells = self.outline_cells
        edges: list[QLineF] = []
        for x, y in cells:
            if (x, y - 1) not in cells:
                edges.append(QLineF(x, y, x + 1, y))
            if (x, y + 1) not in cells:
                edges.append(QLineF(x, y + 1, x + 1, y + 1))
            if (x - 1, y) not in cells:
                edges.append(QLineF(x, y, x, y + 1))
            if (x + 1, y) not in cells:
                edges.append(QLineF(x + 1, y, x + 1, y + 1))
        if not edges:
            return

        p.save()
        p.translate(self.state.ox, self.state.oy)
        p.scale(self.state.scale, self.state.scale)

        halo = QPen(QColor(0, 0, 0, 210))
        halo.setCosmetic(True)
        halo.setWidth(4)
        p.setPen(halo)
        for line in edges:
            p.drawLine(line)

        main = QPen(QColor(255, 224, 70, 255))
        main.setCosmetic(True)
        main.setWidth(2)
        p.setPen(main)
        for line in edges:
            p.drawLine(line)
        p.restore()

    # ---- 鼠标交互 -------------------------------------------------------
    def wheelEvent(self, event: QWheelEvent) -> None:  # noqa: N802
        dy = event.angleDelta().y()
        if dy == 0:
            return
        factor = 1.2 if dy > 0 else 1 / 1.2
        pos = event.position()
        self.state.zoom_at(pos.x(), pos.y(), factor)
        event.accept()

    def mousePressEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if event.button() in (Qt.MouseButton.LeftButton, Qt.MouseButton.MiddleButton):
            self._press_pos = event.position().toPoint()
            self._last_pos = self._press_pos
            self._dragged = False
            self.setCursor(Qt.CursorShape.ClosedHandCursor)
            event.accept()

    def mouseMoveEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        pos = event.position().toPoint()
        if self._last_pos is not None and self._press_pos is not None:
            if (pos - self._press_pos).manhattanLength() > 4:
                self._dragged = True
            if self._dragged:
                self.state.pan(pos.x() - self._last_pos.x(), pos.y() - self._last_pos.y())
            self._last_pos = pos
        else:
            self.hoverPixel.emit(self.pixel_at(pos))

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        was_drag = self._dragged
        self._press_pos = None
        self._last_pos = None
        self._dragged = False
        self.unsetCursor()
        if event.button() == Qt.MouseButton.LeftButton and not was_drag:
            xy = self.pixel_at(event.position().toPoint())
            if xy is not None:
                self.pixelClicked.emit(*xy)

    def leaveEvent(self, event) -> None:  # noqa: N802
        self.hoverPixel.emit(None)
        super().leaveEvent(event)
