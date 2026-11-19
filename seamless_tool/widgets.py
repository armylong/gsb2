"""图像视图控件:缩放、平移、块边界、点选、画笔。

关键设计:3x3 平铺先由 numpy 整体合成一张大图,再整体一次性缩放绘制,
各块之间不存在独立缩放,因此放大检查接缝时不会出现假的一像素缝。
"""
from __future__ import annotations

import numpy as np
from PySide6.QtCore import QPointF, Qt, Signal
from PySide6.QtGui import QColor, QImage, QPainter, QPen, QPixmap
from PySide6.QtWidgets import QWidget


def ndarray_to_pixmap(img: np.ndarray) -> QPixmap:
    img = np.ascontiguousarray(img)
    h, w = img.shape[:2]
    qimg = QImage(img.data, w, h, 3 * w, QImage.Format.Format_RGB888)
    return QPixmap.fromImage(qimg.copy())  # copy 脱离 numpy 缓冲区


def compose_overlay(img: np.ndarray, mask: np.ndarray | None,
                    conflict: np.ndarray | None) -> np.ndarray:
    """把保护区(红)与冲突区(橙)叠加到图像上,随图一起缩放。"""
    out = img.copy()
    if mask is not None and mask.any():
        m = mask
        out[m] = (0.55 * out[m] + 0.45 * np.array([230, 40, 40])).astype(np.uint8)
    if conflict is not None and conflict.any():
        out[conflict] = (0.45 * out[conflict]
                         + 0.55 * np.array([255, 170, 0])).astype(np.uint8)
    return out


class ImageView(QWidget):
    """通用图像视图:滚轮缩放、拖拽平移、可选块边界网格、点选与画笔回调。"""

    pixel_picked = Signal(int, int)          # 图像坐标(点击,未拖动)
    paint_stroke = Signal(int, int, bool)    # 图像坐标, 是否擦除(持续拖动)
    paint_finished = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        self._pixmap: QPixmap | None = None
        self._img_w = 0
        self._img_h = 0
        self.zoom = 1.0
        self.pan = QPointF(0, 0)
        self.grid_step: tuple[int, int] | None = None  # (w, h) 块尺寸
        self.paint_enabled = False
        self.erase_mode = False
        self._drag_button = None
        self._press_pos = None
        self._press_pan = None
        self._moved = False
        self.setMouseTracking(False)
        self.setMinimumSize(300, 300)

    # ---- 内容 ----
    def set_image(self, img: np.ndarray | None, grid_step=None):
        if img is None:
            self._pixmap = None
        else:
            self._pixmap = ndarray_to_pixmap(img)
            self._img_h, self._img_w = img.shape[:2]
        self.grid_step = grid_step
        self.update()

    def fit(self):
        if not self._pixmap:
            return
        vw, vh = max(self.width(), 1), max(self.height(), 1)
        self.zoom = min(vw / self._img_w, vh / self._img_h) * 0.98
        self.pan = QPointF((vw - self._img_w * self.zoom) / 2,
                           (vh - self._img_h * self.zoom) / 2)
        self.update()

    # ---- 坐标 ----
    def to_image(self, pos: QPointF) -> tuple[int, int]:
        x = int((pos.x() - self.pan.x()) / self.zoom)
        y = int((pos.y() - self.pan.y()) / self.zoom)
        return x, y

    # ---- 绘制 ----
    def paintEvent(self, event):
        p = QPainter(self)
        p.fillRect(self.rect(), QColor(40, 40, 40))
        if not self._pixmap:
            p.setPen(QColor(180, 180, 180))
            p.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter,
                       "打开图片或生成测试纹理")
            p.end()
            return
        # 高倍放大时用最近邻,便于逐像素检查接缝;缩小时用平滑
        if self.zoom < 3.0:
            p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
        p.translate(self.pan)
        p.scale(self.zoom, self.zoom)
        p.drawPixmap(0, 0, self._pixmap)
        if self.grid_step:
            gw, gh = self.grid_step
            pen = QPen(QColor(0, 220, 255, 160))
            pen.setWidth(0)  # 装饰线:恒 1 像素,不随缩放变粗
            pen.setCosmetic(True)
            p.setPen(pen)
            x = gw
            while x < self._img_w:
                p.drawLine(x, 0, x, self._img_h)
                x += gw
            y = gh
            while y < self._img_h:
                p.drawLine(0, y, self._img_w, y)
                y += gh
        p.end()

    # ---- 交互 ----
    def wheelEvent(self, e):
        if not self._pixmap:
            return
        old = self.zoom
        factor = 1.25 if e.angleDelta().y() > 0 else 0.8
        self.zoom = float(np.clip(old * factor, 0.02, 64.0))
        pos = e.position()
        self.pan = QPointF(pos) - (QPointF(pos) - self.pan) * (self.zoom / old)
        self.update()

    def mousePressEvent(self, e):
        self._press_pos = e.position()
        self._press_pan = QPointF(self.pan)
        self._moved = False
        self._drag_button = e.button()
        if (self.paint_enabled and e.button() == Qt.MouseButton.LeftButton
                and self._pixmap):
            x, y = self.to_image(e.position())
            self.paint_stroke.emit(x, y, self.erase_mode)

    def mouseMoveEvent(self, e):
        if self._press_pos is None:
            return
        delta = e.position() - self._press_pos
        if abs(delta.x()) + abs(delta.y()) > 3:
            self._moved = True
        if (self.paint_enabled and self._drag_button == Qt.MouseButton.LeftButton
                and self._pixmap):
            x, y = self.to_image(e.position())
            self.paint_stroke.emit(x, y, self.erase_mode)
        elif self._drag_button in (Qt.MouseButton.LeftButton,
                                   Qt.MouseButton.MiddleButton):
            self.pan = self._press_pan + delta
            self.update()

    def mouseReleaseEvent(self, e):
        if self._press_pos is None:
            return
        was_paint = (self.paint_enabled
                     and self._drag_button == Qt.MouseButton.LeftButton)
        if not self._moved and e.button() == Qt.MouseButton.LeftButton \
                and self._pixmap and not was_paint:
            x, y = self.to_image(e.position())
            if 0 <= x < self._img_w and 0 <= y < self._img_h:
                self.pixel_picked.emit(x, y)
        if was_paint:
            self.paint_finished.emit()
        self._press_pos = None
        self._drag_button = None
