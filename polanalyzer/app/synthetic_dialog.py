"""合成图参数对话框."""

from __future__ import annotations

from PySide6.QtWidgets import (
    QDialog, QDialogButtonBox, QFormLayout, QSpinBox, QDoubleSpinBox, QCheckBox, QLabel,
)

from ..synthetic import SyntheticConfig


class SyntheticDialog(QDialog):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("生成合成偏振图")
        form = QFormLayout(self)

        self.width = QSpinBox(); self.width.setRange(160, 2000); self.width.setValue(640)
        self.height = QSpinBox(); self.height.setRange(160, 2000); self.height.setValue(480)
        self.blob_phi = self._angle(30.0)
        self.patch_phi = self._angle(110.0)
        self.blob_rho = self._ratio(0.70, 0.05)
        self.patch_rho = self._ratio(0.35, 0.05)
        self.noise = QDoubleSpinBox(); self.noise.setRange(0.0, 0.2)
        self.noise.setDecimals(3); self.noise.setSingleStep(0.005); self.noise.setValue(0.012)
        self.dark = QCheckBox("注入极暗方块"); self.dark.setChecked(True)
        self.sat = QCheckBox("注入过曝方块"); self.sat.setChecked(True)

        form.addRow(QLabel("强亮斑: 高斯圆斑, 高亮度强调制; 普通底色为弱调制背景 + 低对比度斑块"))
        form.addRow("宽", self.width)
        form.addRow("高", self.height)
        form.addRow("亮斑偏振方向 φ (°)", self.blob_phi)
        form.addRow("亮斑偏振度 ρ", self.blob_rho)
        form.addRow("普通斑块方向 φ (°)", self.patch_phi)
        form.addRow("普通斑块偏振度 ρ", self.patch_rho)
        form.addRow("噪声 σ", self.noise)
        form.addRow(self.dark)
        form.addRow(self.sat)

        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        form.addRow(buttons)

    @staticmethod
    def _angle(value: float) -> QDoubleSpinBox:
        sb = QDoubleSpinBox()
        sb.setRange(0.0, 179.9)
        sb.setDecimals(1)
        sb.setSingleStep(5.0)
        sb.setValue(value)
        return sb

    @staticmethod
    def _ratio(value: float, minimum: float) -> QDoubleSpinBox:
        sb = QDoubleSpinBox()
        sb.setRange(minimum, 1.0)
        sb.setDecimals(2)
        sb.setSingleStep(0.05)
        sb.setValue(value)
        return sb

    def config(self) -> SyntheticConfig:
        return SyntheticConfig(
            width=self.width.value(), height=self.height.value(),
            blob_phi_deg=self.blob_phi.value(), blob_rho=self.blob_rho.value(),
            patch_phi_deg=self.patch_phi.value(), patch_rho=self.patch_rho.value(),
            noise_sigma=self.noise.value(),
            add_dark_region=self.dark.isChecked(), add_saturated_region=self.sat.isChecked(),
        )
