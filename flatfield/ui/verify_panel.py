"""Verification dock: selector of viewing modes + objective check against truth."""

from __future__ import annotations

import numpy as np
from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QAbstractItemView,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QPushButton,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from ..verification import VerificationReport


class VerifyPanel(QWidget):
    checkRequested = Signal()
    exportMaskRequested = Signal()

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        outer = QHBoxLayout(self)
        outer.setContentsMargins(8, 8, 8, 8)
        outer.setSpacing(10)

        column = QVBoxLayout()
        column.setSpacing(6)
        self.status = QLabel("未加载真值。可以先用「生成测试数据」创建一组带已知暗角与纹理的图。")
        self.status.setWordWrap(True)
        self.status.setTextInteractionFlags(Qt.TextSelectableByMouse)
        column.addWidget(self.status)

        buttons = QHBoxLayout()
        self.check_button = QPushButton("重新检查")
        self.check_button.clicked.connect(self.checkRequested)
        self.mask_button = QPushButton("导出有效区域掩膜…")
        self.mask_button.clicked.connect(self.exportMaskRequested)
        buttons.addWidget(self.check_button)
        buttons.addWidget(self.mask_button)
        buttons.addStretch(1)
        column.addLayout(buttons)

        self.detail = QLabel("")
        self.detail.setWordWrap(True)
        self.detail.setTextFormat(Qt.RichText)
        self.detail.setTextInteractionFlags(Qt.TextSelectableByMouse)
        column.addWidget(self.detail, 1)
        left = QWidget()
        left.setLayout(column)
        left.setMinimumWidth(330)
        left.setMaximumWidth(470)
        outer.addWidget(left)
        layout = outer

        self.table = QTableWidget(0, 4)
        self.table.setHorizontalHeaderLabels(["指标", "原始样品", "仅暗场", "暗场+亮场"])
        self.table.setColumnWidth(0, 180)
        self.table.verticalHeader().setVisible(False)
        self.table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.table.setSelectionMode(QAbstractItemView.NoSelection)
        self.table.setAlternatingRowColors(True)
        self.table.setWordWrap(True)
        self.table.setHorizontalScrollBarPolicy(Qt.ScrollBarAsNeeded)
        self.table.verticalHeader().setDefaultSectionSize(24)
        self.table.setMinimumHeight(24 * 7 + 30)
        header = self.table.horizontalHeader()
        header.setSectionResizeMode(0, QHeaderView.Interactive)
        self.table.setColumnWidth(0, 180)
        for col in range(1, 4):
            header.setSectionResizeMode(col, QHeaderView.ResizeToContents)
        layout.addWidget(self.table, 1)



    # ------------------------------------------------------------------ #
    def set_report(self, report: VerificationReport | None, has_truth: bool) -> None:
        if not has_truth:
            self.status.setText("未加载真值。可以先用「生成测试数据」创建一组带已知暗角与纹理的图。")
            self.table.setRowCount(0)
            self.detail.setText("")
            return
        if report is None:
            self.status.setText("已加载真值, 生成校正结果后即可对比。")
            self.table.setRowCount(0)
            return

        self.status.setText(
            f"<b>缺陷检测</b>: 召回 {report.defect_recall:.1%} · 精确 {report.defect_precision:.1%} · "
            f"IoU {report.defect_iou:.1%}<br>"
            f"<b>连通区域</b>: 检出大面积 {report.detected_large} 片 / 真值 {report.truth_large} 片 · "
            f"重叠率 {report.large_region_iou:.1%}<br>"
            f"<b>有效区域掩膜</b>与真值一致度 {report.mask_agreement:.1%}")

        variants = list(report.variants)
        truth = report.truth

        def fmt(value, spec: str, suffix: str = "") -> str:
            if value is None or not np.isfinite(value):
                return "—"
            return f"{value:{spec}}{suffix}"

        def background(metrics, attr: str, spec: str, suffix: str = "") -> str:
            bg = metrics.background
            return "—" if bg is None else fmt(getattr(bg, attr), spec, suffix)

        specs: list[tuple[str, str]] = [
            ("背景残差 % (越小越平)", "bg:plane_std_pct"),
            ("背景 1–99% 跨度 %", "bg:p1p99_pct"),
            ("边缘/中心", "bg:edge_center_ratio"),
            ("纹理相关 (→1)", "texture_corr"),
            ("纹理幅度比 (→1)", "texture_ratio_median"),
            ("纹理对比度比 (→1)", "texture_contrast_ratio"),
            ("有效像素占比", "valid_fraction"),
        ]
        columns = variants + [truth]
        self.table.setColumnCount(1 + len(columns))
        self.table.setHorizontalHeaderLabels(
            ["指标"] + [m.label for m in columns])
        self.table.setRowCount(len(specs))
        for row, (label, key) in enumerate(specs):
            cell = QTableWidgetItem(label)
            cell.setFlags(Qt.ItemIsEnabled)
            self.table.setItem(row, 0, cell)
            for col, metrics in enumerate(columns, start=1):
                if key.startswith("bg:"):
                    text = background(metrics, key[3:], ".2f")
                elif key == "texture_corr":
                    text = fmt(metrics.texture_corr, ".5f")
                elif key == "texture_ratio_median":
                    text = fmt(metrics.texture_ratio_median, ".4f")
                elif key == "texture_contrast_ratio":
                    text = fmt(metrics.texture_contrast_ratio, ".4f")
                else:
                    text = fmt(metrics.valid_fraction, ".2%")
                item = QTableWidgetItem(text)
                item.setFlags(Qt.ItemIsEnabled)
                if metrics.label == "真值理想结果":
                    item.setForeground(Qt.gray)
                self.table.setItem(row, col, item)
        self.table.verticalHeader().setDefaultSectionSize(24)
        self.table.setMinimumHeight(24 * 7 + 30)
        header = self.table.horizontalHeader()
        header.setSectionResizeMode(0, QHeaderView.Interactive)
        self.table.setColumnWidth(0, 180)
        for col in range(1, self.table.columnCount()):
            header.setSectionResizeMode(col, QHeaderView.ResizeToContents)

        notes = "".join(f"• {note}<br>" for note in report.notes)
        best = report.variant("暗场+亮场")
        verdict = ""
        if best is not None and best.background is not None:
            ok_flat = best.background.plane_std_pct < 3.0
            ok_texture = (np.isfinite(best.texture_corr) and best.texture_corr > 0.99
                          and abs(best.texture_ratio_median - 1.0) < 0.02)
            verdict = (
                f'<p><b>判读</b>: 背景平坦度 {"通过" if ok_flat else "未通过"} · '
                f'纹理保留 {"通过" if ok_texture else "未通过"}</p>')
        self.detail.setText(verdict + notes + (
            "<p style='color:#8b93a3'>背景平面残差为有效区域内拟合平面后的残差标准差相对中位数的百分比, "
            "越小越平坦; 纹理相关越接近 1、幅度比越接近 1 表示小结构保留越好。</p>"))

    def sizeHint(self):  # noqa: N802
        from PySide6.QtCore import QSize

        return QSize(1100, 250)

    def set_export_enabled(self, enabled: bool) -> None:
        self.mask_button.setEnabled(enabled)
        self.check_button.setEnabled(enabled)
