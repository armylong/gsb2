"""Reusable Qt widgets: image canvas, histogram with range handles, profiles."""

from __future__ import annotations

from typing import Iterable

import numpy as np
from PySide6.QtCore import QPoint, QPointF, QRectF, QSize, Qt, Signal
from PySide6.QtGui import (
    QColor,
    QImage,
    QMouseEvent,
    QPainter,
    QPainterPath,
    QPen,
    QPixmap,
    QWheelEvent,
)
from PySide6.QtWidgets import QLabel, QSizePolicy, QWidget

from ..core import Profile, to_display_u8

OVERLAY_COLORS = {
    "low": QColor(70, 130, 255, 150),
    "saturated": QColor(255, 60, 60, 170),
    "unstable": QColor(255, 165, 0, 150),
    "patched": QColor(0, 230, 160, 150),
    "sample_sat": QColor(255, 0, 255, 150),
    "invalid_shade": QColor(0, 0, 0, 110),
}


def _qimage_gray(u8: np.ndarray) -> QImage:
    u8 = np.ascontiguousarray(u8)
    h, w = u8.shape
    image = QImage(u8.data, w, h, w, QImage.Format_Grayscale8)
    return image.copy()


class ImageView(QWidget):
    """Zoom / pan grayscale viewer with pixel interrogation and defect overlay."""

    hovered = Signal(int, int)          # row, col (or -1, -1)
    clicked = Signal(int, int)
    zoomChanged = Signal(float)

    MIN_ZOOM = 0.02
    MAX_ZOOM = 64.0

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setMinimumSize(320, 240)
        self.setMouseTracking(True)
        self.setFocusPolicy(Qt.StrongFocus)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)

        self._array: np.ndarray | None = None
        self._valid: np.ndarray | None = None
        self._u8: np.ndarray | None = None
        self._qimage: QImage | None = None
        self._overlay: QImage | None = None
        self._overlay_data: np.ndarray | None = None
        self._range = (0.0, 65535.0)
        self._zoom = 1.0
        self._offset = QPointF(0.0, 0.0)
        self._fit_pending = True
        self._panning = False
        self._press_pos = QPoint()
        self._press_offset = QPointF()
        self._moved = False
        self._cursor = (-1, -1)
        self._marker: tuple[int, int] | None = None
        self._placeholder = "尚未导入图像"
        self._show_placeholder = True
        self._interpolation_nearest = True

    # ------------------------------------------------------------------ #
    # Data
    # ------------------------------------------------------------------ #
    def set_image(self, data: np.ndarray | None, valid: np.ndarray | None,
                  display_range: tuple[float, float], keep_view: bool = True,
                  placeholder: str = "尚未导入图像") -> None:
        self._placeholder = placeholder
        self._show_placeholder = data is None
        if data is None:
            self._array = self._valid = self._u8 = None
            self._qimage = None
            self._overlay = None
            self.update()
            return
        new = np.asarray(data, np.float32)
        shape_changed = self._array is None or new.shape != self._array.shape
        self._array = new
        self._valid = np.asarray(valid, bool) if valid is not None else np.ones(
            self._array.shape, bool)
        self._range = display_range
        self._rebuild()
        if shape_changed:
            self._marker = None
            self._fit_pending = True
        if not keep_view or self._fit_pending:
            self.fit_to_window()
        self.update()

    def set_display_range(self, lo: float, hi: float) -> None:
        self._range = (float(lo), float(hi))
        if self._array is not None:
            self._rebuild()
            self.update()

    def set_overlay_masks(self, masks: dict[str, np.ndarray] | None,
                          shade_invalid: bool = False) -> None:
        """masks: keys from OVERLAY_COLORS; values boolean arrays."""
        if self._array is None:
            self._overlay = None
            return
        h, w = self._array.shape
        if not masks:
            self._overlay = None
            self._overlay_data = None
            self.update()
            return
        rgba = np.zeros((h, w, 4), np.uint8)
        any_paint = False
        if shade_invalid and "invalid" in masks:
            invalid = masks["invalid"]
            rgba[invalid] = [OVERLAY_COLORS["invalid_shade"].red(),
                             0, 0, OVERLAY_COLORS["invalid_shade"].alpha()]
            any_paint = True
        order = ["low", "unstable", "saturated", "patched", "sample_sat"]
        for key in order:
            mask = masks.get(key)
            if mask is None:
                continue
            color = OVERLAY_COLORS[key]
            rgba[mask] = [color.red(), color.green(), color.blue(), color.alpha()]
            any_paint = True
        if "invalid" in masks and not shade_invalid:
            mask = masks["invalid"]
            rgba[mask] = [OVERLAY_COLORS["invalid_shade"].red(),
                          OVERLAY_COLORS["invalid_shade"].green(),
                          OVERLAY_COLORS["invalid_shade"].blue(), 90]
            any_paint = True
        if not any_paint:
            self._overlay = None
            self._overlay_data = None
        else:
            rgba = np.ascontiguousarray(rgba)
            self._overlay_data = rgba
            image = QImage(rgba.data, w, h, w * 4, QImage.Format_RGBA8888)
            self._overlay = image.copy()
        self.update()

    def set_marker(self, row: int | None, col: int | None) -> None:
        self._marker = None if row is None or col is None else (int(row), int(col))
        self.update()

    def clear(self, placeholder: str = "尚未导入图像") -> None:
        self.set_image(None, None, (0, 65535), placeholder=placeholder)

    def set_interpolation(self, nearest: bool) -> None:
        self._interpolation_nearest = nearest
        self.update()

    # ------------------------------------------------------------------ #
    # Zoom / pan
    # ------------------------------------------------------------------ #
    @property
    def zoom(self) -> float:
        return self._zoom

    def fit_to_window(self) -> None:
        if self._array is None:
            return
        h, w = self._array.shape
        if w == 0 or h == 0 or self.width() <= 8 or self.height() <= 8:
            return
        sx = (self.width() - 8) / w
        sy = (self.height() - 8) / h
        self._zoom = max(self.MIN_ZOOM, min(sx, sy))
        self._center_image()
        self._fit_pending = False
        self.zoomChanged.emit(self._zoom)
        self.update()

    def actual_size(self) -> None:
        self._zoom = 1.0
        self._center_image()
        self.zoomChanged.emit(self._zoom)
        self.update()

    def focus_on(self, row: int, col: int, zoom: float | None = None) -> None:
        """Centre the view on a pixel, optionally zooming to a level."""
        if self._array is None:
            return
        if zoom is not None:
            self._zoom = max(self.MIN_ZOOM, min(self.MAX_ZOOM, zoom))
        self._offset = QPointF(self.width() / 2 - col * self._zoom,
                               self.height() / 2 - row * self._zoom)
        self.zoomChanged.emit(self._zoom)
        self.update()

    def set_zoom(self, zoom: float, anchor: QPointF | None = None) -> None:
        if self._array is None:
            return
        zoom = max(self.MIN_ZOOM, min(self.MAX_ZOOM, zoom))
        if abs(zoom - self._zoom) < 1e-9:
            return
        if anchor is None:
            anchor = QPointF(self.width() / 2, self.height() / 2)
        image_point = self._widget_to_image(anchor)
        self._zoom = zoom
        self._offset = QPointF(anchor.x() - image_point.x() * zoom,
                               anchor.y() - image_point.y() * zoom)
        self.zoomChanged.emit(self._zoom)
        self.update()

    def _center_image(self) -> None:
        if self._array is None:
            return
        h, w = self._array.shape
        self._offset = QPointF((self.width() - w * self._zoom) / 2,
                               (self.height() - h * self._zoom) / 2)

    def _widget_to_image(self, pos: QPointF) -> QPointF:
        if self._zoom <= 0:
            return QPointF(0, 0)
        return QPointF((pos.x() - self._offset.x()) / self._zoom,
                       (pos.y() - self._offset.y()) / self._zoom)

    def _image_to_widget(self, row: float, col: float) -> QPointF:
        return QPointF(self._offset.x() + col * self._zoom,
                       self._offset.y() + row * self._zoom)

    def _image_rect(self) -> QRectF:
        if self._array is None:
            return QRectF()
        h, w = self._array.shape
        return QRectF(self._offset, QSize(w * self._zoom, h * self._zoom))

    # ------------------------------------------------------------------ #
    # Rendering
    # ------------------------------------------------------------------ #
    def _rebuild(self) -> None:
        assert self._array is not None
        self._u8 = to_display_u8(self._array, *self._range)
        self._qimage = _qimage_gray(self._u8)

    def paintEvent(self, event) -> None:  # noqa: N802
        painter = QPainter(self)
        painter.fillRect(self.rect(), QColor(24, 26, 30))
        if self._qimage is None:
            painter.setPen(QColor(150, 155, 165))
            font = painter.font()
            font.setPointSize(13)
            painter.setFont(font)
            painter.drawText(self.rect(), Qt.AlignCenter, self._placeholder)
            painter.end()
            return
        target = self._image_rect()
        smooth = (not self._interpolation_nearest) or self._zoom < 1.0
        painter.setRenderHint(QPainter.SmoothPixmapTransform, smooth)
        painter.drawImage(target, self._qimage)
        if self._overlay is not None:
            painter.drawImage(target, self._overlay)

        # pixel grid at very high zoom
        if self._zoom >= 8:
            pen = QPen(QColor(255, 255, 255, 40))
            pen.setWidthF(0.5)
            painter.setPen(pen)
            h, w = self._array.shape
            visible = self._visible_pixel_bounds()
            step = 1
            for c in range(visible[0], visible[1] + 1, step):
                x = self._offset.x() + c * self._zoom
                painter.drawLine(QPointF(x, target.top()), QPointF(x, target.bottom()))
            for r in range(visible[2], visible[3] + 1, step):
                y = self._offset.y() + r * self._zoom
                painter.drawLine(QPointF(target.left(), y), QPointF(target.right(), y))

        if self._marker is not None:
            row, col = self._marker
            pen = QPen(QColor(255, 220, 90), 1.5)
            painter.setPen(pen)
            painter.setBrush(Qt.NoBrush)
            rect = QRectF(self._offset.x() + col * self._zoom,
                          self._offset.y() + row * self._zoom,
                          self._zoom, self._zoom)
            if rect.width() < 6:
                rect.adjust(-3, -3, 3, 3)
            painter.drawRect(rect)

        self._draw_scale_bar(painter)
        painter.end()

    def _draw_scale_bar(self, painter: QPainter) -> None:
        assert self._array is not None
        h, w = self._array.shape
        painter.setPen(QColor(210, 210, 220))
        text = f"{w} × {h} px · 缩放 {self._zoom * 100:.0f}%"
        font = painter.font()
        font.setPointSize(9)
        painter.setFont(font)
        painter.drawText(QRectF(8, 4, self.width() - 16, 20),
                         Qt.AlignLeft | Qt.AlignVCenter, text)

    def _visible_pixel_bounds(self) -> tuple[int, int, int, int]:
        assert self._array is not None
        h, w = self._array.shape
        p0 = self._widget_to_image(QPointF(0, 0))
        p1 = self._widget_to_image(QPointF(self.width(), self.height()))
        c0 = max(0, int(np.floor(p0.x())))
        c1 = min(w - 1, int(np.ceil(p1.x())))
        r0 = max(0, int(np.floor(p0.y())))
        r1 = min(h - 1, int(np.ceil(p1.y())))
        return c0, c1, r0, r1

    # ------------------------------------------------------------------ #
    # Events
    # ------------------------------------------------------------------ #
    def _pixel_at(self, pos: QPointF) -> tuple[int, int]:
        if self._array is None:
            return -1, -1
        h, w = self._array.shape
        p = self._widget_to_image(pos)
        col = int(np.floor(p.x()))
        row = int(np.floor(p.y()))
        if 0 <= row < h and 0 <= col < w:
            return row, col
        return -1, -1

    def mouseMoveEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        pos = event.position()
        if self._panning:
            delta = pos - QPointF(self._press_pos)
            if delta.manhattanLength() > 2:
                self._moved = True
            self._offset = self._press_offset + delta
            self.update()
            return
        row, col = self._pixel_at(pos)
        if (row, col) != self._cursor:
            self._cursor = (row, col)
            self.hovered.emit(row, col)

    def mousePressEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if event.button() in (Qt.LeftButton, Qt.MiddleButton):
            self._panning = True
            self._moved = False
            self._press_pos = event.position().toPoint()
            self._press_offset = QPointF(self._offset)
            if event.button() == Qt.MiddleButton:
                self.setCursor(Qt.ClosedHandCursor)
        super().mousePressEvent(event)

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if self._panning and event.button() in (Qt.LeftButton, Qt.MiddleButton):
            self._panning = False
            self.unsetCursor()
            if not self._moved and event.button() == Qt.LeftButton:
                row, col = self._pixel_at(event.position())
                if row >= 0:
                    self._marker = (row, col)
                    self.clicked.emit(row, col)
                    self.update()
        super().mouseReleaseEvent(event)

    def mouseDoubleClickEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if event.button() == Qt.LeftButton:
            self.fit_to_window()

    def wheelEvent(self, event: QWheelEvent) -> None:  # noqa: N802
        if self._array is None:
            return
        steps = event.angleDelta().y() / 120.0
        if steps == 0:
            return
        factor = 1.25 ** steps
        self.set_zoom(self._zoom * factor, event.position())

    def leaveEvent(self, event) -> None:  # noqa: N802
        if self._cursor != (-1, -1):
            self._cursor = (-1, -1)
            self.hovered.emit(-1, -1)
        super().leaveEvent(event)

    def resizeEvent(self, event) -> None:  # noqa: N802
        if self._fit_pending or self._array is None:
            self.fit_to_window()
        super().resizeEvent(event)


class HistogramWidget(QWidget):
    """Histogram of the current view; dragging handles edits the display window."""

    rangeEdited = Signal(float, float)
    autoRequested = Signal()

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setMinimumHeight(120)
        self.setMouseTracking(True)
        self._values: np.ndarray | None = None
        self._hist: np.ndarray | None = None
        self._edges: np.ndarray | None = None
        self._range = (0.0, 65535.0)
        self._display = (0.0, 65535.0)
        self._drag: str | None = None
        self._sat_count = 0
        self._sat_label = "饱和像素"
        self._valid_count = 0
        self._percentiles: tuple[float, float, float] = (0.0, 0.0, 0.0)

    def set_data(self, values: np.ndarray, valid: np.ndarray | None,
                 display_range: tuple[float, float]) -> None:
        finite = np.isfinite(values)
        if valid is not None:
            finite &= valid
        data = values[finite]
        self._valid_count = int(data.size)
        if data.size == 0:
            self._values = self._hist = self._edges = None
            self._range = display_range
            self._display = display_range
            self.update()
            return
        lo = float(data.min())
        hi = float(data.max())
        if hi <= lo:
            hi = lo + 1.0
        self._range = (lo, hi)
        self._display = (max(lo, display_range[0]), min(hi, display_range[1]))
        if self._display[1] <= self._display[0]:
            self._display = (lo, hi)
        bins = 256
        hist, edges = np.histogram(data, bins=bins, range=(lo, hi))
        self._hist = hist.astype(np.float64)
        self._edges = edges.astype(np.float64)
        p1, p50, p99 = np.percentile(data, [1, 50, 99])
        self._percentiles = (float(p1), float(p50), float(p99))
        self._values = data
        self.update()

    def display_range(self) -> tuple[float, float]:
        return self._display

    def set_display_range(self, lo: float, hi: float) -> None:
        if self._range[1] <= self._range[0]:
            return
        lo = max(self._range[0], min(lo, self._range[1]))
        hi = max(self._range[0], min(hi, self._range[1]))
        if hi <= lo:
            return
        self._display = (lo, hi)
        self.update()

    # -- painting ------------------------------------------------------- #
    def paintEvent(self, event) -> None:  # noqa: N802
        painter = QPainter(self)
        painter.fillRect(self.rect(), QColor(30, 32, 38))
        rect = self._plot_rect()
        painter.setPen(QColor(90, 95, 105))
        painter.drawRect(rect)
        if self._hist is None:
            painter.setPen(QColor(150, 155, 165))
            painter.drawText(self.rect(), Qt.AlignCenter, "暂无有效像素")
            painter.end()
            return

        assert self._edges is not None and self._hist is not None
        lo, hi = self._range
        display_lo, display_hi = self._display
        max_count = max(float(self._hist.max()), 1.0)
        bw = rect.width() / self._hist.size

        # shaded region outside display window
        x_lo = rect.left() + (display_lo - lo) / (hi - lo) * rect.width()
        x_hi = rect.left() + (display_hi - lo) / (hi - lo) * rect.width()
        painter.fillRect(QRectF(rect.left(), rect.top(), max(0.0, x_lo - rect.left()),
                                rect.height()), QColor(0, 0, 0, 80))
        painter.fillRect(QRectF(x_hi, rect.top(), max(0.0, rect.right() - x_hi),
                                rect.height()), QColor(0, 0, 0, 80))

        path = QPainterPath()
        path.moveTo(rect.left(), rect.bottom())
        log_scale = np.log1p(self._hist) / np.log1p(max_count)
        for i, value in enumerate(log_scale):
            x = rect.left() + i * bw
            y = rect.bottom() - float(value) * (rect.height() - 12)
            path.lineTo(x, y)
        path.lineTo(rect.right(), rect.bottom())
        path.closeSubpath()
        painter.setPen(QPen(QColor(120, 185, 255), 1.0))
        painter.setBrush(QColor(58, 118, 180, 150))
        painter.drawPath(path)

        # median marker
        med = self._percentiles[1]
        if hi > lo:
            xm = rect.left() + (med - lo) / (hi - lo) * rect.width()
            painter.setPen(QPen(QColor(255, 210, 120), 1, Qt.DashLine))
            painter.drawLine(QPointF(xm, rect.top()), QPointF(xm, rect.bottom()))

        # group separator marker (saturated pixels are counted separately)
        if self._sat_count:
            painter.setPen(QColor(255, 90, 90))
            painter.drawText(QRectF(rect.left(), rect.top(), rect.width(), 18),
                             Qt.AlignRight | Qt.AlignTop,
                             f"{self._sat_label} {self._sat_count:,} px 未计入")
        painter.setPen(QColor(190, 195, 205))
        font = painter.font()
        font.setPointSize(9)
        painter.setFont(font)
        painter.drawText(QRectF(rect.left(), rect.bottom() + 2, rect.width(), 16),
                         Qt.AlignLeft, f"{lo:.0f}")
        painter.drawText(QRectF(rect.left(), rect.bottom() + 2, rect.width(), 16),
                         Qt.AlignRight, f"{hi:.0f}")
        painter.drawText(QRectF(rect.left(), rect.bottom() + 2, rect.width(), 16),
                         Qt.AlignHCenter, f"显示 {display_lo:.0f} – {display_hi:.0f}")

        # handles
        for x in (x_lo, x_hi):
            painter.setPen(QPen(QColor(255, 255, 255, 220), 1.5))
            painter.drawLine(QPointF(x, rect.top()), QPointF(x, rect.bottom()))
            painter.setBrush(QColor(255, 255, 255, 220))
            painter.drawRect(QRectF(x - 3, rect.top() - 1, 6, 6))
            painter.drawRect(QRectF(x - 3, rect.bottom() - 5, 6, 6))
        painter.end()

    def set_saturation_count(self, count: int, label: str = "饱和像素") -> None:
        self._sat_count = int(count)
        self._sat_label = label
        self.update()

    def _plot_rect(self) -> QRectF:
        return QRectF(self.rect().adjusted(8, 8, -8, -22))

    # -- interaction ---------------------------------------------------- #
    def _x_to_value(self, x: float) -> float:
        rect = self._plot_rect()
        lo, hi = self._range
        t = (x - rect.left()) / max(rect.width(), 1.0)
        return float(lo + np.clip(t, 0.0, 1.0) * (hi - lo))

    def _handle_x(self, which: float) -> float:
        rect = self._plot_rect()
        lo, hi = self._range
        return rect.left() + (which - lo) / max(hi - lo, 1e-9) * rect.width()

    def mousePressEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if self._hist is None:
            return
        x = event.position().x()
        lo_x = self._handle_x(self._display[0])
        hi_x = self._handle_x(self._display[1])
        if abs(x - lo_x) <= 6:
            self._drag = "lo"
        elif abs(x - hi_x) <= 6:
            self._drag = "hi"
        elif x < lo_x:
            self._drag = "lo"
            self._set_handle("lo", x)
        elif x > hi_x:
            self._drag = "hi"
            self._set_handle("hi", x)

    def mouseMoveEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if self._drag is None:
            return
        self._set_handle(self._drag, event.position().x())

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        self._drag = None

    def mouseDoubleClickEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if self._hist is not None:
            self._display = self._range
            self.rangeEdited.emit(*self._display)
            self.update()

    def _set_handle(self, which: str, x: float) -> None:
        value = self._x_to_value(x)
        lo, hi = self._display
        if which == "lo":
            lo = min(value, hi - 1e-3)
        else:
            hi = max(value, lo + 1e-3)
        self._display = (float(lo), float(hi))
        self.rangeEdited.emit(*self._display)
        self.update()


class ProfilesWidget(QWidget):
    """Center vs edge numeric profiles for the horizontal and vertical axes."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setMinimumHeight(180)
        self.setMouseTracking(True)
        self._profiles: list[Profile] = []
        self._reference: list[Profile] = []
        self._hover_col: float | None = None
        self._colors = [QColor(120, 190, 255), QColor(255, 170, 90),
                        QColor(150, 230, 160), QColor(230, 140, 220)]

    def set_profiles(self, profiles: Iterable[Profile],
                     reference: Iterable[Profile] | None = None) -> None:
        self._profiles = [p for p in profiles if p.x.size]
        self._reference = [p for p in reference if p.x.size] if reference else []
        self.update()

    def _draw_series(self, painter: QPainter, profiles: list[Profile],
                     rect: QRectF, lo: float, hi: float, max_len: int,
                     alpha: int = 255, dashed: bool = False) -> None:
        painter.save()
        painter.setClipRect(rect)
        for i, profile in enumerate(profiles):
            color = self._colors[i % len(self._colors)]
            color = QColor(color.red(), color.green(), color.blue(), alpha)
            n = profile.y.size
            xs = profile.x.astype(np.float64)
            ys = profile.y.astype(np.float64)
            finite = np.isfinite(ys)
            if not finite.any():
                continue
            step = max(1, int(np.ceil(n / max(rect.width(), 1))))
            xs, ys, finite = xs[::step], ys[::step], finite[::step]
            nx = xs / max(max_len - 1, 1)
            ny = (ys - lo) / (hi - lo)
            path = QPainterPath()
            started = False
            for xv, yv, ok in zip(rect.left() + nx * rect.width(),
                                  rect.bottom() - ny * rect.height(), finite):
                if not ok:
                    started = False
                    continue
                if started:
                    path.lineTo(xv, yv)
                else:
                    path.moveTo(xv, yv)
                    started = True
            pen = QPen(color, 1.0 if dashed else 1.2)
            if dashed:
                pen.setStyle(Qt.DashLine)
            painter.setPen(pen)
            painter.drawPath(path)
            level = profile.median if np.isfinite(profile.median) else profile.mean
            if not dashed and np.isfinite(level):
                ym = rect.bottom() - (level - lo) / (hi - lo) * rect.height()
                p = QPen(QColor(color.red(), color.green(), color.blue(), 80), 1,
                         Qt.DashLine)
                painter.setPen(p)
                painter.drawLine(QPointF(rect.left(), ym), QPointF(rect.right(), ym))
        painter.restore()

    def paintEvent(self, event) -> None:  # noqa: N802
        painter = QPainter(self)
        painter.fillRect(self.rect(), QColor(30, 32, 38))
        font = painter.font()
        font.setPointSize(9)
        painter.setFont(font)
        if not self._profiles:
            painter.setPen(QColor(150, 155, 165))
            painter.drawText(self.rect(), Qt.AlignCenter,
                             "暂无剖面。导入参考图并生成校正结果后显示中心/边缘剖面。")
            painter.end()
            return
        rect = QRectF(self.rect().adjusted(42, 22, -10, -32))
        # scale to the data being examined; the dashed reference stays relative
        all_values = np.concatenate([p.y[np.isfinite(p.y)] for p in self._profiles
                                     if np.isfinite(p.y).any()])
        if all_values.size == 0:
            painter.end()
            return
        lo = float(all_values.min())
        hi = float(all_values.max())
        if hi <= lo:
            hi = lo + 1.0
        pad = (hi - lo) * 0.08
        lo -= pad
        hi += pad

        painter.setPen(QColor(70, 74, 84))
        painter.drawRect(rect)
        for frac in (0.25, 0.5, 0.75):
            y = rect.bottom() - frac * rect.height()
            painter.setPen(QPen(QColor(60, 64, 74), 1, Qt.DotLine))
            painter.drawLine(QPointF(rect.left(), y), QPointF(rect.right(), y))
        for frac in (0.25, 0.5, 0.75):
            x = rect.left() + frac * rect.width()
            painter.setPen(QPen(QColor(60, 64, 74), 1, Qt.DotLine))
            painter.drawLine(QPointF(x, rect.top()), QPointF(x, rect.bottom()))

        painter.setPen(QColor(170, 176, 188))
        painter.drawText(QRectF(2, rect.top() - 12, 40, 14), Qt.AlignRight, f"{hi:.0f}")
        painter.drawText(QRectF(2, rect.bottom() - 6, 40, 14), Qt.AlignRight, f"{lo:.0f}")
        max_len = max(p.x.size for p in self._profiles + self._reference)

        self._draw_series(painter, self._reference, rect, lo, hi, max_len,
                          alpha=110, dashed=True)
        self._draw_series(painter, self._profiles, rect, lo, hi, max_len)

        # legend (two lines: current data, then dashed reference)
        x = rect.left()
        for i, profile in enumerate(self._profiles):
            color = self._colors[i % len(self._colors)]
            painter.setPen(color)
            painter.drawText(QRectF(x, 2, 220, 16), Qt.AlignLeft | Qt.AlignVCenter,
                             f"{profile.name}  中位 {profile.median:.1f}")
            x += 225
            if x > rect.right() - 120:
                break
        if self._reference:
            painter.setPen(QColor(170, 176, 188))
            painter.drawText(
                QRectF(rect.left(), rect.bottom() + 14, rect.width(), 16),
                Qt.AlignRight,
                "虚线 = 亮场参考")
        painter.setPen(QColor(120, 126, 138))
        painter.drawText(QRectF(rect.left(), rect.bottom() + 14, rect.width() * 0.4, 16),
                         Qt.AlignLeft, "像素索引 →")
        painter.end()

    def mouseMoveEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        rect = QRectF(self.rect().adjusted(42, 22, -10, -32))
        if rect.contains(event.position()):
            self._hover_col = event.position().x()
        else:
            self._hover_col = None
        self.update()

    def leaveEvent(self, event) -> None:  # noqa: N802
        self._hover_col = None
        self.update()
        super().leaveEvent(event)


class Thumbnail(QWidget):
    """Small preview with red saturation overlay, used in group headers."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setFixedSize(180, 110)
        self._pixmap: QPixmap | None = None
        self._message = "无数据"

    def set_frame_preview(self, data: np.ndarray | None,
                          highlight: np.ndarray | None = None) -> None:
        """Percentile-stretched preview of one frame, auto-highlighting saturation."""
        if data is None:
            self.set_preview(None, None, None)
            return
        finite = np.isfinite(data)
        values = data[finite]
        lo, hi = (np.percentile(values, [1, 99]) if values.size else (0.0, 1.0))
        u8 = to_display_u8(data, float(lo), float(max(hi, lo + 1e-6)))
        rgba = np.dstack([u8, u8, u8, np.full_like(u8, 255)])
        mask = highlight if highlight is not None else (data >= 65535)
        if mask is not None and mask.any():
            rgba[mask] = [255, 70, 70, 255]
        rgba = np.ascontiguousarray(rgba)
        image = QImage(rgba.data, data.shape[1], data.shape[0],
                       data.shape[1] * 4, QImage.Format_RGBA8888).copy()
        self._pixmap = QPixmap.fromImage(image)
        self._message = ""
        self.update()

    def set_preview(self, data: np.ndarray | None, valid: np.ndarray | None,
                    highlight: np.ndarray | None) -> None:
        if data is None:
            self._pixmap = None
            self._message = "无数据"
            self.update()
            return
        h, w = data.shape
        finite = np.isfinite(data)
        values = data[finite]
        if values.size:
            lo, hi = np.percentile(values, [1, 99])
        else:
            lo, hi = 0.0, 1.0
        if hi <= lo:
            hi = lo + 1.0
        u8 = to_display_u8(data, lo, hi)
        rgba = np.dstack([u8, u8, u8, np.full_like(u8, 255)])
        if valid is not None:
            rgba[~valid, 3] = 255
            rgba[~valid, :3] = (rgba[~valid, :3] * 0.35).astype(np.uint8)
        if highlight is not None and highlight.any():
            rgba[highlight] = [255, 70, 70, 255]
        rgba = np.ascontiguousarray(rgba)
        img = QImage(rgba.data, w, h, w * 4, QImage.Format_RGBA8888).copy()
        self._pixmap = QPixmap.fromImage(img)
        self.update()

    def paintEvent(self, event) -> None:  # noqa: N802
        painter = QPainter(self)
        painter.fillRect(self.rect(), QColor(22, 24, 28))
        if self._pixmap is None:
            painter.setPen(QColor(120, 125, 135))
            painter.drawText(self.rect(), Qt.AlignCenter, self._message)
        else:
            scaled = self._pixmap.scaled(self.size(), Qt.KeepAspectRatio,
                                         Qt.SmoothTransformation)
            x = (self.width() - scaled.width()) // 2
            y = (self.height() - scaled.height()) // 2
            painter.drawPixmap(x, y, scaled)
        painter.end()


class ElidedLabel(QLabel):
    """QLabel that elides its text instead of forcing the toolbar wider."""

    def __init__(self, text: str = "", parent: QWidget | None = None) -> None:
        super().__init__(text, parent)
        self._full = text
        self.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Preferred)
        self.setMinimumWidth(60)
        self.setTextInteractionFlags(Qt.TextSelectableByMouse)

    def setText(self, text: str) -> None:  # noqa: N802
        self._full = text or ""
        self.setToolTip(self._full)
        self._apply()

    def fullText(self) -> str:  # noqa: N802
        return self._full

    def _apply(self) -> None:
        metrics = self.fontMetrics()
        super().setText(metrics.elidedText(self._full, Qt.ElideRight,
                                           max(1, self.width() - 4)))

    def resizeEvent(self, event) -> None:  # noqa: N802
        super().resizeEvent(event)
        self._apply()
