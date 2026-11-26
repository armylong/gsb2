"""导入 WAV 时的通道顺序选择对话框。"""

from __future__ import annotations

from PySide6.QtWidgets import (
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFormLayout,
    QLabel,
)

AMBIX = "AmbiX (ACN: W,Y,Z,X / SN3D)"
FUMA = "FuMa (W,X,Y,Z / FuMa 增益)"
CUSTOM = "自定义重排 (SN3D, 仅换通道位置)"


class ChannelOrderDialog(QDialog):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("选择输入通道顺序")
        form = QFormLayout(self)
        form.addWidget(QLabel(
            "该 WAV 未携带可识别的 Ambisonic 标识。\n"
            "请声明四个输入通道各自代表的分量:"))
        self.combo = QComboBox()
        self.combo.addItems([AMBIX, FUMA, CUSTOM])
        form.addRow("通道约定", self.combo)

        self.role_combos = []
        roles = ("W", "Y", "Z", "X")
        for i in range(4):
            cb = QComboBox()
            cb.addItems(roles)
            cb.setCurrentIndex(i)
            cb.setEnabled(False)
            self.role_combos.append(cb)
            form.addRow(f"输入第 {i + 1} 路 ->", cb)
        self.combo.currentTextChanged.connect(self._on_preset)
        btns = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel)
        btns.accepted.connect(self.accept)
        btns.rejected.connect(self.reject)
        form.addRow(btns)

    def _on_preset(self, text: str) -> None:
        custom = text == CUSTOM
        for cb in self.role_combos:
            cb.setEnabled(custom)

    def selection(self) -> tuple[str, tuple[int, int, int, int] | None]:
        text = self.combo.currentText()
        if text == AMBIX:
            return "ambix", None
        if text == FUMA:
            return "fuma", None
        roles = [cb.currentIndex() for cb in self.role_combos]
        if sorted(roles) != [0, 1, 2, 3]:
            return "ambix", None
        return "custom", tuple(roles)  # 输入路 i -> ACN roles[i]
