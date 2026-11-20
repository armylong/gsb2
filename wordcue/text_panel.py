"""文本面板: 整段文本按词/停顿切分展示, 点选高亮, 支持合并/拆分.  """

from __future__ import annotations

from PySide6.QtCore import QPointF, QRectF, Qt, Signal
from PySide6.QtGui import QColor, QFont, QFontMetricsF, QMouseEvent, QPainter, QPen
from PySide6.QtWidgets import QSizePolicy, QWidget

from .model import Timeline

TEXT = QColor("#C7CFDB")
IDLE_BG = QColor("#1A212B")
IDLE_EDGE = QColor("#2A3442")
SELECT_BG = QColor("#274A44")
SELECT_EDGE = QColor("#7FD1C8")
ACTIVE_BG = QColor("#3D3420")
ACTIVE_EDGE = QColor("#F5B942")
PAUSE_FG = QColor("#7D8899")
BAD_EDGE = QColor("#E45757")


class TextPanel(QWidget):
    """把时间轴里的词按阅读顺序平铺排出来.

    每个词是一个胶囊, 按阅读顺序换行排列; 点击词 (Ctrl/Shift 多选) 直接联动
    词表和时间轴。双击词 = 循环听该词。
    """

    selectionChanged = Signal(list)
    cueActivated = Signal(int)

    PAD = 6
    SPACING = 10
    LINE_GAP = 12
    MARGIN = 14

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.timeline = Timeline()
        self.selected: set[int] = set()
        self.active_id: int | None = None
        self.position_ms = 0
        self._boxes: list[tuple[object, QRectF, str]] = []
        self._font = QFont()
        self._font.setFamilies(["PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC",
                                "Microsoft YaHei", "Arial Unicode MS"])
        self._font.setPixelSize(19)
        self._need_layout = True
        self.setMouseTracking(True)
        self.setMinimumHeight(110)
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self.setFocusPolicy(Qt.FocusPolicy.ClickFocus)

    def set_timeline(self, timeline: Timeline) -> None:
        self.timeline = timeline
        self.selected &= {c.id for c in timeline.cues}
        self._need_layout = True
        self.update()

    def set_selection(self, ids: list[int]) -> None:
        new = set(ids)
        if new != self.selected:
            self.selected = new
            self.update()

    def set_active(self, cue_id: int | None) -> None:
        if cue_id != self.active_id:
            self.active_id = cue_id
            self.update()

    def set_position(self, ms: int) -> None:
        self.position_ms = ms
        self.update()

    # ------------------------------------------------------------------ 布局
    def _layout_boxes(self) -> None:
        self._boxes = []
        fm = QFontMetricsF(self._font)
        width = max(120, self.width() - self.MARGIN * 2)
        x = self.MARGIN
        y = self.MARGIN
        line_h = fm.height() + self.PAD * 2
        cues = self.timeline.ordered_cues()
        for cue in cues:
            label = cue.text if cue.text.strip() else "⏸"
            w = max(16.0, fm.horizontalAdvance(label) + self.PAD * 2 + 6)
            if cue.kind == "pause":
                w = max(w, 26.0)
            if x + w > self.MARGIN + width and x > self.MARGIN:
                x = self.MARGIN
                y += line_h + self.LINE_GAP
            rect = QRectF(x, y, w, line_h)
            self._boxes.append((cue, rect, label))
            x += w + self.SPACING
        total_h = y + line_h + self.MARGIN
        target = int(total_h) if total_h > self.height() else int(self.MARGIN * 2 + line_h)
        if target != self.minimumHeight():
            self.setMinimumHeight(target)
        self._need_layout = False

    def resizeEvent(self, event) -> None:  # noqa: N802
        self._need_layout = True
        super().resizeEvent(event)

    # ------------------------------------------------------------------ 绘制
    def paintEvent(self, event) -> None:  # noqa: N802
        if self._need_layout:
            self._layout_boxes()
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        p.fillRect(self.rect(), QColor("#10141A"))
        bad_ids = self.timeline.invalid_ids()
        unmarked = {c.id for c in self.timeline.cues if not c.is_timed}
        for cue, rect, label in self._boxes:
            selected = cue.id in self.selected
            if cue.id == self.active_id:
                bg, edge = ACTIVE_BG, ACTIVE_EDGE
            elif selected:
                bg, edge = SELECT_BG, SELECT_EDGE
            elif cue.id in bad_ids:
                bg, edge = QColor("#33222A"), BAD_EDGE
            else:
                bg, edge = IDLE_BG, IDLE_EDGE
            if cue.kind == "pause" and not (selected or cue.id == self.active_id):
                bg = QColor("#161C24")
            radius = rect.height() / 2
            if cue.id in unmarked:
                p.setPen(QPen(edge, 1, Qt.PenStyle.DashLine))
                p.setBrush(QColor("#1A1F27"))
            else:
                p.setPen(QPen(edge, 1.6 if (selected or cue.id == self.active_id) else 1.0))
                p.setBrush(bg)
            p.drawRoundedRect(rect, radius, radius)
            # 当前词的时间进度
            if cue.id == self.active_id and cue.is_timed:
                ratio = max(0.0, min(1.0, (self.position_ms - cue.start) / max(1, cue.duration)))
                if ratio > 0:
                    p.save()
                    p.setClipRect(QRectF(rect.left(), rect.top(), rect.width() * ratio, rect.height()))
                    p.setPen(Qt.PenStyle.NoPen)
                    p.setBrush(QColor(ACTIVE_EDGE.red(), ACTIVE_EDGE.green(), ACTIVE_EDGE.blue(), 60))
                    p.drawRoundedRect(rect, radius, radius)
                    p.restore()
            p.setFont(self._font)
            if cue.kind == "pause":
                p.setPen(PAUSE_FG)
            elif cue.id == self.active_id:
                p.setPen(QColor("#F7D48A"))
            else:
                p.setPen(TEXT)
            p.drawText(rect.adjusted(5, 0, -2, 0), Qt.AlignmentFlag.AlignCenter, label)
        p.end()

    # ------------------------------------------------------------------ 交互
    def _hit(self, pos: QPointF):
        for cue, rect, _ in self._boxes:
            if rect.contains(pos):
                return cue
        return None

    def mousePressEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        if self._need_layout:
            self._layout_boxes()
        cue = self._hit(event.position())
        additive = bool(event.modifiers() & (Qt.KeyboardModifier.ControlModifier
                                             | Qt.KeyboardModifier.MetaModifier
                                             | Qt.KeyboardModifier.ShiftModifier))
        if cue is None:
            if not additive:
                self.selected = set()
                self.selectionChanged.emit([])
                self.update()
            return
        if additive:
            if cue.id in self.selected:
                self.selected.discard(cue.id)
            else:
                self.selected.add(cue.id)
        else:
            self.selected = {cue.id}
        self.update()
        self.selectionChanged.emit(sorted(self.selected))

    def mouseDoubleClickEvent(self, event: QMouseEvent) -> None:  # noqa: N802
        cue = self._hit(event.position())
        if cue is not None:
            self.cueActivated.emit(cue.id)
            event.accept()
            return
        super().mouseDoubleClickEvent(event)

    def contextMenuEvent(self, event) -> None:  # noqa: N802
        cue = self._hit(QPointF(event.pos()))
        if cue is not None:
            self.selected = {cue.id}
            self.selectionChanged.emit([cue.id])
            self.update()
        super().contextMenuEvent(event)
