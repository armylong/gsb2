"""PySide6 图像显示控件: 灰度/彩色图、点击取像素、无效点标记、十字光标."""
from __future__ import annotations

import numpy as np
from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QColor, QImage, QPainter, QPen, QPixmap
from PySide6.QtWidgets import QWidget


def gray_to_qimage(img: np.ndarray, vmax: float | None = None) -> QImage:
    """浮点灰度 (H,W) -> QImage (灰度 8 位)."""
    img = np.asarray(img, dtype=np.float64)
    scale = vmax if vmax is not None else max(float(np.nanmax(img)), 1e-9)
    u8 = np.clip(img / max(scale, 1e-9) * 255.0, 0, 255).astype(np.uint8)
    h, w = u8.shape
    return QImage(u8.tobytes(), w, h, w, QImage.Format.Format_Grayscale8).copy()


def rgb_to_qimage(rgb: np.ndarray) -> QImage:
    """uint8 RGB (H,W,3) -> QImage."""
    rgb = np.ascontiguousarray(rgb, np.uint8)
    h, w = rgb.shape[:2]
    return QImage(rgb.tobytes(), w, h, 3 * w, QImage.Format.Format_RGB888).copy()


class ImageView(QWidget):
    """显示一张图, 点击/移动发出像素坐标; 支持无效点红叉和十字叠加."""

    pixel_clicked = Signal(int, int)
    pixel_hovered = Signal(int, int)

    def __init__(self, title: str = "", parent: QWidget | None = None):
        super().__init__(parent)
        self._title = title
        self._pixmap: QPixmap | None = None
        self._invalid: np.ndarray | None = None
        self._cursor: tuple[int, int] | None = None
        self.setMinimumSize(180, 180)
        self.setMouseTracking(True)

    def set_gray(self, img: np.ndarray, invalid: np.ndarray | None = None,
                 vmax: float | None = None) -> None:
        self._pixmap = QPixmap.fromImage(gray_to_qimage(img, vmax))
        self._invalid = None if invalid is None else np.asarray(invalid, bool)
        self.update()

    def set_rgb(self, rgb: np.ndarray, invalid: np.ndarray | None = None) -> None:
        self._pixmap = QPixmap.fromImage(rgb_to_qimage(rgb))
        self._invalid = None if invalid is None else np.asarray(invalid, bool)
        self.update()

    def set_cursor(self, yx: tuple[int, int] | None) -> None:
        self._cursor = yx
        self.update()

    def title(self) -> str:
        return self._title

    def _to_pixel(self, ev) -> tuple[int, int] | None:
        if self._pixmap is None or self._pixmap.width() == 0:
            return None
        sx = self._pixmap.width() / self.width()
        sy = self._pixmap.height() / self.height()
        x = int(ev.position().x() * sx)
        y = int(ev.position().y() * sy)
        h = self._pixmap.height()
        w = self._pixmap.width()
        if 0 <= x < w and 0 <= y < h:
            return y, x
        return None

    def mouseMoveEvent(self, ev):
        px = self._to_pixel(ev)
        if px is not None:
            self.pixel_hovered.emit(*px)

    def mousePressEvent(self, ev):
        px = self._to_pixel(ev)
        if px is not None:
            self.pixel_clicked.emit(*px)

    def paintEvent(self, _ev):
        painter = QPainter(self)
        painter.fillRect(self.rect(), Qt.GlobalColor.black)
        if self._pixmap is None:
            return
        scaled = self._pixmap.scaled(
            self.size(),
            Qt.AspectRatioMode.KeepAspectRatio,
            Qt.TransformationMode.FastTransformation,
        )
        x0 = (self.width() - scaled.width()) // 2
        y0 = (self.height() - scaled.height()) // 2
        painter.drawPixmap(x0, y0, scaled)

        # 标题
        painter.setPen(Qt.GlobalColor.yellow)
        painter.drawText(6, 16, self._title)

        if self._pixmap is None:
            return
        pw, ph = self._pixmap.width(), self._pixmap.height()

        def map_pt(x: int, y: int):
            return x0 + x * scaled.width() / pw, y0 + y * scaled.height() / ph

        # 无效点标记: 稀疏/背景无效画红叉; 超过一半像素失效才用半透明红色蒙层
        if self._invalid is not None and self._invalid.any():
            frac = float(self._invalid.mean())
            if frac > 0.50:
                # 密集无效: 半透明红色蒙层, 仍能透出底下的图
                painter.setOpacity(0.55)
                painter.fillRect(x0, y0, scaled.width(), scaled.height(),
                                 QColor(255, 0, 0))
                painter.setOpacity(1.0)
                painter.setPen(Qt.GlobalColor.red)
                painter.drawText(6, self.height() - 8,
                                 f"红色区域 = 无效/低可信 ({frac*100:.0f}%)")
            else:
                pen = QPen(Qt.GlobalColor.red, 1.0)
                painter.setPen(pen)
                ys, xs = np.nonzero(self._invalid)
                step = max(1, len(xs) // 2500)
                d = max(1.5, scaled.width() / pw)
                for y, x in zip(ys[::step], xs[::step]):
                    mx, my = map_pt(x, y)
                    painter.drawLine(int(mx - d), int(my - d), int(mx + d), int(my + d))
                    painter.drawLine(int(mx - d), int(my + d), int(mx + d), int(my - d))

        # 十字光标
        if self._cursor is not None:
            y, x = self._cursor
            mx, my = map_pt(x, y)
            pen = QPen(Qt.GlobalColor.cyan, 1.0)
            painter.setPen(pen)
            painter.drawLine(int(mx), y0, int(mx), y0 + scaled.height())
            painter.drawLine(x0, int(my), x0 + scaled.width(), int(my))
