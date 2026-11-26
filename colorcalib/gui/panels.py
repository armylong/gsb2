"""右侧控制面板：取样、校准模型、残差表、预览与导出。"""

from __future__ import annotations

import numpy as np
from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QColor
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QFileDialog,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QPushButton,
    QRadioButton,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from ..calibration import LARGE_DELTA_E
from ..reference import ReferencePatch
from ..sampling import SampleResult


class SamplingPanel(QGroupBox):
    """色格选择与取样结果。"""

    draw_requested = Signal(str)
    role_changed = Signal(str, str)        # patch_id, role
    enabled_changed = Signal(str, bool)    # patch_id, enabled
    delete_requested = Signal(str)
    sample_all_requested = Signal()
    patch_selected = Signal(str)

    def __init__(self, parent=None):
        super().__init__("1. 取样区域", parent)
        layout = QVBoxLayout(self)

        form = QFormLayout()
        self.patch_combo = QComboBox()
        self.patch_combo.currentIndexChanged.connect(self._emit_selected)
        self.draw_btn = QPushButton("在图上拖拽绘制取样框")
        self.draw_btn.clicked.connect(self._emit_draw)
        form.addRow("色格：", self.patch_combo)
        form.addRow("", self.draw_btn)
        layout.addLayout(form)

        self.role_combo = QComboBox()
        self.role_combo.addItem("参与对色拟合", "fit")
        self.role_combo.addItem("仅留作检查", "check")
        self.role_combo.currentIndexChanged.connect(self._emit_role)
        form.addRow("用途：", self.role_combo)

        self.enabled_check = QCheckBox("启用该色格（取消勾选可停用被反光盖住的格子）")
        self.enabled_check.setChecked(True)
        self.enabled_check.toggled.connect(self._emit_enabled)
        layout.addWidget(self.enabled_check)

        self.delete_btn = QPushButton("删除当前色格取样框")
        self.delete_btn.clicked.connect(
            lambda: self.delete_requested.emit(self._current_id())
        )
        layout.addWidget(self.delete_btn)

        self.resample_btn = QPushButton("重新取样全部区域")
        self.resample_btn.clicked.connect(self.sample_all_requested)
        layout.addWidget(self.resample_btn)

        self.table = QTableWidget(0, 5)
        self.table.setHorizontalHeaderLabels(["色格", "用途", "中位 RGB", "状态", "提示"])
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.ResizeToContents)
        self.table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        self.table.itemSelectionChanged.connect(self._sync_controls_from_table)
        layout.addWidget(self.table, stretch=1)
        self._updating = False

    def _current_id(self) -> str:
        return self.patch_combo.currentData() or ""

    def _emit_selected(self) -> None:
        if not self._updating:
            self.patch_selected.emit(self._current_id())

    def _emit_draw(self) -> None:
        pid = self._current_id()
        if pid:
            self.draw_requested.emit(pid)

    def _emit_role(self) -> None:
        pid = self._current_id()
        if pid and not self._updating:
            self.role_changed.emit(pid, self.role_combo.currentData())

    def _emit_enabled(self, checked: bool) -> None:
        pid = self._current_id()
        if pid and not self._updating:
            self.enabled_changed.emit(pid, checked)

    def set_references(self, patches: list[ReferencePatch]) -> None:
        self._updating = True
        current = self.patch_combo.currentData()
        self.patch_combo.clear()
        for p in patches:
            label = f"{p.id} {p.name}".strip()
            self.patch_combo.addItem(label, p.id)
        if current:
            idx = self.patch_combo.findData(current)
            if idx >= 0:
                self.patch_combo.setCurrentIndex(idx)
        self._updating = False

    def select_patch(self, patch_id: str) -> None:
        idx = self.patch_combo.findData(patch_id)
        if idx >= 0:
            self.patch_combo.setCurrentIndex(idx)

    def _sync_controls_from_table(self) -> None:
        rows = self.table.selectionModel().selectedRows()
        if not rows:
            return
        pid = self.table.item(rows[0].row(), 0).data(Qt.ItemDataRole.UserRole)
        self.select_patch(pid)

    def sync_from_roi(self, role: str, enabled: bool) -> None:
        """图上右键改了角色/停用时，同步面板控件。"""
        self._updating = True
        idx = self.role_combo.findData(role)
        if idx >= 0:
            self.role_combo.setCurrentIndex(idx)
        self.enabled_check.setChecked(enabled)
        self._updating = False

    def update_samples(self, samples: dict[str, SampleResult], roi_lookup: dict) -> None:
        self._updating = True
        self.table.setRowCount(len(samples))
        for row, (pid, s) in enumerate(sorted(samples.items())):
            roi = roi_lookup.get(pid)
            role = roi.role if roi else "fit"
            id_item = QTableWidgetItem(pid)
            id_item.setData(Qt.ItemDataRole.UserRole, pid)
            self.table.setItem(row, 0, id_item)
            self.table.setItem(row, 1, QTableWidgetItem("检查" if role == "check" else "拟合"))
            rgb = s.median_rgb
            rgb_item = QTableWidgetItem(f"{rgb[0]:.0f},{rgb[1]:.0f},{rgb[2]:.0f}")
            self.table.setItem(row, 2, rgb_item)
            status = (
                "区域无效" if not s.usable
                else "停用" if not roi.enabled
                else ("警告" if s.warnings else "正常")
            )
            status_item = QTableWidgetItem(status)
            if s.overexposed or s.border_risk:
                status_item.setForeground(QColor(192, 57, 43))
            self.table.setItem(row, 3, status_item)
            self.table.setItem(row, 4, QTableWidgetItem(s.note))
        self.table.resizeColumnsToContents()
        self._updating = False


class CalibrationPanel(QGroupBox):
    """模型选择、拟合诊断与残差表。"""

    model_kind_changed = Signal(str)
    refit_requested = Signal()

    def __init__(self, parent=None):
        super().__init__("2. 颜色修正与残差", parent)
        layout = QVBoxLayout(self)

        kind_row = QHBoxLayout()
        self.rb_full = QRadioButton("完整 3x3 修正")
        self.rb_wb = QRadioButton("仅白平衡（对角矩阵，对照）")
        self.rb_full.setChecked(True)
        self.rb_full.toggled.connect(self._emit_kind)
        kind_row.addWidget(self.rb_full)
        kind_row.addWidget(self.rb_wb)
        layout.addLayout(kind_row)

        self.refit_btn = QPushButton("重新计算修正")
        self.refit_btn.clicked.connect(self.refit_requested)
        layout.addWidget(self.refit_btn)

        self.diagnostic = QLabel("尚未计算")
        self.diagnostic.setWordWrap(True)
        self.diagnostic.setStyleSheet("padding:6px; background:#f4f6f7; border-radius:4px;")
        layout.addWidget(self.diagnostic)

        self.table = QTableWidget(0, 7)
        self.table.setHorizontalHeaderLabels(
            ["色格", "类别", "修正前ΔE", "修正后ΔE", "改动ΔE", "目标RGB", "说明"]
        )
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.ResizeToContents)
        layout.addWidget(self.table, stretch=1)
        self._held_out_label = QLabel("—")
        self._held_out_label.setWordWrap(True)
        layout.addWidget(self._held_out_label)

    def _emit_kind(self) -> None:
        self.model_kind_changed.emit("full" if self.rb_full.isChecked() else "white_balance")

    def set_kind(self, kind: str) -> None:
        (self.rb_full if kind == "full" else self.rb_wb).setChecked(True)

    def show_failure(self, message: str) -> None:
        self.diagnostic.setText(f"⚠ 算不出可靠修正：{message}")
        self.diagnostic.setStyleSheet(
            "padding:6px; background:#fdecea; color:#922; border-radius:4px;"
        )
        self.table.setRowCount(0)
        self._held_out_label.setText("—")

    def show_model(self, model, held_out: list) -> None:
        cond = model.condition_number
        warn = "，偏大、对噪声敏感" if cond >= 30 else ""
        self.diagnostic.setText(
            f"模型：{model.kind}　条件数：{cond:.1f}{warn}\n"
            f"参与拟合 {len(model.used_ids)} 格：平均残差 {model.fit_residual_mean:.2f} ΔE，"
            f"最大 {model.fit_residual_max:.2f} ΔE"
        )
        self.diagnostic.setStyleSheet(
            "padding:6px; background:#eafaf1; color:#196f3d; border-radius:4px;"
        )
        if held_out:
            deltas = [r.delta_after for r in held_out]
            improved = sum(1 for r in held_out if r.delta_after < r.delta_before)
            self._held_out_label.setText(
                f"未参与对色的检查格 {len(held_out)} 块：修正后平均 {np.mean(deltas):.2f} ΔE、"
                f"最大 {np.max(deltas):.2f} ΔE；其中 {improved}/{len(held_out)} 块比修正前更接近目标色"
            )
        else:
            self._held_out_label.setText("当前没有留作检查的格子（把部分格子设为“仅留作检查”以验证泛化）")

    def update_residuals(self, residuals: list) -> None:
        self.table.setRowCount(len(residuals))
        for row, r in enumerate(residuals):
            if not r.enabled:
                category = "停用"
            elif r.role == "check":
                category = "检查"
            elif not r.usable:
                category = "无效"
            else:
                category = "拟合"
            cells = [
                r.patch_id,
                category,
                f"{r.delta_before:.2f}",
                f"{r.delta_after:.2f}",
                f"{r.changed:.2f}",
                f"{r.target_rgb[0]:.0f},{r.target_rgb[1]:.0f},{r.target_rgb[2]:.0f}",
                r.excluded_reason or ("改动很大" if r.changed >= LARGE_DELTA_E else ""),
            ]
            for col, text in enumerate(cells):
                item = QTableWidgetItem(text)
                if r.excluded_reason:
                    item.setForeground(QColor(39, 102, 173))
                elif r.changed >= LARGE_DELTA_E and col == 4:
                    item.setForeground(QColor(192, 57, 43))
                if col == 3 and r.delta_after >= LARGE_DELTA_E:
                    item.setForeground(QColor(192, 57, 43))
                self.table.setItem(row, col, item)
        self.table.resizeColumnsToContents()


class PreviewPanel(QGroupBox):
    """预览模式、越界说明与导出。"""

    mode_changed = Signal(str)
    export_requested = Signal(str)
    save_settings_requested = Signal()

    def __init__(self, parent=None):
        super().__init__("3. 预览与导出", parent)
        layout = QVBoxLayout(self)

        self.mode_combo = QComboBox()
        self.mode_combo.addItem("原始图", "original")
        self.mode_combo.addItem("修正后（与导出同规则）", "corrected")
        self.mode_combo.addItem("仅白平衡对照", "white_balance")
        self.mode_combo.addItem("越界裁剪遮罩", "clipping")
        self.mode_combo.currentIndexChanged.connect(
            lambda: self.mode_changed.emit(self.mode_combo.currentData())
        )
        layout.addWidget(self.mode_combo)

        self.info = QLabel("—")
        self.info.setWordWrap(True)
        self.info.setStyleSheet("padding:6px; background:#fef9e7; border-radius:4px;")
        layout.addWidget(self.info)

        self.export_btn = QPushButton("导出校准图（PNG）…")
        self.export_btn.clicked.connect(self._choose_export)
        layout.addWidget(self.export_btn)

        self.save_btn = QPushButton("保存/另存取样设置（JSON，可重开）…")
        self.save_btn.clicked.connect(self.save_settings_requested)
        layout.addWidget(self.save_btn)

    def _choose_export(self) -> None:
        path, _ = QFileDialog.getSaveFileName(
            self, "导出校准图", "calibrated.png", "PNG 图片 (*.png)"
        )
        if path:
            self.export_requested.emit(path)

    def set_mode(self, mode: str) -> None:
        idx = self.mode_combo.findData(mode)
        if idx >= 0:
            self.mode_combo.setCurrentIndex(idx)

    def update_info(self, clip_count: int, total: int, wb_delta: float | None) -> None:
        pct = 100.0 * clip_count / max(total, 1)
        text = (
            f"越界像素 {clip_count} 个（{pct:.2f}%）：这些像素修正后超出 sRGB 0-255 范围，"
            "预览与导出都按同一规则压到边界，其真实颜色无法在 sRGB 中表示。"
        )
        if wb_delta is not None:
            text += f"\n当前完整修正相对纯白平衡，全图平均再移动 {wb_delta:.2f} ΔE。"
        self.info.setText(text)
