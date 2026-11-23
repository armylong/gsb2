"""Dialog that generates a synthetic set with known defects and texture."""

from __future__ import annotations

from PySide6.QtWidgets import (
    QCheckBox,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QGroupBox,
    QLabel,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)

from ..generator import SyntheticSet, generate_set


class GeneratorDialog(QDialog):
    """Collects parameters, generates on accept (result in ``self.dataset``)."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("生成测试数据")
        self.setMinimumWidth(420)
        self.dataset: SyntheticSet | None = None
        self.save_requested = False

        layout = QVBoxLayout(self)
        intro = QLabel(
            "生成一组有已知暗角、偏置、饱和点与小型纹理的 16 位灰度图, 用来检查校正后的"
            "背景平坦度、纹理是否保留, 以及有效区域掩膜。真值同时载入, 可在「真值自检」中对照。")
        intro.setWordWrap(True)
        layout.addWidget(intro)

        box = QGroupBox("采集参数")
        form = QFormLayout(box)

        def spin(minimum: int, maximum: int, value: int, suffix: str,
                 step: int = 1) -> QSpinBox:
            widget = QSpinBox()
            widget.setRange(minimum, maximum)
            widget.setValue(value)
            widget.setSingleStep(step)
            widget.setSuffix(suffix)
            return widget

        self.width = spin(160, 4096, 640, " px", 16)
        self.height = spin(120, 4096, 480, " px", 16)
        self.n_dark = spin(1, 20, 5, " 张")
        self.n_light = spin(1, 20, 5, " 张")
        self.seed = spin(0, 2_000_000_000, 20251124, "")
        form.addRow("宽度", self.width)
        form.addRow("高度", self.height)
        form.addRow("暗场张数", self.n_dark)
        form.addRow("亮场张数", self.n_light)
        form.addRow("随机种子", self.seed)
        layout.addWidget(box)

        self.save_check = QCheckBox("生成后另存为文件 (选定目录)")
        layout.addWidget(self.save_check)

        hint = QLabel("包含: cos⁴ 暗角、低频照明起伏、固定偏置、6 个常饱和像素、"
                      "4 个近零响应像素、5 个高起伏像素、1 片大面积遮挡。")
        hint.setWordWrap(True)
        hint.setStyleSheet("color:#8b93a3; font-size:11px;")
        layout.addWidget(hint)

        buttons = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        buttons.button(QDialogButtonBox.Ok).setText("生成")
        buttons.button(QDialogButtonBox.Cancel).setText("取消")
        buttons.accepted.connect(self._generate)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

    def _generate(self) -> None:
        self.setEnabled(False)
        try:
            self.dataset = generate_set(
                (self.height.value(), self.width.value()),
                seed=self.seed.value(),
                n_dark=self.n_dark.value(),
                n_light=self.n_light.value())
            self.save_requested = self.save_check.isChecked()
        finally:
            self.setEnabled(True)
        self.accept()
