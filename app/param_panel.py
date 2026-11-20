"""两组网点参数的编辑面板(A/B 对照)。

面板只持有控件状态；校验、渲染、统计全部由 main_window 调用 core 完成，
非法输入在这里拦截并以普通提示条展示，不产生半成品渲染。
"""

from __future__ import annotations

from PySide6.QtCore import Signal
from PySide6.QtWidgets import (
    QComboBox,
    QDoubleSpinBox,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from halftone.core import (
    DEFAULT_PARAMS,
    GAMMA_RANGE,
    MAX_PERIOD,
    MIN_PERIOD,
    SCREEN_LABELS,
    validate_params,
    HalftoneError,
)

_GAMMA_PRESETS = [
    ("线性 (γ=1.0)", 1.0),
    ("加重中间调 (γ=0.7)", 0.7),
    ("减轻中间调 (γ=1.5)", 1.5),
]


def _make_double_spin(low: float, high: float, step: float, decimals: int):
    sb = QDoubleSpinBox()
    sb.setRange(low, high)
    sb.setDecimals(decimals)
    sb.setSingleStep(step)
    sb.setKeyboardTracking(False)
    return sb


class ParamPanel(QWidget):
    paramsChanged = Signal(str)          # 组名 "A"/"B"
    resetRequested = Signal(str)

    def __init__(self, group_name: str, parent=None):
        super().__init__(parent)
        self.group_name = group_name

        box = QGroupBox(f"参数组 {group_name}", self)
        form = QFormLayout(box)

        self.screen = QComboBox()
        for key, label in SCREEN_LABELS.items():
            self.screen.addItem(label, key)

        self.period = _make_double_spin(MIN_PERIOD, MAX_PERIOD, 1.0, 2)
        self.period.setSuffix(" px")

        # 角度允许任意有限值，展示上规范到 (-180, 180]
        self.angle = _make_double_spin(-180.0, 180.0, 1.0, 2)
        self.angle.setSuffix("° (逆时针)")

        self.phase_x = _make_double_spin(-2000.0, 2000.0, 1.0, 2)
        self.phase_x.setSuffix(" px")
        self.phase_y = _make_double_spin(-2000.0, 2000.0, 1.0, 2)
        self.phase_y.setSuffix(" px")

        self.gamma = _make_double_spin(GAMMA_RANGE[0], GAMMA_RANGE[1], 0.05, 2)
        self.gamma.setPrefix("γ=")

        self.preset = QComboBox()
        for label, value in _GAMMA_PRESETS:
            self.preset.addItem(label, value)

        form.addRow("网点形式", self.screen)
        form.addRow("网格周期 P", self.period)
        form.addRow("角度", self.angle)
        form.addRow("水平相位", self.phase_x)
        form.addRow("垂直相位", self.phase_y)
        form.addRow("墨量曲线", self.gamma)
        form.addRow("曲线预设", self.preset)

        self.hint = QLabel("")
        self.hint.setWordWrap(True)
        self.hint.setStyleSheet("color: #b3261e;")

        self.reset_btn = QPushButton(f"恢复 {group_name} 组默认参数")
        btn_row = QHBoxLayout()
        btn_row.addWidget(self.reset_btn)
        btn_row.addStretch(1)

        root = QVBoxLayout(self)
        root.addWidget(box)
        root.addWidget(self.hint)
        root.addLayout(btn_row)
        root.addStretch(1)

        self.set_values(DEFAULT_PARAMS)

        self.screen.currentIndexChanged.connect(self._changed)
        self.period.valueChanged.connect(self._changed)
        self.angle.valueChanged.connect(self._changed)
        self.phase_x.valueChanged.connect(self._changed)
        self.phase_y.valueChanged.connect(self._changed)
        self.gamma.valueChanged.connect(self._on_gamma_edited)
        self.preset.currentIndexChanged.connect(self._on_preset)
        self.reset_btn.clicked.connect(
            lambda: self.resetRequested.emit(self.group_name)
        )

    # ------------------------------------------------------------------ 取值
    def values(self) -> dict:
        return {
            "screen": self.screen.currentData(),
            "period": self.period.value(),
            "angle": self.angle.value(),
            "phase_x": self.phase_x.value(),
            "phase_y": self.phase_y.value(),
            "gamma": self.gamma.value(),
        }

    def validated_values(self) -> dict:
        """返回校验通过的参数；非法时抛 HalftoneError 并保留界面提示。"""
        try:
            values = validate_params(self.values())
        except HalftoneError as exc:
            self.hint.setText(str(exc))
            raise
        self.hint.setText("")
        return values

    def set_values(self, params: dict) -> None:
        for sb in (self.period, self.angle, self.phase_x, self.phase_y, self.gamma):
            sb.blockSignals(True)
        self.screen.blockSignals(True)

        idx = self.screen.findData(params["screen"])
        self.screen.setCurrentIndex(max(0, idx))
        self.period.setValue(float(params["period"]))
        self.angle.setValue(float(params["angle"]))
        self.phase_x.setValue(float(params["phase_x"]))
        self.phase_y.setValue(float(params["phase_y"]))
        self.gamma.setValue(float(params["gamma"]))

        for sb in (self.period, self.angle, self.phase_x, self.phase_y, self.gamma):
            sb.blockSignals(False)
        self.screen.blockSignals(False)
        self.hint.setText("")

    def clear_error(self) -> None:
        self.hint.setText("")

    # ------------------------------------------------------------------ 槽
    def _on_preset(self) -> None:
        self.gamma.setValue(float(self.preset.currentData()))
        # valueChanged 会触发 _on_gamma_edited -> _changed

    def _on_gamma_edited(self) -> None:
        self.preset.blockSignals(True)
        match = self.preset.findData(round(self.gamma.value(), 6))
        self.preset.setCurrentIndex(match if match >= 0 else -1)
        self.preset.blockSignals(False)
        self._changed()

    def _changed(self) -> None:
        self.paramsChanged.emit(self.group_name)
