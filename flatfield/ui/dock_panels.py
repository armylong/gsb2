"""Left dock: import groups, exposure conditions, group statistics."""

from __future__ import annotations

import numpy as np
from PySide6.QtCore import QEvent, Qt, Signal
from PySide6.QtGui import QColor
from PySide6.QtWidgets import (
    QAbstractItemView,
    QCheckBox,
    QDoubleSpinBox,
    QFrame,
    QGridLayout,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QPushButton,
    QScrollArea,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from ..core import FULL_SCALE, Frame, FrameStats, GroupStats
from .widgets import Thumbnail


def _fmt(v: float | None, digits: int = 1) -> str:
    return "—" if v is None or (isinstance(v, float) and not np.isfinite(v)) else f"{v:.{digits}f}"


def _issue_color(severity: str) -> str:
    return {"error": "#ff6b6b", "warning": "#ffb454", "info": "#7fb8ff"}.get(severity, "#c8ccd4")


class GroupPanel(QGroupBox):
    """One import group (darks / lights / sample) with stats and saturation info."""

    filesRequested = Signal(str)
    folderRequested = Signal(str)
    removeRequested = Signal(str, int)
    clearRequested = Signal(str)
    frameSelected = Signal(str, int)

    def __init__(self, key: str, title: str, hint: str,
                 parent: QWidget | None = None) -> None:
        super().__init__(title, parent)
        self.key = key
        self._frames: list[Frame] = []
        layout = QVBoxLayout(self)
        layout.setContentsMargins(8, 10, 8, 8)
        layout.setSpacing(6)

        row = QHBoxLayout()
        self.add_button = QPushButton("导入…")
        self.folder_button = QPushButton("文件夹…")
        self.clear_button = QPushButton("清空")
        for button in (self.add_button, self.folder_button, self.clear_button):
            button.setMinimumHeight(24)
            row.addWidget(button)
        layout.addLayout(row)
        self.add_button.clicked.connect(lambda: self.filesRequested.emit(self.key))
        self.folder_button.clicked.connect(lambda: self.folderRequested.emit(self.key))
        self.clear_button.clicked.connect(lambda: self.clearRequested.emit(self.key))

        self.hint = QLabel(hint)
        self.hint.setWordWrap(True)
        self.hint.setStyleSheet("color: #8b93a3; font-size: 11px;")
        layout.addWidget(self.hint)

        head = QHBoxLayout()
        head.setSpacing(8)
        self.thumb = Thumbnail()
        head.addWidget(self.thumb, alignment=Qt.AlignTop)
        text_column = QVBoxLayout()
        text_column.setSpacing(3)
        self.summary = QLabel("—")
        self.summary.setWordWrap(True)
        self.summary.setTextInteractionFlags(Qt.TextSelectableByMouse)
        self.summary.setStyleSheet("font-size: 11px;")
        text_column.addWidget(self.summary)
        self.sat_label = QLabel("—")
        self.sat_label.setWordWrap(True)
        self.sat_label.setStyleSheet("font-size: 11px;")
        text_column.addWidget(self.sat_label)
        text_column.addStretch(1)
        head.addLayout(text_column, 1)
        layout.addLayout(head)

        self.table = QTableWidget(0, 6)
        self.table.setHorizontalHeaderLabels(
            ["文件", "最小", "最大", "均值", "中位", "饱和"])
        self.table.verticalHeader().setVisible(False)
        self.table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.table.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.table.setSelectionMode(QAbstractItemView.ExtendedSelection)
        self.table.setAlternatingRowColors(True)
        self.table.setWordWrap(False)
        self.table.installEventFilter(self)
        header = self.table.horizontalHeader()
        header.setSectionResizeMode(0, QHeaderView.Stretch)
        for col in range(1, 6):
            header.setSectionResizeMode(col, QHeaderView.ResizeToContents)
        self.table.setMinimumHeight(54)
        self.table.setMaximumHeight(118)
        self.table.itemSelectionChanged.connect(self._on_selection)
        layout.addWidget(self.table)

    # ------------------------------------------------------------------ #
    def set_single(self, single: bool) -> None:
        if single:
            self.table.setMaximumHeight(58)
            self.add_button.setText("导入单张…")

    def set_frames(self, frames: list[Frame], stats: GroupStats | FrameStats | None,
                   highlight: np.ndarray | None = None,
                   display: str | None = None) -> None:
        self._frames = frames
        self.clear_button.setEnabled(bool(frames))

        if isinstance(stats, GroupStats):
            per_frame = stats.frames
        elif isinstance(stats, FrameStats):
            per_frame = [stats]
        else:
            per_frame = []
        self.table.blockSignals(True)
        self.table.setRowCount(len(per_frame))
        for row, item in enumerate(per_frame):
            values = [item.name, str(item.vmin), str(item.vmax),
                      _fmt(item.mean), _fmt(item.median), f"{item.sat_count:,}"]
            for col, text in enumerate(values):
                cell = QTableWidgetItem(text)
                cell.setFlags(Qt.ItemIsEnabled | Qt.ItemIsSelectable)
                cell.setToolTip(item.meta.describe())
                if col == 5 and item.sat_count:
                    cell.setForeground(QColor("#ff7b7b"))
                self.table.setItem(row, col, cell)
        self.table.blockSignals(False)

        if isinstance(stats, GroupStats) and stats.frames:
            text = (f"{stats.count} 张 · 尺寸 {stats.shape[1]}×{stats.shape[0]} · "
                    f"全组灰度 {stats.vmin}–{stats.vmax} · 均值 {stats.mean:.1f}")
            self.summary.setText(text)
            self.sat_label.setText(stats.sat_text(FULL_SCALE))
            severe = stats.sat_persistent > 0 or stats.sat_count > 0
            self.sat_label.setStyleSheet(
                "font-size: 11px; color: %s;" % ("#ffb454" if severe else "#9aa3b2"))
        elif isinstance(stats, FrameStats):
            self.summary.setText(
                f"尺寸 {stats.shape[1]}×{stats.shape[0]} · 灰度 {stats.vmin}–{stats.vmax} · "
                f"均值 {stats.mean:.1f} · 1%/99% {stats.p01:.0f}/{stats.p99:.0f}")
            text = "无饱和像素" if not stats.sat_count else (
                f"饱和 {stats.sat_count:,} px ({stats.sat_fraction:.3%}) · "
                f"区域 {stats.bbox_text()} · 中心 "
                f"({stats.sat_centroid[0]:.0f}, {stats.sat_centroid[1]:.0f})")
            self.sat_label.setText(text)
            self.sat_label.setStyleSheet(
                "font-size: 11px; color: %s;" % ("#ffb454" if stats.sat_count else "#9aa3b2"))
        else:
            self.summary.setText("尚未导入")
            self.sat_label.setText("—")
            self.sat_label.setStyleSheet("font-size: 11px; color: #9aa3b2;")

        if display:
            self.hint.setText(display)

        if frames:
            self.thumb.set_frame_preview(frames[0].array.astype(np.float32), highlight)
        else:
            self.thumb.set_frame_preview(None)

    def _on_selection(self) -> None:
        rows = sorted({index.row() for index in self.table.selectedIndexes()})
        if not rows:
            return
        self.frameSelected.emit(self.key, 0 if self.key == "sample" else rows[0])

    def eventFilter(self, obj, event):  # noqa: N802
        if obj is self.table and event.type() == QEvent.Type.KeyPress and \
                event.key() in (Qt.Key_Delete, Qt.Key_Backspace):
            rows = sorted({index.row() for index in self.table.selectedIndexes()},
                          reverse=True)
            for row in rows:
                self.removeRequested.emit(self.key, row)
            return True
        return super().eventFilter(obj, event)


class ConditionsPanel(QGroupBox):
    """Acquisition conditions used to cross-check the imported sets."""

    changed = Signal()

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__("拍摄条件 (用于核对导入的图)", parent)
        outer = QVBoxLayout(self)
        outer.setContentsMargins(8, 8, 8, 8)
        outer.setSpacing(6)

        self.verify_check = QCheckBox("导入时核对曝光与增益")
        self.verify_check.setChecked(True)
        self.verify_check.setToolTip(
            "勾选后, 文件内的曝光/增益元数据会与下方的设定值比较; "
            "不一致时给出警告, 但仍可继续。没有元数据的图只提示不拦截。")
        self.verify_check.toggled.connect(self.changed)
        outer.addWidget(self.verify_check)

        grid = QGridLayout()
        grid.setHorizontalSpacing(8)
        grid.setVerticalSpacing(6)

        def spin(minimum: float, maximum: float, value: float, suffix: str,
                 step: float = 1.0, decimals: int = 2) -> QDoubleSpinBox:
            box = QDoubleSpinBox()
            box.setRange(minimum, maximum)
            box.setDecimals(decimals)
            box.setSingleStep(step)
            box.setValue(value)
            box.setSuffix(suffix)
            box.valueChanged.connect(self.changed)
            return box

        self.dark_exposure = spin(0, 600000, 30.0, " ms")
        self.light_exposure = spin(0, 600000, 30.0, " ms")
        self.sample_exposure = spin(0, 600000, 30.0, " ms")
        self.gain = spin(-120, 120, 0.0, " dB", step=0.5)
        self.exposure_tol = spin(0.01, 100, 1.0, " %", step=0.5)
        self.gain_tol = spin(0.01, 60, 0.15, " dB", step=0.05)
        rows = [("暗场曝光", self.dark_exposure), ("亮场曝光", self.light_exposure),
                ("样品曝光", self.sample_exposure), ("增益", self.gain),
                ("曝光容差", self.exposure_tol), ("增益容差", self.gain_tol)]
        for index, (label, widget) in enumerate(rows):
            grid.addWidget(QLabel(label), index // 2, (index % 2) * 2)
            grid.addWidget(widget, index // 2, (index % 2) * 2 + 1)
        outer.addLayout(grid)

        note = QLabel("取消勾选可跳过核对 (例如参考图来自另一次拍摄)。")
        note.setWordWrap(True)
        note.setStyleSheet("color: #8b93a3; font-size: 10px;")
        outer.addWidget(note)

    def apply_to(self, session) -> None:
        from ..core import Conditions

        enabled = self.verify_check.isChecked()
        session.conditions = Conditions(
            dark_exposure_ms=self.dark_exposure.value() if enabled else None,
            light_exposure_ms=self.light_exposure.value() if enabled else None,
            sample_exposure_ms=self.sample_exposure.value() if enabled else None,
            gain_db=self.gain.value() if enabled else None,
            exposure_tolerance=self.exposure_tol.value() / 100.0,
            gain_tolerance_db=self.gain_tol.value(),
        )


class ImportDock(QWidget):
    """Scrollable column with reference groups, sample and condition settings."""

    importFiles = Signal(str)
    importFolder = Signal(str)
    removeFrame = Signal(str, int)
    clearGroup = Signal(str)
    conditionsChanged = Signal()
    selectFrame = Signal(str, int)
    loadBundle = Signal()

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setMinimumWidth(380)
        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QFrame.NoFrame)
        inner = QWidget()
        column = QVBoxLayout(inner)
        column.setContentsMargins(8, 8, 8, 8)
        column.setSpacing(8)

        self.dark_panel = GroupPanel("dark", "暗场 (遮住镜头)", "至少 1 张; 越接近拍摄时间越稳定。")
        self.light_panel = GroupPanel("light", "亮场 (均匀照明)", "至少 1 张; 与样品同曝光条件。")
        self.sample_panel = GroupPanel("sample", "样品图 (单张)", "只接受一张; 其余尺寸必须完全一致。")
        self.sample_panel.set_single(True)

        for panel in (self.dark_panel, self.light_panel, self.sample_panel):
            panel.filesRequested.connect(self.importFiles)
            panel.folderRequested.connect(self.importFolder)
            panel.removeRequested.connect(self.removeFrame)
            panel.clearRequested.connect(self.clearGroup)
            panel.frameSelected.connect(self.selectFrame)
            column.addWidget(panel)

        self.conditions = ConditionsPanel()
        self.conditions.changed.connect(self.conditionsChanged)
        column.addWidget(self.conditions)

        bundle_button = QPushButton("导入参考集 (.npz / .json / 文件夹)…")
        bundle_button.clicked.connect(self.loadBundle)
        column.addWidget(bundle_button)

        column.addStretch(1)
        scroll.setWidget(inner)
        outer.addWidget(scroll)


class IssueList(QWidget):
    """Validation messages, kept separate from group statistics."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        self.title = QLabel("检查结果")
        self.title.setStyleSheet("font-weight: 600;")
        layout.addWidget(self.title)
        self.body = QLabel("导入后显示尺寸与曝光条件检查结果。")
        self.body.setWordWrap(True)
        self.body.setTextInteractionFlags(Qt.TextSelectableByMouse)
        self.body.setStyleSheet("font-size: 11px;")
        layout.addWidget(self.body)

    def set_issues(self, issues) -> None:
        if not issues:
            self.body.setText('<span style="color:#6ee7a8">尺寸与拍摄条件检查通过。</span>')
            self.body.setTextFormat(Qt.RichText)
            return
        rows = []
        for issue in issues:
            color = _issue_color(issue.severity)
            label = {"error": "阻断", "warning": "警告", "info": "提示"}[issue.severity]
            detail = ""
            if issue.detail:
                escaped = (issue.detail.replace("&", "&amp;").replace("<", "&lt;")
                           .replace("\n", "<br>"))
                detail = (f'<div style="color:#8b93a3; margin-left:10px;">{escaped}</div>')
            rows.append(
                f'<div style="margin-bottom:4px;"><b style="color:{color}">[{label}]</b> '
                f'<span style="color:{color}">{issue.message}</span>{detail}</div>')
        self.body.setTextFormat(Qt.RichText)
        self.body.setText("".join(rows))
