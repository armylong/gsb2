"""Interactive canvas: composite view, heat map, boundaries, ROI and picking."""
from __future__ import annotations

import numpy as np
from PySide6.QtCore import QPoint, QPointF, QRectF, Qt, Signal
from PySide6.QtGui import QColor, QFont, QImage, QPainter, QPainterPath, QPen
from PySide6.QtWidgets import QSizePolicy, QWidget

from . import colormap
from .core import Difference, Roi, boundary_band

MODE_MASKS = "masks"
MODE_HEAT = "heat"
MODE_OUTER = "outer"
MODE_HOLES = "holes"

MODE_LABELS = [
    (MODE_MASKS, "掩膜 / 差异"),
    (MODE_HEAT, "边界距离热图"),
    (MODE_OUTER, "外圈边界"),
    (MODE_HOLES, "孔的边界"),
]

DIRECTION_LABELS = [("a_to_b", "A → B"), ("b_to_a", "B → A")]

_PALETTE = {
    "surface": "#fcfcfb",
    "ink": "#0b0b0b",
    "ink2": "#52514e",
    "muted": "#898781",
    "grid": "#e1e0d9",
    "warning": "#d03b3b",
    "a_line": "#184f95",
    "b_line": "#a8431c",
    "target": "#5c5b57",
}


def _qcolor(rgba) -> QColor:
    if isinstance(rgba, QColor):
        return rgba
    if isinstance(rgba, str):
        return QColor(rgba)
    if len(rgba) == 3:
        return QColor(*rgba)
    return QColor(*rgba)


def _image_from_rgba(arr: np.ndarray) -> QImage:
    arr = np.ascontiguousarray(arr, dtype=np.uint8)
    h, w = arr.shape[:2]
    return QImage(arr.data, w, h, 4 * w, QImage.Format.Format_RGBA8888).copy()


class ColorBar(QWidget):
    """Vertical sequential ramp with tick labels in the chosen unit."""

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self._vmax = 1.0
        self._tolerance = 1.0
        self._unit = "px"
        self._empty = False
        self.setFixedWidth(104)

    def set_scale(self, vmax: float, tolerance: float, unit: str, empty: bool = False) -> None:
        self._vmax = max(float(vmax), 1e-12)
        self._tolerance = float(tolerance)
        self._unit = unit
        self._empty = empty
        self.update()

    def paintEvent(self, event) -> None:  # noqa: N802
        p = QPainter(self)
        p.fillRect(self.rect(), QColor(_PALETTE["surface"]))
        font = QFont(self.font())
        font.setPointSizeF(max(8.0, font.pointSizeF() - 1))
        p.setFont(font)
        p.setPen(QColor(_PALETTE["ink2"]))
        p.drawText(2, 12, f"距离 {self._unit}")
        top = 22
        bottom = self.height() - 46
        bar_w = 16
        bar_x = 4
        if self._empty or bottom - top < 20:
            p.setPen(QColor(_PALETTE["muted"]))
            p.drawText(2, top + 16, "无边界数据")
            return
        lut = colormap.lut()
        for y in range(top, bottom):
            t = 1.0 - (y - top) / max(1, bottom - top - 1)
            p.setPen(_qcolor(tuple(int(v) for v in lut[int(round(t * (len(lut) - 1)))])))
            p.drawLine(bar_x, y, bar_x + bar_w - 1, y)
        p.setPen(QPen(QColor(_PALETTE["grid"]), 1))
        p.setBrush(Qt.BrushStyle.NoBrush)
        p.drawRect(bar_x, top, bar_w, bottom - top)
        p.setPen(QColor(_PALETTE["ink2"]))
        ticks = 5
        for i in range(ticks):
            frac = i / (ticks - 1)
            y = int(round(bottom - frac * (bottom - top)))
            p.drawLine(bar_x + bar_w, y, bar_x + bar_w + 4, y)
            p.drawText(bar_x + bar_w + 6, y + 4, f"{frac * self._vmax:.3g}")
        if 0 <= self._tolerance <= self._vmax:
            y = int(round(bottom - (self._tolerance / self._vmax) * (bottom - top)))
            p.setPen(QPen(QColor(_PALETTE["warning"]), 2, Qt.PenStyle.DashLine))
            p.drawLine(bar_x - 2, y, bar_x + bar_w + 2, y)
            p.setPen(QColor(_PALETTE["warning"]))
            p.drawText(bar_x + bar_w + 6, y + 14, "误差")
        # No-data key (transparent = no target boundary).
        p.setPen(QPen(QColor(_PALETTE["muted"]), 1))
        p.setBrush(QColor(240, 239, 236))
        p.drawRect(bar_x, bottom + 10, bar_w, 9)
        p.setPen(QColor(_PALETTE["ink2"]))
        p.drawText(bar_x + bar_w + 6, bottom + 18, "无边界")


class Legend(QWidget):
    """Categorical legend for whatever the current mode paints."""

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.mode = MODE_MASKS
        self.direction = "a_to_b"
        self.has_boundary = True
        self.has_tiny_holes = False
        self.setMinimumHeight(26)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)

    def set_state(
        self, mode: str, direction: str, has_boundary: bool = True,
        has_tiny_holes: bool = False,
    ) -> None:
        self.mode, self.direction = mode, direction
        self.has_boundary, self.has_tiny_holes = has_boundary, has_tiny_holes
        self.update()

    def paintEvent(self, event) -> None:  # noqa: N802
        p = QPainter(self)
        p.fillRect(self.rect(), QColor(_PALETTE["surface"]))
        font = QFont(self.font())
        font.setPointSizeF(max(8.0, font.pointSizeF() - 1))
        p.setFont(font)
        y = self.height() - 8
        x = 4
        if self.mode == MODE_MASKS:
            items = [
                ("A 独有", _qcolor(colormap.A_FILL)),
                ("重叠", _qcolor(colormap.OVERLAP_FILL)),
                ("B 独有", _qcolor(colormap.B_FILL)),
                ("A 轮廓", _qcolor(_PALETTE["a_line"])),
                ("B 轮廓", _qcolor(_PALETTE["b_line"])),
            ]
            if self.has_tiny_holes:
                items.append(("小孔标记", _qcolor(_PALETTE["warning"])))
        elif self.mode == MODE_HEAT:
            src = "A 边界" if self.direction == "a_to_b" else "B 边界"
            items = [
                (f"{src}着色", _qcolor(colormap.BLUE_RAMP[-1])),
                ("超出允许误差", _qcolor(_PALETTE["warning"])),
                ("选中点 / 最近点", _qcolor(_PALETTE["ink"])),
            ]
        else:
            rim = "外圈" if self.mode == MODE_OUTER else "孔缘"
            items = [(f"A {rim}", _qcolor(_PALETTE["a_line"])),
                     (f"B {rim}", _qcolor(_PALETTE["b_line"]))]
            if self.mode == MODE_HOLES:
                items.append(("小孔标记", _qcolor(_PALETTE["warning"])))
        fm = p.fontMetrics()
        for label, color in items:
            p.setPen(Qt.PenStyle.NoPen)
            p.setBrush(color)
            p.drawRoundedRect(QRectF(x, y - 9, 11, 11), 2, 2)
            p.setPen(QColor(_PALETTE["ink2"]))
            p.drawText(x + 15, y, label)
            x += 19 + fm.horizontalAdvance(label) + 12


class MaskView(QWidget):
    """Renders a :class:`Difference`; lets the user pick samples and drag an ROI."""

    samplePicked = Signal(object)  # dict | None
    roiChanged = Signal(object)  # Roi | None
    cursorInfo = Signal(str)
    scaleChanged = Signal(float)

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setMinimumSize(380, 300)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)

        self.diff: Difference | None = None
        self.mode = MODE_MASKS
        self.direction = "a_to_b"
        self.show_a = True
        self.show_b = True
        self.show_overlap = True
        self.show_only_a = True
        self.show_only_b = True
        self.vmax = 1.0
        self.roi_mode = False
        self.selected: dict | None = None

        self._img: QImage | None = None
        self._img_key = None
        self._band_cache: tuple[tuple, np.ndarray, np.ndarray] | None = None
        self._zoom = 1.0
        self._offset = QPointF(0, 0)
        self._auto_fit = True
        self._pan_anchor: QPoint | None = None
        self._pan_offset = QPointF()
        self._rubber_start: QPointF | None = None
        self._rubber_now: QPointF | None = None
        self._space = False

    # ------------------------------------------------------------------ data
    def set_diff(self, diff: Difference | None) -> None:
        self.diff = diff
        self.selected = None
        self._invalidate()
        self.update()

    def set_mode(self, mode: str) -> None:
        if mode == self.mode:
            return
        self.mode = mode
        self._invalidate()
        self.update()

    def set_direction(self, direction: str) -> None:
        if direction == self.direction:
            return
        self.direction = direction
        self.selected = None
        self._invalidate()
        self.update()

    def set_visibility(self, **kwargs) -> None:
        changed = False
        for key in ("show_a", "show_b", "show_overlap", "show_only_a", "show_only_b"):
            if key in kwargs and bool(kwargs[key]) != getattr(self, key):
                setattr(self, key, bool(kwargs[key]))
                changed = True
        if changed:
            self._invalidate()
            self.update()

    def set_vmax(self, vmax: float) -> None:
        self.vmax = max(float(vmax), 1e-9)
        self._invalidate()
        self.update()

    def set_roi_mode(self, on: bool) -> None:
        self.roi_mode = on
        self.setCursor(Qt.CursorShape.CrossCursor if on else Qt.CursorShape.ArrowCursor)

    def set_selected(self, info: dict | None, center: bool = False) -> None:
        self.selected = info
        if info is not None and center:
            self._center_on(info["source"])
        self.update()

    # -------------------------------------------------------------- geometry
    def _frame(self) -> QRectF:
        return QRectF(12, 12, max(10, self.width() - 24), max(10, self.height() - 24))

    def _scale(self) -> float:
        if self.diff is None:
            return 1.0
        h, w = self.diff.shape
        f = self._frame()
        return max(1e-6, min(f.width() / w, f.height() / h) * self._zoom)

    def _recompute_transform(self) -> None:
        if self.diff is None or not self._auto_fit:
            return
        h, w = self.diff.shape
        f = self._frame()
        s = self._scale()
        self._offset = QPointF(
            f.x() + (f.width() - w * s) / 2, f.y() + (f.height() - h * s) / 2
        )

    def _to_widget(self, row: float, col: float) -> QPointF:
        s = self._scale()
        return QPointF(self._offset.x() + (col + 0.5) * s, self._offset.y() + (row + 0.5) * s)

    def _to_image(self, pos: QPointF) -> tuple[float, float]:
        s = self._scale()
        return ((pos.y() - self._offset.y()) / s - 0.5,
                (pos.x() - self._offset.x()) / s - 0.5)

    def center_on(self, source: tuple[int, int]) -> None:
        """Centre the view on a full-image pixel (used by tables/double-clicks)."""
        self._center_on(source)
        self.update()

    def _center_on(self, source: tuple[int, int]) -> None:
        if self.diff is None:
            return
        s = self._scale()
        f = self._frame()
        self._auto_fit = False
        self._offset = QPointF(
            f.x() + f.width() / 2 - (source[1] + 0.5) * s,
            f.y() + f.height() / 2 - (source[0] + 0.5) * s,
        )

    def fit_to_window(self) -> None:
        self._auto_fit, self._zoom = True, 1.0
        self.update()
        self.scaleChanged.emit(self._scale())

    def zoom_by(self, factor: float) -> None:
        """Zoom around the centre of the visible area (wheel zooms at cursor)."""
        old = self._scale()
        self._zoom = min(80.0, max(0.02, self._zoom * factor))
        if self._auto_fit:
            self._recompute_transform()
        self._auto_fit = False
        new = self._scale()
        ratio = new / old if old else 1.0
        f = self._frame()
        cx = f.x() + f.width() / 2
        cy = f.y() + f.height() / 2
        self._offset = QPointF(
            cx - (cx - self._offset.x()) * ratio,
            cy - (cy - self._offset.y()) * ratio,
        )
        self.update()
        self.scaleChanged.emit(new)

    # --------------------------------------------------------------- raster
    def _invalidate(self) -> None:
        self._img = None
        self._band_cache = None

    def _key(self):
        d = self.diff
        return (
            self.mode, self.direction, self.show_a, self.show_b,
            self.show_overlap, self.show_only_a, self.show_only_b,
            round(self.vmax, 9), d.roi.to_tuple() if d else None,
            d.roi_active if d else False, len(d.holes) if d else 0,
        )

    def _image(self) -> QImage | None:
        d = self.diff
        if d is None:
            return None
        key = self._key()
        if self._img is not None and self._img_key == key:
            return self._img
        h, w = d.shape
        if self.mode == MODE_MASKS:
            arr = np.zeros((h, w, 4), dtype=np.uint8)
            if self.show_a and self.show_b:
                # Side-by-side comparison: four-way classification.
                if self.show_only_a:
                    arr[d.only_a] = colormap.A_FILL
                if self.show_only_b:
                    arr[d.only_b] = colormap.B_FILL
                if self.show_overlap:
                    arr[d.overlap] = colormap.OVERLAP_FILL
            elif self.show_a:
                # Only A visible: show the whole A mask, shared area lighter.
                arr[d.a] = colormap.A_ONLY_VIEW_OVERLAP
                arr[d.only_a] = colormap.A_FILL
            elif self.show_b:
                arr[d.b] = colormap.B_ONLY_VIEW_OVERLAP
                arr[d.only_b] = colormap.B_FILL
        elif self.mode == MODE_HEAT:
            # The silhouette is context only; the band carries the data.
            arr = colormap.silhouette_rgba(
                (h, w), d.a if self.show_a else np.zeros_like(d.a),
                d.b if self.show_b else np.zeros_like(d.b),
            )
            band = self._band(d)
            if band is not None:
                mask, vals = band
                heat = colormap.heat_rgba(vals, self.vmax, alpha=255)
                arr[mask] = heat[mask]
                # The target boundary is what the distances point at, so it
                # stays visible through the band.
                target = d.side(self.direction).target_boundary
                arr[target] = colormap.TARGET_FILL
        else:
            arr = colormap.silhouette_rgba(
                (h, w), d.a if self.show_a else np.zeros_like(d.a),
                d.b if self.show_b else np.zeros_like(d.b),
            )
            rim = d.a_outer if self.mode == MODE_OUTER else d.a_holes
            if self.show_a:
                arr[rim] = colormap.A_FILL
            rim = d.b_outer if self.mode == MODE_OUTER else d.b_holes
            if self.show_b:
                arr[rim] = colormap.B_FILL
        self._img = _image_from_rgba(arr)
        self._img_key = key
        return self._img

    def _band(self, d: Difference):
        """Narrow band around the source boundary, coloured by sample distance.

        Only boundary samples carry a distance; the interior has no meaningful
        "distance to the other boundary", so it stays neutral grey. The band is
        widened by a few pixels so a 1-px boundary stays legible when zoomed
        out, without repainting the silhouette as "very far".
        """
        bs = d.side(self.direction)
        if bs is None or bs.n == 0:
            return None
        key = (self.direction, id(bs), d.shape)
        if self._band_cache is not None and self._band_cache[0] == key:
            return self._band_cache[1], self._band_cache[2]
        result = boundary_band(d, self.direction)
        if result is None:
            return None
        self._band_cache = (key, result[0], result[1])
        return result

    # --------------------------------------------------------------- paint
    def paintEvent(self, event) -> None:  # noqa: N802
        p = QPainter(self)
        p.fillRect(self.rect(), QColor(_PALETTE["surface"]))
        d = self.diff
        if d is None:
            p.setPen(QColor(_PALETTE["muted"]))
            p.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter,
                       "载入两张同尺寸的二值 PNG，或从“内置示例”开始")
            return
        self._recompute_transform()
        s = self._scale()
        h, w = d.shape
        target = QRectF(self._offset.x(), self._offset.y(), w * s, h * s)
        img = self._image()
        if img is not None:
            p.drawImage(target, img)
        p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        p.setPen(QPen(QColor(_PALETTE["grid"]), 1))
        p.setBrush(Qt.BrushStyle.NoBrush)
        p.drawRect(target)

        if self.mode in (MODE_MASKS, MODE_OUTER, MODE_HOLES) and s < 3.0:
            self._paint_boundary_pixels(p, d, s)
        if self.mode in (MODE_MASKS, MODE_HOLES):
            # A one-pixel pinhole is otherwise invisible at normal zoom.
            self._paint_hole_marks(p, d)
        if self.mode == MODE_HEAT:
            self._paint_over_tolerance(p, d, s)
        if d.roi_active:
            self._paint_roi(p, d, s)
        if self._rubber_start is not None and self._rubber_now is not None:
            rect = QRectF(self._rubber_start, self._rubber_now).normalized()
            p.setPen(QPen(QColor(_PALETTE["ink"]), 1, Qt.PenStyle.DashLine))
            p.setBrush(Qt.BrushStyle.NoBrush)
            p.drawRect(rect)
            r0, c0 = self._to_image(rect.topLeft())
            r1, c1 = self._to_image(rect.bottomRight())
            p.setPen(QColor(_PALETTE["ink2"]))
            p.drawText(
                QPointF(rect.x(), rect.y() - 4),
                f"{abs(r1 - r0) + 1:.0f}×{abs(c1 - c0) + 1:.0f} px",
            )
        if self.selected is not None:
            self._paint_selection(p, s, d)
        p.setPen(QColor(_PALETTE["muted"]))
        f = QFont(self.font())
        f.setPointSizeF(max(8.0, f.pointSizeF() - 1))
        p.setFont(f)
        p.drawText(8, self.height() - 8, f"{w} × {h} px · 显示 {s:.0%}")

    def _paint_boundary_pixels(self, p: QPainter, d: Difference, s: float) -> None:
        size = max(1.0, s)

        def draw(mask: np.ndarray, color: str) -> None:
            rows, cols = np.nonzero(mask)
            if rows.size == 0:
                return
            if rows.size > 80000:
                step = rows.size // 80000 + 1
                rows, cols = rows[::step], cols[::step]
            path = QPainterPath()
            xs = self._offset.x() + (cols + 0.5) * s - size / 2
            ys = self._offset.y() + (rows + 0.5) * s - size / 2
            for x, y in zip(xs.tolist(), ys.tolist()):
                path.addRect(QRectF(x, y, size, size))
            p.setPen(Qt.PenStyle.NoPen)
            p.setBrush(QColor(color))
            p.drawPath(path)

        if self.mode == MODE_MASKS:
            a_mask, b_mask = d.a_outer | d.a_holes, d.b_outer | d.b_holes
        elif self.mode == MODE_OUTER:
            a_mask, b_mask = d.a_outer, d.b_outer
        else:
            a_mask, b_mask = d.a_holes, d.b_holes
        if self.show_a:
            draw(a_mask, _PALETTE["a_line"])
        if self.show_b:
            draw(b_mask, _PALETTE["b_line"])

    def _paint_hole_marks(self, p: QPainter, d: Difference) -> None:
        p.setBrush(Qt.BrushStyle.NoBrush)
        for hole in d.holes:
            if not hole.is_tiny:
                continue
            if hole.mask_name == "A" and not self.show_a:
                continue
            if hole.mask_name == "B" and not self.show_b:
                continue
            pt = self._to_widget(*hole.centroid)
            p.setPen(QPen(QColor(_PALETTE["warning"]), 1.6))
            p.drawEllipse(pt, 9.0, 9.0)
            p.setPen(QColor(_PALETTE["ink"]))
            p.drawText(
                QPointF(pt.x() + 11, pt.y() + 4),
                f"{hole.mask_name}: {hole.area_px}px",
            )

    def _paint_over_tolerance(self, p: QPainter, d: Difference, s: float) -> None:
        bs = d.side(self.direction)
        if bs is None or bs.n == 0:
            return
        over = bs.sample_values > d.calib.tolerance
        if not over.any():
            return
        rows, cols = bs.sample_rows[over], bs.sample_cols[over]
        if rows.size > 3000:
            step = rows.size // 3000 + 1
            rows, cols = rows[::step], cols[::step]
        r = max(1.6, min(3.4, s * 0.6))
        xs = self._offset.x() + (cols + 0.5) * s
        ys = self._offset.y() + (rows + 0.5) * s
        path = QPainterPath()
        for x, y in zip(xs.tolist(), ys.tolist()):
            path.addEllipse(QPointF(x, y), r, r)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(QColor(_PALETTE["warning"]))
        p.drawPath(path)

    def _paint_roi(self, p: QPainter, d: Difference, s: float) -> None:
        roi = d.roi
        rect = QRectF(
            self._offset.x() + roi.col0 * s, self._offset.y() + roi.row0 * s,
            (roi.col1 - roi.col0) * s, (roi.row1 - roi.row0) * s,
        )
        p.setPen(QPen(QColor(_PALETTE["ink"]), 1.5, Qt.PenStyle.DashLine))
        p.setBrush(Qt.BrushStyle.NoBrush)
        p.drawRect(rect)
        p.setPen(QColor(_PALETTE["ink2"]))
        p.drawText(QPointF(rect.x() + 4, rect.y() - 4),
                   f"统计区 行 {roi.row0}:{roi.row1} 列 {roi.col0}:{roi.col1}")

    def _paint_selection(self, p: QPainter, s: float, d: Difference) -> None:
        info = self.selected
        assert info is not None
        src = self._to_widget(*info["source"])
        near = self._to_widget(*info["nearest"])
        rev = self._to_widget(*info["reverse"])
        p.setPen(QPen(QColor(_PALETTE["warning"]), 1.6))
        p.drawLine(src, near)
        p.setBrush(QColor(_PALETTE["warning"]))
        p.setPen(QPen(QColor(_PALETTE["ink"]), 1.6))
        p.drawEllipse(src, 4.5, 4.5)
        p.setBrush(Qt.BrushStyle.NoBrush)
        p.setPen(QPen(QColor(_PALETTE["target"]), 1.6))
        p.drawEllipse(near, 5.5, 5.5)
        p.drawLine(QPointF(near.x() - 9, near.y()), QPointF(near.x() + 9, near.y()))
        p.drawLine(QPointF(near.x(), near.y() - 9), QPointF(near.x(), near.y() + 9))
        if info["reverse"] != info["source"]:
            p.setPen(QPen(QColor(_PALETTE["ink2"]), 1.2, Qt.PenStyle.DotLine))
            p.drawEllipse(rev, 4.0, 4.0)
        label = f"{info['distance']:.3f} {info['unit']}".strip()
        mid = QPointF((src.x() + near.x()) / 2 + 6, (src.y() + near.y()) / 2 - 6)
        fm = p.fontMetrics()
        wpx = fm.horizontalAdvance(label) + 8
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(QColor(252, 252, 251, 225))
        p.drawRoundedRect(QRectF(mid.x(), mid.y() - fm.ascent() - 2, wpx, fm.height()), 3, 3)
        p.setPen(QColor(_PALETTE["ink"]))
        p.drawText(QPointF(mid.x() + 4, mid.y() - 2), label)

    # ---------------------------------------------------------------- input
    def nearest_sample(self, pos: QPointF, max_px: float = 14.0) -> dict | None:
        d = self.diff
        if d is None or not d.boundary_available:
            return None
        bs = d.side(self.direction)
        if bs is None or bs.n == 0:
            return None
        s = self._scale()
        wx = self._offset.x() + (bs.sample_cols + 0.5) * s
        wy = self._offset.y() + (bs.sample_rows + 0.5) * s
        d2 = (wx - pos.x()) ** 2 + (wy - pos.y()) ** 2
        # Only let the user pick samples the current view is showing.
        visible = self._visible_sample_filter(d, bs)
        if visible is not None:
            d2 = np.where(visible, d2, np.inf)
        if d.roi_active:
            inside = d.roi.contains(bs.sample_rows, bs.sample_cols)
            if inside.any():
                d2 = np.where(inside, d2, np.inf)
        i = int(np.argmin(d2))
        if not np.isfinite(d2[i]) or d2[i] > max_px * max_px:
            return None
        return d.sample_info(self.direction, i)

    def _visible_sample_filter(self, d: Difference, bs) -> np.ndarray | None:
        """Per-sample mask for outer/hole modes; None means all samples."""
        if self.mode == MODE_MASKS or self.mode == MODE_HEAT:
            return None
        rows, cols = bs.sample_rows, bs.sample_cols
        if self.mode == MODE_OUTER:
            mask = d.a_outer if bs.source_name == "A" else d.b_outer
        else:
            mask = d.a_holes if bs.source_name == "A" else d.b_holes
        return mask[rows, cols]

    def select_sample(self, index: int, center: bool = True) -> dict | None:
        d = self.diff
        if d is None or not d.boundary_available:
            return None
        bs = d.side(self.direction)
        if bs is None or not (0 <= index < bs.n):
            return None
        info = d.sample_info(self.direction, index)
        self.selected = info
        if center:
            self._center_on(info["source"])
        self.update()
        return info

    def _pick_at(self, pos: QPointF) -> None:
        info = self.nearest_sample(pos)
        self.selected = info
        self.samplePicked.emit(info)
        self.update()

    def mousePressEvent(self, event) -> None:  # noqa: N802
        pos = event.position()
        if event.button() == Qt.MouseButton.MiddleButton or (
            event.button() == Qt.MouseButton.LeftButton and self._space
        ):
            self._pan_anchor = pos.toPoint()
            self._pan_offset = QPointF(self._offset)
            self.setCursor(Qt.CursorShape.ClosedHandCursor)
            return
        if event.button() == Qt.MouseButton.LeftButton and self.roi_mode:
            self._rubber_start = pos
            self._rubber_now = pos
            self.update()
            return
        if event.button() == Qt.MouseButton.LeftButton:
            self._pick_at(pos)
        elif event.button() == Qt.MouseButton.RightButton and self.roi_mode:
            self.roiChanged.emit(None)

    def mouseMoveEvent(self, event) -> None:  # noqa: N802
        pos = event.position()
        if self._pan_anchor is not None:
            delta = pos.toPoint() - self._pan_anchor
            self._auto_fit = False
            self._offset = self._pan_offset + QPointF(delta.x(), delta.y())
            self.update()
            return
        if self._rubber_start is not None:
            self._rubber_now = pos
            self.update()
            return
        d = self.diff
        if d is None:
            return
        row, col = self._to_image(pos)
        h, w = d.shape
        if not (0 <= row < h and 0 <= col < w):
            self.cursorInfo.emit("")
            return
        info = self.nearest_sample(pos, max_px=8.0)
        if info is not None:
            self.cursorInfo.emit(
                f"行 {int(row)}, 列 {int(col)} · 边界距离 {info['distance']:.3f} {info['unit']}"
                f" · 最近点 行 {info['nearest'][0]}, 列 {info['nearest'][1]}"
            )
        else:
            self.cursorInfo.emit(f"行 {int(row)}, 列 {int(col)}")

    def mouseReleaseEvent(self, event) -> None:  # noqa: N802
        if self._pan_anchor is not None:
            self._pan_anchor = None
            self.setCursor(Qt.CursorShape.CrossCursor if self.roi_mode else Qt.CursorShape.ArrowCursor)
            return
        if self._rubber_start is not None and event.button() == Qt.MouseButton.LeftButton:
            start, now = self._rubber_start, event.position()
            self._rubber_start = self._rubber_now = None
            d = self.diff
            if d is not None:
                r0, c0 = self._to_image(start)
                r1, c1 = self._to_image(now)
                h, w = d.shape
                roi = Roi(
                    int(round(min(r0, r1))), int(round(max(r0, r1)) + 1),
                    int(round(min(c0, c1))), int(round(max(c0, c1)) + 1),
                ).clip((h, w))
                if roi.row1 - roi.row0 >= 2 and roi.col1 - roi.col0 >= 2:
                    self.roiChanged.emit(roi)
                # Too small a drag is an accidental click: keep the current
                # selection and stay in box-select mode. Right-click / Esc clear.
            self.update()

    def wheelEvent(self, event) -> None:  # noqa: N802
        if self.diff is None:
            return
        old = self._scale()
        factor = 1.25 if event.angleDelta().y() > 0 else 0.8
        self._zoom = min(80.0, max(0.02, self._zoom * factor))
        new = self._scale()
        cursor = event.position()
        ratio = new / old if old else 1.0
        if self._auto_fit:
            self._recompute_transform()
        self._auto_fit = False
        self._offset = QPointF(
            cursor.x() - (cursor.x() - self._offset.x()) * ratio,
            cursor.y() - (cursor.y() - self._offset.y()) * ratio,
        )
        self.update()
        self.scaleChanged.emit(new)

    def zoom_to_point(self, source: tuple[int, int], zoom: float) -> None:
        """Convenience: set a zoom level and centre on an image pixel."""
        self._zoom = min(80.0, max(0.02, float(zoom)))
        self._auto_fit = False
        self._center_on(source)
        self.update()
        self.scaleChanged.emit(self._scale())

    def keyPressEvent(self, event) -> None:  # noqa: N802
        if event.key() == Qt.Key.Key_Space:
            self._space = True
            self.setCursor(Qt.CursorShape.OpenHandCursor)
        elif event.key() in (Qt.Key.Key_Plus, Qt.Key.Key_Equal):
            self.zoom_by(1.25)
        elif event.key() == Qt.Key.Key_Minus:
            self.zoom_by(0.8)
        elif event.key() == Qt.Key.Key_0:
            self.fit_to_window()
        elif event.key() == Qt.Key.Key_Escape and self.roi_mode:
            self.roiChanged.emit(None)

    def keyReleaseEvent(self, event) -> None:  # noqa: N802
        if event.key() == Qt.Key.Key_Space:
            self._space = False
            self.setCursor(Qt.CursorShape.CrossCursor if self.roi_mode else Qt.CursorShape.ArrowCursor)
