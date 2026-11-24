"""Main window for the boundary-difference checker."""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PySide6.QtCore import Qt
from PySide6.QtGui import QAction, QColor, QFont, QKeySequence, QPalette
from PySide6.QtWidgets import (
    QAbstractItemView,
    QApplication,
    QCheckBox,
    QComboBox,
    QDoubleSpinBox,
    QFileDialog,
    QFormLayout,
    QFrame,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QSplitter,
    QTabWidget,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from . import samples
from .canvas import ColorBar, DIRECTION_LABELS, MODE_LABELS, Legend, MaskView
from .core import Calibration, Difference, Roi, analyze
from .export import (
    export_difference_png,
    export_hole_csv,
    export_region_csv,
    export_summary_csv,
)
from .io import MaskLoadError, load_mask_png


def _fmt(v: float, digits: int = 3) -> str:
    if v is None or not np.isfinite(v):
        return "—"
    return f"{v:.{digits}f}"


def _mono_item(text: str, align_right: bool = True) -> QTableWidgetItem:
    item = QTableWidgetItem(text)
    if align_right:
        item.setTextAlignment(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
    return item


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("掩膜边界差异检查器")
        self.resize(1280, 820)
        self.a: np.ndarray | None = None
        self.b: np.ndarray | None = None
        self.a_path: str = ""
        self.b_path: str = ""
        self.roi: Roi | None = None
        self.diff: Difference | None = None
        self._updating = False

        self.view = MaskView()
        self.view.samplePicked.connect(self._on_sample_picked)
        self.view.roiChanged.connect(self._on_roi_changed)
        self.view.cursorInfo.connect(self._on_cursor)
        self.legend = Legend()
        self.colorbar = ColorBar()

        self._build_actions()
        self._build_central()
        self._refresh_all()
        self.statusBar().showMessage(
            "提示：载入 PNG 或打开示例 · 空白区域拖动 = 平移，滚轮缩放，单击边界查看最近点"
        )

    # --------------------------------------------------------------- layout
    def _build_actions(self) -> None:
        mb = self.menuBar()
        file_menu = mb.addMenu("文件")
        act_a = QAction("载入 A…", self)
        act_a.setShortcut(QKeySequence("Ctrl+1"))
        act_a.triggered.connect(lambda: self._load_side("A"))
        file_menu.addAction(act_a)
        act_b = QAction("载入 B…", self)
        act_b.setShortcut(QKeySequence("Ctrl+2"))
        act_b.triggered.connect(lambda: self._load_side("B"))
        file_menu.addAction(act_b)
        file_menu.addSeparator()
        act_png = QAction("导出差异图…", self)
        act_png.setShortcut(QKeySequence("Ctrl+E"))
        act_png.triggered.connect(self._export_png)
        file_menu.addAction(act_png)
        act_csv = QAction("导出分区统计 CSV…", self)
        act_csv.setShortcut(QKeySequence("Ctrl+Shift+E"))
        act_csv.triggered.connect(self._export_csv)
        file_menu.addAction(act_csv)
        file_menu.addSeparator()
        act_quit = QAction("退出", self)
        act_quit.triggered.connect(self.close)
        file_menu.addAction(act_quit)

        ex_menu = mb.addMenu("内置示例")
        for key, (label, _) in samples.EXAMPLES.items():
            act = QAction(label, self)
            act.triggered.connect(lambda _=False, k=key: self._load_example(k))
            ex_menu.addAction(act)

    def _build_central(self) -> None:
        root = QSplitter(Qt.Orientation.Horizontal)
        root.addWidget(self._build_left_panel())
        root.addWidget(self._build_center())
        root.addWidget(self._build_right_panel())
        root.setStretchFactor(0, 0)
        root.setStretchFactor(1, 1)
        root.setStretchFactor(2, 0)
        root.setSizes([280, 700, 330])
        self.setCentralWidget(root)

    def _build_left_panel(self) -> QWidget:
        panel = QWidget()
        panel.setMinimumWidth(260)
        panel.setMaximumWidth(340)
        lay = QVBoxLayout(panel)
        lay.setContentsMargins(8, 8, 8, 8)

        load_box = QGroupBox("输入")
        lv = QVBoxLayout(load_box)
        for side in ("A", "B"):
            row = QHBoxLayout()
            btn = QPushButton(f"载入 {side}")
            btn.clicked.connect(lambda _=False, s=side: self._load_side(s))
            label = QLabel("未载入")
            label.setWordWrap(True)
            label.setMinimumWidth(120)
            row.addWidget(btn)
            row.addWidget(label, 1)
            lv.addLayout(row)
            setattr(self, f"{side.lower()}_label", label)
        ex_row = QHBoxLayout()
        for key, (label, _) in samples.EXAMPLES.items():
            b = QPushButton(label)
            b.clicked.connect(lambda _=False, k=key: self._load_example(k))
            ex_row.addWidget(b)
        lv.addLayout(ex_row)
        lay.addWidget(load_box)

        view_box = QGroupBox("显示")
        vv = QVBoxLayout(view_box)
        self.mode_combo = QComboBox()
        for key, label in MODE_LABELS:
            self.mode_combo.addItem(label, key)
        self.mode_combo.currentIndexChanged.connect(self._on_mode)
        vv.addWidget(self.mode_combo)
        self.dir_combo = QComboBox()
        for key, label in DIRECTION_LABELS:
            self.dir_combo.addItem(label, key)
        self.dir_combo.currentIndexChanged.connect(self._on_direction)
        drift = QFormLayout()
        drift.addRow("距离方向", self.dir_combo)
        vv.addLayout(drift)
        self.chk_a = QCheckBox("显示 A")
        self.chk_a.setChecked(True)
        self.chk_b = QCheckBox("显示 B")
        self.chk_b.setChecked(True)
        self.chk_overlap = QCheckBox("重叠")
        self.chk_overlap.setChecked(True)
        self.chk_only_a = QCheckBox("仅 A 的区域")
        self.chk_only_a.setChecked(True)
        self.chk_only_b = QCheckBox("仅 B 的区域")
        self.chk_only_b.setChecked(True)
        for c in (self.chk_a, self.chk_b, self.chk_overlap, self.chk_only_a, self.chk_only_b):
            c.toggled.connect(self._on_visibility)
            vv.addWidget(c)
        lay.addWidget(view_box)

        cal_box = QGroupBox("标定与误差")
        form = QFormLayout(cal_box)
        self.row_spin = QDoubleSpinBox()
        self.col_spin = QDoubleSpinBox()
        self.tol_spin = QDoubleSpinBox()
        for sp in (self.row_spin, self.col_spin, self.tol_spin):
            sp.setDecimals(4)
            sp.setRange(1e-4, 1e6)
            sp.setSingleStep(0.05)
            sp.setKeyboardTracking(False)
        self.row_spin.setValue(1.0)
        self.col_spin.setValue(1.0)
        self.tol_spin.setRange(0.0, 1e6)
        self.tol_spin.setValue(1.0)
        self.row_spin.valueChanged.connect(self._on_calibration)
        self.col_spin.valueChanged.connect(self._on_calibration)
        self.tol_spin.valueChanged.connect(self._on_calibration)
        form.addRow("纵向行高", self.row_spin)
        form.addRow("横向列宽", self.col_spin)
        form.addRow("允许误差", self.tol_spin)
        unit_row = QHBoxLayout()
        self.unit_combo = QComboBox()
        self.unit_combo.setEditable(True)
        for u in ("mm", "µm", "px", "cm", "in"):
            self.unit_combo.addItem(u)
        self.unit_combo.setCurrentText("mm")
        self.unit_combo.currentTextChanged.connect(self._on_calibration)
        unit_row.addWidget(QLabel("单位"))
        unit_row.addWidget(self.unit_combo, 1)
        form.addRow(unit_row)
        note = QLabel("行高/列宽分别使用；距离、热图与面积同单位。")
        note.setWordWrap(True)
        note.setStyleSheet("color: #52514e;")
        form.addRow(note)
        lay.addWidget(cal_box)

        roi_box = QGroupBox("局部统计")
        rv = QVBoxLayout(roi_box)
        self.roi_btn = QPushButton("框选局部")
        self.roi_btn.setCheckable(True)
        self.roi_btn.setToolTip(
            "开启后在图上拖拽画统计框；再点一次退出框选。右键或 Esc 清除选框。"
        )
        self.roi_btn.toggled.connect(self._on_roi_mode)
        rv.addWidget(self.roi_btn)
        self.roi_clear_btn = QPushButton("清除选区（Esc）")
        self.roi_clear_btn.clicked.connect(lambda: self._set_roi(None))
        rv.addWidget(self.roi_clear_btn)
        self.roi_label = QLabel("统计区：整图")
        self.roi_label.setWordWrap(True)
        rv.addWidget(self.roi_label)
        roi_note = QLabel("框边切过图形时，距离仍按原图边界计算，统计只取框内采样点。")
        roi_note.setWordWrap(True)
        roi_note.setStyleSheet("color: #52514e;")
        rv.addWidget(roi_note)
        lay.addWidget(roi_box)

        self.chk_ignore_holes = QCheckBox("忽略孔的边界（只看外圈）")
        self.chk_ignore_holes.setChecked(False)
        self.chk_ignore_holes.toggled.connect(self._on_recompute)
        lay.addWidget(self.chk_ignore_holes)

        lay.addStretch(1)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setWidget(panel)
        scroll.setFrameShape(QFrame.Shape.NoFrame)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        return scroll

    def _build_center(self) -> QWidget:
        box = QWidget()
        v = QVBoxLayout(box)
        v.setContentsMargins(4, 4, 4, 4)
        self.banner = QLabel("")
        self.banner.setWordWrap(True)
        self.banner.setStyleSheet(
            "background:#f0efec; color:#0b0b0b; border:1px solid #e1e0d9;"
            " border-radius:4px; padding:6px;"
        )
        self.banner.hide()
        v.addWidget(self.banner)
        self.legend.setMaximumHeight(30)
        v.addWidget(self.legend)
        row = QHBoxLayout()
        row.setSpacing(6)
        row.addWidget(self.view, 1)
        row.addWidget(self.colorbar)
        v.addLayout(row, 1)
        self.cursor_label = QLabel("")
        self.cursor_label.setStyleSheet("color:#52514e;")
        v.addWidget(self.cursor_label)
        return box

    def _build_right_panel(self) -> QWidget:
        panel = QWidget()
        panel.setMinimumWidth(320)
        panel.setMaximumWidth(430)
        v = QVBoxLayout(panel)
        v.setContentsMargins(8, 8, 8, 8)

        self.tabs = QTabWidget()
        self.tabs.addTab(self._build_stats_tab(), "双向统计")
        self.tabs.addTab(self._build_worst_tab(), "异常边")
        self.tabs.addTab(self._build_region_tab(), "分区")
        self.tabs.addTab(self._build_hole_tab(), "孔")
        v.addWidget(self.tabs)
        return panel

    def _build_stats_tab(self) -> QWidget:
        w = QWidget()
        v = QVBoxLayout(w)
        self.stats_table = QTableWidget(0, 3)
        self.stats_table.setHorizontalHeaderLabels(["统计量", "A → B", "B → A"])
        self._prep_table(self.stats_table)
        v.addWidget(self.stats_table, 1)
        self.area_table = QTableWidget(0, 2)
        self.area_table.setHorizontalHeaderLabels(["面积", "数值"])
        self._prep_table(self.area_table)
        v.addWidget(self.area_table, 1)
        self.compare_label = QLabel("")
        self.compare_label.setWordWrap(True)
        self.compare_label.setStyleSheet("color:#0b0b0b; padding:4px;")
        v.addWidget(self.compare_label)
        return w

    def _build_worst_tab(self) -> QWidget:
        w = QWidget()
        v = QVBoxLayout(w)
        hint = QLabel("按本方向距离从大到小；双击一行在图上定位两端。")
        hint.setWordWrap(True)
        hint.setStyleSheet("color:#52514e;")
        v.addWidget(hint)
        self.worst_table = QTableWidget(0, 4)
        self.worst_table.setHorizontalHeaderLabels(["距离", "采样点", "最近点", "反向采样点"])
        self.worst_table.setHorizontalHeaderItem(0, QTableWidgetItem("距离"))
        self.worst_table.setHorizontalHeaderItem(1, QTableWidgetItem("采样点 行,列"))
        self.worst_table.setHorizontalHeaderItem(2, QTableWidgetItem("最近点 行,列"))
        self.worst_table.setHorizontalHeaderItem(3, QTableWidgetItem("采样侧对应点"))
        self.worst_table.horizontalHeader().setToolTip(
            "采样点：本方向要检查的边界点。最近点：另一条边界上离它最近的像素。"
            "采样侧对应点：从“最近点”回看，本侧边界上离它最近的像素，"
            "用来判断这条异常边两端是否确实对应。"
        )
        self._prep_table(self.worst_table, stretch=False)
        header = self.worst_table.horizontalHeader()
        header.setSectionResizeMode(0, QHeaderView.ResizeMode.ResizeToContents)
        header.setSectionResizeMode(1, QHeaderView.ResizeMode.Stretch)
        header.setSectionResizeMode(2, QHeaderView.ResizeMode.Stretch)
        header.setSectionResizeMode(3, QHeaderView.ResizeMode.Stretch)
        self.worst_table.cellDoubleClicked.connect(self._on_worst_activated)
        v.addWidget(self.worst_table, 1)
        return w

    def _build_region_tab(self) -> QWidget:
        w = QWidget()
        v = QVBoxLayout(w)
        self.region_table = QTableWidget(0, 4)
        self.region_table.setHorizontalHeaderLabels(
            ["类型", "像素", "面积", "最大距离"]
        )
        self._prep_table(self.region_table)
        self.region_table.setToolTip("悬停一行可看到包围盒与质心；完整字段见导出的分区 CSV。")
        v.addWidget(self.region_table, 1)
        self.region_note = QLabel("")
        self.region_note.setWordWrap(True)
        self.region_note.setStyleSheet("color:#52514e;")
        self.region_note.hide()
        v.addWidget(self.region_note)
        return w

    def _build_hole_tab(self) -> QWidget:
        w = QWidget()
        v = QVBoxLayout(w)
        note = QLabel("孔不设面积阈值：1 px 的针孔也会列出。双击定位。")
        note.setWordWrap(True)
        note.setStyleSheet("color:#52514e;")
        v.addWidget(note)
        self.hole_table = QTableWidget(0, 5)
        self.hole_table.setHorizontalHeaderLabels(
            ["掩膜", "像素", "面积", "内切半径", "仅此方有"]
        )
        self._prep_table(self.hole_table, stretch=False)
        hh = self.hole_table.horizontalHeader()
        for c in range(5):
            hh.setSectionResizeMode(c, QHeaderView.ResizeMode.Stretch)
        self.hole_table.cellDoubleClicked.connect(self._on_hole_activated)
        v.addWidget(self.hole_table, 1)
        return w

    @staticmethod
    def _prep_table(table: QTableWidget, stretch: bool = True) -> None:
        table.verticalHeader().setVisible(False)
        table.setAlternatingRowColors(True)
        table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        if stretch:
            table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        table.setWordWrap(False)

    # -------------------------------------------------------------- actions
    def _calibration(self) -> Calibration:
        return Calibration(
            row_size=float(self.row_spin.value()),
            col_size=float(self.col_spin.value()),
            tolerance=float(self.tol_spin.value()),
            unit=self.unit_combo.currentText().strip() or "px",
        )

    def _load_side(self, side: str) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, f"选择掩膜 {side}", "", "PNG 图片 (*.png);;所有图片 (*)"
        )
        if not path:
            return
        try:
            mask = load_mask_png(path)
        except MaskLoadError as exc:
            QMessageBox.warning(self, "读取失败", str(exc))
            return
        if side == "A":
            self.a, self.a_path = mask, path
        else:
            self.b, self.b_path = mask, path
        # A ROI from the previous image would silently limit the new statistics.
        self.roi = None
        if self.roi_btn.isChecked():
            self.roi_btn.setChecked(False)
        if (
            self.a is not None
            and self.b is not None
            and self.a.shape != self.b.shape
        ):
            QMessageBox.warning(
                self,
                "尺寸不一致",
                f"A 为 {self.a.shape[1]}×{self.a.shape[0]}，"
                f"B 为 {self.b.shape[1]}×{self.b.shape[0]}。\n"
                "请载入同尺寸的两张掩膜后再比较。",
            )
        self._refresh_all()

    def _load_example(self, key: str) -> None:
        self.a, self.b = samples.build(key)
        self.roi = None
        if self.roi_btn.isChecked():
            self.roi_btn.setChecked(False)
        label = samples.EXAMPLES[key][0]
        self.a_path = f"内置示例/{label}/A"
        self.b_path = f"内置示例/{label}/B"
        self._refresh_all()

    def _on_mode(self) -> None:
        mode = self.mode_combo.currentData()
        self.view.set_mode(mode)
        self._sync_legend()

    def _on_direction(self) -> None:
        self.view.set_direction(self.dir_combo.currentData())
        self._sync_legend()
        self._refresh_worst()
        self._refresh_colorbar()

    def _on_visibility(self) -> None:
        self.view.set_visibility(
            show_a=self.chk_a.isChecked(),
            show_b=self.chk_b.isChecked(),
            show_overlap=self.chk_overlap.isChecked(),
            show_only_a=self.chk_only_a.isChecked(),
            show_only_b=self.chk_only_b.isChecked(),
        )

    def _on_calibration(self) -> None:
        self._recompute()

    def _on_recompute(self) -> None:
        self._recompute()

    def _on_roi_mode(self, on: bool) -> None:
        self.view.set_roi_mode(on)
        if on:
            self.view.setFocus()

    def _set_roi(self, roi: Roi | None) -> None:
        # Clearing the selection does not leave box-select mode; the user may
        # want to draw another box straight away.
        self.roi = roi
        self._recompute()

    def _on_roi_changed(self, roi: Roi | None) -> None:
        self._set_roi(roi)

    # ------------------------------------------------------------- recompute
    def _refresh_all(self) -> None:
        def describe(path: str, mask) -> str:
            if mask is None:
                return "未载入"
            name = Path(path).name
            h, w = mask.shape
            return f"{name}\n{w}×{h} px，前景 {int(mask.sum())} px"

        self.a_label.setText(describe(self.a_path, self.a))
        self.b_label.setText(describe(self.b_path, self.b))
        self._recompute()

    def _recompute(self) -> None:
        if self._updating:
            return
        if self.a is None or self.b is None:
            self.diff = None
            self.view.set_diff(None)
            self.banner.hide()
            self._clear_tables()
            self.colorbar.set_scale(1.0, 1.0, "—", empty=True)
            return
        self._updating = True
        try:
            calib = self._calibration()
            try:
                diff = analyze(
                    self.a,
                    self.b,
                    calib=calib,
                    roi=self.roi,
                    ignore_hole_boundaries=self.chk_ignore_holes.isChecked(),
                )
            except ValueError as exc:
                # Load-time checks already warned; keep this non-modal so the
                # window stays usable and shows why nothing is computed.
                self.diff = None
                self.view.set_diff(None)
                self._clear_tables()
                self.colorbar.set_scale(1.0, 1.0, calib.unit, empty=True)
                self.banner.setText(str(exc))
                self.banner.show()
                return
            self.diff = diff
            self.view.set_diff(diff)
            self.cursor_label.setText("")
            self._set_banner(diff)
            self._refresh_colorbar()
            self._refresh_stats()
            self._refresh_worst()
            self._refresh_regions()
            self._refresh_holes()
            self._sync_legend()
            self.roi_label.setText(
                f"统计区：行 {diff.roi.row0}:{diff.roi.row1}, 列 {diff.roi.col0}:{diff.roi.col1}"
                if diff.roi_active else "统计区：整图"
            )
        finally:
            self._updating = False

    def _set_banner(self, diff: Difference) -> None:
        text = diff.summary_text()
        if not text and not diff.boundary_available:
            text = "距离不可用。"
        if text:
            self.banner.setText(text)
            self.banner.show()
        else:
            self.banner.hide()

    def _sync_legend(self) -> None:
        self.legend.set_state(
            self.mode_combo.currentData(),
            self.dir_combo.currentData() or "a_to_b",
            self.diff.boundary_available if self.diff else False,
            any(h.is_tiny for h in self.diff.holes) if self.diff else False,
        )

    def _refresh_colorbar(self) -> None:
        diff = self.diff
        if diff is None or not diff.boundary_available:
            self.colorbar.set_scale(1.0, 1.0, self._calibration().unit, empty=True)
            return
        bs = diff.side(self.dir_combo.currentData() or "a_to_b")
        # Use the actual maximum so the hottest sample is legible on the bar
        # instead of saturating above a percentile cut.
        vmax = float(np.max(bs.sample_values)) if bs is not None and bs.n else 1.0
        vmax = max(vmax, diff.calib.tolerance * 1.05, 1e-6)
        self.view.set_vmax(vmax)
        self.colorbar.set_scale(vmax, diff.calib.tolerance, diff.calib.unit)

    def _clear_tables(self) -> None:
        for t in (self.stats_table, self.area_table, self.worst_table,
                  self.region_table, self.hole_table):
            t.setRowCount(0)
        self.compare_label.setText("")

    def _refresh_stats(self) -> None:
        diff = self.diff
        if diff is None:
            self._clear_tables()
            return
        unit = diff.calib.unit
        a = diff.stats("a_to_b")
        b = diff.stats("b_to_a")
        rows = [
            ("边界采样点数", a.as_row()[0], b.as_row()[0]),
            (f"平均 ({unit})", a.as_row()[1], b.as_row()[1]),
            (f"中位 ({unit})", a.as_row()[2], b.as_row()[2]),
            (f"P95 ({unit})", a.as_row()[3], b.as_row()[3]),
            (f"最大 ({unit})", a.as_row()[4], b.as_row()[4]),
            (f"超差 >{diff.calib.tolerance:g} {unit}", a.as_row()[5], b.as_row()[5]),
        ]
        self.stats_table.setRowCount(len(rows))
        for i, (k, va, vb) in enumerate(rows):
            self.stats_table.setItem(i, 0, QTableWidgetItem(k))
            self.stats_table.setItem(i, 1, _mono_item(va))
            self.stats_table.setItem(i, 2, _mono_item(vb))

        ar = diff.area_stats()
        area_unit = diff.calib.area_unit
        scope = "统计区内" if diff.roi_active else ""
        area_rows = [
            (f"{scope}A 面积 ({area_unit})", _fmt(ar.a_area, 2)),
            (f"{scope}B 面积 ({area_unit})", _fmt(ar.b_area, 2)),
            (f"{scope}重叠 ({area_unit})", _fmt(ar.overlap_area, 2)),
            (f"{scope}仅 A ({area_unit})", _fmt(ar.only_a_area, 2)),
            (f"{scope}仅 B ({area_unit})", _fmt(ar.only_b_area, 2)),
            (f"{scope}IoU", f"{ar.jaccard:.4f}"),
            (f"{scope}面积差 |A-B|/max", f"{ar.area_diff_ratio:.2%}"),
        ]
        self.area_table.setRowCount(len(area_rows))
        for i, (k, val) in enumerate(area_rows):
            self.area_table.setItem(i, 0, QTableWidgetItem(k))
            self.area_table.setItem(i, 1, _mono_item(val))

        self.compare_label.setText(self._conclusion(diff, a, b))

    def _conclusion(self, diff: Difference, a, b) -> str:
        """State whether the area verdict and the boundary verdict agree.

        The area verdict deliberately looks at total area (not IoU): a global
        shift keeps total area identical while every boundary point moves. When
        the two verdicts disagree, say so explicitly -- that is the reason both
        measurements exist.
        """
        if not diff.boundary_available:
            return "只有一张掩膜有内容：面积差可读，边界距离无定义。"
        ar = diff.area_stats()
        worst = max(a.maximum, b.maximum)
        tol = diff.calib.tolerance
        area_close = ar.area_diff_ratio <= 0.01
        boundary_close = worst <= tol
        detail = (
            f"面积差 {ar.area_diff_ratio:.2%}，IoU {ar.jaccard:.3f}；"
            f"边界最大距离 {worst:.3f} {diff.calib.unit}（允许 {tol:g}）。"
        )
        if area_close and boundary_close:
            return "两种结论一致：面积接近，边界也在允许误差内。" + detail
        if area_close and not boundary_close:
            return "结论不同：按面积看差异很小，按边界距离看已超差。" + detail
        if not area_close and boundary_close:
            return "结论不同：按面积看差异明显，但边界距离都在允许误差内。" + detail
        return "两种结论一致：面积与边界都超出允许范围。" + detail

    def _refresh_worst(self) -> None:
        diff = self.diff
        self.worst_table.setRowCount(0)
        if diff is None or not diff.boundary_available:
            return
        side = self.dir_combo.currentData() or "a_to_b"
        edges = diff.worst_edges(side, limit=60)
        self.worst_table.setRowCount(len(edges))
        for i, e in enumerate(edges):
            self.worst_table.setItem(i, 0, _mono_item(f"{e['distance']:.3f}"))
            self.worst_table.setItem(i, 1, _mono_item(f"{e['source'][0]}, {e['source'][1]}"))
            self.worst_table.setItem(i, 2, _mono_item(f"{e['nearest'][0]}, {e['nearest'][1]}"))
            self.worst_table.setItem(i, 3, _mono_item(f"{e['reverse'][0]}, {e['reverse'][1]}"))
            if e["distance"] > diff.calib.tolerance:
                for col in range(4):
                    self.worst_table.item(i, col).setForeground(QColor("#d03b3b"))
            self.worst_table.item(i, 0).setData(Qt.ItemDataRole.UserRole, e["index"])

    def _refresh_regions(self) -> None:
        diff = self.diff
        self.region_table.setRowCount(0)
        if diff is None:
            return
        rows = diff.regions
        self.region_table.setRowCount(len(rows))
        area_unit = diff.calib.area_unit
        unit = diff.calib.unit
        for i, r in enumerate(rows):
            kind_item = QTableWidgetItem(r.kind)
            kind_item.setToolTip(
                f"{r.kind}\n包围盒 {r.bbox_text}\n质心 行 {r.centroid[0]:.1f}, 列 {r.centroid[1]:.1f}"
            )
            self.region_table.setItem(i, 0, kind_item)
            self.region_table.setItem(i, 1, _mono_item(str(r.area_px)))
            self.region_table.setItem(i, 2, _mono_item(_fmt(r.area, 2)))
            self.region_table.setItem(i, 3, _mono_item(_fmt(r.max_distance, 3)))
        self.region_table.setHorizontalHeaderLabels(
            ["类型", "像素", f"面积({area_unit})", f"最大距离({unit})"]
        )
        if diff.regions_omitted:
            self.region_note.setText(
                f"区域过多：仅列出最大的 {len(rows)} 个，另 {diff.regions_omitted} 个"
                "小区域未单独测量（面积统计仍包含它们）。"
            )
            self.region_note.show()
        else:
            self.region_note.hide()

    def _refresh_holes(self) -> None:
        diff = self.diff
        self.hole_table.setRowCount(0)
        if diff is None:
            return
        holes = diff.holes
        self.hole_table.setRowCount(len(holes))
        for i, h in enumerate(holes):
            self.hole_table.setItem(i, 0, QTableWidgetItem(h.mask_name))
            self.hole_table.setItem(i, 1, _mono_item(str(h.area_px)))
            self.hole_table.setItem(i, 2, _mono_item(_fmt(h.area, 2)))
            self.hole_table.setItem(i, 3, _mono_item(_fmt(h.radius, 3)))
            mark = "是" if h.only_here else ""
            item = _mono_item(mark)
            if h.is_tiny:
                item.setForeground(QColor("#d03b3b"))
            self.hole_table.setItem(i, 4, item)
            self.hole_table.item(i, 0).setData(Qt.ItemDataRole.UserRole, (h.centroid, h.mask_name))

    # --------------------------------------------------------------- picking
    def _on_sample_picked(self, info) -> None:
        # Canvas clicks only update the readout; the table stays where it is.
        if info is None:
            return
        self.cursor_label.setText(self._sample_text(info))

    def _on_worst_activated(self, row: int, _col: int) -> None:
        diff = self.diff
        if diff is None:
            return
        item = self.worst_table.item(row, 0)
        if item is None:
            return
        index = item.data(Qt.ItemDataRole.UserRole)
        info = self.view.select_sample(int(index), center=True)
        if info is not None:
            self.tabs.setCurrentIndex(1)
            self._show_sample(info)

    def _on_hole_activated(self, row: int, _col: int) -> None:
        diff = self.diff
        if diff is None:
            return
        item = self.hole_table.item(row, 0)
        if item is None:
            return
        centroid, _name = item.data(Qt.ItemDataRole.UserRole)
        # A hole has no boundary sample of its own; centre the view on it.
        self.view.center_on((int(round(centroid[0])), int(round(centroid[1]))))
        self.cursor_label.setText(
            f"孔中心 行 {centroid[0]:.1f}, 列 {centroid[1]:.1f}（在“孔的边界”视图中高亮）"
        )
        for i in range(self.mode_combo.count()):
            if self.mode_combo.itemData(i) == "holes":
                self.mode_combo.setCurrentIndex(i)
                break
        self.view.selected = None
        self.view.setFocus()

    @staticmethod
    def _sample_text(info: dict) -> str:
        arrow = "A → B" if info["side"] == "a_to_b" else "B → A"
        tail = "（超出允许误差）" if info["distance"] > info["tolerance"] else ""
        return (
            f"{arrow} · 采样点 行 {info['source'][0]}, 列 {info['source'][1]} → "
            f"最近点 行 {info['nearest'][0]}, 列 {info['nearest'][1]} · "
            f"距离 {info['distance']:.3f} {info['unit']}{tail}"
        )

    def _show_sample(self, info: dict) -> None:
        self.cursor_label.setText(self._sample_text(info))

    def _on_cursor(self, text: str) -> None:
        self.cursor_label.setText(text)

    # ---------------------------------------------------------------- export
    def _export_png(self) -> None:
        if self.diff is None:
            QMessageBox.information(self, "导出", "尚无可导出的比较结果。")
            return
        path, _ = QFileDialog.getSaveFileName(
            self, "导出差异图", "mask_difference.png", "PNG 图片 (*.png)"
        )
        if not path:
            return
        try:
            export_difference_png(self.diff, path)
        except OSError as exc:
            QMessageBox.warning(self, "导出失败", str(exc))
            return
        self.statusBar().showMessage(f"已导出差异图: {path}", 6000)

    def _export_csv(self) -> None:
        if self.diff is None:
            QMessageBox.information(self, "导出", "尚无可导出的比较结果。")
            return
        path, _ = QFileDialog.getSaveFileName(
            self, "导出分区统计", "mask_difference.csv", "CSV 文件 (*.csv)"
        )
        if not path:
            return
        p = Path(path)
        try:
            export_summary_csv(self.diff, p)
            export_region_csv(self.diff, p.with_name(p.stem + "_regions.csv"))
            export_hole_csv(self.diff, p.with_name(p.stem + "_holes.csv"))
        except OSError as exc:
            QMessageBox.warning(self, "导出失败", str(exc))
            return
        self.statusBar().showMessage(f"已导出统计: {p}", 6000)


def run(argv: list[str] | None = None) -> int:
    app = QApplication(argv if argv is not None else [])
    app.setApplicationName("maskdiff")
    font = QFont()
    font.setPointSizeF(12.0)
    app.setFont(font)
    pal = app.palette()
    pal.setColor(QPalette.ColorRole.Window, QColor("#f9f9f7"))
    pal.setColor(QPalette.ColorRole.Base, QColor("#fcfcfb"))
    pal.setColor(QPalette.ColorRole.Text, QColor("#0b0b0b"))
    pal.setColor(QPalette.ColorRole.WindowText, QColor("#0b0b0b"))
    app.setPalette(pal)
    win = MainWindow()
    win.show()
    return app.exec()
