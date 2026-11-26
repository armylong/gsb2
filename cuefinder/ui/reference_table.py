"""参考音列表：显示长度/有效长度/状态，支持移除与重新分析。"""
from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtGui import QColor
from PySide6.QtWidgets import (QAbstractItemView, QHeaderView, QTableWidget,
                               QTableWidgetItem)

from ..reference import READY, Reference

HEADERS = ["参考音", "时长", "有效段", "状态", "说明"]


class ReferenceTable(QTableWidget):
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

    def populate(self, refs: list[Reference]) -> None:
        current = self.selected_path()
        self.setRowCount(len(refs))
        for row, ref in enumerate(refs):
            name = QTableWidgetItem(ref.label)
            name.setData(Qt.ItemDataRole.UserRole, ref.path)
            name.setToolTip(ref.path)
            self.setItem(row, 0, name)
            dur = QTableWidgetItem(f"{ref.duration:.2f} s" if ref.duration else "—")
            act = QTableWidgetItem(f"{ref.active_duration:.2f} s" if ref.ready else "—")
            status = QTableWidgetItem(ref.status_text())
            detail = QTableWidgetItem(ref.detail_text())
            detail.setToolTip(ref.error or ref.path)
            for col, item in enumerate((dur, act, status, detail), start=1):
                item.setFlags(item.flags() & ~Qt.ItemFlag.ItemIsEditable)
                self.setItem(row, col, item)
            color = None
            if ref.status == READY:
                pass
            elif ref.status == "error" or ref.status == "empty":
                color = QColor("#c0392b")
            else:
                color = QColor("#b7791f")
            if color:
                for col in range(len(HEADERS)):
                    it = self.item(row, col)
                    if it is not None:
                        it.setForeground(color)
        if current:
            self.select_path(current)

    def select_path(self, path: str) -> None:
        for row in range(self.rowCount()):
            it = self.item(row, 0)
            if it is not None and it.data(Qt.ItemDataRole.UserRole) == path:
                self.selectRow(row)
                return

    def selected_path(self) -> str | None:
        rows = self.selectionModel().selectedRows() if self.selectionModel() else []
        if not rows:
            return None
        it = self.item(rows[0].row(), 0)
        return it.data(Qt.ItemDataRole.UserRole) if it else None
