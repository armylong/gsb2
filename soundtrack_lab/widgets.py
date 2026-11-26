from __future__ import annotations

import numpy as np
from PySide6.QtCore import QPoint, QRect, QRectF, Qt, Signal
from PySide6.QtGui import QBrush, QColor, QFont, QPainter, QPainterPath, QPen, QPixmap, QPolygon
from PySide6.QtWidgets import QFrame, QWidget

from .core import (
    DEFAULT_CAL_MM,
    ROW_RATE,
    Segment,
    calibration_seconds,
    decode_image,
)
from .qt_support import gray_to_qimage


class TrackView(QWidget):
    seekRequested = Signal(float)

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._qimage = None
        self._duration = 1.0
        self._segments: list[Segment] = []
        self._trial = None
        self._gray: np.ndarray | None = None
        self._meta: dict = {}
        self._selected_time = 0.0
        self._px_per_sec = 260.0
        self._cal_mm = DEFAULT_CAL_MM
        self._params = None
        self.setMouseTracking(True)
        self.setMinimumWidth(700)
        self._recompute_height()

    def set_data(
        self,
        gray: np.ndarray | None,
        meta: dict,
        segments: list[Segment],
        trial,
        params,
        selected_time: float,
        cal_mm: float,
    ) -> None:
        self._gray = gray
        self._qimage = gray_to_qimage(gray) if gray is not None else None
        self._meta = meta or {}
        self._segments = segments
        self._trial = trial
        self._params = params
        self._selected_time = selected_time
        self._cal_mm = cal_mm
        if gray is not None:
            self._duration = gray.shape[0] / ROW_RATE
        self._recompute_height()
        self.update()

    def set_selected_time(self, t: float) -> None:
        self._selected_time = max(0.0, min(self._duration, t))
        self.update()

    def set_zoom(self, px_per_sec: float) -> None:
        self._px_per_sec = float(np.clip(px_per_sec, 70, 2600))
        self._recompute_height()
        self.update()

    def zoom(self) -> float:
        return self._px_per_sec

    def _recompute_height(self) -> None:
        track_h = max(260, int(self._duration * self._px_per_sec))
        self.setMinimumHeight(track_h + 70)
        self.resize(self.width(), track_h + 70)

    def _geometry(self) -> tuple[int, int, int]:
        img_x = 76
        top = 38
        img_w = self._qimage.width() if self._qimage is not None else int(self._meta.get("width_px", 420))
        return img_x, top, img_w

    def _y(self, t: float) -> int:
        _, top, _ = self._geometry()
        return int(top + t * self._px_per_sec)

    def _time_at_y(self, y: int) -> float:
        _, top, _ = self._geometry()
        return max(0.0, min(self._duration, (y - top) / self._px_per_sec))

    def mousePressEvent(self, event) -> None:
        t = self._time_at_y(event.position().y())
        self.seekRequested.emit(t)
        event.accept()

    def mouseMoveEvent(self, event) -> None:
        if event.buttons() & Qt.MouseButton.LeftButton:
            self.seekRequested.emit(self._time_at_y(event.position().y()))
        event.accept()

    def paintEvent(self, event) -> None:  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        p.fillRect(self.rect(), QColor("#f7f7f5"))
        img_x, top, img_w = self._geometry()
        track_h = int(self._duration * self._px_per_sec)
        img_rect = QRect(img_x, top, img_w, track_h)

        # Time grid and labels.
        pen = QPen(QColor("#d0d0d0"))
        pen.setWidthF(0.8)
        p.setPen(pen)
        tick_step = 0.25 if self._px_per_sec >= 220 else 0.5
        t = 0.0
        font = QFont()
        font.setPointSize(9)
        p.setFont(font)
        while t <= self._duration + 1e-6:
            y = self._y(t)
            p.drawLine(58, y, img_x + img_w + 8, y)
            p.setPen(QColor("#555"))
            p.drawText(8, y - 6, 48, 18, Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter, f"{t:.2f}s")
            p.setPen(pen)
            t += tick_step

        # Segment bands and right-side labels.
        for i, seg in enumerate(self._segments):
            y0, y1 = self._y(seg.start), self._y(seg.end)
            color = QColor(70, 130, 180, 24 if i % 2 == 0 else 14)
            p.fillRect(QRect(60, y0, img_w + 24, max(1, y1 - y0)), color)
            p.setPen(QPen(QColor("#7a9bb8"), 1, Qt.PenStyle.DashLine))
            p.drawLine(60, y0, img_x + img_w + 24, y0)
            p.setPen(QColor("#244a66"))
            label = f"{seg.label}\n{seg.start:.2f}–{seg.end:.2f}s"
            p.drawText(
                QRect(img_x + img_w + 10, y0 + 3, 168, max(28, y1 - y0 - 4)),
                Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignTop | Qt.TextFlag.TextWordWrap,
                label,
            )

        # Direction arrow.
        arrow_x = 28
        p.setPen(QPen(QColor("#222"), 2))
        p.drawLine(arrow_x, top + 8, arrow_x, top + 72)
        p.drawLine(arrow_x - 6, top + 62, arrow_x, top + 74)
        p.drawLine(arrow_x + 6, top + 62, arrow_x, top + 74)
        p.save()
        p.translate(14, top + 45)
        p.rotate(-90)
        p.drawText(QRect(-45, -12, 90, 20), Qt.AlignmentFlag.AlignCenter, "走片方向")
        p.restore()

        # Calibration bracket.
        cal_s = calibration_seconds(self._cal_mm)
        cal_h = max(10, int(cal_s * self._px_per_sec))
        bx = 62
        by = top + 12
        p.setPen(QPen(QColor("#8a5a00"), 2))
        p.drawLine(bx, by, bx, by + cal_h)
        p.drawLine(bx - 5, by, bx + 5, by)
        p.drawLine(bx - 5, by + cal_h, bx + 5, by + cal_h)
        cal_rows = int(round(self._cal_mm / 0.05))
        cal_text = f"标定 {self._cal_mm:g}mm = {cal_rows}行 = {cal_s * 1000:.1f}ms"
        text_rect = QRect(img_x + 8, by - 6, 238, 22)
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(QColor(255, 255, 255, 210))
        p.drawRoundedRect(text_rect, 4, 4)
        p.setBrush(Qt.BrushStyle.NoBrush)
        p.setPen(QColor("#6e4700"))
        p.drawText(text_rect, Qt.AlignmentFlag.AlignCenter, cal_text)

        # Soundtrack image.
        if self._qimage is not None:
            p.drawImage(img_rect, self._qimage)
            p.setPen(QPen(QColor("#111"), 1.2))
            p.drawRect(img_rect)

        # Lateral read gates.
        if self._params is not None and self._meta:
            center = float(self._meta.get("center_x", 210))
            base_half = float(self._meta.get("base_half_px", 72))
            radius = float(self._meta.get("edge_gate_radius", 72))
            off = float(getattr(self._params, "offset_px", 0.0))
            for gc in (center - base_half + off, center + base_half + off):
                gx0 = img_x + gc - radius
                p.fillRect(QRectF(gx0, top, 2 * radius, track_h), QColor(40, 110, 200, 18))
                p.setPen(QPen(QColor(40, 110, 200, 150), 1, Qt.PenStyle.DashLine))
                p.drawLine(int(gx0), top, int(gx0), top + track_h)
                p.drawLine(int(gx0 + 2 * radius), top, int(gx0 + 2 * radius), top + track_h)

        # Defect intervals.
        if self._trial is not None:
            h = self._gray.shape[0] if self._gray is not None else 1
            for d in getattr(self._trial, "defects", []):
                ry0 = top + d.review_start_row / ROW_RATE * self._px_per_sec
                ry1 = top + d.review_end_row / ROW_RATE * self._px_per_sec
                p.fillRect(QRectF(img_x, ry0, img_w, max(1, ry1 - ry0)), QColor(230, 170, 0, 55))
                cy0 = top + d.start_row / ROW_RATE * self._px_per_sec
                cy1 = top + d.end_row / ROW_RATE * self._px_per_sec
                p.fillRect(QRectF(img_x, cy0, img_w, max(1, cy1 - cy0)), QColor(210, 45, 35, 70))
                p.setPen(QPen(QColor("#b3261e"), 1.2))
                label = "待查" if d.status == "review" else "异常"
                p.drawText(QRect(img_x + 4, int(ry0) + 2, 80, 18), Qt.AlignmentFlag.AlignLeft, label)

        # Scan window and selected row.
        row = int(round(self._selected_time * ROW_RATE))
        y = self._y(self._selected_time)
        if self._params is not None:
            win_s = int(getattr(self._params, "window_rows", 1)) / ROW_RATE
            wh = max(3, win_s * self._px_per_sec)
            p.fillRect(QRectF(img_x, y - wh / 2, img_w, wh), QColor(30, 120, 220, 42))
            p.setPen(QPen(QColor("#1769c2"), 1.4))
            p.drawRect(QRectF(img_x, y - wh / 2, img_w, wh))

        p.setPen(QPen(QColor("#0b57d0"), 1.6))
        p.drawLine(60, y, img_x + img_w + 34, y)
        p.setBrush(QColor("#0b57d0"))
        p.drawEllipse(QPoint(60, y), 4, 4)
        p.setBrush(Qt.BrushStyle.NoBrush)

        # Edge markers for the selected row.
        if self._trial is not None and 0 <= row < len(self._trial.left_x):
            lx = self._trial.left_x[row]
            rx = self._trial.right_x[row]
            for xval, name, color in ((lx, "L", QColor("#004a99")), (rx, "R", QColor("#7a1fa2"))):
                if np.isfinite(xval):
                    x = img_x + float(xval)
                    p.setPen(QPen(color, 2))
                    p.drawLine(int(x), y - 9, int(x), y + 9)
                    p.drawEllipse(QPoint(int(x), y), 5, 5)
                    p.setPen(color)
                    p.drawText(int(x) - 12, y - 24, 24, 16, Qt.AlignmentFlag.AlignCenter, name)

        p.end()


class ProfileView(QWidget):
    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setMinimumHeight(170)
        self._gray: np.ndarray | None = None
        self._trial = None
        self._row = 0
        self._meta = {}
        self._params = None

    def set_data(self, gray, trial, row: int, meta: dict, params) -> None:
        self._gray = gray
        self._trial = trial
        self._row = int(np.clip(row, 0, (gray.shape[0] - 1) if gray is not None else 0))
        self._meta = meta
        self._params = params
        self.update()

    def paintEvent(self, event) -> None:  # noqa: N802
        p = QPainter(self)
        p.fillRect(self.rect(), QColor("white"))
        p.setPen(QPen(QColor("#e0e0e0"), 1))
        for i in range(5):
            y = 18 + i * (self.height() - 42) / 4
            p.drawLine(34, int(y), self.width() - 10, int(y))
        if self._gray is None:
            p.setPen(QColor("#777"))
            p.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter, "打开或生成样例后显示该行灰度剖面")
            p.end()
            return

        row = int(np.clip(self._row, 0, self._gray.shape[0] - 1))
        vals = self._gray[row].astype(np.float32)
        x0, plot_w = 34, max(10, self.width() - 48)
        y_top, plot_h = 14, self.height() - 34

        def px(x: float) -> float:
            return x0 + x / max(1, self._gray.shape[1] - 1) * plot_w

        def py(v: float) -> float:
            return y_top + (1.0 - v / 255.0) * plot_h

        path = QPainterPath()
        path.moveTo(px(0), py(vals[0]))
        for x in range(1, len(vals)):
            path.lineTo(px(x), py(vals[x]))
        p.setPen(QPen(QColor("#333"), 1.4))
        p.drawPath(path)

        if self._params is not None:
            ev_gain = 2.0 ** float(self._params.exposure_ev)
            exp = np.clip(vals / 255.0 * ev_gain + max(0.0, self._params.exposure_ev) * 0.035, 0, 1) * 255
            path2 = QPainterPath()
            path2.moveTo(px(0), py(exp[0]))
            for x in range(1, len(exp)):
                path2.lineTo(px(x), py(exp[x]))
            p.setPen(QPen(QColor("#d35400"), 1.2, Qt.PenStyle.DashLine))
            p.drawPath(path2)

        p.setPen(QPen(QColor("#999"), 1))
        p.drawText(4, self.height() - 16, "灰度 0")
        p.drawText(4, 16, "255")
        p.setPen(QColor("#d35400"))
        p.drawText(self.width() - 150, 16, "橙虚线=曝光后")

        if self._trial is not None:
            for key, color in (("left_x", QColor("#004a99")), ("right_x", QColor("#7a1fa2"))):
                arr = getattr(self._trial, key)
                if row < len(arr) and np.isfinite(arr[row]):
                    x = px(float(arr[row]))
                    p.setPen(QPen(color, 2))
                    p.drawLine(int(x), y_top, int(x), y_top + plot_h)
        p.end()


class WaveView(QWidget):
    seekRequested = Signal(float)

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setMinimumHeight(210)
        self._source: np.ndarray | None = None
        self._baseline = None
        self._trial = None
        self._segments: list[Segment] = []
        self._time = 0.0
        self._duration = 1.0
        self._rate = 22050

    def set_data(self, source, baseline, trial, segments, current_time: float, rate: int = 22050) -> None:
        self._source = source
        self._baseline = baseline
        self._trial = trial
        self._segments = segments
        self._time = current_time
        self._rate = rate
        durations = [len(source) / rate if source is not None else 1.0]
        if trial is not None:
            durations.append(trial.duration)
        self._duration = max(durations)
        self.update()

    def set_time(self, t: float) -> None:
        self._time = t
        self.update()

    def _time_to_x(self, t: float, x0: int, w: int) -> int:
        return x0 + int(t / max(self._duration, 1e-6) * w)

    def _x_to_time(self, x: float, x0: int, w: int) -> float:
        return max(0.0, min(self._duration, (x - x0) / max(1, w) * self._duration))

    def mousePressEvent(self, event) -> None:
        self.seekRequested.emit(self._x_to_time(event.position().x(), 54, self.width() - 70))

    def mouseMoveEvent(self, event) -> None:
        if event.buttons() & Qt.MouseButton.LeftButton:
            self.seekRequested.emit(self._x_to_time(event.position().x(), 54, self.width() - 70))

    def _draw_panel(self, p: QPainter, rect: QRect, y: np.ndarray | None, title: str, color: QColor) -> None:
        x0, w = rect.left(), rect.width()
        mid = rect.center().y()
        p.setPen(QPen(QColor("#ededed"), 1))
        p.drawLine(x0, mid, rect.right(), mid)
        p.setPen(QColor("#333"))
        p.drawText(6, rect.top() + 14, title)
        if y is None or len(y) == 0:
            p.setPen(QColor("#999"))
            p.drawText(rect, Qt.AlignmentFlag.AlignCenter, "—")
            return

        # Min/max envelope per horizontal pixel.
        npx = max(20, w)
        chunk = max(1, len(y) // npx)
        pen = QPen(color, 1)
        p.setPen(pen)
        scale = rect.height() * 0.42
        for px_i in range(npx):
            a = px_i * chunk
            b = len(y) if px_i == npx - 1 else min(len(y), a + chunk)
            if b <= a:
                continue
            part = y[a:b]
            lo = float(np.min(part))
            hi = float(np.max(part))
            x = x0 + px_i
            p.drawLine(x, int(mid - hi * scale), x, int(mid - lo * scale))

    def paintEvent(self, event) -> None:  # noqa: N802
        p = QPainter(self)
        p.fillRect(self.rect(), QColor("#fbfbf8"))
        x0 = 54
        w = self.width() - 72
        panel_h = (self.height() - 34) / 3.0
        rects = [
            QRect(x0, 4, w, int(panel_h)),
            QRect(x0, int(4 + panel_h), w, int(panel_h)),
            QRect(x0, int(4 + 2 * panel_h), w, int(panel_h)),
        ]

        for seg in self._segments:
            xa = self._time_to_x(seg.start, x0, w)
            xb = self._time_to_x(seg.end, x0, w)
            for r in rects:
                p.fillRect(QRect(xa, r.top(), max(1, xb - xa), r.height()), QColor(80, 140, 200, 16))

        self._draw_panel(p, rects[0], self._source, "源音", QColor("#1b5e20"))
        self._draw_panel(
            p,
            rects[1],
            None if self._baseline is None else self._baseline.samples_audio,
            "无改动回读",
            QColor("#0b57d0"),
        )
        self._draw_panel(
            p,
            rects[2],
            None if self._trial is None else self._trial.samples_audio,
            "试改回读",
            QColor("#b3261e"),
        )

        # Shared time ruler.
        ruler_y = self.height() - 16
        p.setPen(QPen(QColor("#777"), 1))
        p.drawLine(x0, ruler_y, x0 + w, ruler_y)
        step = 0.5 if self._duration <= 4 else 1.0
        t = 0.0
        while t <= self._duration + 1e-6:
            x = self._time_to_x(t, x0, w)
            p.drawLine(x, ruler_y - 4, x, ruler_y + 4)
            p.setPen(QColor("#555"))
            p.drawText(x - 24, ruler_y + 2, 48, 14, Qt.AlignmentFlag.AlignCenter, f"{t:.1f}")
            p.setPen(QPen(QColor("#777"), 1))
            t += step

        x = self._time_to_x(self._time, x0, w)
        p.setPen(QPen(QColor("#111"), 1.6))
        p.drawLine(x, 2, x, self.height() - 2)
        p.setBrush(QColor("#111"))
        p.drawPolygon(QPolygon([QPoint(x - 5, 2), QPoint(x + 5, 2), QPoint(x, 9)]))
        p.setBrush(Qt.BrushStyle.NoBrush)
        p.end()
