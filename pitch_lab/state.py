"""三个图共享的时间轴 / 光标 / 圈选状态。"""

from __future__ import annotations

from dataclasses import dataclass

from PySide6.QtCore import QObject, Signal


class ViewState(QObject):
    viewChanged = Signal()
    cursorChanged = Signal(float)
    selectionChanged = Signal(object, object)  # t0, t1；None 表示清除

    def __init__(self, duration: float = 1.0):
        super().__init__()
        self._duration = max(duration, 1e-6)
        self._t0 = 0.0
        self._t1 = self._duration
        self.cursor: float | None = None
        self.selection: tuple[float, float] | None = None

    @property
    def duration(self) -> float:
        return self._duration

    def reset(self, duration: float) -> None:
        self._duration = max(duration, 1e-6)
        self._t0, self._t1 = 0.0, self._duration
        self.cursor = None
        self.selection = None
        self.viewChanged.emit()
        self.selectionChanged.emit(None, None)

    @property
    def view(self) -> tuple[float, float]:
        return self._t0, self._t1

    def set_view(self, t0: float, t1: float) -> None:
        t0 = max(0.0, min(t0, self._duration - 1e-6))
        t1 = max(t0 + 1e-4, min(t1, self._duration))
        if abs(t0 - self._t0) > 1e-9 or abs(t1 - self._t1) > 1e-9:
            self._t0, self._t1 = t0, t1
            self.viewChanged.emit()

    def zoom(self, factor: float, center: float | None = None) -> None:
        if center is None:
            center = (self._t0 + self._t1) / 2.0
        center = min(max(center, self._t0), self._t1)
        span = (self._t1 - self._t0) * factor
        self.set_view(center - (center - self._t0) * factor,
                      center + (self._t1 - center) * factor)

    def pan_ratio(self, ratio: float) -> None:
        span = self._t1 - self._t0
        shift = span * ratio
        t0 = self._t0 + shift
        t1 = self._t1 + shift
        if t0 < 0:
            t0, t1 = 0.0, span
        if t1 > self._duration:
            t0, t1 = self._duration - span, self._duration
        self.set_view(t0, t1)

    def set_cursor(self, t: float) -> None:
        self.cursor = min(max(t, 0.0), self._duration)
        self.cursorChanged.emit(self.cursor)

    def set_selection(self, t0: float | None, t1: float | None) -> None:
        if t0 is None or t1 is None or abs(t1 - t0) < 1e-4:
            self.selection = None
            self.selectionChanged.emit(None, None)
        else:
            a, b = sorted((t0, t1))
            self.selection = (max(0.0, a), min(self._duration, b))
            self.selectionChanged.emit(*self.selection)
