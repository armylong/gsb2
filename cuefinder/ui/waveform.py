"""波形视图：上排查询，下排参考命中区间，同一时间位置垂直对齐。"""
from __future__ import annotations

import numpy as np
from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import QColor, QPainter, QPen, QPolygonF
from PySide6.QtWidgets import QSizePolicy, QWidget

QUERY_COLOR = QColor("#2f6feb")
REF_COLOR = QColor("#e07b39")
GOOD_FILL = QColor(47, 111, 235, 34)
MISS_FILL = QColor(192, 57, 43, 44)
NONE_FILL = QColor(0, 0, 0, 0)
OVERRUN_FILL = QColor(140, 140, 140, 55)
END_MARK = QColor("#b03a2e")
GRID = QColor(0, 0, 0, 28)
TEXT = QColor("#3a3f47")
BG = QColor("#ffffff")
BG_ALT = QColor("#f6f7f9")


def _envelope(samples: np.ndarray, width: int) -> tuple[np.ndarray, np.ndarray]:
    if samples.size == 0 or width <= 0:
        return np.zeros(0), np.zeros(0)
    x = np.asarray(samples, dtype=np.float64)
    n = int(width)
    edges = np.linspace(0, x.size, n + 1).astype(int)
    lo = np.zeros(n)
    hi = np.zeros(n)
    for i in range(n):
        seg = x[edges[i]:max(edges[i] + 1, edges[i + 1])]
        lo[i] = float(seg.min())
        hi[i] = float(seg.max())
    return lo, hi


class WaveformCompare(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumHeight(200)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self._query = np.zeros(0)
        self._ref = np.zeros(0)
        self._good: np.ndarray | None = None
        self._evidence: np.ndarray | None = None
        self._unsupported: list[tuple[int, int]] = []
        self._hop = 0.005
        self._fs_q = 16000
        self._fs_r = 16000
        self._overrun = 0.0
        self._ref_dur = 0.0
        self._total_span = 1.0
        self._playhead = None
        self._env_cache: dict[tuple[int, int], tuple[np.ndarray, np.ndarray]] = {}

    def set_data(self, query: np.ndarray, ref: np.ndarray,
                 good: np.ndarray | None = None,
                 unsupported: list[tuple[int, int]] | None = None,
                 evidence: np.ndarray | None = None,
                 hop_sec: float = 0.005,
                 overrun_sec: float = 0.0,
                 fs_query: int = 16000, fs_ref: int = 16000,
                 span_sec: float | None = None) -> None:
        self._query = np.asarray(query, dtype=np.float64)
        self._ref = np.asarray(ref, dtype=np.float64)
        self._good = None if good is None else np.asarray(good, dtype=bool)
        self._evidence = None if evidence is None else np.asarray(evidence, dtype=np.int8)
        self._unsupported = list(unsupported or [])
        self._hop = float(hop_sec)
        self._fs_q = int(fs_query)
        self._fs_r = int(fs_ref)
        self._overrun = float(overrun_sec)
        self._ref_dur = self._ref.size / float(max(1, self._fs_r))
        qdur = self._query.size / float(max(1, self._fs_q))
        self._total_span = float(span_sec) if span_sec else max(qdur, self._ref_dur + self._overrun, 1e-6)
        self._playhead = None
        self._env_cache = {}
        self.update()

    def set_playhead(self, sec: float | None) -> None:
        self._playhead = sec
        self.update()

    def clear(self) -> None:
        self.set_data(np.zeros(0), np.zeros(0))

    def paintEvent(self, event) -> None:  # noqa: N802
        p = QPainter(self)
        try:
            p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
            rect = self.rect()
            label_h = 18
            pad = 9
            mid_gap = 16
            w = max(10, rect.width() - 2 * pad)
            block = (rect.height() - 2 * pad - 2 * label_h - mid_gap) / 2
            block = max(30.0, block)
            top = QRectF(pad, pad + label_h, w, block)
            bottom = QRectF(pad, top.bottom() + label_h + mid_gap, w, block)
            p.fillRect(rect, BG)
            self._draw_panel(p, top, self._query, QUERY_COLOR, "查询", self._fs_q)
            self._draw_panel(p, bottom, self._ref, REF_COLOR, "参考命中区间", self._fs_r)
            self._draw_alignment(p, top, bottom)
            self._draw_playhead(p, top, bottom)
        finally:
            p.end()

    def _draw_alignment(self, p: QPainter, top: QRectF, bottom: QRectF) -> None:
        if self._good is None or self._good.size == 0:
            return
        span = max(self._total_span, 1e-6)
        T = self._good.size
        for i in range(T):
            x = top.left() + (i * self._hop / span) * top.width()
            w = max(1.0, self._hop / span * top.width())
            if self._evidence is not None and i < self._evidence.size:
                lvl = int(self._evidence[i])
                fill = (GOOD_FILL if lvl == 1 else
                        MISS_FILL if lvl == 2 else NONE_FILL)
            else:
                fill = GOOD_FILL if self._good[i] else MISS_FILL
            if fill.alpha() > 0:
                p.fillRect(QRectF(x, top.top(), w, top.height()), fill)
                p.fillRect(QRectF(x, bottom.top(), w, bottom.height()), fill)
        if self._overrun > 0 and self._ref_dur > 0:
            x0 = bottom.left() + (self._ref_dur / span) * bottom.width()
            x1 = bottom.left() + ((self._ref_dur + self._overrun) / span) * bottom.width()
            if x1 - x0 > 1:
                p.fillRect(QRectF(x0, bottom.top(), x1 - x0, bottom.height()), OVERRUN_FILL)
                p.setPen(QPen(END_MARK, 1, Qt.PenStyle.DashLine))
                p.drawLine(QPointF(x0, bottom.top()), QPointF(x0, bottom.bottom()))

    def _draw_playhead(self, p: QPainter, top: QRectF, bottom: QRectF) -> None:
        if self._playhead is None:
            return
        x = top.left() + (self._playhead / max(self._total_span, 1e-6)) * top.width()
        p.setPen(QPen(QColor("#d9480f"), 1.4))
        p.drawLine(QPointF(x, top.top()), QPointF(x, bottom.bottom()))

    def _draw_panel(self, p: QPainter, rect: QRectF, data: np.ndarray,
                    color: QColor, title: str, unit_fs: int) -> None:
        p.fillRect(rect, BG_ALT)
        p.setPen(QPen(QColor(0, 0, 0, 30), 1))
        p.setBrush(Qt.BrushStyle.NoBrush)
        p.drawRect(rect)
        p.setPen(TEXT)
        dur = data.size / float(unit_fs) if data.size else 0.0
        p.drawText(QRectF(rect.left(), rect.top() - 18, rect.width(), 16),
                   Qt.AlignmentFlag.AlignLeft, f"{title}  {dur*1000:.0f} ms")
        if data.size == 0:
            p.setPen(QColor(120, 120, 120))
            p.drawText(rect, Qt.AlignmentFlag.AlignCenter, "（无数据）")
            return
        width = max(2, min(int(rect.width()), 2400))
        key = width
        cached = self._env_cache.get(("q" if data is self._query else "r", key))
        if cached is None:
            cached = _envelope(data, width)
            if len(self._env_cache) > 8:
                self._env_cache.clear()
            self._env_cache[("q" if data is self._query else "r", key)] = cached
        lo, hi = cached
        peak = max(float(np.max(np.abs(lo)) if lo.size else 0.0),
                   float(np.max(np.abs(hi)) if hi.size else 0.0), 1e-9)
        mid = rect.center().y()
        half = rect.height() / 2.0 - 2
        scale = half / peak
        top_pts = []
        bot_pts = []
        for i in range(width):
            x = rect.left() + i * rect.width() / width
            top_pts.append(QPointF(x, mid - hi[i] * scale))
            bot_pts.append(QPointF(x, mid - lo[i] * scale))
        p.setPen(Qt.PenStyle.NoPen)
        p.setBrush(color)
        p.drawPolygon(QPolygonF(top_pts + list(reversed(bot_pts))))
        p.setPen(QPen(QColor(0, 0, 0, 60), 0.8))
        p.drawLine(QPointF(rect.left(), mid), QPointF(rect.right(), mid))
