"""边界报告面板: 导出前逐对检查相邻两词, 点击一行即可试听该处.  """

from __future__ import annotations

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QBrush, QColor
from PySide6.QtWidgets import (QAbstractItemView, QCheckBox, QHBoxLayout,
                               QHeaderView, QLabel, QPushButton, QTableWidget,
                               QTableWidgetItem, QVBoxLayout, QWidget)

from .export import BoundaryRow, boundary_report
from .model import Timeline, format_ms

COL_PREV, COL_GAP, COL_NEXT, COL_STATUS = range(4)
COLORS = {
    "ok": QColor("#4FBF8B"),
    "tight": QColor("#E0A93C"),
    "overlap": QColor("#E45757"),
    "unmarked": QColor("#8E9BB0"),
}
LABELS = {
    "ok": "正常",
    "tight": "偏紧",
    "overlap": "重叠",
    "unmarked": "未打轴",
}


class BoundaryPanel(QWidget):
    playPair = Signal(int, int)          # 从 prev.start 播到 next.end
    cueSelected = Signal(int)
    selectionChanged = Signal(list)

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.timeline = Timeline()
        self._only_problems = False

        self.summary = QLabel("")
        self.summary.setStyleSheet("color:#8E9BB0; padding:2px 2px;")
        self.only_problems = QCheckBox("只看问题边界")
        self.only_problems.setStyleSheet("color:#AEB8C7;")
        self.only_problems.toggled.connect(self._on_filter)
        refresh = QPushButton("重新检查")
        refresh.setStyleSheet(_button_style())
        refresh.clicked.connect(self.rebuild)
        play = QPushButton("试听该处")
        play.setStyleSheet(_button_style(accent=True))
        play.clicked.connect(self._play_current)

        bar = QHBoxLayout()
        bar.setContentsMargins(2, 2, 2, 2)
        bar.addWidget(self.summary, 1)
        bar.addWidget(self.only_problems)
        bar.addWidget(play)
        bar.addWidget(refresh)

        self.table = QTableWidget(0, 4, self)
        self.table.setHorizontalHeaderLabels(["前一词", "间隔", "后一词", "状态"])
        self.table.verticalHeader().setVisible(False)
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.table.verticalHeader().setDefaultSectionSize(24)
        self.table.setShowGrid(False)
        header = self.table.horizontalHeader()
        header.setSectionResizeMode(COL_PREV, QHeaderView.ResizeMode.Stretch)
        header.setSectionResizeMode(COL_GAP, QHeaderView.ResizeMode.Fixed)
        header.setSectionResizeMode(COL_NEXT, QHeaderView.ResizeMode.Stretch)
        header.setSectionResizeMode(COL_STATUS, QHeaderView.ResizeMode.Fixed)
        self.table.setColumnWidth(COL_GAP, 76)
        self.table.setColumnWidth(COL_STATUS, 66)
        self.table.setStyleSheet(
            "QTableWidget { background:#12161D; color:#D6DDE8;"
            " selection-background-color:#254257; border:1px solid #222B37; }"
            " QHeaderView::section { background:#1A212B; color:#8E9BB0; border:0;"
            " border-bottom:1px solid #2A3442; padding:3px; }"
        )
        self.table.itemSelectionChanged.connect(self._on_row_selected)
        self.table.cellDoubleClicked.connect(lambda *_: self._play_current())

        layout = QVBoxLayout(self)
        layout.setContentsMargins(4, 2, 4, 4)
        layout.setSpacing(4)
        layout.addLayout(bar)
        layout.addWidget(self.table, 1)

    # ------------------------------------------------------------------ 数据
    def set_timeline(self, timeline: Timeline) -> None:
        self.timeline = timeline
        self.rebuild()

    def rebuild(self) -> None:
        rows = boundary_report(self.timeline)
        if self._only_problems:
            rows = [r for r in rows if r.status != "ok"]
        self.table.setRowCount(0)
        self.table.setRowCount(len(rows))
        problems = 0
        for i, row in enumerate(rows):
            if row.status in ("overlap", "unmarked", "tight"):
                problems += 1
            self._fill(i, row)
        total = len(boundary_report(self.timeline))
        overlaps = sum(1 for r in boundary_report(self.timeline) if r.status == "overlap")
        unmarked = sum(1 for r in boundary_report(self.timeline) if r.status == "unmarked")
        bits = [f"共 {total} 处边界"]
        if overlaps:
            bits.append(f"重叠 {overlaps}")
        if unmarked:
            bits.append(f"未打轴 {unmarked}")
        self.summary.setText(" · ".join(bits) + ("  ✓" if not (overlaps or unmarked) else ""))

    def _fill(self, row_index: int, row: BoundaryRow) -> None:
        prev_text = row.prev.text if row.prev else "—"
        next_text = row.nxt.text if row.nxt else "—"
        prev_item = QTableWidgetItem(prev_text)
        prev_item.setData(Qt.ItemDataRole.UserRole, row.prev.id if row.prev else -1)
        nxt_item = QTableWidgetItem(next_text)
        nxt_item.setData(Qt.ItemDataRole.UserRole, row.nxt.id if row.nxt else -1)
        if row.prev:
            prev_item.setToolTip(f"{format_ms(row.prev.start)} – {format_ms(row.prev.end)}")
        if row.nxt:
            nxt_item.setToolTip(f"{format_ms(row.nxt.start)} – {format_ms(row.nxt.end)}")
        gap_text = f"{row.gap_ms:+d} ms" if row.prev and row.nxt else "—"
        gap_item = QTableWidgetItem(gap_text)
        gap_item.setTextAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        status_item = QTableWidgetItem(LABELS.get(row.status, row.status))
        status_item.setToolTip(row.detail)
        color = COLORS.get(row.status, QColor("#D6DDE8"))
        status_item.setForeground(QBrush(color))
        gap_item.setForeground(QBrush(color))
        if row.status == "overlap":
            bg = QBrush(QColor("#38222A"))
            for item in (prev_item, nxt_item):
                item.setBackground(bg)
        for col, item in enumerate((prev_item, gap_item, nxt_item, status_item)):
            self.table.setItem(row_index, col, item)

    def _on_filter(self, checked: bool) -> None:
        self._only_problems = checked
        self.rebuild()

    # ------------------------------------------------------------------ 交互
    def _current_pair(self) -> tuple[int, int] | None:
        row = self.table.currentRow()
        if row < 0:
            return None
        prev_id = int(self.table.item(row, COL_PREV).data(Qt.ItemDataRole.UserRole))
        next_id = int(self.table.item(row, COL_NEXT).data(Qt.ItemDataRole.UserRole))
        if prev_id < 0 or next_id < 0:
            return None
        return prev_id, next_id

    def _play_current(self) -> None:
        pair = self._current_pair()
        if pair:
            self.playPair.emit(*pair)

    def _on_row_selected(self) -> None:
        pair = self._current_pair()
        if pair:
            self.cueSelected.emit(pair[0])
            self.selectionChanged.emit([pair[0], pair[1]])


def _button_style(accent: bool = False) -> str:
    if accent:
        return ("QPushButton { background:#F5B942; color:#14181F; border:0; border-radius:3px;"
                " padding:4px 10px; font-weight:600; } QPushButton:hover { background:#FFC95C; }")
    return ("QPushButton { background:#1E2733; color:#C3CAD6; border:1px solid #2E3A49;"
            " border-radius:3px; padding:4px 10px; } QPushButton:hover { background:#273240; }")
