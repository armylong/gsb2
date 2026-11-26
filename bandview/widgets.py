"""侧边控制面板: 波段加载、通道分配、显示范围、参考区、归一化差值。"""

from __future__ import annotations

from PySide6.QtCore import Qt, Signal
from PySide6.QtWidgets import (
    QButtonGroup,
    QCheckBox,
    QComboBox,
    QDoubleSpinBox,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QRadioButton,
    QVBoxLayout,
    QWidget,
)

NONE_BAND = "（未分配）"


class RangeSpin(QDoubleSpinBox):
    """支持 uint16/uint32 全范围的数值框, 手动编辑时发 editingFinished 防抖。"""

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setDecimals(4)
        self.setRange(-1.0e12, 1.0e12)
        self.setKeyboardTracking(False)
        self.setSpecialValueText("")


class BandPanel(QGroupBox):
    """波段列表与加载。"""

    load_requested = Signal()
    remove_requested = Signal(int)
    nodata_changed = Signal(int, object)

    def __init__(self, parent=None) -> None:
        super().__init__("① 波段 (同尺寸单通道)", parent)
        self._rows_layout = QFormLayout()
        load_btn = QPushButton("加载波段…")
        load_btn.clicked.connect(self.load_requested.emit)
        layout = QVBoxLayout(self)
        layout.addWidget(load_btn)
        layout.addLayout(self._rows_layout)
        self._row_widgets: list[tuple[QWidget, ...]] = []

    def set_bands(self, bands: list) -> None:
        while self._rows_layout.rowCount():
            self._rows_layout.removeRow(0)
        self._row_widgets.clear()
        for idx, band in enumerate(bands):
            info = QLabel(
                f"<b>{band.name}</b><br>"
                f"{band.dtype} {band.shape[1]}×{band.shape[0]}　"
                f"无值 {int((~band.valid).sum())} px"
            )
            info.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
            remove_btn = QPushButton("移除")
            remove_btn.clicked.connect(lambda _=False, i=idx: self.remove_requested.emit(i))
            row = QWidget()
            row_layout = QHBoxLayout(row)
            row_layout.setContentsMargins(0, 0, 0, 0)
            row_layout.addWidget(info, 1)
            row_layout.addWidget(remove_btn)
            self._rows_layout.addRow(row)
            self._row_widgets.append((info, remove_btn))


class ChannelPanel(QGroupBox):
    """把任意波段分给 R/G/B 屏幕通道。"""

    assignment_changed = Signal(object)  # tuple[str|None, ...] x3

    def __init__(self, parent=None) -> None:
        super().__init__("② 通道分配", parent)
        self._combos: list[QComboBox] = []
        layout = QFormLayout(self)
        for ch in ("R 红屏通道", "G 绿屏通道", "B 蓝屏通道"):
            combo = QComboBox()
            combo.currentIndexChanged.connect(self._emit)
            self._combos.append(combo)
            layout.addRow(ch, combo)

    def set_band_names(self, names: list[str]) -> None:
        for combo in self._combos:
            combo.blockSignals(True)
            current = combo.currentData()
            combo.clear()
            combo.addItem(NONE_BAND, None)
            for name in names:
                combo.addItem(name, name)
            idx = combo.findData(current)
            combo.setCurrentIndex(max(0, idx))
            combo.blockSignals(False)
        self._emit()

    def assignment(self) -> tuple[object, object, object]:
        return tuple(c.currentData() for c in self._combos)

    def combos(self) -> list[QComboBox]:
        return list(self._combos)

    def _emit(self) -> None:
        self.assignment_changed.emit(self.assignment())


class StretchPanel(QGroupBox):
    """显示范围: 全图/参考区, 共同/独立拉伸, 手动上下界, 裁剪覆盖。"""

    mode_changed = Signal(str, str)       # source(roi|full), mode(common|per)
    range_edited = Signal(str, float, float)  # channel key, lo, hi
    apply_auto = Signal()
    clip_toggle = Signal(bool)

    def __init__(self, parent=None) -> None:
        super().__init__("③ 显示范围与拉伸", parent)
        layout = QVBoxLayout(self)

        self.source_group = QButtonGroup(self)
        src_row = QHBoxLayout()
        self.rb_full = QRadioButton("全图取范围")
        self.rb_roi = QRadioButton("参考区取范围")
        self.rb_full.setChecked(True)
        self.source_group.addButton(self.rb_full)
        self.source_group.addButton(self.rb_roi)
        src_row.addWidget(self.rb_full)
        src_row.addWidget(self.rb_roi)
        layout.addLayout(src_row)

        self.mode_group = QButtonGroup(self)
        mode_row = QHBoxLayout()
        self.rb_common = QRadioButton("共同拉伸")
        self.rb_per = QRadioButton("各通道单独拉伸")
        self.rb_common.setChecked(True)
        self.mode_group.addButton(self.rb_common)
        self.mode_group.addButton(self.rb_per)
        mode_row.addWidget(self.rb_common)
        mode_row.addWidget(self.rb_per)
        layout.addLayout(mode_row)

        self.cb_clip = QCheckBox("显示裁剪/无值覆盖色")
        self.cb_clip.setChecked(True)
        layout.addWidget(self.cb_clip)

        self.auto_btn = QPushButton("按当前来源重取自动范围")
        layout.addWidget(self.auto_btn)

        form = QFormLayout()
        self.spins: dict[str, tuple[RangeSpin, RangeSpin]] = {}
        for key, label in (("common", "共同范围"), ("R", "R 通道"), ("G", "G 通道"), ("B", "B 通道")):
            lo = RangeSpin()
            hi = RangeSpin()
            lo.editingFinished.connect(lambda k=key: self._emit_edit(k))
            hi.editingFinished.connect(lambda k=key: self._emit_edit(k))
            form.addRow(f"{label} 下界", lo)
            form.addRow(f"{label} 上界", hi)
            self.spins[key] = (lo, hi)
        layout.addLayout(form)

        self.rb_full.toggled.connect(self._emit_mode)
        self.rb_common.toggled.connect(self._emit_mode)
        self.auto_btn.clicked.connect(self.apply_auto.emit)
        self.cb_clip.toggled.connect(self.clip_toggle.emit)

    def source(self) -> str:
        return "roi" if self.rb_roi.isChecked() else "full"

    def stretch_mode(self) -> str:
        return "per" if self.rb_per.isChecked() else "common"

    def set_spin_values(self, values: dict[str, tuple[float, float]]) -> None:
        for key, (lo, hi) in values.items():
            lo_spin, hi_spin = self.spins[key]
            lo_spin.blockSignals(True)
            hi_spin.blockSignals(True)
            lo_spin.setValue(lo)
            hi_spin.setValue(hi)
            lo_spin.blockSignals(False)
            hi_spin.blockSignals(False)

    def _emit_mode(self) -> None:
        self.mode_changed.emit(self.source(), self.stretch_mode())

    def _emit_edit(self, key: str) -> None:
        lo, hi = self.spins[key]
        self.range_edited.emit(key, lo.value(), hi.value())


class RoiPanel(QGroupBox):
    def __init__(self, parent=None) -> None:
        super().__init__("④ 参考区 (在任一视图上拖拽)", parent)
        layout = QVBoxLayout(self)
        self.label = QLabel("未设置 (全图)")
        self.label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        layout.addWidget(self.label)
        row = QHBoxLayout()
        draw_btn = QPushButton("进入框选模式")
        clear_btn = QPushButton("清除参考区")
        row.addWidget(draw_btn)
        row.addWidget(clear_btn)
        layout.addLayout(row)
        self.draw_btn = draw_btn
        self.clear_btn = clear_btn

    def set_roi_text(self, rect: object) -> None:
        if rect is None:
            self.label.setText("未设置 (全图)")
        else:
            x0, y0, x1, y1 = rect
            self.label.setText(
                f"x [{x0}, {x1})　y [{y0}, {y1})\n"
                f"尺寸 {x1 - x0} × {y1 - y0} 原像素"
            )


class NdviPanel(QGroupBox):
    """归一化差值 (a-b)/(a+b)。"""

    params_changed = Signal(object, object, float)  # a, b, eps
    swap_requested = Signal()

    def __init__(self, parent=None) -> None:
        super().__init__("⑤ 归一化差值 (a−b)/(a+b)", parent)
        layout = QFormLayout(self)
        self.combo_a = QComboBox()
        self.combo_b = QComboBox()
        self.eps_spin = RangeSpin()
        self.eps_spin.setDecimals(8)
        self.eps_spin.setValue(1e-6)
        layout.addRow("分子 a", self.combo_a)
        layout.addRow("分母波段 b", self.combo_b)
        layout.addRow("分母阈值 |a+b| <", self.eps_spin)
        swap_btn = QPushButton("交换 a / b (读数应整体反号)")
        layout.addRow(swap_btn)
        self.swap_btn = swap_btn

        self.combo_a.currentIndexChanged.connect(self._emit)
        self.combo_b.currentIndexChanged.connect(self._emit)
        self.eps_spin.editingFinished.connect(self._emit)
        swap_btn.clicked.connect(self._swap)

    def set_band_names(self, names: list[str]) -> None:
        for combo in (self.combo_a, self.combo_b):
            combo.blockSignals(True)
            current = combo.currentData()
            combo.clear()
            combo.addItem(NONE_BAND, None)
            for name in names:
                combo.addItem(name, name)
            idx = combo.findData(current)
            combo.setCurrentIndex(max(0, idx))
            combo.blockSignals(False)
        self._emit()

    def params(self) -> tuple[object, object, float]:
        return self.combo_a.currentData(), self.combo_b.currentData(), self.eps_spin.value()

    def _emit(self) -> None:
        a, b, eps = self.params()
        self.params_changed.emit(a, b, eps)

    def _swap(self) -> None:
        ia, ib = self.combo_a.currentIndex(), self.combo_b.currentIndex()
        self.combo_a.blockSignals(True)
        self.combo_b.blockSignals(True)
        self.combo_a.setCurrentIndex(ib)
        self.combo_b.setCurrentIndex(ia)
        self.combo_a.blockSignals(False)
        self.combo_b.blockSignals(False)
        self.swap_requested.emit()
        self._emit()


class ExportPanel(QGroupBox):
    export_composite = Signal()
    export_settings = Signal()
    import_settings = Signal()
    generate_sample = Signal()

    def __init__(self, parent=None) -> None:
        super().__init__("⑥ 数据与导出", parent)
        layout = QVBoxLayout(self)
        gen = QPushButton("生成自带测试图到目录…")
        exp_img = QPushButton("导出当前合成图 PNG…")
        exp_set = QPushButton("导出设置 JSON…")
        imp_set = QPushButton("从 JSON 导入设置…")
        for b, sig in (
            (gen, self.generate_sample),
            (exp_img, self.export_composite),
            (exp_set, self.export_settings),
            (imp_set, self.import_settings),
        ):
            b.clicked.connect(sig.emit)
            layout.addWidget(b)
