"""词表面板: 按阅读顺序列出每个词, 显示起止时间与边界状态, 并支持编辑.  """

from __future__ import annotations

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QBrush, QColor
from PySide6.QtWidgets import (QAbstractItemView, QComboBox, QHBoxLayout,
                               QHeaderView, QLabel, QTableWidget,
                               QTableWidgetItem, QVBoxLayout, QWidget)

from .model import Timeline, format_ms

BG = QColor("#12161D")
FG = QColor("#D6DDE8")
MUTED = QColor("#7D8899")
GOOD = QColor("#4FBF8B")
WARN = QColor("#E0A93C")
BAD = QColor("#E45757")
PAUSE = QColor("#8E9BB0")
SEL = QColor("#1F3B4D")

COL_INDEX, COL_TEXT, COL_KIND, COL_START, COL_END, COL_DUR, COL_NOTE = range(7)


class CueTable(QWidget):
    """时间码按 ``model.format_ms`` 展示, 键入 ``1:02.345`` 即可修改。"""

    cueSelected = Signal(int)
    selectionChanged = Signal(list)
    cueChanged = Signal(int, str, str)     # cue_id, field, value
    cuePreview = Signal(int, str, int)     # cue_id, "start"/"end", ms (实时拖动)
    seekRequested = Signal(int)

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.timeline = Timeline()
        self._loading = False
        self._active_id: int | None = None

        self.table = QTableWidget(0, 7, self)
        self.table.setHorizontalHeaderLabels(["#", "词", "类型", "开始", "结束", "时长", "备注"])
        self.table.verticalHeader().setVisible(False)
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.DoubleClicked
                                   | QAbstractItemView.EditTrigger.SelectedClicked
                                   | QAbstractItemView.EditTrigger.EditKeyPressed)
        self.table.setAlternatingRowColors(True)
        self.table.setShowGrid(False)
        self.table.setWordWrap(False)
        header = self.table.horizontalHeader()
        header.setSectionResizeMode(COL_INDEX, QHeaderView.ResizeMode.Fixed)
        header.setSectionResizeMode(COL_TEXT, QHeaderView.ResizeMode.Stretch)
        header.setSectionResizeMode(COL_KIND, QHeaderView.ResizeMode.Fixed)
        header.setSectionResizeMode(COL_START, QHeaderView.ResizeMode.Fixed)
        header.setSectionResizeMode(COL_END, QHeaderView.ResizeMode.Fixed)
        header.setSectionResizeMode(COL_DUR, QHeaderView.ResizeMode.Fixed)
        header.setSectionResizeMode(COL_NOTE, QHeaderView.ResizeMode.Stretch)
        self.table.setColumnWidth(COL_INDEX, 36)
        self.table.setColumnWidth(COL_KIND, 58)
        self.table.setColumnWidth(COL_START, 82)
        self.table.setColumnWidth(COL_END, 82)
        self.table.setColumnWidth(COL_DUR, 62)
        self.table.verticalHeader().setDefaultSectionSize(26)
        self.table.setStyleSheet(
            "QTableWidget { background:#12161D; alternate-background-color:#151B23;"
            " gridline-color:#222B37; color:#D6DDE8; selection-background-color:#254257; }"
            " QHeaderView::section { background:#1A212B; color:#8E9BB0; border:0;"
            " border-bottom:1px solid #2A3442; padding:4px; }"
        )
        self.table.itemChanged.connect(self._on_item_changed)
        self.table.itemSelectionChanged.connect(self._on_selection_changed)
        self.table.cellDoubleClicked.connect(self._on_double_clicked)

        self.problem_label = QLabel("")
        self.problem_label.setWordWrap(True)
        self.problem_label.setStyleSheet("color:#E0A93C; padding:4px 8px;")
        self.problem_label.setMaximumHeight(64)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(2)
        layout.addWidget(self.table, 1)
        layout.addWidget(self.problem_label)

    # ------------------------------------------------------------------ 数据
    def set_timeline(self, timeline: Timeline) -> None:
        self.timeline = timeline
        self.rebuild()

    def rebuild(self) -> None:
        self._loading = True
        try:
            selected = {i for i in self.selected_ids()}
            self.table.setRowCount(0)
            cues = self.timeline.ordered_cues()
            self.table.setRowCount(len(cues))
            for row, cue in enumerate(cues):
                self._fill_row(row, cue, row + 1)
                if cue.id in selected:
                    self.table.selectRow(row)
            self.table.resizeRowsToContents()
            self._apply_problem_hint()
            self._highlight_under_loading()
        finally:
            self._loading = False

    def _fill_row(self, row: int, cue, index: int) -> None:
        num = QTableWidgetItem(str(index))
        num.setFlags(Qt.ItemFlag.ItemIsEnabled | Qt.ItemFlag.ItemIsSelectable)
        num.setForeground(QBrush(MUTED))
        num.setData(Qt.ItemDataRole.UserRole, cue.id)
        self.table.setItem(row, COL_INDEX, num)

        text = QTableWidgetItem(cue.text)
        text.setData(Qt.ItemDataRole.UserRole, cue.text)
        if cue.kind == "pause":
            text.setForeground(QBrush(PAUSE))
        self.table.setItem(row, COL_TEXT, text)

        kind = QWidget()
        combo = QComboBox()
        combo.addItems(["词", "停顿"])
        combo.setCurrentIndex(0 if cue.kind == "word" else 1)
        combo.setStyleSheet("QComboBox { background:#1A212B; color:#D6DDE8; border:1px solid #2A3442;"
                            " border-radius:3px; padding:1px 4px; }")
        row_layout = QHBoxLayout(kind)
        row_layout.setContentsMargins(2, 1, 2, 1)
        row_layout.addWidget(combo)
        combo.currentIndexChanged.connect(
            lambda idx, cid=cue.id: self._on_kind_changed(cid, idx))
        self.table.setCellWidget(row, COL_KIND, kind)

        for col, (value, field) in ((COL_START, (cue.start, "start")), (COL_END, (cue.end, "end"))):
            item = QTableWidgetItem(format_ms(value))
            item.setData(Qt.ItemDataRole.UserRole, value)
            item.setTextAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
            self.table.setItem(row, col, item)

        dur = QTableWidgetItem(f"{cue.duration} ms" if cue.is_timed else "未打轴")
        dur.setFlags(Qt.ItemFlag.ItemIsEnabled | Qt.ItemFlag.ItemIsSelectable)
        dur.setForeground(QBrush(BAD if cue.end < cue.start else (WARN if not cue.is_timed else MUTED)))
        self.table.setItem(row, COL_DUR, dur)

        note = QTableWidgetItem(cue.note)
        note.setData(Qt.ItemDataRole.UserRole, cue.note)
        note.setForeground(QBrush(MUTED))
        self.table.setItem(row, COL_NOTE, note)

        state = "error" if cue.id in self.timeline.invalid_ids() else ""
        for col in range(7):
            item = self.table.item(row, col)
            if item is None:
                continue
            if cue.id == self._active_id:
                item.setBackground(QBrush(QColor("#2A3442")))
            elif state == "error":
                item.setBackground(QBrush(QColor("#3A2226")))

    def _apply_problem_hint(self) -> None:
        rows = []
        for issue in self.timeline.conflicts():
            if issue.level in ("error", "warning"):
                rows.append(("⛔ " if issue.level == "error" else "⚠️ ") + issue.message)
        if rows:
            self.problem_label.setText("\n".join(rows[:3]) + (" …" if len(rows) > 3 else ""))
        else:
            self.problem_label.setText("")
        self.problem_label.setVisible(bool(rows))

    # ------------------------------------------------------------------ 选择
    def selected_ids(self) -> list[int]:
        ids: list[int] = []
        for item in self.table.selectedItems():
            if item.column() == COL_INDEX:
                cid = item.data(Qt.ItemDataRole.UserRole)
                if cid not in ids:
                    ids.append(int(cid))
        if not ids:
            # 某些平台只在当前单元格上报告选中项
            row = self.table.currentRow()
            if row >= 0:
                item = self.table.item(row, COL_INDEX)
                if item and self.table.selectionModel().isRowSelected(row, self.table.rootIndex()):
                    ids.append(int(item.data(Qt.ItemDataRole.UserRole)))
        return ids

    def set_selection(self, ids: list[int]) -> None:
        wanted = set(ids)
        if wanted == set(self.selected_ids()):
            return
        self._loading = True
        try:
            self.table.clearSelection()
            for row in range(self.table.rowCount()):
                item = self.table.item(row, COL_INDEX)
                if item and int(item.data(Qt.ItemDataRole.UserRole)) in wanted:
                    self.table.selectionModel().select(
                        self.table.model().index(row, 0),
                        self.table.selectionModel().SelectionFlag.Select
                        | self.table.selectionModel().SelectionFlag.Rows)
                    self.table.setCurrentCell(row, COL_TEXT,
                                              self.table.selectionModel().SelectionFlag.NoUpdate)
        finally:
            self._loading = False

    def set_active(self, cue_id: int | None) -> None:
        if cue_id == self._active_id:
            return
        previous = self._active_id
        self._active_id = cue_id
        self._repaint_row(previous)
        self._repaint_row(cue_id)
        if cue_id is not None:
            for row in range(self.table.rowCount()):
                item = self.table.item(row, COL_INDEX)
                if item and int(item.data(Qt.ItemDataRole.UserRole)) == cue_id:
                    self.table.scrollToItem(item, QAbstractItemView.ScrollHint.EnsureVisible)
                    break

    def _repaint_row(self, cue_id: int | None) -> None:
        if cue_id is None:
            return
        bad_ids = self.timeline.invalid_ids()
        previous = self._loading
        self._loading = True
        try:
            for row in range(self.table.rowCount()):
                item = self.table.item(row, COL_INDEX)
                if item is None:
                    continue
                cid = int(item.data(Qt.ItemDataRole.UserRole))
                if cid != cue_id:
                    continue
                for col in range(7):
                    cell = self.table.item(row, col)
                    if cell is None:
                        continue
                    if cid == self._active_id:
                        cell.setBackground(QBrush(QColor("#33424F")))
                    elif cid in bad_ids:
                        cell.setBackground(QBrush(QColor("#3A2226")))
                    else:
                        cell.setBackground(QBrush())
                break
        finally:
            self._loading = previous

    def _highlight_under_loading(self) -> None:
        """改底色会触发 itemChanged; 统一用 ``_loading`` 包住并恢复原值。"""
        previous = self._loading
        self._loading = True
        try:
            bad_ids = self.timeline.invalid_ids()
            for row in range(self.table.rowCount()):
                item = self.table.item(row, COL_INDEX)
                if item is None:
                    continue
                cid = int(item.data(Qt.ItemDataRole.UserRole))
                is_active = cid == self._active_id
                if not is_active and cid not in bad_ids:
                    continue  # 只重涂有状态的行, 避免每次播放都刷整张表
                for col in range(7):
                    cell = self.table.item(row, col)
                    if cell is None:
                        continue
                    if cid == self._active_id:
                        cell.setBackground(QBrush(QColor("#33424F")))
                    elif cid in bad_ids:
                        cell.setBackground(QBrush(QColor("#3A2226")))
                    else:
                        cell.setBackground(QBrush())
                item.setForeground(QBrush(MUTED))
        finally:
            self._loading = previous

    # ------------------------------------------------------------------ 编辑
    def _on_selection_changed(self) -> None:
        if self._loading:
            return
        ids = self.selected_ids()
        self.selectionChanged.emit(ids)
        if ids:
            self.cueSelected.emit(ids[0])

    def _on_double_clicked(self, row: int, column: int) -> None:
        item = self.table.item(row, COL_START)
        if item is None:
            return
        cid = int(self.table.item(row, COL_INDEX).data(Qt.ItemDataRole.UserRole))
        cue = self.timeline.cue(cid)
        if column in (COL_INDEX, COL_TEXT):
            self.seekRequested.emit(cue.start)
        elif column in (COL_START, COL_END):
            self.seekRequested.emit(cue.start)

    def _on_item_changed(self, item: QTableWidgetItem) -> None:
        if self._loading:
            return
        row = item.row()
        id_item = self.table.item(row, COL_INDEX)
        if id_item is None:
            return
        cid = int(id_item.data(Qt.ItemDataRole.UserRole))
        col = item.column()
        if col == COL_TEXT:
            new = item.text().strip()
            old = item.data(Qt.ItemDataRole.UserRole)
            if new and new != old:
                self.cueChanged.emit(cid, "text", new)
        elif col == COL_NOTE:
            self.cueChanged.emit(cid, "note", item.text())
        elif col in (COL_START, COL_END):
            field = "start" if col == COL_START else "end"
            value = _parse_time(item.text())
            old = int(item.data(Qt.ItemDataRole.UserRole))
            if value is None:
                self._loading = True
                item.setText(format_ms(old))
                self._loading = False
                return
            if value != old:
                self.cuePreview.emit(cid, field, value)

    def _on_kind_changed(self, cue_id: int, index: int) -> None:
        if self._loading:
            return
        kind = "word" if index == 0 else "pause"
        if self.timeline.cue(cue_id).kind != kind:
            self.cueChanged.emit(cue_id, "kind", kind)


def _parse_time(text: str) -> int | None:
    """接受 1:02.345 / 62.345 / 62345 三种写法.

    带冒号按「分:秒」解析; 带小数点按「秒」解析; 纯整数按毫秒解析。
    """
    text = text.strip().replace("，", ",")
    if not text:
        return None
    try:
        if ":" in text:
            seconds = 0.0
            for part in text.split(":"):
                seconds = seconds * 60 + float(part)
            return int(round(seconds * 1000))
        if "." in text or "," in text:
            return int(round(float(text.replace(",", ".")) * 1000))
        return int(text)
    except ValueError:
        return None
