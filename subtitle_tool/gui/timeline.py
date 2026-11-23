"""Timeline widget: events, scene cuts, playhead and the rows at that time.

The timeline is the verification surface — no video is needed.  Drag anywhere
(or press ←/→) to move the playhead; the panel underneath lists exactly the
rows that are on screen at that millisecond, including warnings attached to
those events.
"""

from __future__ import annotations

from typing import Optional, Tuple

from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import (
    QColor,
    QMouseEvent,
    QPainter,
    QPen,
    QPolygonF,
    QWheelEvent,
)
from PySide6.QtWidgets import QSizePolicy, QWidget

from ..model import Project
from ..srt import ms_to_short
from .common import STATUS_COLORS, lang_color

TRACK_HEIGHT = 26
RULER_HEIGHT = 22
PAD = 10


class TimelineWidget(QWidget):
    timeClicked = Signal(int)
    eventClicked = Signal(str)

    def __init__(self, parent: Optional[QWidget] = None) -> None:
        super().__init__(parent)
        self.project: Optional[Project] = None
        self.time_ms: int = 0
        self.selected_eid: str = ""
        self.zoom_ms: int = 0  # 0 = fit whole project
        self.view_start: int = 0
        self._dragging = False
        self.setMinimumHeight(TRACK_HEIGHT * 3 + RULER_HEIGHT + PAD * 2)
        self.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Preferred)
        self.setMouseTracking(True)
        self.setFocusPolicy(Qt.StrongFocus)

    # -- data -------------------------------------------------------------
    def set_project(self, project: Optional[Project]) -> None:
        self.project = project
        self.update()

    def set_time(self, t: int) -> None:
        self.time_ms = max(0, int(t))
        self.update()

    def span(self) -> Tuple[int, int]:
        if self.project is None:
            return (0, 60_000)
        total = self.project.project_duration()
        if self.zoom_ms > 0:
            start = min(self.view_start, max(0, total - self.zoom_ms))
            return (start, start + self.zoom_ms)
        return (0, max(1, total))

    def _x_for(self, t: int) -> float:
        start, end = self.span()
        width = max(1.0, self.width() - PAD * 2)
        return PAD + width * (t - start) / max(1, end - start)

    def _time_for(self, x: float) -> int:
        start, end = self.span()
        width = max(1.0, self.width() - PAD * 2)
        return int(round(start + (x - PAD) / width * (end - start)))

    # -- painting ---------------------------------------------------------
    def paintEvent(self, event) -> None:  # noqa: N802
        painter = QPainter(self)
        try:
            self._paint(painter)
        finally:
            painter.end()

    def _paint(self, painter: QPainter) -> None:
        painter.setRenderHint(QPainter.Antialiasing, False)
        painter.fillRect(self.rect(), QColor("#fbfbfb"))
        if self.project is None:
            painter.setPen(QColor("#888"))
            painter.drawText(self.rect(), Qt.AlignCenter, "导入两条字幕轨后可预览时间轴")
            return
        start, end = self.span()
        width = self.width()

        # ruler
        painter.fillRect(QRectF(0, 0, width, RULER_HEIGHT), QColor("#eceff1"))
        painter.setPen(QPen(QColor("#b0bec5")))
        painter.drawLine(0, RULER_HEIGHT, width, RULER_HEIGHT)
        step = _nice_step(end - start, max(2, width // 90))
        t = (start // step) * step
        while t <= end:
            x = self._x_for(t)
            painter.setPen(QPen(QColor("#90a4ae")))
            painter.drawLine(QPointF(x, RULER_HEIGHT - 5), QPointF(x, RULER_HEIGHT))
            painter.setPen(QColor("#546e7a"))
            painter.drawText(QPointF(x + 2, RULER_HEIGHT - 8), ms_to_short(t))
            t += step

        langs = list(self.project.lang_order)
        for index, lang in enumerate(langs):
            y = RULER_HEIGHT + PAD + index * TRACK_HEIGHT
            painter.fillRect(
                QRectF(0, y, width, TRACK_HEIGHT),
                QColor("#ffffff") if index % 2 == 0 else QColor("#f5f7f8"),
            )
            painter.setPen(QColor("#9e9e9e"))
            painter.drawLine(0, y + TRACK_HEIGHT, width, y + TRACK_HEIGHT)
            painter.setPen(lang_color(index))
            painter.drawText(QPointF(4, y + TRACK_HEIGHT - 8),
                             self.project.lang_label(lang))

            for ev in self.project.sorted_events():
                if not ev.rows_for(lang):
                    continue
                x1 = self._x_for(ev.start_ms)
                x2 = self._x_for(ev.end_ms)
                if x2 - x1 < 1:
                    x2 = x1 + 1
                rect = QRectF(x1, y + 4, x2 - x1, TRACK_HEIGHT - 8)
                status = self.project.event_status(ev)
                color = STATUS_COLORS.get(status, QColor("#546e7a"))
                if not any(r.visible for r in ev.rows_for(lang)):
                    color = STATUS_COLORS["missing"]
                fill = QColor(color)
                fill.setAlpha(80 if ev.eid != self.selected_eid else 170)
                painter.setBrush(fill)
                painter.setPen(QPen(color, 2 if ev.eid == self.selected_eid else 1))
                painter.drawRoundedRect(rect, 3, 3)
                if ev.locked:
                    painter.setPen(QColor("#1565c0"))
                    painter.setBrush(QColor("#1565c0"))
                    painter.drawEllipse(
                        QPointF(rect.left() + 5, rect.center().y()), 3, 3
                    )

        # scene cuts
        cut_y = RULER_HEIGHT + PAD
        cut_bottom = cut_y + TRACK_HEIGHT * max(1, len(langs))
        for cut in self.project.cuts:
            x = self._x_for(cut)
            pen = QPen(STATUS_COLORS["cut"], 2, Qt.DashLine)
            painter.setPen(pen)
            painter.drawLine(QPointF(x, cut_y), QPointF(x, cut_bottom))
            painter.setPen(QColor("#bf360c"))
            painter.drawText(QPointF(x + 2, cut_bottom + 11), "切")

        # playhead
        x = self._x_for(self.time_ms)
        painter.setPen(QPen(QColor("#c62828"), 2))
        painter.drawLine(QPointF(x, 0), QPointF(x, self.height()))
        painter.setBrush(QColor("#c62828"))
        painter.setPen(Qt.NoPen)
        painter.drawPolygon(
            QPolygonF([QPointF(x - 5, 0), QPointF(x + 5, 0), QPointF(x, 8)])
        )

    # -- interaction ------------------------------------------------------
    def mousePressEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if event.button() == Qt.LeftButton and self.project is not None:
            self._dragging = True
            self._emit_at(event.position().x(), event.position().y())
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if self._dragging and self.project is not None:
            self.set_time(self._time_for(event.position().x()))
            self.timeClicked.emit(self.time_ms)
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        self._dragging = False
        super().mouseReleaseEvent(event)

    def _emit_at(self, x: float, y: float) -> None:
        assert self.project is not None
        t = self._time_for(x)
        self.set_time(t)
        self.timeClicked.emit(t)
        # clicking on a block also selects that event
        track_index = int((y - RULER_HEIGHT - PAD) // TRACK_HEIGHT)
        if 0 <= track_index < len(self.project.lang_order):
            lang = self.project.lang_order[track_index]
            for ev in self.project.sorted_events():
                if ev.start_ms <= t < ev.end_ms and ev.rows_for(lang):
                    self.selected_eid = ev.eid
                    self.eventClicked.emit(ev.eid)
                    break

    def wheelEvent(self, event: QWheelEvent) -> None:  # noqa: N802
        if self.project is None:
            return
        if event.modifiers() & Qt.ShiftModifier:
            if self.zoom_ms <= 0:
                self.zoom_ms = max(2000, self.project.project_duration() // 2)
            factor = 0.8 if event.angleDelta().y() > 0 else 1.25
            self.zoom_ms = int(max(1000, min(600_000, self.zoom_ms * factor)))
            self.view_start = max(0, self.time_ms - self.zoom_ms // 2)
            self.update()
        elif event.modifiers() & Qt.ControlModifier:
            self.zoom_ms = 0
            self.view_start = 0
            self.update()
        else:
            self.set_time(self.time_ms + (-1 if event.angleDelta().y() > 0 else 1) * 500)
            self.timeClicked.emit(self.time_ms)

    def keyPressEvent(self, event) -> None:  # noqa: N802
        step = 500
        if event.modifiers() & Qt.ShiftModifier:
            step = 100
        if event.key() == Qt.Key_Left:
            self.set_time(self.time_ms - step)
            self.timeClicked.emit(self.time_ms)
        elif event.key() == Qt.Key_Right:
            self.set_time(self.time_ms + step)
            self.timeClicked.emit(self.time_ms)
        elif event.key() == Qt.Key_Home:
            self.set_time(self.span()[0])
            self.timeClicked.emit(self.time_ms)
        elif event.key() == Qt.Key_End:
            self.set_time(self.span()[1] - 1)
            self.timeClicked.emit(self.time_ms)
        else:
            super().keyPressEvent(event)


def _nice_step(span_ms: int, ticks: int) -> int:
    raw = max(1, span_ms // max(1, ticks))
    for step in (
        100, 250, 500, 1000, 2000, 5000, 10_000, 15_000, 30_000, 60_000,
        120_000, 300_000, 600_000,
    ):
        if raw <= step:
            return step
    return 600_000
