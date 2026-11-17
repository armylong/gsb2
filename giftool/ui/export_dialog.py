"""Export dialog: palette/transparency options plus a conversion preview."""

from __future__ import annotations

import numpy as np
from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QLabel,
    QSpinBox,
    QVBoxLayout,
)

from giftool.quantize import (
    ALPHA_THRESHOLD,
    quantize_frame,
    quantized_to_rgba,
)
from giftool.ui.image_utils import overlay_with_checker


class ExportDialog(QDialog):
    def __init__(self, sample_rgba: np.ndarray, parent=None) -> None:
        super().__init__(parent)
        self.setWindowTitle("导出 GIF 选项")
        self._sample = sample_rgba

        layout = QVBoxLayout(self)
        form = QFormLayout()

        self.colors_spin = QSpinBox()
        self.colors_spin.setRange(2, 256)
        self.colors_spin.setValue(256)
        self.colors_spin.setToolTip("每帧局部调色板的最大颜色数（2–256）")
        form.addRow("颜色数", self.colors_spin)

        self.transparent_check = QCheckBox("启用透明背景")
        self.transparent_check.setChecked(True)
        form.addRow("", self.transparent_check)

        self.optimize_check = QCheckBox("启用局部帧优化（仅改变存储方式）")
        self.optimize_check.setChecked(True)
        form.addRow("", self.optimize_check)

        self.loop_combo = QComboBox()
        self.loop_combo.addItem("无限循环 (loop=0)", 0)
        for count in range(1, 6):
            self.loop_combo.addItem(f"播放 {count + 1} 遍 (loop={count})", count)
        form.addRow("循环", self.loop_combo)

        layout.addLayout(form)

        rule = QLabel(
            f"半透明转换规则：alpha ≥ {ALPHA_THRESHOLD} 视为不透明，"
            f"alpha < {ALPHA_THRESHOLD} 视为完全透明（GIF 不支持半透明）。"
        )
        rule.setWordWrap(True)
        rule.setStyleSheet("color: #555;")
        layout.addWidget(rule)

        layout.addWidget(QLabel("调色板转换预览（基于当前帧）："))
        self.preview_label = QLabel()
        self.preview_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.preview_label.setMinimumHeight(180)
        layout.addWidget(self.preview_label)

        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel
        )
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

        self.colors_spin.valueChanged.connect(self._refresh_preview)
        self.transparent_check.toggled.connect(self._refresh_preview)
        self._refresh_preview()

    def _refresh_preview(self) -> None:
        quantized = quantize_frame(
            self._sample,
            colors=self.colors_spin.value(),
            transparent_background=self.transparent_check.isChecked(),
        )
        rgba = quantized_to_rgba(quantized)
        pixmap = overlay_with_checker(rgba)
        self.preview_label.setPixmap(
            pixmap.scaled(
                180,
                180,
                Qt.AspectRatioMode.KeepAspectRatio,
                Qt.TransformationMode.FastTransformation,
            )
        )

    def options(self) -> dict:
        return {
            "colors": self.colors_spin.value(),
            "transparent_background": self.transparent_check.isChecked(),
            "optimize": self.optimize_check.isChecked(),
            "loop_count": self.loop_combo.currentData(),
        }
