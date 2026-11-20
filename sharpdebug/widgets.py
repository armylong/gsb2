"""Custom Qt widgets: zoomable image canvas, fixed-scale pixel profile plot,
and a small curve plot.  Kept free of pipeline logic so it can be tested
head-less with the offscreen platform."""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from PySide6.QtCore import QPointF, QRectF, QSize, Qt, Signal
from PySide6.QtGui import (
    QColor,
    QFont,
    QImage,
    QPainter,
    QPainterPath,
    QPen,
    QPolygonF,
)
from PySide6.QtWidgets import QSizePolicy, QWidget

from .core import to_display_rgb

# ---------------------------------------------------------------------------
# palette
# ---------------------------------------------------------------------------
BG = QColor(22, 24, 29)
PANEL = QColor(31, 35, 43)
GRID = QColor(52, 58, 70)
TEXT = QColor(216, 222, 233)
MUTED = QColor(140, 150, 166)
ACCENT = QColor(90, 176, 255)
OVER = QColor(255, 92, 92)
UNDER = QColor(86, 156, 255)
CH_R = QColor(255, 107, 107)
CH_G = QColor(107, 220, 138)
CH_B = QColor(102, 170, 255)
BASE_C = QColor(160, 168, 180)


def rgb_to_qimage(rgb_u8: np.ndarray) -> QImage:
    a = np.ascontiguousarray(rgb_u8, dtype=np.uint8)
    h, w = a.shape[:2]
    if a.ndim == 2:
        a = np.repeat(a[..., None], 3, axis=-1)
        a = np.ascontiguousarray(a)
    img = QImage(a.data, w, h, 3 * w, QImage.Format_RGB888).copy()
    return img


def compose_overlay(
    rgb_float: np.ndarray,
    overlays: list[tuple[np.ndarray, tuple[float, float, float], float]] | None,
) -> np.ndarray:
    """Blend fixed-colour masks over the (already display-clipped) image.

    No rescaling of the base image happens here; the image is simply clipped
    to [0,1] for 8-bit display, and the overlay is drawn on top.
    """
    out = to_display_rgb(rgb_float).astype(np.float64) / 255.0
    if not overlays:
        return out
    for mask, colour, alpha in overlays:
        m = np.asarray(mask, dtype=np.float64)
        if m.ndim == 3:
            m = m.max(axis=-1)
        m = np.clip(m, 0.0, 1.0)[..., None] * float(alpha)
        c = np.asarray(colour, dtype=np.float64)
        out = out * (1.0 - m) + c * m
    return np.clip(out, 0.0, 1.0)


# ---------------------------------------------------------------------------
# Image canvas
# ---------------------------------------------------------------------------


class ImageCanvas(QWidget):
    """Displays an RGB image with fit/zoom/pan and an optional profile line.

    - wheel: zoom around cursor
    - right/middle drag: pan
    - left drag when ``line_mode``: set the profile line
    - double click: fit
    """

    lineChanged = Signal(QPointF, QPointF)
    hoverMoved = Signal(float, float)   # image pixel coords
    viewChanged = Signal(float)         # zoom relative to fit

    def __init__(self, title: str = "", line_mode: bool = False, parent=None):
        super().__init__(parent)
        self.title = title
        self.line_mode = line_mode
        self._qimg: QImage | None = None
        self._img_size = QSize(1, 1)
        self._zoom = 1.0
        self._pan = QPointF(0, 0)
        self._line: tuple[QPointF, QPointF] | None = None
        self._drag_line_start: QPointF | None = None
        self._pan_start: QPointF | None = None
        self._pan_origin = QPointF(0, 0)
        self._hover: QPointF | None = None
        self._hover_text = ""
        self.info = ""
        self.legend = ""
        self.setMinimumSize(220, 170)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)
        self.setMouseTracking(True)
        self.setFocusPolicy(Qt.StrongFocus)
        self.setToolTip(
            "滚轮缩放 · 右键拖动平移 · 双击适应窗口"
            + (" · 左键拖动设置剖面线" if line_mode else "")
        )

    # -- public API --------------------------------------------------------
    def set_image(self, rgb_float: np.ndarray, info: str = "", legend: str = "") -> None:
        if rgb_float.ndim == 2:
            rgb_float = np.repeat(rgb_float[..., None], 3, axis=-1)
        self._qimg = rgb_to_qimage(to_display_rgb(rgb_float))
        self._img_size = QSize(self._qimg.width(), self._qimg.height())
        self.info = info
        self.legend = legend
        self.update()

    def set_qimage(self, qimg: QImage, info: str = "", legend: str = "") -> None:
        self._qimg = qimg
        self._img_size = QSize(qimg.width(), qimg.height())
        self.info = info
        self.legend = legend
        self.update()

    def set_line(self, p0: tuple[float, float], p1: tuple[float, float]) -> None:
        self._line = (QPointF(*p0), QPointF(*p1))
        self.update()

    def set_title(self, title: str) -> None:
        self.title = title
        self.update()

    def fit(self) -> None:
        self._zoom = 1.0
        self._pan = QPointF(0, 0)
        self.viewChanged.emit(1.0)
        self.update()

    # -- geometry helpers --------------------------------------------------
    def _fit_scale(self) -> float:
        if self._img_size.width() <= 0 or self._img_size.height() <= 0:
            return 1.0
        return min(
            (self.width() - 12) / self._img_size.width(),
            (self.height() - 12) / self._img_size.height(),
        )

    def _scale(self) -> float:
        return self._fit_scale() * self._zoom

    def _origin(self) -> QPointF:
        s = self._scale()
        return QPointF(
            (self.width() - self._img_size.width() * s) / 2 + self._pan.x(),
            (self.height() - self._img_size.height() * s) / 2 + self._pan.y(),
        )

    def widget_to_image(self, pt: QPointF) -> QPointF:
        s = max(self._scale(), 1e-9)
        o = self._origin()
        return QPointF((pt.x() - o.x()) / s, (pt.y() - o.y()) / s)

    def image_to_widget(self, pt: QPointF) -> QPointF:
        s = self._scale()
        o = self._origin()
        return QPointF(o.x() + pt.x() * s, o.y() + pt.y() * s)

    # -- events ------------------------------------------------------------
    def wheelEvent(self, ev) -> None:
        if self._qimg is None:
            return
        before = self.widget_to_image(ev.position())
        factor = 1.25 if ev.angleDelta().y() > 0 else 1 / 1.25
        self._zoom = float(np.clip(self._zoom * factor, 0.2, 24.0))
        after = self.widget_to_image(ev.position())
        s = self._scale()
        self._pan += QPointF(
            (after.x() - before.x()) * s, (after.y() - before.y()) * s
        )
        self.viewChanged.emit(self._zoom)
        self.update()

    def mousePressEvent(self, ev) -> None:
        pos = ev.position()
        if ev.button() in (Qt.RightButton, Qt.MiddleButton):
            self._pan_start = pos
            self._pan_origin = QPointF(self._pan)
            self.setCursor(Qt.ClosedHandCursor)
        elif ev.button() == Qt.LeftButton and self.line_mode and self._qimg is not None:
            ip = self.widget_to_image(pos)
            self._drag_line_start = self._clamp_img(ip)
            self._line = (self._drag_line_start, self._drag_line_start)
            self.lineChanged.emit(*self._line)
            self.update()

    def mouseMoveEvent(self, ev) -> None:
        pos = ev.position()
        if self._pan_start is not None:
            self._pan = self._pan_origin + (pos - self._pan_start)
            self.update()
            return
        if self._drag_line_start is not None:
            ip = self._clamp_img(self.widget_to_image(pos))
            self._line = (self._drag_line_start, ip)
            self.lineChanged.emit(*self._line)
            self.update()
            return
        if self._qimg is not None:
            ip = self.widget_to_image(pos)
            self._hover = ip
            inside = 0 <= ip.x() < self._img_size.width() and 0 <= ip.y() < self._img_size.height()
            self._hover_text = (
                f"x={ip.x():.1f}  y={ip.y():.1f}"
                if inside
                else ""
            )
            self.hoverMoved.emit(ip.x(), ip.y())
            self.update()

    def mouseReleaseEvent(self, ev) -> None:
        if ev.button() in (Qt.RightButton, Qt.MiddleButton):
            self._pan_start = None
            self.unsetCursor()
        elif ev.button() == Qt.LeftButton and self._drag_line_start is not None:
            self._drag_line_start = None
            self.unsetCursor()
            if self._line is not None:
                self.lineChanged.emit(*self._line)

    def mouseDoubleClickEvent(self, ev) -> None:
        self.fit()

    def _clamp_img(self, pt: QPointF) -> QPointF:
        return QPointF(
            float(np.clip(pt.x(), 0, self._img_size.width() - 1)),
            float(np.clip(pt.y(), 0, self._img_size.height() - 1)),
        )

    # -- painting ----------------------------------------------------------
    def paintEvent(self, ev) -> None:
        p = QPainter(self)
        p.fillRect(self.rect(), BG)
        if self._qimg is None:
            p.setPen(MUTED)
            p.drawText(self.rect(), Qt.AlignCenter, "无图像")
            return
        s = self._scale()
        o = self._origin()
        target = QRectF(
            o.x(), o.y(), self._img_size.width() * s, self._img_size.height() * s
        )
        p.setRenderHint(QPainter.SmoothPixmapTransform, s < 1.0)
        p.drawImage(target, self._qimg)
        p.setRenderHint(QPainter.SmoothPixmapTransform, True)
        p.setPen(QPen(GRID, 1))
        p.drawRect(target)

        if self._line is not None:
            # convert line endpoint indices to widget coordinates
            a = self._line[0]
            b = self._line[1]
            wa = self.image_to_widget(a)
            wb = self.image_to_widget(b)
            p.setPen(QPen(QColor(255, 214, 90), 1.6, Qt.DashLine))
            p.drawLine(wa, wb)
            p.setBrush(QColor(255, 214, 90))
            p.setPen(Qt.NoPen)
            for w in (wa, wb):
                p.drawEllipse(w, 4.0, 4.0)

        # HUD
        p.setPen(TEXT)
        f = QFont()
        f.setPointSize(9)
        f.setBold(True)
        p.setFont(f)
        p.fillRect(QRectF(0, 0, self.width(), 24), QColor(22, 24, 29, 205))
        p.drawText(QRectF(8, 0, self.width() - 16, 24), Qt.AlignVCenter | Qt.AlignLeft, self.title)

        f2 = QFont()
        f2.setPointSize(8)
        p.setFont(f2)
        p.setPen(MUTED)
        right = f"缩放 {self._zoom * 100:.0f}%  {self._hover_text}"
        p.drawText(
            QRectF(8, 0, self.width() - 16, 24),
            Qt.AlignVCenter | Qt.AlignRight,
            right,
        )
        if self.info:
            p.fillRect(
                QRectF(0, self.height() - 22, self.width(), 22),
                QColor(22, 24, 29, 205),
            )
            p.setPen(TEXT)
            p.drawText(
                QRectF(8, self.height() - 22, self.width() - 16, 22),
                Qt.AlignVCenter | Qt.AlignLeft,
                self.info,
            )
        if self.legend:
            p.setPen(MUTED)
            p.drawText(
                QRectF(8, 26, self.width() - 16, 18),
                Qt.AlignLeft | Qt.AlignVCenter,
                self.legend,
            )


# ---------------------------------------------------------------------------
# Pixel profile plot (fixed Y, never auto-stretched)
# ---------------------------------------------------------------------------

Y_PRESETS: dict[str, tuple[float, float]] = {
    "固定 −0.25 … 1.25": (-0.25, 1.25),
    "固定 −0.60 … 1.60": (-0.60, 1.60),
    "固定 −0.05 … 1.05": (-0.05, 1.05),
}


class ProfilePlot(QWidget):
    """Line-profile plot with an explicit, fixed Y axis.

    The whole point is that values are *not* normalised to the data: the Y
    axis is chosen from one of the fixed presets and out-of-range values are
    drawn clipped at the border with numeric annotations, so overshoot and
    undershoot can be read in real units.
    """

    def __init__(self, parent=None):
        super().__init__(parent)
        self._dist: np.ndarray | None = None
        self._base: np.ndarray | None = None
        self._result: np.ndarray | None = None  # Nx3 luma channels
        self._channels = False
        self.y_range = Y_PRESETS["固定 −0.25 … 1.25"]
        self.title = "像素剖面"
        self.subtitle = "Y 轴固定，未自动拉伸"
        self._notes: list[str] = []
        self.setMinimumSize(260, 200)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)

    def set_data(
        self,
        dist: np.ndarray,
        base_luma: np.ndarray,
        result_rgb: np.ndarray,
        channels: bool = False,
        title: str = "像素剖面",
    ) -> None:
        self._dist = np.asarray(dist, dtype=np.float64)
        self._base = np.asarray(base_luma, dtype=np.float64)
        self._result = np.asarray(result_rgb, dtype=np.float64)
        self._channels = channels
        self.title = title
        self.update()

    def set_y_preset(self, name: str) -> None:
        if name in Y_PRESETS:
            self.y_range = Y_PRESETS[name]
            self.update()

    @property
    def y_limits(self) -> tuple[float, float]:
        return self.y_range

    def _stats(self) -> tuple[float, float, float, float]:
        if self._result is None or self._result.size == 0:
            return 0.0, 0.0, 0.0, 0.0
        luma = self._result @ np.array([0.2126, 0.7152, 0.0722])
        over = float(np.max(luma) - 1.0)
        under = float(0.0 - np.min(luma))
        return float(luma.max()), float(luma.min()), over, under

    def set_notes(self, notes: list[str]) -> None:
        """Extra numeric lines drawn under the title (e.g. full-image overshoot).

        Kept separate from the curve annotation so a local profile of a smooth
        region cannot be mistaken for "no overshoot anywhere".
        """
        self._notes = list(notes)
        self.update()

    def paintEvent(self, ev) -> None:
        p = QPainter(self)
        p.fillRect(self.rect(), PANEL)
        p.setRenderHint(QPainter.Antialiasing, True)
        L, R, B = 58, 16, 34
        # -- legend layout first: it decides how tall the header must be -----
        items = [("结果亮度", QColor(245, 248, 255)), ("原图亮度", BASE_C)]
        if self._channels:
            items += [("R", CH_R), ("G", CH_G), ("B", CH_B)]
        avail = max(60, self.width() - L - R)
        per_item = 70
        cols = max(1, int(avail // per_item))
        rows = (len(items) + cols - 1) // cols
        notes = getattr(self, "_notes", [])
        legend_top = 40 + 15 * len(notes)
        T = legend_top + rows * 15 + 4
        plot = QRectF(L, T, max(10, self.width() - L - R), max(10, self.height() - T - B))
        ymin, ymax = self.y_range

        p.setPen(TEXT)
        f = QFont()
        f.setPointSize(9)
        f.setBold(True)
        p.setFont(f)
        p.drawText(QRectF(10, 4, self.width() - 20, 18), Qt.AlignLeft, self.title)
        f2 = QFont()
        f2.setPointSize(8)
        p.setFont(f2)
        p.setPen(MUTED)
        p.drawText(
            QRectF(10, 22, self.width() - 20, 16),
            Qt.AlignLeft,
            "Y 轴 " + f"[{ymin:.2f}, {ymax:.2f}] 固定，不做自动拉伸",
        )
        for i, line in enumerate(notes):
            p.setPen(QColor(255, 190, 120) if "全图" in line else MUTED)
            p.drawText(
                QRectF(10, 40 + i * 15, self.width() - 20, 15),
                Qt.AlignLeft,
                line,
            )
        for i, (name, col) in enumerate(items):
            r, c = divmod(i, cols)
            x = 10 + c * per_item
            y = legend_top + r * 15
            p.setPen(QPen(col, 2))
            p.drawLine(QPointF(x, y + 7), QPointF(x + 14, y + 7))
            p.setPen(MUTED)
            p.drawText(QRectF(x + 17, y, per_item - 20, 15), Qt.AlignLeft, name)

        if self._dist is None or self._result is None or self._dist.size == 0:
            p.setPen(MUTED)
            p.drawText(plot, Qt.AlignCenter, "拖动图像上的黄色剖面线以采样")
            return

        xmin = float(self._dist.min())
        xmax = float(self._dist.max())
        if xmax <= xmin:
            xmax = xmin + 1.0

        def sx(x: float) -> float:
            return plot.left() + (x - xmin) / (xmax - xmin) * plot.width()

        def sy(y: float) -> float:
            return plot.bottom() - (y - ymin) / (ymax - ymin) * plot.height()

        p.setPen(QPen(GRID, 1))
        p.setBrush(Qt.NoBrush)
        p.drawRect(plot)
        # grid + ticks
        n_y = 6
        for i in range(n_y + 1):
            y = ymin + (ymax - ymin) * i / n_y
            yy = sy(y)
            p.setPen(QPen(GRID, 1, Qt.DotLine))
            p.drawLine(QPointF(plot.left(), yy), QPointF(plot.right(), yy))
            p.setPen(MUTED)
            p.drawText(
                QRectF(0, yy - 8, L - 6, 16), Qt.AlignRight | Qt.AlignVCenter, f"{y:.2f}"
            )
        n_x = 5
        for i in range(n_x + 1):
            x = xmin + (xmax - xmin) * i / n_x
            xx = sx(x)
            p.setPen(QPen(GRID, 1, Qt.DotLine))
            p.drawLine(QPointF(xx, plot.top()), QPointF(xx, plot.bottom()))
            p.setPen(MUTED)
            p.drawText(
                QRectF(xx - 40, plot.bottom() + 4, 80, 16),
                Qt.AlignHCenter | Qt.AlignTop,
                f"{x:.0f}",
            )
        p.setPen(MUTED)
        p.drawText(
            QRectF(plot.left(), plot.bottom() + 18, plot.width(), 16),
            Qt.AlignRight | Qt.AlignTop,
            "沿线像素距离 (px)",
        )

        # 0 / 1 reference lines
        for val, col, label in ((1.0, QColor(255, 180, 90), "1.0"), (0.0, QColor(255, 180, 90), "0.0")):
            if ymin <= val <= ymax:
                p.setPen(QPen(col, 1.2, Qt.DashLine))
                p.drawLine(QPointF(plot.left(), sy(val)), QPointF(plot.right(), sy(val)))
                p.setPen(col)
                p.drawText(QRectF(plot.right() - 30, sy(val) - 16, 30, 14), Qt.AlignRight, label)

        luma = self._result @ np.array([0.2126, 0.7152, 0.0722])

        # shade overshoot / undershoot regions (using result luma).
        # Clip to the plot rect: values beyond the fixed axis must not paint
        # over the tick labels - they are reported numerically instead.
        p.save()
        p.setClipRect(plot)
        p.setPen(Qt.NoPen)
        for i in range(len(luma) - 1):
            for arr, limit, col in ((luma, 1.0, QColor(255, 92, 92, 70)), (luma, 0.0, QColor(86, 156, 255, 70))):
                a, b = arr[i], arr[i + 1]
                if limit == 1.0:
                    hi_a, hi_b = a > 1.0, b > 1.0
                else:
                    hi_a, hi_b = a < 0.0, b < 0.0
                if hi_a or hi_b:
                    va = a if hi_a else limit
                    vb = b if hi_b else limit
                    poly = QPolygonF(
                        [
                            QPointF(sx(self._dist[i]), sy(va)),
                            QPointF(sx(self._dist[i]), sy(limit)),
                            QPointF(sx(self._dist[i + 1]), sy(limit)),
                            QPointF(sx(self._dist[i + 1]), sy(vb)),
                        ]
                    )
                    p.setBrush(col)
                    p.drawPolygon(poly)
        p.setBrush(Qt.NoBrush)
        p.restore()

        # base luma (dashed)
        if self._base is not None and self._base.size == len(self._dist):
            path = QPainterPath()
            for i, (x, y) in enumerate(zip(self._dist, self._base)):
                pt = QPointF(sx(x), sy(float(np.clip(y, ymin, ymax))))
                path.moveTo(pt) if i == 0 else path.lineTo(pt)
            p.setPen(QPen(BASE_C, 1.1, Qt.DashLine))
            p.drawPath(path)

        # channels
        if self._channels:
            names = [("R", CH_R), ("G", CH_G), ("B", CH_B)]
            for ci, (_, col) in enumerate(names):
                path = QPainterPath()
                for i, x in enumerate(self._dist):
                    y = float(np.clip(self._result[i, ci], ymin, ymax))
                    pt = QPointF(sx(x), sy(y))
                    path.moveTo(pt) if i == 0 else path.lineTo(pt)
                p.setPen(QPen(col, 1.0))
                p.drawPath(path)

        # result luma (thick).  Values outside the fixed axis are clamped to the
        # plot border (visible as a flat line on the frame) and are reported
        # numerically in the annotations below - never rescaled.
        p.save()
        p.setClipRect(plot)
        path = QPainterPath()
        for i, x in enumerate(self._dist):
            y = float(np.clip(luma[i], ymin, ymax))
            pt = QPointF(sx(x), sy(y))
            path.moveTo(pt) if i == 0 else path.lineTo(pt)
        p.setPen(QPen(QColor(245, 248, 255), 1.8))
        p.drawPath(path)
        p.restore()

        # numeric annotations (actual, not clipped), on their own line
        vmax, vmin, over, under = self._stats()
        p.setFont(f2)
        ann = (
            f"超白(>1.0) +{max(over, 0):.4f}   欠黑(<0.0) −{max(under, 0):.4f}   "
            f"曲线极值 {vmin:.4f} … {vmax:.4f}"
        )
        p.setPen(OVER if (over > 0 or under > 0) else MUTED)
        p.fillRect(
            QRectF(plot.left() + 4, plot.top() + 3, plot.width() - 8, 17),
            QColor(31, 35, 43, 215),
        )
        p.drawText(
            QRectF(plot.left() + 6, plot.top() + 4, plot.width() - 12, 16),
            Qt.AlignLeft,
            ann,
        )
        # values that exceed the fixed plot range get an explicit marker
        clipped_high = int(np.sum(luma > ymax))
        clipped_low = int(np.sum(luma < ymin))
        if clipped_high or clipped_low:
            p.setPen(QColor(255, 210, 120))
            p.fillRect(
                QRectF(plot.left() + 4, plot.top() + 20, plot.width() - 8, 17),
                QColor(31, 35, 43, 215),
            )
            p.drawText(
                QRectF(plot.left() + 6, plot.top() + 21, plot.width() - 12, 16),
                Qt.AlignLeft,
                f"超出绘图区: {clipped_high} 点高于 {ymax:.2f}, {clipped_low} 点低于 {ymin:.2f}",
            )


# ---------------------------------------------------------------------------
# Generic curve plot (for the sharpening sweeps)
# ---------------------------------------------------------------------------


@dataclass
class Series:
    xs: np.ndarray
    ys: np.ndarray
    colour: QColor
    name: str
    dashed: bool = False
    markers: bool = True
    axis: int = 0          # 0 = left axis, 1 = right axis (independent range)


class CurvePlot(QWidget):
    """Small labelled line plot with optional independent right axis.

    Diagnostic curves may have wildly different units (absolute overshoot in
    0..1 vs. a texture gain factor).  Squashing them into one axis would make
    one curve unreadable, so series can be bound to a second, separately
    labelled axis.  Both axes show real numeric ticks; nothing is normalised
    away silently.
    """

    def __init__(self, title: str = "", parent=None):
        super().__init__(parent)
        self.title = title
        self.x_label = ""
        self.y_label = ""
        self.y2_label = ""
        self.series: list[Series] = []
        self.hlines: list[tuple[float, QColor, str]] = []
        self.setMinimumSize(240, 170)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)

    def set_series(
        self,
        series: list[Series],
        x_label: str = "",
        y_label: str = "",
        hlines: list[tuple[float, QColor, str]] | None = None,
        title: str | None = None,
        y2_label: str = "",
    ) -> None:
        self.series = series
        self.x_label = x_label
        self.y_label = y_label
        self.y2_label = y2_label
        self.hlines = hlines or []
        if title is not None:
            self.title = title
        self.update()

    def paintEvent(self, ev) -> None:
        p = QPainter(self)
        p.fillRect(self.rect(), PANEL)
        p.setRenderHint(QPainter.Antialiasing, True)
        L, R, T, B = 58, 58, 42, 36
        plot = QRectF(L, T, max(10, self.width() - L - R), max(10, self.height() - T - B))
        p.setPen(TEXT)
        f = QFont()
        f.setPointSize(9)
        f.setBold(True)
        p.setFont(f)
        p.drawText(QRectF(10, 4, self.width() - 20, 18), Qt.AlignLeft, self.title)
        f2 = QFont()
        f2.setPointSize(8)
        p.setFont(f2)
        p.setPen(MUTED)
        p.drawText(QRectF(10, 22, self.width() - 20, 16), Qt.AlignLeft, self.y_label)

        if not self.series:
            p.setPen(MUTED)
            p.drawText(plot, Qt.AlignCenter, "尚无数据")
            return

        xs_all = np.concatenate([s.xs for s in self.series if s.xs.size])
        if xs_all.size == 0:
            return
        xmin, xmax = float(xs_all.min()), float(xs_all.max())
        if xmax <= xmin:
            xmax = xmin + 1.0

        def _range(axis: int) -> tuple[float, float]:
            vals = [s for s in self.series if s.axis == axis and s.ys.size]
            if not vals:
                return 0.0, 1.0
            ys = np.concatenate([s.ys for s in vals])
            lo, hi = float(ys.min()), float(ys.max())
            if axis == 0:
                for y, _, _ in self.hlines:
                    lo, hi = min(lo, y), max(hi, y)
            pad = (hi - lo) * 0.12 or 0.1
            return lo - pad, hi + pad

        ymin, ymax = _range(0)
        y2min, y2max = _range(1)
        has_right = any(s.axis == 1 for s in self.series)

        def sx(x):
            return plot.left() + (x - xmin) / (xmax - xmin) * plot.width()

        def sy(y, axis=0):
            if axis == 1:
                if y2max <= y2min:
                    return plot.bottom()
                return plot.bottom() - (y - y2min) / (y2max - y2min) * plot.height()
            return plot.bottom() - (y - ymin) / (ymax - ymin) * plot.height()

        p.setPen(QPen(GRID, 1))
        p.drawRect(plot)
        for i in range(5):
            y = ymin + (ymax - ymin) * i / 4
            p.setPen(QPen(GRID, 1, Qt.DotLine))
            p.drawLine(QPointF(plot.left(), sy(y)), QPointF(plot.right(), sy(y)))
            p.setPen(MUTED)
            p.drawText(QRectF(0, sy(y) - 8, L - 6, 16), Qt.AlignRight | Qt.AlignVCenter, f"{y:.3g}")
            if has_right:
                y2 = y2min + (y2max - y2min) * i / 4
                p.setPen(QColor(120, 220, 150))
                p.drawText(
                    QRectF(plot.right() + 4, sy(y) - 8, R - 6, 16),
                    Qt.AlignLeft | Qt.AlignVCenter,
                    f"{y2:.3g}",
                )
        for i in range(5):
            x = xmin + (xmax - xmin) * i / 4
            p.setPen(MUTED)
            p.drawText(
                QRectF(sx(x) - 40, plot.bottom() + 4, 80, 16),
                Qt.AlignHCenter | Qt.AlignTop,
                f"{x:.3g}",
            )
        p.setPen(MUTED)
        p.drawText(
            QRectF(plot.left(), plot.bottom() + 18, plot.width(), 16),
            Qt.AlignRight | Qt.AlignTop,
            self.x_label,
        )
        if has_right and self.y2_label:
            p.setPen(QColor(120, 220, 150))
            p.drawText(
                QRectF(plot.left(), plot.bottom() + 18, plot.width(), 16),
                Qt.AlignLeft | Qt.AlignTop,
                "右轴: " + self.y2_label,
            )
        for y, col, label in self.hlines:
            if ymin <= y <= ymax:
                p.setPen(QPen(col, 1.0, Qt.DashLine))
                p.drawLine(QPointF(plot.left(), sy(y)), QPointF(plot.right(), sy(y)))
                p.setPen(col)
                p.drawText(
                    QRectF(plot.right() - 70, sy(y) - 15, 70, 14),
                    Qt.AlignRight,
                    label,
                )
        for s in self.series:
            if s.xs.size == 0:
                continue
            path = QPainterPath()
            for i, (x, y) in enumerate(zip(s.xs, s.ys)):
                lo = y2min if s.axis == 1 else ymin
                hi = y2max if s.axis == 1 else ymax
                pt = QPointF(sx(float(x)), sy(float(np.clip(y, lo, hi)), s.axis))
                path.moveTo(pt) if i == 0 else path.lineTo(pt)
            pen = QPen(s.colour, 1.8, Qt.DashLine if s.dashed else Qt.SolidLine)
            p.setPen(pen)
            p.drawPath(path)
            if s.markers:
                p.setBrush(s.colour)
                p.setPen(Qt.NoPen)
                lo = y2min if s.axis == 1 else ymin
                hi = y2max if s.axis == 1 else ymax
                for x, y in zip(s.xs, s.ys):
                    p.drawEllipse(
                        QPointF(sx(float(x)), sy(float(np.clip(y, lo, hi)), s.axis)),
                        2.6,
                        2.6,
                    )
                p.setBrush(Qt.NoBrush)
        # legend
        lx = plot.left() + 6
        ly = plot.top() + 4
        for i, s in enumerate(self.series):
            p.setPen(QPen(s.colour, 2, Qt.DashLine if s.dashed else Qt.SolidLine))
            p.drawLine(QPointF(lx, ly + 7 + i * 15), QPointF(lx + 16, ly + 7 + i * 15))
            p.setPen(MUTED)
            suffix = " →右轴" if s.axis == 1 else ""
            p.drawText(
                QRectF(lx + 20, ly + i * 15, plot.width() - 26, 14),
                Qt.AlignLeft | Qt.AlignVCenter,
                s.name + suffix,
            )
