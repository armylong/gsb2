"""候选列表：得分、起点、覆盖；点击切换对照。"""
from __future__ import annotations

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (QAbstractItemView, QHeaderView, QTableWidget,
                               QTableWidgetItem)

from ..search import Candidate

HEADERS = ["参考音", "得分", "起点", "覆盖", "状态"]


class CandidateList(QTableWidget):
    candidateSelected = Signal(int)

    def __init__(self, parent=None):
        super().__init__(0, len(HEADERS), parent)
        self.setHorizontalHeaderLabels(HEADERS)
        self.verticalHeader().setVisible(False)
        self.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.setAlternatingRowColors(True)
        header = self.horizontalHeader()
        header.setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        for i in range(1, len(HEADERS) - 1):
            header.setSectionResizeMode(i, QHeaderView.ResizeMode.ResizeToContents)
        header.setSectionResizeMode(len(HEADERS) - 1, QHeaderView.ResizeMode.Stretch)
        self.setMinimumHeight(150)
        self._cands: list[Candidate] = []
        self.itemSelectionChanged.connect(self._on_selection)

    def populate(self, cands: list[Candidate]) -> None:
        self._cands = list(cands)
        self.setRowCount(len(cands))
        for row, c in enumerate(cands):
            name = QTableWidgetItem(c.label)
            name.setToolTip(c.path)
            score = QTableWidgetItem(f"{c.score:.2f}")
            start = QTableWidgetItem(f"{c.start_sec:.2f} s")
            cov = QTableWidgetItem(f"{c.coverage:.0%}")
            if not c.passed:
                status = "低于门槛"
            elif c.end_overrun:
                status = f"越过末尾 {c.overrun*1000:.0f} ms"
            elif c.coverage < 0.85:
                status = f"支持仅 {c.coverage:.0%}"
            else:
                status = "—"
            note = QTableWidgetItem(status)
            for col, item in enumerate((name, score, start, cov, note)):
                item.setFlags(item.flags() & ~Qt.ItemFlag.ItemIsEditable)
                self.setItem(row, col, item)
            if not c.passed:
                for col in range(len(HEADERS)):
                    it = self.item(row, col)
                    if it is not None:
                        it.setForeground(Qt.GlobalColor.gray)
            elif c.end_overrun or c.coverage < 0.85:
                for col in range(len(HEADERS)):
                    it = self.item(row, col)
                    if it is not None:
                        it.setForeground(Qt.GlobalColor.darkRed)
        if cands:
            self.selectRow(0)
        self._on_selection()

    def current_candidate(self) -> Candidate | None:
        rows = self.selectionModel().selectedRows()
        if not rows or not self._cands:
            return None
        idx = rows[0].row()
        return self._cands[idx] if 0 <= idx < len(self._cands) else None

    def current_index(self) -> int:
        rows = self.selectionModel().selectedRows()
        return rows[0].row() if rows else 0

    def _on_selection(self) -> None:
        self.candidateSelected.emit(self.current_index())
