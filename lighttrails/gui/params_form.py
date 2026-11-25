from __future__ import annotations

from PySide6.QtCore import Signal
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDoubleSpinBox,
    QFormLayout,
    QGroupBox,
    QPushButton,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)

from ..engine import METHOD_BRIGHTEN, METHOD_COUNT, StackParams


class ParameterForm(QWidget):
    paramsChanged = Signal(str)
    runRequested = Signal(str)
    copyRequested = Signal(str)

    def __init__(self, version_key: str, parent=None) -> None:
        super().__init__(parent)
        self.version_key = version_key
        self._blocked = False

        root = QVBoxLayout(self)
        box = QGroupBox(f"参数版本 {version_key}")
        root.addWidget(box)
        form = QFormLayout(box)

        self.method = QComboBox()
        self.method.addItem("取亮部（亮帧/光迹最大值）", METHOD_BRIGHTEN)
        self.method.addItem("按出现次数保留", METHOD_COUNT)
        form.addRow("叠法", self.method)

        self.lum_threshold = QSpinBox()
        self.lum_threshold.setRange(1, 255)
        self.lum_threshold.setValue(34)
        form.addRow("亮度阈值", self.lum_threshold)

        self.excess_threshold = QDoubleSpinBox()
        self.excess_threshold.setRange(0.0, 255.0)
        self.excess_threshold.setDecimals(1)
        self.excess_threshold.setValue(18.0)
        form.addRow("高于暗部基底", self.excess_threshold)

        self.min_occurrences = QSpinBox()
        self.min_occurrences.setRange(1, 999)
        self.min_occurrences.setValue(2)
        form.addRow("最少出现次数", self.min_occurrences)

        self.max_occurrences = QSpinBox()
        self.max_occurrences.setRange(0, 999)
        self.max_occurrences.setValue(0)
        self.max_occurrences.setSpecialValueText("不限")
        form.addRow("最多出现次数", self.max_occurrences)

        self.temporal_support = QCheckBox("用相邻帧确认连续运动")
        self.temporal_support.setChecked(True)
        form.addRow("", self.temporal_support)

        self.motion_radius = QSpinBox()
        self.motion_radius.setRange(0, 500)
        self.motion_radius.setValue(14)
        self.motion_radius.setSuffix(" px")
        form.addRow("运动邻域", self.motion_radius)

        self.anti_flash = QCheckBox("检测并抑制单帧强反光")
        self.anti_flash.setChecked(True)
        form.addRow("", self.anti_flash)

        self.flash_sensitivity = QDoubleSpinBox()
        self.flash_sensitivity.setRange(1.0, 10.0)
        self.flash_sensitivity.setSingleStep(0.25)
        self.flash_sensitivity.setValue(3.0)
        form.addRow("反光判定灵敏度", self.flash_sensitivity)

        self.suppress_isolated = QCheckBox("压掉孤立亮点/热噪点")
        self.suppress_isolated.setChecked(True)
        form.addRow("", self.suppress_isolated)

        self.min_component_area = QSpinBox()
        self.min_component_area.setRange(1, 100000)
        self.min_component_area.setValue(8)
        self.min_component_area.setSuffix(" px²")
        form.addRow("最小组件面积", self.min_component_area)

        self.min_component_span = QSpinBox()
        self.min_component_span.setRange(0, 10000)
        self.min_component_span.setValue(0)
        self.min_component_span.setSuffix(" px")
        self.min_component_span.setSpecialValueText("不检查跨度")
        form.addRow("最小轨迹跨度", self.min_component_span)

        self.baseline_mode = QComboBox()
        self.baseline_mode.addItem("逐像素最小值（最抗单帧反光）", "minimum")
        self.baseline_mode.addItem("逐像素中位数", "median")
        form.addRow("暗部基底", self.baseline_mode)

        self.auto_update = QCheckBox("修改后自动刷新本版本")
        self.auto_update.setChecked(True)
        form.addRow("", self.auto_update)

        self.run_button = QPushButton(f"立即计算版本 {version_key}")
        form.addRow(self.run_button)
        self.copy_button = QPushButton(f"把 {version_key} 的参数复制到另一版本")
        form.addRow(self.copy_button)

        root.addStretch(1)

        for widget in self.findChildren(QSpinBox):
            widget.valueChanged.connect(self._changed)
        for widget in self.findChildren(QDoubleSpinBox):
            widget.valueChanged.connect(self._changed)
        for widget in self.findChildren(QCheckBox):
            widget.toggled.connect(self._changed)
        self.method.currentIndexChanged.connect(self._changed)
        self.baseline_mode.currentIndexChanged.connect(self._changed)
        self.run_button.clicked.connect(lambda: self.runRequested.emit(self.version_key))
        self.copy_button.clicked.connect(lambda: self.copyRequested.emit(self.version_key))
        self._update_enabled()

    def _changed(self, *_args) -> None:
        self._update_enabled()
        if not self._blocked:
            self.paramsChanged.emit(self.version_key)

    def _update_enabled(self) -> None:
        is_count = self.method.currentData() == METHOD_COUNT
        self.min_occurrences.setEnabled(is_count)
        self.max_occurrences.setEnabled(is_count)
        self.motion_radius.setEnabled(self.temporal_support.isChecked())
        self.flash_sensitivity.setEnabled(self.anti_flash.isChecked())
        self.min_component_area.setEnabled(self.suppress_isolated.isChecked())
        self.min_component_span.setEnabled(self.suppress_isolated.isChecked())

    def params(self) -> StackParams:
        return StackParams(
            method=self.method.currentData(),
            lum_threshold=self.lum_threshold.value(),
            excess_threshold=self.excess_threshold.value(),
            min_occurrences=self.min_occurrences.value(),
            max_occurrences=self.max_occurrences.value(),
            temporal_support=self.temporal_support.isChecked(),
            motion_radius=self.motion_radius.value(),
            anti_flash=self.anti_flash.isChecked(),
            flash_sensitivity=self.flash_sensitivity.value(),
            suppress_isolated=self.suppress_isolated.isChecked(),
            min_component_area=self.min_component_area.value(),
            min_component_span=self.min_component_span.value(),
            baseline_mode=self.baseline_mode.currentData(),
        )

    def set_params(self, params: StackParams) -> None:
        self._blocked = True
        try:
            self.method.setCurrentIndex(max(0, self.method.findData(params.method)))
            self.lum_threshold.setValue(params.lum_threshold)
            self.excess_threshold.setValue(params.excess_threshold)
            self.min_occurrences.setValue(params.min_occurrences)
            self.max_occurrences.setValue(params.max_occurrences)
            self.temporal_support.setChecked(params.temporal_support)
            self.motion_radius.setValue(params.motion_radius)
            self.anti_flash.setChecked(params.anti_flash)
            self.flash_sensitivity.setValue(params.flash_sensitivity)
            self.suppress_isolated.setChecked(params.suppress_isolated)
            self.min_component_area.setValue(params.min_component_area)
            self.min_component_span.setValue(params.min_component_span)
            self.baseline_mode.setCurrentIndex(max(0, self.baseline_mode.findData(params.baseline_mode)))
        finally:
            self._blocked = False
        self._update_enabled()
