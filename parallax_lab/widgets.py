"""PySide6 view widgets for the parallax preview tool.

Pure-UI module: it only talks to `parallax_lab.core` through `render()` and
`RenderResult.probe()`, so it can be imported without a display (the Qt
widgets are only constructed inside the app).
"""

from __future__ import annotations

import numpy as np
from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import QColor, QFont, QImage, QPainter, QPen, QPixmap
from PySide6.QtWidgets import QSizePolicy, QWidget

from .core import (CAT_BACK_TO_FRONT, CAT_FRONT_TO_BACK, CAT_FROM_HOLE, CAT_TO_HOLE,
                   RenderResult)

_LAYER_COLORS = [QColor(255, 196, 64), QColor(96, 200, 255)]


def numpy_to_qimage(rgb: np.ndarray) -> QImage:
    """Copy an (H, W, 3) uint8 RGB array into a QImage."""
    rgb = np.ascontiguousarray(rgb)
    h, w = rgb.shape[:2]
    img = QImage(rgb.data, w, h, 3 * w, QImage.Format.Format_RGB888)
    return img.copy()          # detach from the numpy buffer


class ImageView(QWidget):
    """Paints a RenderResult (or a plain image) with an optional overlay.

    Features
    --------
    * `set_overlay` draws a translucent layer map (which layer won, where the
      holes are) -- requirement: see the layout.
    * Click / drag emits `pixel_hovered(x, y)` in *output image* coordinates,
      scaled to the widget rect.
    * `set_marker` shows a crosshair at the last probed pixel.
    """

    pixel_hovered = Signal(int, int)
    pixel_clicked = Signal(int, int)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumSize(320, 200)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self._pixmap: QPixmap | None = None
        self._img_shape = (0, 0)
        self._overlay: QImage | None = None
        self._marker: tuple[int, int] | None = None
        self._marker_text: str = ""
        self._title: str = ""
        self.setMouseTracking(True)
        self.setCursor(Qt.CursorShape.CrossCursor)

    # ---- content ------------------------------------------------------
    def set_result(self, result: RenderResult | None, title: str = ""):
        self._title = title
        if result is None:
            self._pixmap = None
            self._overlay = None
            self._img_shape = (0, 0)
        else:
            self._pixmap = QPixmap.fromImage(numpy_to_qimage(result.rgb))
            self._img_shape = result.shape
            self._overlay = None
        self.update()

    def set_image(self, rgb: np.ndarray | None, title: str = ""):
        self._title = title
        self._pixmap = QPixmap.fromImage(numpy_to_qimage(rgb)) if rgb is not None else None
        self._img_shape = rgb.shape[:2] if rgb is not None else (0, 0)
        self._overlay = None
        self.update()

    def set_overlay(self, overlay: np.ndarray | None):
        """overlay: (H, W, 4) uint8 RGBA to composite over the image."""
        if overlay is None:
            self._overlay = None
        else:
            ov = np.ascontiguousarray(overlay, dtype=np.uint8)
            h, w = ov.shape[:2]
            self._overlay = QImage(ov.data, w, h, 4 * w,
                                   QImage.Format.Format_RGBA8888).copy()
        self.update()

    def set_marker(self, xy: tuple[int, int] | None, text: str = ""):
        self._marker = xy
        self._marker_text = text
        self.update()

    def has_image(self) -> bool:
        return self._pixmap is not None

    # ---- geometry -----------------------------------------------------
    def _target_rect(self) -> QRectF:
        if self._pixmap is None:
            return QRectF(0, 0, self.width(), self.height())
        pw, ph = self._pixmap.width(), self._pixmap.height()
        sw, sh = self.width() - 8, self.height() - 8
        scale = min(sw / pw, sh / ph)
        w, h = pw * scale, ph * scale
        return QRectF((self.width() - w) / 2, (self.height() - h) / 2, w, h)

    def _to_image(self, pos: QPointF):
        if self._pixmap is None or self._img_shape == (0, 0):
            return None
        r = self._target_rect()
        if not r.contains(pos):
            return None
        H, W = self._img_shape
        x = int((pos.x() - r.x()) / r.width() * W)
        y = int((pos.y() - r.y()) / r.height() * H)
        return min(max(x, 0), W - 1), min(max(y, 0), H - 1)

    # ---- events -------------------------------------------------------
    def mouseMoveEvent(self, event):
        xy = self._to_image(event.position())
        if xy is not None:
            self.pixel_hovered.emit(*xy)
        super().mouseMoveEvent(event)

    def mousePressEvent(self, event):
        xy = self._to_image(event.position())
        if xy is not None:
            self.pixel_clicked.emit(*xy)
        super().mousePressEvent(event)

    # ---- painting -----------------------------------------------------
    def paintEvent(self, event):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, False)
        p.fillRect(self.rect(), QColor(24, 26, 30))
        if self._pixmap is None:
            p.setPen(QColor(120, 124, 132))
            p.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter, "no image")
            return
        target = self._target_rect()
        p.drawPixmap(target, self._pixmap, QRectF(self._pixmap.rect()))
        if self._overlay is not None:
            p.setOpacity(0.55)
            p.drawImage(target, self._overlay)
            p.setOpacity(1.0)
        p.setPen(QPen(QColor(80, 84, 92), 1))
        p.drawRect(target)

        # marker crosshair, drawn only if the marker maps into view
        if self._marker is not None:
            H, W = self._img_shape
            if 0 <= self._marker[0] < W and 0 <= self._marker[1] < H:
                mx = target.x() + (self._marker[0] + 0.5) / W * target.width()
                my = target.y() + (self._marker[1] + 0.5) / H * target.height()
                pen = QPen(QColor(255, 255, 255), 2)
                pen.setCosmetic(True)
                p.setPen(pen)
                p.drawLine(QPointF(mx - 9, my), QPointF(mx + 9, my))
                p.drawLine(QPointF(mx, my - 9), QPointF(mx, my + 9))
                p.setPen(QPen(QColor(0, 0, 0), 1))
                p.drawEllipse(QPointF(mx, my), 4.5, 4.5)
                if self._marker_text:
                    self._draw_callout(p, QPointF(mx, my), self._marker_text, target)

        if self._title:
            p.setPen(QColor(230, 232, 236))
            f = QFont()
            f.setPointSizeF(max(9.0, f.pointSizeF()))
            p.setFont(f)
            p.fillRect(QRectF(target.x(), target.y(), target.width(), 22),
                       QColor(0, 0, 0, 120))
            p.drawText(QRectF(target.x() + 6, target.y(), target.width(), 22),
                       Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignLeft,
                       self._title)

    def _draw_callout(self, p: QPainter, at: QPointF, text: str, target: QRectF):
        lines = text.split("\n")
        fm = p.fontMetrics()
        w = max(fm.horizontalAdvance(s) for s in lines) + 14
        h = fm.height() * len(lines) + 10
        x = at.x() + 14
        y = at.y() + 14
        if x + w > target.right():
            x = at.x() - w - 14
        if y + h > target.bottom():
            y = at.y() - h - 14
        box = QRectF(x, y, w, h)
        p.setBrush(QColor(18, 20, 24, 225))
        p.setPen(QPen(QColor(90, 96, 106), 1))
        p.drawRoundedRect(box, 4, 4)
        p.setPen(QColor(235, 238, 242))
        for i, s in enumerate(lines):
            p.drawText(QRectF(x + 7, y + 5 + i * fm.height(), w - 14, fm.height()),
                       Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter, s)


class DepthView(QWidget):
    """Shows a layer's depth as colour, with an optional NaN/alpha mask.

    Click-drag paints an additive depth offset (the draft) into `brush`.
    Emits `stroke_finished(x, y, radius, value)` at the end of a drag.
    """

    stroke = Signal(int, int, int, float)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumSize(220, 160)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self._img: QImage | None = None
        self._shape = (0, 0)
        self._text = ""
        self._hover: tuple[int, int] | None = None
        self._brush_radius = 8
        self._brush_value = 0.05
        self._drawing = False
        self.setMouseTracking(True)

    def set_depth(self, depth: np.ndarray, title: str = "",
                  valid_mask: np.ndarray | None = None):
        finite = np.isfinite(depth)
        self._shape = depth.shape
        self._text = title
        if not finite.any():
            self._img = None
            self.update()
            return
        vals = depth[finite].astype(np.float64)
        lo, hi = float(vals.min()), float(vals.max())
        self._constant = (hi - lo) < 1e-3
        if self._constant:
            # A constant depth has no useful range; centre a narrow band on it
            # so a small brush edit is visible, and label it as constant.
            lo, hi = lo - 0.15, hi + 0.15
        t = np.zeros(depth.shape, np.float32)
        t[finite] = np.clip((depth[finite] - lo) / (hi - lo), 0, 1)
        # blue (far) -> cyan -> green -> yellow -> red (near)
        r = np.clip(1.65 * t - 0.15, 0, 1)
        g = np.clip(1.45 - np.abs(2.4 * t - 1.1), 0, 1)
        b = np.clip(1.15 - 2.0 * t, 0, 1)
        a = np.where(finite, 255, 0).astype(np.uint8)
        if valid_mask is not None:
            a = np.where(valid_mask, a, 0).astype(np.uint8)
        rgba = np.empty(depth.shape + (4,), np.uint8)
        rgba[..., 0] = (r * 255).astype(np.uint8)
        rgba[..., 1] = (g * 255).astype(np.uint8)
        rgba[..., 2] = (b * 255).astype(np.uint8)
        rgba[..., 3] = a
        self._img = QImage(np.ascontiguousarray(rgba).data, depth.shape[1], depth.shape[0],
                           4 * depth.shape[1], QImage.Format.Format_RGBA8888).copy()
        self._range = (lo, hi)
        self.update()

    def _rect(self) -> QRectF:
        w, h = self._shape[1], self._shape[0]
        if self._img is None or w == 0:
            return QRectF(0, 0, self.width(), self.height())
        scale = min((self.width() - 6) / w, (self.height() - 6) / h)
        tw, th = w * scale, h * scale
        return QRectF((self.width() - tw) / 2, (self.height() - th) / 2, tw, th)

    def _to_image(self, pos):
        if self._img is None:
            return None
        r = self._rect()
        if not r.contains(pos):
            return None
        x = int((pos.x() - r.x()) / r.width() * self._shape[1])
        y = int((pos.y() - r.y()) / r.height() * self._shape[0])
        return min(max(x, 0), self._shape[1] - 1), min(max(y, 0), self._shape[0] - 1)

    def set_brush(self, radius: int, value: float):
        self._brush_radius = max(1, radius)
        self._brush_value = value

    def mousePressEvent(self, e):
        if e.button() == Qt.MouseButton.LeftButton:
            self._drawing = True
            self._emit_stroke(e.position())
        super().mousePressEvent(e)

    def mouseMoveEvent(self, e):
        xy = self._to_image(e.position())
        if xy != self._hover:
            self._hover = xy
            self.update()
        if self._drawing:
            self._emit_stroke(e.position())
        super().mouseMoveEvent(e)

    def mouseReleaseEvent(self, e):
        self._drawing = False
        super().mouseReleaseEvent(e)

    def _emit_stroke(self, pos):
        xy = self._to_image(pos)
        if xy is not None:
            self.stroke.emit(xy[0], xy[1], self._brush_radius, self._brush_value)

    def paintEvent(self, e):
        p = QPainter(self)
        p.fillRect(self.rect(), QColor(20, 22, 26))
        if self._img is None:
            p.setPen(QColor(110, 116, 124))
            p.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter, "no depth")
            return
        r = self._rect()
        p.drawImage(r, self._img)
        p.setPen(QPen(QColor(70, 74, 82), 1))
        p.drawRect(r)
        p.setPen(QColor(220, 224, 230))
        p.drawText(QRectF(4, 2, self.width() - 8, 18),
                   Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignTop, self._text)
        # depth scale legend
        lo, hi = self._range
        if getattr(self, "_constant", False):
            p.drawText(QRectF(r.x() + 4, r.bottom() - 20, r.width() - 8, 18),
                       Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignBottom,
                       f"constant {(lo + hi) / 2:.2f} m")
        else:
            p.drawText(QRectF(r.x() + 4, r.bottom() - 20, r.width() - 8, 18),
                       Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignBottom,
                       f"near {lo:.2f} m")
            p.drawText(QRectF(r.x() + 4, r.bottom() - 20, r.width() - 8, 18),
                       Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignBottom,
                       f"far {hi:.2f} m")
        if self._hover is not None:
            mx = r.x() + (self._hover[0] + 0.5) / self._shape[1] * r.width()
            my = r.y() + (self._hover[1] + 0.5) / self._shape[0] * r.height()
            p.setPen(QPen(QColor(255, 255, 255, 200), 1, Qt.PenStyle.DotLine))
            p.drawEllipse(QPointF(mx, my), self._brush_radius, self._brush_radius)


def layer_overlay(result: RenderResult) -> np.ndarray | None:
    """RGBA overlay showing winner layer and holes."""
    if result is None:
        return None
    H, W = result.shape
    rgba = np.zeros((H, W, 4), np.uint8)
    for i, col in enumerate(_LAYER_COLORS):
        m = result.layer_map == i
        rgba[m] = (col.red(), col.green(), col.blue(), 55)
    hole = result.hole_mask
    rgba[hole & ~result.filled_mask] = (255, 0, 176, 170)
    rgba[hole & result.filled_mask] = (140, 110, 255, 110)
    return rgba


def hole_overlay(result: RenderResult) -> np.ndarray | None:
    """RGBA overlay with only the hole/filled mask."""
    if result is None:
        return None
    H, W = result.shape
    rgba = np.zeros((H, W, 4), np.uint8)
    rgba[result.filled_mask] = (140, 110, 255, 190)
    rgba[result.hole_mask & ~result.filled_mask] = (255, 0, 176, 220)
    return rgba


def diff_overlay(diff) -> np.ndarray | None:
    """RGBA overlay for a LayoutDiff."""
    if diff is None:
        return None
    H, W = diff.mask.shape
    rgba = np.zeros((H, W, 4), np.uint8)
    palette = {
        CAT_FRONT_TO_BACK: (255, 170, 40, 200),
        CAT_BACK_TO_FRONT: (60, 200, 255, 200),
        CAT_TO_HOLE: (255, 0, 176, 220),
        CAT_FROM_HOLE: (120, 255, 130, 220),
    }
    for cat, col in palette.items():
        rgba[diff.category == cat] = col
    return rgba
