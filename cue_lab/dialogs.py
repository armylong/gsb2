"""生成声音对话框: 按所选类型动态显示参数, 直接返回 float 波形。"""

from __future__ import annotations

import numpy as np
from PySide6.QtWidgets import (
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QDoubleSpinBox,
    QFormLayout,
    QLabel,
    QVBoxLayout,
)

from . import synth

BG_TYPES = {
    "间歇带限噪声 (模拟一阵一阵的办公室噪声)": "intermittent",
    "窄带噪声 (持续嗡嗡声 + 慢速起伏)": "narrowband",
}
CUE_TYPES = {
    "单频提示音": "tone",
    "双音提示 (前后两半不同频率)": "two_tone",
    "线性扫频提示音": "chirp",
    "窄带噪声提示音": "nb_cue",
}


def _spin(value: float, lo: float, hi: float, step: float, suffix: str = "") -> QDoubleSpinBox:
    s = QDoubleSpinBox()
    s.setRange(lo, hi)
    s.setValue(value)
    s.setSingleStep(step)
    s.setDecimals(2)
    if suffix:
        s.setSuffix(suffix)
    return s


class GenerateDialog(QDialog):
    def __init__(self, role: str, sr: int, parent=None):
        super().__init__(parent)
        self.role = role  # "background" | "cue"
        self.sr = sr
        self.setWindowTitle("生成" + ("背景声" if role == "background" else "提示音"))
        self.setMinimumWidth(420)
        layout = QVBoxLayout(self)
        form = QFormLayout()
        layout.addLayout(form)

        self.type_box = QComboBox()
        type_map = BG_TYPES if role == "background" else CUE_TYPES
        for label, key in type_map.items():
            self.type_box.addItem(label, key)
        form.addRow("类型", self.type_box)

        self.form = form
        self.duration = _spin(6.0 if role == "background" else 0.9, 0.1, 60.0, 0.1, " s")
        form.addRow("时长", self.duration)

        # key -> (spin, label 控件, 适用类型集合)
        self.spin_defs: dict[str, tuple[QDoubleSpinBox, QLabel, set[str]]] = {}

        def add_field(key: str, label: str, value: float, lo: float, hi: float,
                      step: float, suffix: str, kinds: set[str]):
            sp = _spin(value, lo, hi, step, suffix)
            lb = QLabel(label)
            form.addRow(lb, sp)
            self.spin_defs[key] = (sp, lb, kinds)

        add_field("f_low", "下限频率", 400, 40, 9000, 50, " Hz", {"intermittent"})
        add_field("f_high", "上限频率", 900, 80, 11000, 50, " Hz", {"intermittent"})
        add_field("on_ms", "开持续", 450, 30, 3000, 10, " ms", {"intermittent"})
        add_field("off_ms", "关持续", 550, 30, 3000, 10, " ms", {"intermittent"})
        add_field("center", "中心频率", 2000, 100, 10000, 50, " Hz",
                  {"narrowband", "nb_cue"})
        add_field("width", "带宽", 240, 20, 4000, 20, " Hz",
                  {"narrowband", "nb_cue"})
        add_field("am_hz", "起伏频率", 3.0, 0.1, 20.0, 0.5, " Hz", {"narrowband"})
        add_field("freq", "频率", 1200, 80, 10000, 50, " Hz", {"tone"})
        add_field("vibrato", "颤音频率 (0=关)", 0.0, 0.0, 20.0, 0.5, " Hz", {"tone"})
        add_field("f1", "前半频率", 880, 80, 10000, 50, " Hz", {"two_tone"})
        add_field("f2", "后半频率", 1320, 80, 10000, 50, " Hz", {"two_tone"})
        add_field("f_start", "起始频率", 500, 80, 10000, 50, " Hz", {"chirp"})
        add_field("f_end", "结束频率", 2600, 80, 11000, 50, " Hz", {"chirp"})

        self.hint = QLabel()
        self.hint.setWordWrap(True)
        layout.addWidget(self.hint)
        buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel
        )
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        buttons.button(QDialogButtonBox.StandardButton.Ok).setText("生成")
        buttons.button(QDialogButtonBox.StandardButton.Cancel).setText("取消")
        layout.addWidget(buttons)
        self.type_box.currentIndexChanged.connect(self._update_visibility)
        self._update_visibility()

    def _update_visibility(self):
        kind = self.type_box.currentData()
        for sp, lb, kinds in self.spin_defs.values():
            visible = kind in kinds
            sp.setVisible(visible)
            lb.setVisible(visible)
        self.hint.setText(
            "生成结果峰值统一归一到 0.9, 实际响度由主界面电平推子控制。"
            if kind in {"intermittent", "narrowband"}
            else "提示音按当前设置的开始时刻混入时间轴, 超面试听段的部分只在交集内发声。"
        )

    def selected_kind(self) -> str:
        return self.type_box.currentData()

    def _val(self, key: str) -> float:
        return self.spin_defs[key][0].value()

    def build_audio(self) -> np.ndarray:
        kind = self.selected_kind()
        dur = self.duration.value()
        if kind == "intermittent":
            return synth.intermittent_noise(
                self.sr, dur, self._val("f_low"), self._val("f_high"),
                self._val("on_ms"), self._val("off_ms"),
            )
        if kind == "narrowband":
            return synth.narrowband_noise(
                self.sr, dur, self._val("center"), self._val("width"), self._val("am_hz"),
            )
        if kind == "tone":
            return synth.tone_cue(self.sr, dur, self._val("freq"), self._val("vibrato"))
        if kind == "two_tone":
            return synth.two_tone_cue(self.sr, dur, self._val("f1"), self._val("f2"))
        if kind == "chirp":
            return synth.chirp_cue(self.sr, dur, self._val("f_start"), self._val("f_end"))
        return synth.narrowband_cue(self.sr, dur, self._val("center"), self._val("width"))
