"""Docks and tables used by the main window."""

from __future__ import annotations

from typing import List, Optional

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QBrush, QColor
from PySide6.QtWidgets import (QAbstractItemView, QCheckBox, QComboBox,
                               QFormLayout, QGroupBox, QHBoxLayout,
                               QHeaderView, QLabel, QLineEdit, QListWidget,
                               QListWidgetItem, QPushButton, QSpinBox,
                               QTableWidget, QTableWidgetItem, QVBoxLayout,
                               QWidget)


class CropListPanel(QWidget):
    """Crop list with inline rename, enable toggle and selection."""

    selectionChanged = Signal(int)      # -1 for none
    renameRequested = Signal(int, str)
    enabledChanged = Signal(int, bool)
    addRequested = Signal()
    removeRequested = Signal()
    duplicateRequested = Signal()

    def __init__(self, parent=None):
        super().__init__(parent)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(6, 6, 6, 6)
        self.list = QListWidget()
        self.list.setSelectionMode(
            QAbstractItemView.SelectionMode.SingleSelection)
        self.list.currentRowChanged.connect(self._on_row)
        self.list.itemChanged.connect(self._on_item_changed)
        layout.addWidget(self.list)

        row = QHBoxLayout()
        self.btn_add = QPushButton("新增")
        self.btn_dup = QPushButton("复制")
        self.btn_del = QPushButton("删除")
        for b in (self.btn_add, self.btn_dup, self.btn_del):
            row.addWidget(b)
        layout.addLayout(row)
        self.btn_add.clicked.connect(self.addRequested)
        self.btn_dup.clicked.connect(self.duplicateRequested)
        self.btn_del.clicked.connect(self.removeRequested)
        self._updating = False

    def _on_item_changed(self, item: QListWidgetItem) -> None:
        if self._updating:
            return
        row = self.list.row(item)
        enabled = item.checkState() == Qt.CheckState.Checked
        if item.data(Qt.ItemDataRole.UserRole + 1) != enabled:
            item.setData(Qt.ItemDataRole.UserRole + 1, enabled)
            self.enabledChanged.emit(row, enabled)
        original = item.data(Qt.ItemDataRole.UserRole + 2)
        if original is not None and item.text() != original:
            item.setData(Qt.ItemDataRole.UserRole + 2, item.text())
            self.renameRequested.emit(row, item.text())

    def _on_row(self, row: int) -> None:
        if not self._updating:
            self.selectionChanged.emit(row)

    def set_items(self, entries: List[dict], active: Optional[int]) -> None:
        self._updating = True
        self.list.clear()
        for e in entries:
            item = QListWidgetItem(e["name"])
            item.setFlags(item.flags() | Qt.ItemFlag.ItemIsEditable |
                          Qt.ItemFlag.ItemIsUserCheckable)
            item.setCheckState(Qt.CheckState.Checked if e["enabled"]
                               else Qt.CheckState.Unchecked)
            item.setData(Qt.ItemDataRole.UserRole, e["index"])
            item.setData(Qt.ItemDataRole.UserRole + 1, e["enabled"])
            item.setData(Qt.ItemDataRole.UserRole + 2, e["name"])
            size = e.get("size")
            if size:
                item.setToolTip(f"{size[0]} × {size[1]} px")
            self.list.addItem(item)
        if active is not None and 0 <= active < self.list.count():
            self.list.setCurrentRow(active)
        self._updating = False

    def current_index(self) -> Optional[int]:
        row = self.list.currentRow()
        return row if row >= 0 else None


class MarkerListPanel(QWidget):
    selectionChanged = Signal(int)
    addRequested = Signal()
    removeRequested = Signal()
    renameRequested = Signal(int, str)

    def __init__(self, parent=None):
        super().__init__(parent)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(6, 6, 6, 6)
        self.list = QListWidget()
        self.list.setSelectionMode(
            QAbstractItemView.SelectionMode.SingleSelection)
        self.list.currentRowChanged.connect(self.selectionChanged)
        layout.addWidget(self.list)
        row = QHBoxLayout()
        self.btn_add = QPushButton("新增定点")
        self.btn_del = QPushButton("删除")
        row.addWidget(self.btn_add)
        row.addWidget(self.btn_del)
        layout.addLayout(row)
        self.btn_add.clicked.connect(self.addRequested)
        self.btn_del.clicked.connect(self.removeRequested)

    def set_items(self, markers: List[dict], active: Optional[int],
                  crop_count_for: Optional[dict] = None) -> None:
        self.list.blockSignals(True)
        self.list.clear()
        for m in markers:
            text = f"{m['name']}  ({m['x']}, {m['y']})"
            if crop_count_for is not None:
                n = crop_count_for.get(m["index"], 0)
                text += f"  · {n} 个裁片"
            self.list.addItem(QListWidgetItem(text))
        if active is not None and 0 <= active < self.list.count():
            self.list.setCurrentRow(active)
        self.list.blockSignals(False)


class TransformPanel(QWidget):
    """Widen / translate / tighten controls."""

    widenRequested = Signal(int, bool, str)
    translateRequested = Signal(int, int, bool)
    tightenRequested = Signal(str, bool)
    ratioChanged = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        outer = QVBoxLayout(self)
        outer.setContentsMargins(6, 6, 6, 6)

        ratio_box = QGroupBox("长宽比")
        rf = QFormLayout(ratio_box)
        self.ratio_edit = QLineEdit()
        self.ratio_edit.setPlaceholderText("如 4:3，留空为自由比例")
        self.ratio_edit.editingFinished.connect(
            lambda: self.ratioChanged.emit(self.ratio_edit.text()))
        rf.addRow("比例", self.ratio_edit)
        self.tighten_scope = QCheckBox("仅当前裁片")
        self.tighten_scope.setChecked(True)
        rf.addRow(self.tighten_scope)
        row = QHBoxLayout()
        self.btn_tighten = QPushButton("按比例收紧")
        self.btn_tighten.setToolTip("在现有选区内收紧到指定长宽比，不越出原选区")
        row.addWidget(self.btn_tighten)
        rf.addRow(row)
        self.btn_tighten.clicked.connect(
            lambda: self.tightenRequested.emit(
                self.ratio_edit.text(), self.tighten_scope.isChecked()))
        outer.addWidget(ratio_box)

        widen_box = QGroupBox("展宽")
        wf = QFormLayout(widen_box)
        self.widen_amount = QSpinBox()
        self.widen_amount.setRange(1, 2000)
        self.widen_amount.setValue(8)
        self.widen_amount.setSuffix(" px")
        self.widen_sides = QComboBox()
        self.widen_sides.addItem("四周", "all")
        self.widen_sides.addItem("左右", "x")
        self.widen_sides.addItem("上下", "y")
        self.widen_scope = QCheckBox("仅当前裁片")
        self.widen_scope.setChecked(True)
        wf.addRow("幅度", self.widen_amount)
        wf.addRow("方向", self.widen_sides)
        wf.addRow(self.widen_scope)
        self.btn_widen = QPushButton("展宽选区")
        wf.addRow(self.btn_widen)
        self.btn_widen.clicked.connect(
            lambda: self.widenRequested.emit(
                self.widen_amount.value(), self.widen_scope.isChecked(),
                self.widen_sides.currentData()))
        outer.addWidget(widen_box)

        move_box = QGroupBox("平移")
        mf = QFormLayout(move_box)
        self.move_dx = QSpinBox()
        self.move_dy = QSpinBox()
        for spin in (self.move_dx, self.move_dy):
            spin.setRange(-5000, 5000)
            spin.setSuffix(" px")
        mf.addRow("水平 dx", self.move_dx)
        mf.addRow("垂直 dy", self.move_dy)
        self.move_scope = QCheckBox("仅当前裁片")
        self.move_scope.setChecked(True)
        mf.addRow(self.move_scope)
        row = QHBoxLayout()
        self.btn_move = QPushButton("平移")
        self.btn_nudge_left = QPushButton("←")
        self.btn_nudge_right = QPushButton("→")
        row.addWidget(self.btn_move)
        row.addWidget(self.btn_nudge_left)
        row.addWidget(self.btn_nudge_right)
        mf.addRow(row)
        self.btn_move.clicked.connect(
            lambda: self.translateRequested.emit(
                self.move_dx.value(), self.move_dy.value(),
                self.move_scope.isChecked()))
        self.btn_nudge_left.clicked.connect(
            lambda: self.translateRequested.emit(-1, 0, True))
        self.btn_nudge_right.clicked.connect(
            lambda: self.translateRequested.emit(1, 0, True))
        outer.addWidget(move_box)
        outer.addStretch(1)

    def set_ratio_text(self, text: str) -> None:
        if self.ratio_edit.text() != (text or ""):
            self.ratio_edit.setText(text or "")


class ExportTable(QTableWidget):
    COLUMNS = ("裁片", "定位点", "状态", "原图坐标", "裁片内坐标", "说明")

    def __init__(self, parent=None):
        super().__init__(0, len(self.COLUMNS), parent)
        self.setHorizontalHeaderLabels(self.COLUMNS)
        self.verticalHeader().setVisible(False)
        self.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.setSelectionBehavior(
            QAbstractItemView.SelectionBehavior.SelectRows)
        header = self.horizontalHeader()
        header.setSectionResizeMode(QHeaderView.ResizeMode.ResizeToContents)
        header.setStretchLastSection(True)

    def set_rows(self, rows: List[dict]) -> None:
        self.setRowCount(len(rows))
        for r, row in enumerate(rows):
            outside = row.get("status") == "未包含"
            values = (
                row.get("crop", ""),
                row.get("marker", ""),
                row.get("status", ""),
                f"{row.get('x')}, {row.get('y')}"
                if row.get("x") != "" else "",
                row.get("local", ""),
                row.get("note", ""),
            )
            for c, value in enumerate(values):
                item = QTableWidgetItem(str(value))
                if c == 0:
                    item.setData(Qt.ItemDataRole.UserRole,
                                 row.get("crop_index"))
                if outside and c == 2:
                    item.setForeground(QBrush(QColor("#d9534f")))
                if row.get("status") == "已包含" and c == 2:
                    item.setForeground(QBrush(QColor("#2e9d68")))
                self.setItem(r, c, item)


class LocatePanel(QWidget):
    """Cross-navigation between source image and exported crop."""

    markerChosen = Signal(int)
    showInSourceRequested = Signal(int)
    showInCropRequested = Signal(int, int, int)   # crop index, local x, y
    markerInCropRequested = Signal(int, int)      # marker, crop
    cropChosen = Signal(int)

    def __init__(self, parent=None):
        super().__init__(parent)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(6, 6, 6, 6)
        form = QFormLayout()
        self.marker_combo = QComboBox()
        self.marker_combo.currentIndexChanged.connect(
            self._marker_changed)
        form.addRow("定位点", self.marker_combo)
        self.crop_combo = QComboBox()
        self.crop_combo.currentIndexChanged.connect(
            lambda _: self.cropChosen.emit(
                self.crop_combo.currentData()
                if self.crop_combo.currentData() is not None else -1))
        form.addRow("裁片", self.crop_combo)
        self.local_x = QSpinBox()
        self.local_y = QSpinBox()
        self.local_x.setRange(-100000, 100000)
        self.local_y.setRange(-100000, 100000)
        form.addRow("裁片内 x", self.local_x)
        form.addRow("裁片内 y", self.local_y)
        layout.addLayout(form)

        row = QHBoxLayout()
        self.btn_source = QPushButton("在原图中找")
        self.btn_crop = QPushButton("按坐标在裁片中找")
        row.addWidget(self.btn_source)
        row.addWidget(self.btn_crop)
        layout.addLayout(row)
        self.btn_marker_in_crop = QPushButton("定位点 → 裁片")
        self.btn_marker_in_crop.setToolTip(
            "把当前定位点换算到所选裁片内，越界时会说明落在哪一侧")
        layout.addWidget(self.btn_marker_in_crop)
        self.btn_source.clicked.connect(
            lambda: self.showInSourceRequested.emit(
                self.marker_combo.currentData()
                if self.marker_combo.currentData() is not None else -1))
        self.btn_crop.clicked.connect(
            lambda: self.showInCropRequested.emit(
                self.crop_combo.currentData()
                if self.crop_combo.currentData() is not None else -1,
                self.local_x.value(), self.local_y.value()))
        self.btn_marker_in_crop.clicked.connect(
            lambda: self.markerInCropRequested.emit(
                self.marker_combo.currentData()
                if self.marker_combo.currentData() is not None else -1,
                self.crop_combo.currentData()
                if self.crop_combo.currentData() is not None else -1))
        self.info = QLabel("—")
        self.info.setWordWrap(True)
        layout.addWidget(self.info)
        layout.addStretch(1)

    def _marker_changed(self, _index: int) -> None:
        data = self.marker_combo.currentData()
        if data is not None:
            self.markerChosen.emit(data)

    def set_markers(self, entries: List[dict], active: Optional[int]) -> None:
        self.marker_combo.blockSignals(True)
        self.marker_combo.clear()
        for e in entries:
            self.marker_combo.addItem(
                f"{e['name']} ({e['x']}, {e['y']})", e["index"])
        if active is not None:
            pos = self.marker_combo.findData(active)
            if pos >= 0:
                self.marker_combo.setCurrentIndex(pos)
        self.marker_combo.blockSignals(False)

    def set_crops(self, entries: List[dict], active: Optional[int]) -> None:
        self.crop_combo.blockSignals(True)
        self.crop_combo.clear()
        for e in entries:
            self.crop_combo.addItem(e["name"], e["index"])
        if active is not None:
            pos = self.crop_combo.findData(active)
            if pos >= 0:
                self.crop_combo.setCurrentIndex(pos)
        self.crop_combo.blockSignals(False)

    def set_info(self, text: str) -> None:
        self.info.setText(text)

    def set_local(self, x: int, y: int) -> None:
        self.local_x.setValue(x)
        self.local_y.setValue(y)
