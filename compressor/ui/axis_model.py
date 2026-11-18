"""四个绘图视图共享的时间轴状态（区间选择 / 光标 / 缩放）。"""

from __future__ import annotations

from PySide6.QtCore import QObject, Signal


class TimeAxisModel(QObject):
    rangeChanged = Signal(float, float)        # t0, t1（秒）
    selectionChanged = Signal(object)          # (t0, t1) 或 None
    cursorChanged = Signal(object)             # float 或 None

    def __init__(self, duration: float, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._duration = max(duration, 1e-9)
        self._t0 = 0.0
        self._t1 = self._duration
        self._selection: tuple[float, float] | None = None
        self._cursor: float | None = None

    @property
    def duration(self) -> float:
        return self._duration

    def view_range(self) -> tuple[float, float]:
        return self._t0, self._t1

    def set_range(self, t0: float, t1: float) -> None:
        t0 = float(np_clip(t0, 0.0, self._duration))
        t1 = float(np_clip(t1, 0.0, self._duration))
        if t1 - t0 < 1e-4:
            t1 = min(self._duration, t0 + 1e-4)
        if abs(t0 - self._t0) > 1e-9 or abs(t1 - self._t1) > 1e-9:
            self._t0, self._t1 = t0, t1
            self.rangeChanged.emit(t0, t1)

    def reset(self, duration: float) -> None:
        """换文件时复用同一模型：重置时长与所有视图状态。"""
        self._duration = max(float(duration), 1e-9)
        self._t0, self._t1 = 0.0, self._duration
        self._selection = None
        self._cursor = None
        self.rangeChanged.emit(0.0, self._duration)
        self.selectionChanged.emit(None)
        self.cursorChanged.emit(None)

    def reset_zoom(self) -> None:
        self.set_range(0.0, self._duration)

    def selection(self) -> tuple[float, float] | None:
        return self._selection

    def set_selection(self, sel: tuple[float, float] | None) -> None:
        if sel is not None:
            a, b = sorted(sel)
            sel = (float(np_clip(a, 0, self._duration)),
                   float(np_clip(b, 0, self._duration)))
            if sel[1] - sel[0] < 1e-4:
                sel = None
        self._selection = sel
        self.selectionChanged.emit(sel)

    def cursor(self) -> float | None:
        return self._cursor

    def set_cursor(self, t: float | None) -> None:
        if t is not None:
            t = float(np_clip(t, 0.0, self._duration))
        self._cursor = t
        self.cursorChanged.emit(t)


def np_clip(v, lo, hi):
    return max(lo, min(hi, v))
