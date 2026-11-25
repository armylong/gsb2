"""自定义绘图控件 (纯 QPainter, 不依赖 matplotlib):

- SpectrogramWidget: 对数频率谱图热图, 叠加测试区间/试听段/提示音位置,
  点击或拖拽选择 (时间, 频带), 同步高亮试听区间。
- EnergyGridWidget: 频带小多联, 同一测试区间内逐带比较背景(灰)与
  各提示音(分类色)的时变能量, 点击任意小图选中该频带。
"""

from __future__ import annotations

import numpy as np
from PySide6.QtCore import QPoint, QRect, Qt, Signal
from PySide6.QtGui import (
    QColor,
    QFont,
    QImage,
    QMouseEvent,
    QPainter,
    QPen,
    QPolygon,
)
from PySide6.QtWidgets import QToolTip, QWidget

# ---- 来自 dataviz 参考调色板 (已通过 CVD/对比度校验的前 3 槽 + 蓝色连续阶) ----
SURFACE = QColor("#fcfcfb")
INK_PRIMARY = QColor("#0b0b0b")
INK_SECONDARY = QColor("#52514e")
INK_MUTED = QColor("#898781")
GRID_LINE = QColor("#e1e0d9")
AXIS_LINE = QColor("#c3c2b7")
SERIES_COLORS = ["#2a78d6", "#eb6834", "#1baf7a"]  # 蓝/橙/青, 最多 3 路提示音
BG_CURVE = QColor("#898781")  # 背景曲线固定用中性灰, 与分类色区分
SELECT_BORDER = QColor("#0b0b0b")
TEST_SHADE = QColor(42, 120, 214, 26)
SEG_SHADE = QColor(42, 120, 214, 52)
PLAYHEAD = QColor("#e34948")
BAND_MARK = QColor("#52514e")
CUE_MARK = QColor("#eda100")
CUE_MARK_ALPHA = 46

# 蓝色连续色阶 (浅->深), 谱图近零值与浅色纸面自然融合
_RAMP_STOPS = [
    "#f4f8fe", "#cde2fb", "#b7d3f6", "#9ec5f4",
    "#86b6ef", "#6da7ec", "#5598e7", "#3987e5",
    "#2a78d6", "#256abf", "#1c5cab", "#184f95",
    "#104281", "#0d366b",
]
_LUT_N = 160


def build_lut() -> list[QColor]:
    stops = [QColor(h) for h in _RAMP_STOPS]
    lut: list[QColor] = []
    for i in range(_LUT_N):
        pos = i / (_LUT_N - 1) * (len(stops) - 1)
        k = min(int(pos), len(stops) - 2)
        frac = pos - k
        c0, c1 = stops[k], stops[k + 1]
        lut.append(
            QColor(
                int(c0.red() + (c1.red() - c0.red()) * frac),
                int(c0.green() + (c1.green() - c0.green()) * frac),
                int(c0.blue() + (c1.blue() - c0.blue()) * frac),
            )
        )
    return lut


LUT = build_lut()


def _time_ticks(t0: float, t1: float, max_ticks: int = 9) -> list[float]:
    """生成不超过 max_ticks 个整齐时间刻度。"""
    span = max(t1 - t0, 1e-6)
    raw = np.array([0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1.0, 2.0, 5.0, 10.0, 30.0, 60.0])
    step = raw[np.searchsorted(raw, span / max_ticks)]
    first = np.ceil(t0 / step) * step
    ticks = list(np.arange(first, t1 + step * 0.5, step))
    return [float(t) for t in ticks if t0 - 1e-9 <= t <= t1 + 1e-9]


class SpectrogramWidget(QWidget):
    """谱图热图 + 区间/频带/播放头叠加。"""

    selectionMade = Signal(float, int)   # 点击时刻, 频带编号
    rangeChanged = Signal(float, float)  # 拖拽得到的新试听段 (起点, 时长)

    MARGIN_L = 64
    MARGIN_R = 14
    MARGIN_T = 26
    MARGIN_B = 30

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumHeight(260)
        self.setMouseTracking(True)
        self._heat: np.ndarray | None = None
        self._times = np.zeros(0)
        self._f_edges = np.zeros(0)
        self._band_edges = np.zeros(0)
        self._t0 = 0.0
        self._t1 = 1.0
        self.test_range = (0.0, 1.0)
        self.seg_range = (0.0, 1.0)
        self.cue_ranges: list[tuple[float, float]] = []
        self.selected_band = 0
        self.playhead: float | None = None
        self._drag: tuple[float, float] | None = None
        self._image: QImage | None = None

    # ---- 数据 ----
    def set_data(self, heat_db: np.ndarray, times: np.ndarray, f_edges: np.ndarray,
                 band_edges: np.ndarray, t0: float, t1: float):
        self._heat = heat_db
        self._times = times
        self._f_edges = f_edges
        self._band_edges = band_edges
        self._t0, self._t1 = t0, t1
        self._image = None
        self.update()

    def set_overlays(self, test_range, seg_range, cue_ranges, selected_band: int,
                     playhead: float | None):
        self.test_range = tuple(test_range)
        self.seg_range = tuple(seg_range)
        self.cue_ranges = list(cue_ranges)
        self.selected_band = selected_band
        self.playhead = playhead
        self.update()

    # ---- 坐标换算 ----
    def _plot_rect(self) -> QRect:
        return QRect(
            self.MARGIN_L, self.MARGIN_T,
            max(10, self.width() - self.MARGIN_L - self.MARGIN_R),
            max(10, self.height() - self.MARGIN_T - self.MARGIN_B),
        )

    def _x_of_t(self, t: float, r: QRect) -> float:
        return r.left() + (t - self._t0) / max(self._t1 - self._t0, 1e-9) * r.width()

    def _t_of_x(self, x: float, r: QRect) -> float:
        u = (x - r.left()) / max(r.width(), 1)
        return self._t0 + np.clip(u, 0.0, 1.0) * (self._t1 - self._t0)

    def _y_of_freq(self, f: float, r: QRect) -> float:
        lo, hi = np.log(self._f_edges[0]), np.log(self._f_edges[-1])
        u = (np.log(max(f, self._f_edges[0])) - lo) / max(hi - lo, 1e-9)
        return r.bottom() - u * r.height()

    def _freq_of_y(self, y: float, r: QRect) -> float:
        lo, hi = np.log(self._f_edges[0]), np.log(self._f_edges[-1])
        u = (r.bottom() - y) / max(r.height(), 1)
        return float(np.exp(lo + np.clip(u, 0.0, 1.0) * (hi - lo)))

    def _band_at_y(self, y: float, r: QRect) -> int:
        f = self._freq_of_y(y, r)
        for b in range(len(self._band_edges) - 1):
            if self._band_edges[b] <= f < self._band_edges[b + 1]:
                return b
        return len(self._band_edges) - 2

    # ---- 绘制 ----
    def _build_image(self, r: QRect) -> QImage:
        h, w = self._heat.shape
        vmin, vmax = np.percentile(self._heat, [8, 99.5])
        if vmax - vmin < 6:
            vmax = vmin + 6
        idx = np.clip(
            ((self._heat - vmin) / (vmax - vmin) * (_LUT_N - 1)).astype(np.int32),
            0, _LUT_N - 1,
        )
        # 向量化查 LUT (RGB 通道), 行序翻转让低频在下方
        lut_rgb = np.array([(c.red(), c.green(), c.blue()) for c in LUT], dtype=np.uint8)
        rgb = lut_rgb[idx[::-1, :], :]  # (h, w, 3)
        rgb = np.ascontiguousarray(rgb)
        img = QImage(rgb.data, w, h, 3 * w, QImage.Format.Format_RGB888).copy()
        return img.scaled(
            r.width(), r.height(),
            Qt.AspectRatioMode.IgnoreAspectRatio,
            Qt.TransformationMode.SmoothTransformation,
        )

    def paintEvent(self, event):  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing, False)
        p.fillRect(self.rect(), SURFACE)
        r = self._plot_rect()
        p.fillRect(r, QColor("#f4f8fe"))

        if self._heat is not None and self._heat.size:
            if self._image is None or self._image.size() != r.size():
                self._image = self._build_image(r)
            p.drawImage(r, self._image)

        p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        # 测试区间底色
        x0, x1 = self._x_of_t(self.test_range[0], r), self._x_of_t(self.test_range[1], r)
        p.fillRect(QRect(int(x0), r.top(), int(x1 - x0), r.height()), TEST_SHADE)
        # 提示音覆盖范围 (琥珀色淡带)
        for cs, ce in self.cue_ranges:
            cx0, cx1 = self._x_of_t(cs, r), self._x_of_t(ce, r)
            p.fillRect(QRect(int(cx0), r.top(), max(1, int(cx1 - cx0)), r.height()),
                       QColor(237, 161, 0, CUE_MARK_ALPHA))
        # 试听段
        s0, s1 = self._x_of_t(self.seg_range[0], r), self._x_of_t(self.seg_range[1], r)
        p.fillRect(QRect(int(s0), r.top(), int(s1 - s0), r.height()), SEG_SHADE)
        for x in (s0, s1):
            p.setPen(QPen(BAND_MARK, 1.4, Qt.PenStyle.DashLine))
            p.drawLine(int(x), r.top(), int(x), r.bottom())

        # 频带分界线 + 选中带双横线
        p.setPen(QPen(GRID_LINE, 1.0))
        for f in self._band_edges[1:-1]:
            y = self._y_of_freq(f, r)
            p.drawLine(r.left(), int(y), r.right(), int(y))
        if len(self._band_edges) > 1:
            ylo = self._y_of_freq(self._band_edges[self.selected_band], r)
            yhi = self._y_of_freq(self._band_edges[self.selected_band + 1], r)
            p.setPen(QPen(SELECT_BORDER, 2.0))
            p.drawLine(r.left(), int(ylo), r.right(), int(ylo))
            p.drawLine(r.left(), int(yhi), r.right(), int(yhi))

        # 坐标框与文字
        p.setPen(QPen(AXIS_LINE, 1.0))
        p.drawRect(r)
        p.setPen(INK_MUTED)
        font = QFont()
        font.setPointSize(9)
        p.setFont(font)
        for t in _time_ticks(self._t0, self._t1):
            x = int(self._x_of_t(t, r))
            p.setPen(QPen(GRID_LINE, 1.0))
            p.drawLine(x, r.bottom(), x, r.bottom() + 4)
            p.setPen(INK_MUTED)
            p.drawText(QRect(x - 42, r.bottom() + 6, 84, 18),
                       Qt.AlignmentFlag.AlignCenter, f"{t:.2f}s")
        # 频率刻度 (对数)
        f_lo, f_hi = self._f_edges[0], self._f_edges[-1]
        candidates = np.array([100, 200, 500, 1000, 2000, 5000, 10000])
        for f in candidates:
            if f_lo <= f <= f_hi:
                y = int(self._y_of_freq(f, r))
                p.setPen(QPen(GRID_LINE, 1.0))
                p.drawLine(r.left() - 4, y, r.left(), y)
                p.setPen(INK_MUTED)
                label = f"{f/1000:.1f}k" if f >= 1000 else f"{int(f)}"
                p.drawText(QRect(2, y - 9, self.MARGIN_L - 8, 18),
                           Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter, label)
        # 频带编号标在左侧每个带的中心 (带半透明衬底, 避免被深色能量区压住)
        for b in range(len(self._band_edges) - 1):
            yc = (self._y_of_freq(self._band_edges[b], r)
                  + self._y_of_freq(self._band_edges[b + 1], r)) / 2
            chip = QRect(r.left() + 3, int(yc) - 8, 26, 16)
            p.fillRect(chip, QColor(252, 252, 251, 190))
            p.setPen(INK_SECONDARY)
            p.drawText(chip,
                       Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter, f"B{b+1}")

        # 播放头
        if self.playhead is not None and self._t0 <= self.playhead <= self._t1:
            x = int(self._x_of_t(self.playhead, r))
            p.setPen(QPen(PLAYHEAD, 2.0))
            p.drawLine(x, r.top(), x, r.bottom())

        # 拖拽预览
        if self._drag is not None:
            d0, d1 = sorted(self._drag)
            x0, x1 = self._x_of_t(d0, r), self._x_of_t(d1, r)
            p.setPen(QPen(SELECT_BORDER, 1.6, Qt.PenStyle.DashLine))
            p.drawRect(QRect(int(x0), r.top(), max(2, int(x1 - x0)), r.height()))

        p.setPen(INK_PRIMARY)
        p.drawText(QRect(r.left(), 2, r.width(), self.MARGIN_T - 6),
                   Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter,
                   "谱图 (对数频率, 蓝色越深能量越高) — 点击选带/定位, 横向拖拽改试听段")

    # ---- 鼠标 ----
    def mousePressEvent(self, ev: QMouseEvent):  # noqa: N802
        if ev.button() != Qt.MouseButton.LeftButton:
            return
        r = self._plot_rect()
        if not r.contains(ev.position().toPoint()):
            return
        t = self._t_of_x(ev.position().x(), r)
        band = self._band_at_y(ev.position().y(), r)
        self._drag = (t, t)
        self.selectionMade.emit(t, band)

    def mouseMoveEvent(self, ev: QMouseEvent):  # noqa: N802
        r = self._plot_rect()
        if self._drag is not None:
            t = self._t_of_x(ev.position().x(), r)
            self._drag = (self._drag[0], t)
            self.update()
            return
        if r.contains(ev.position().toPoint()):
            t = self._t_of_x(ev.position().x(), r)
            f = self._freq_of_y(ev.position().y(), r)
            band = self._band_at_y(ev.position().y(), r)
            QToolTip.showText(
                ev.globalPosition().toPoint(),
                f"t = {t:.3f}s\nf ≈ {f:,.0f} Hz\n频带 B{band+1}",
                self,
            )

    def mouseReleaseEvent(self, ev: QMouseEvent):  # noqa: N802
        if self._drag is None:
            return
        r = self._plot_rect()
        t1 = self._t_of_x(ev.position().x(), r)
        t0, t1 = sorted((self._drag[0], t1))
        self._drag = None
        if t1 - t0 >= 0.05:  # 视为拖拽, 更新试听段
            self.rangeChanged.emit(t0, t1 - t0)
        self.update()


class EnergyGridWidget(QWidget):
    """频带时变能量小多联: 灰=背景, 分类色=各提示音。"""

    bandSelected = Signal(int)
    timeClicked = Signal(float)

    MARGIN_L = 64
    MARGIN_R = 14
    MARGIN_T = 26
    MARGIN_B = 40
    GAP = 10

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumHeight(300)
        self.setMouseTracking(True)
        self.times = np.zeros(0)
        self.bg_db: np.ndarray | None = None
        self.cue_db: list[np.ndarray] = []
        self.cue_names: list[str] = []
        self.edges = np.zeros(0)
        self.t0 = 0.0
        self.t1 = 1.0
        self.selected_band = 0
        self.seg_range = (0.0, 1.0)
        self.playhead: float | None = None
        self._vmin = -80.0
        self._vmax = 0.0

    def set_data(self, times, bg_db, cue_db, cue_names, edges, t0, t1):
        self.times = np.asarray(times)
        self.bg_db = None if bg_db is None else np.asarray(bg_db)
        self.cue_db = [np.asarray(a) for a in cue_db]
        self.cue_names = list(cue_names)
        self.edges = np.asarray(edges)
        self.t0, self.t1 = t0, t1
        all_db = []
        if self.bg_db is not None:
            all_db.append(self.bg_db.ravel())
        all_db.extend(a.ravel() for a in self.cue_db)
        if all_db:
            joined = np.concatenate(all_db)
            self._vmin = max(float(np.percentile(joined, 5)), -85.0)
            self._vmax = float(np.percentile(joined, 99)) + 3
            if self._vmax - self._vmin < 12:
                self._vmax = self._vmin + 12
        self.update()

    def set_state(self, selected_band: int, seg_range, playhead: float | None):
        self.selected_band = selected_band
        self.seg_range = tuple(seg_range)
        self.playhead = playhead
        self.update()

    def _grid(self) -> tuple[int, int, list[QRect]]:
        n = max(1, len(self.edges) - 1)
        cols = 2
        rows = int(np.ceil(n / cols))
        avail_w = self.width() - self.MARGIN_L - self.MARGIN_R - self.GAP
        avail_h = self.height() - self.MARGIN_T - self.MARGIN_B - self.GAP * (rows - 1)
        cw = avail_w // cols
        ch = avail_h // rows
        rects = []
        for b in range(n):
            col = b % cols
            row = b // cols
            rects.append(
                QRect(
                    self.MARGIN_L + col * (cw + self.GAP),
                    self.MARGIN_T + row * (ch + self.GAP),
                    cw,
                    ch,
                )
            )
        return rows, cols, rects

    def _x_of_t(self, t: float, r: QRect) -> float:
        return r.left() + (t - self.t0) / max(self.t1 - self.t0, 1e-9) * r.width()

    def _y_of_db(self, v: float, r: QRect) -> float:
        u = (v - self._vmin) / max(self._vmax - self._vmin, 1e-9)
        return r.bottom() - np.clip(u, 0, 1) * r.height()

    def _band_at_pos(self, pos: QPoint) -> int | None:
        _, _, rects = self._grid()
        for b, r in enumerate(rects):
            if r.contains(pos):
                return b
        return None

    def paintEvent(self, event):  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        p.fillRect(self.rect(), SURFACE)
        if self.bg_db is None and not self.cue_db:
            p.setPen(INK_MUTED)
            p.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter, "导入或生成背景/提示音后显示频带能量")
            return
        _, _, rects = self._grid()
        n_bands = len(rects)
        font = QFont()
        font.setPointSize(8)
        p.setFont(font)

        for b, r in enumerate(rects):
            active = b == self.selected_band
            col = b % 2
            p.fillRect(r, QColor("#ffffff") if active else QColor("#fbfbfa"))
            # 试听段竖带
            sx0 = self._x_of_t(self.seg_range[0], r)
            sx1 = self._x_of_t(self.seg_range[1], r)
            p.fillRect(QRect(int(sx0), r.top(), int(sx1 - sx0), r.height()), SEG_SHADE)
            # dB 网格 (低强度, 每 20dB 一条); 数值标签只在左列
            db = np.ceil(self._vmin / 20) * 20
            while db <= self._vmax:
                y = int(self._y_of_db(db, r))
                p.setPen(QPen(GRID_LINE, 0.8))
                p.drawLine(r.left(), y, r.right(), y)
                if col == 0:
                    p.setPen(INK_MUTED)
                    p.drawText(QRect(r.left() - 44, y - 8, 40, 16),
                               Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter,
                               f"{int(db)}")
                db += 20

            def poly(db_arr: np.ndarray) -> QPolygon:
                pts = []
                for i, t in enumerate(self.times):
                    if self.t0 <= t <= self.t1:
                        pts.append(QPoint(int(self._x_of_t(t, r)),
                                          int(self._y_of_db(db_arr[i, b], r))))
                return QPolygon(pts)

            if self.bg_db is not None:
                pen = QPen(BG_CURVE, 1.6)
                p.setPen(pen)
                p.drawPolyline(poly(self.bg_db))
            for k, arr in enumerate(self.cue_db):
                pen = QPen(QColor(SERIES_COLORS[k % len(SERIES_COLORS)]), 2.0)
                p.setPen(pen)
                p.drawPolyline(poly(arr))

            # 播放头
            if self.playhead is not None and self.t0 <= self.playhead <= self.t1:
                x = int(self._x_of_t(self.playhead, r))
                p.setPen(QPen(PLAYHEAD, 1.6))
                p.drawLine(x, r.top(), x, r.bottom())

            # 边框: 选中带加粗黑色, 其余细灰
            p.setPen(QPen(SELECT_BORDER if active else AXIS_LINE, 2.0 if active else 1.0))
            p.drawRect(r)
            # 带标签
            lo, hi = self.edges[b], self.edges[b + 1]
            label = f"B{b+1}  {lo:,.0f}–{hi:,.0f} Hz"
            fm = p.fontMetrics()
            text_w = fm.horizontalAdvance(label) + 8
            label_rect = QRect(r.left() + 2, r.top() + 1,
                               min(text_w, r.width() - 6), 17)
            # 半透明纸面衬底, 避免能量曲线压住标签文字
            p.fillRect(label_rect, QColor(252, 252, 251, 210))
            p.setPen(INK_PRIMARY if active else INK_SECONDARY)
            p.drawText(label_rect, Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter,
                       label)

            # 底排画时间刻度 (每个小多联各自底部, 但标签只在最底排整体画一次)
            if b >= n_bands - 2:
                for t in _time_ticks(self.t0, self.t1, max_ticks=5):
                    x = int(self._x_of_t(t, r))
                    p.setPen(QPen(GRID_LINE, 0.8))
                    p.drawLine(x, r.bottom(), x, r.bottom() + 3)

        # 最底排统一时间标签: 按整个网格宽度单排分布, 避免两列交界处重叠
        _, _, rects = self._grid()
        p.setPen(INK_MUTED)
        grid_left = rects[-2].left()
        grid_right = rects[-1].right()
        bottom = rects[-1].bottom()
        span = max(self.t1 - self.t0, 1e-9)
        for t in _time_ticks(self.t0, self.t1, max_ticks=9):
            x = int(grid_left + (t - self.t0) / span * (grid_right - grid_left))
            p.drawText(QRect(x - 36, bottom + 4, 72, 16),
                       Qt.AlignmentFlag.AlignCenter, f"{t:.2f}s")

        # 图例
        lx = self.MARGIN_L
        ly = 6
        items = [("背景", BG_CURVE)] + [
            (name, QColor(SERIES_COLORS[k % len(SERIES_COLORS)]))
            for k, name in enumerate(self.cue_names)
        ]
        for name, color in items:
            p.setPen(QPen(color, 2.4))
            p.drawLine(lx, ly + 7, lx + 22, ly + 7)
            p.setPen(INK_PRIMARY)
            p.drawText(QRect(lx + 26, ly, max(60, len(name) * 13), 16),
                       Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter, name)
            lx += 30 + max(60, len(name) * 13) + 16

    def mousePressEvent(self, ev: QMouseEvent):  # noqa: N802
        if ev.button() != Qt.MouseButton.LeftButton:
            return
        pos = ev.position().toPoint()
        b = self._band_at_pos(pos)
        if b is None:
            return
        _, _, rects = self._grid()
        r = rects[b]
        u = (pos.x() - r.left()) / max(r.width(), 1)
        t = self.t0 + np.clip(u, 0, 1) * (self.t1 - self.t0)
        self.bandSelected.emit(b)
        self.timeClicked.emit(float(t))

    def mouseMoveEvent(self, ev: QMouseEvent):  # noqa: N802
        b = self._band_at_pos(ev.position().toPoint())
        if b is None:
            return
        QToolTip.showText(
            ev.globalPosition().toPoint(),
            f"频带 B{b+1}: {self.edges[b]:,.0f}–{self.edges[b+1]:,.0f} Hz\n点击选中该频带并定位试听",
            self,
        )
