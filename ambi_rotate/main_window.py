"""主窗口: 波形 / 罗盘 / 电平 / 朝向控制 / 标记自动化 / 导出 / 校验。"""

from __future__ import annotations

import math
import os
from pathlib import Path

import numpy as np
from PySide6.QtCore import Qt, QTimer
from PySide6.QtWidgets import (
    QAbstractItemView,
    QButtonGroup,
    QComboBox,
    QDial,
    QDoubleSpinBox,
    QFileDialog,
    QGridLayout,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QRadioButton,
    QSlider,
    QSpinBox,
    QSplitter,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from .audio_engine import AudioEngine
from .channel_dialog import ChannelOrderDialog
from .dsp import (
    ACN_DESCRIPTIONS,
    ACN_NAMES,
    DIR_CCW,
    DIR_CW,
    DIR_SHORTEST,
    MODE_FULL,
    SOLO_MODES,
    YawMarkers,
    custom_to_ambix,
    fuma_to_ambix,
    intensity_azimuth,
)
from .exporter import export_stereo, verify_export
from .synth import make_sample
from .validation import (
    CHANNEL_EXPLANATION,
    DECODER_EXPLANATION,
    run_all_checks,
)
from .wavio import read_wav, write_wav
from .widgets.compass import CompassWidget
from .widgets.level_meter import LevelMeter
from .widgets.waveform import WaveformWidget

MODE_LABELS = [
    (MODE_FULL, "完整一阶 (W+指向)"),
    ("omni", "仅全向分量 W"),
    ("directional", "仅指向分量 Y/Z/X"),
]
for i, name in enumerate(ACN_NAMES):
    MODE_LABELS.append((f"solo{i}", f"单独听第 {i + 1} 路 ({name})"))

DIR_LABELS = ((DIR_SHORTEST, "最短方向"), (DIR_CCW, "逆时针 (+)"), (DIR_CW, "顺时针 (-)"))


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("FOA 声场旋转试听 (AmbiX 四声道)")
        self.resize(1280, 860)

        self.engine = AudioEngine(self)
        self.b: np.ndarray | None = None
        self.sr = 48000
        self.source_path: str | None = None
        self.markers: list[tuple[float, float]] = []
        self._sel_range: tuple[int, int] | None = None

        self._build_ui()
        self._wire()
        # 周期性用当前播放位置估计输入方位, 驱动罗盘蓝点
        self._ui_timer = QTimer(self)
        self._ui_timer.setInterval(150)
        self._ui_timer.timeout.connect(self._update_input_az)
        self._ui_timer.start()

    # ------------------------------------------------------------------ UI
    def _build_ui(self) -> None:
        bar = self.addToolBar("文件")
        bar.setMovable(False)
        self.act_open = bar.addAction("导入四声道 WAV…")
        self.act_sample = bar.addAction("生成并载入内置样例")
        self.act_save_sample = bar.addAction("保存样例为 WAV…")
        self.act_export = bar.addAction("导出立体声 + 设置…")
        self.act_verify = bar.addAction("回读校验导出…")
        self.act_check = bar.addAction("方位校验…")
        for a in (self.act_save_sample, self.act_export, self.act_verify):
            a.setEnabled(False)

        root = QSplitter(Qt.Orientation.Horizontal)

        # 左: 波形 + 播放控制
        left = QWidget()
        lv = QVBoxLayout(left)
        self.wave = WaveformWidget()
        lv.addWidget(self.wave, 1)
        transport = QHBoxLayout()
        self.btn_play = QPushButton("播放")
        self.btn_pause = QPushButton("暂停")
        self.btn_stop = QPushButton("停止")
        self.btn_loop = QPushButton("循环: 关")
        self.btn_clear_sel = QPushButton("清除选区")
        self.lbl_time = QLabel("0.000 / 0.000 s")
        for b in (self.btn_play, self.btn_pause, self.btn_stop,
                  self.btn_loop, self.btn_clear_sel):
            transport.addWidget(b)
        transport.addWidget(self.lbl_time)
        transport.addStretch(1)
        lv.addLayout(transport)

        # 中: 罗盘 + 电平
        center = QWidget()
        cv = QVBoxLayout(center)
        self.compass = CompassWidget()
        cv.addWidget(self.compass, 2)
        meter_box = QGroupBox("输出电平 (dBFS, RMS 条 / 白线为峰值)")
        mh = QHBoxLayout(meter_box)
        self.meter = LevelMeter()
        mh.addWidget(self.meter)
        self.btn_reset_clip = QPushButton("清除削波灯")
        mh.addWidget(self.btn_reset_clip)
        cv.addWidget(meter_box, 1)
        self.lbl_solo_note = QLabel("")
        self.lbl_solo_note.setWordWrap(True)
        self.lbl_solo_note.setStyleSheet("color:#C9A227;")
        cv.addWidget(self.lbl_solo_note)

        # 右: 控制区
        right = QWidget()
        right.setMaximumWidth(430)
        rv = QVBoxLayout(right)

        yaw_box = QGroupBox("水平朝向 yaw (逆时针为正, 0=前)")
        gl = QGridLayout(yaw_box)
        self.dial = QDial()
        self.dial.setRange(0, 359)
        self.dial.setWrapping(True)
        self.spn_yaw = QSpinBox()
        self.spn_yaw.setRange(0, 359)
        self.spn_yaw.setSuffix("°")
        self.sld_yaw = QSlider(Qt.Orientation.Horizontal)
        self.sld_yaw.setRange(0, 359)
        gl.addWidget(self.dial, 0, 0, 3, 1)
        gl.addWidget(QLabel("角度"), 0, 1)
        gl.addWidget(self.spn_yaw, 0, 2)
        gl.addWidget(self.sld_yaw, 1, 1, 1, 2)
        self.lbl_out_az = QLabel("旋转后声源方位: —")
        gl.addWidget(self.lbl_out_az, 2, 1, 1, 2)
        rv.addWidget(yaw_box)

        spk_box = QGroupBox("虚拟扬声器夹角 (左右各 φ, 相对朝向)")
        sh = QHBoxLayout(spk_box)
        self.sld_angle = QSlider(Qt.Orientation.Horizontal)
        self.sld_angle.setRange(10, 170)
        self.sld_angle.setValue(90)
        self.spn_angle = QSpinBox()
        self.spn_angle.setRange(10, 170)
        self.spn_angle.setValue(90)
        self.spn_angle.setSuffix("°")
        sh.addWidget(self.sld_angle)
        sh.addWidget(self.spn_angle)
        rv.addWidget(spk_box)

        mode_box = QGroupBox("试听内容")
        mv = QVBoxLayout(mode_box)
        self.cmb_mode = QComboBox()
        for key, label in MODE_LABELS:
            self.cmb_mode.addItem(label, key)
        mv.addWidget(self.cmb_mode)
        self.mode_group = QButtonGroup(self)
        row = QHBoxLayout()
        for i, name in enumerate(ACN_NAMES):
            rb = QRadioButton(name)
            self.mode_group.addButton(rb, i)
            row.addWidget(rb)
        mv.addLayout(row)
        rv.addWidget(mode_box)

        mk_box = QGroupBox("朝向标记 (标记间线性插值, 自动连续转向)")
        mv2 = QVBoxLayout(mk_box)
        addrow = QHBoxLayout()
        self.spn_mk_t = QDoubleSpinBox()
        self.spn_mk_t.setDecimals(3)
        self.spn_mk_t.setSingleStep(0.5)
        self.spn_mk_t.setSuffix(" s")
        self.spn_mk_y = QDoubleSpinBox()
        self.spn_mk_y.setRange(-360.0, 720.0)
        self.spn_mk_y.setSuffix("°")
        self.btn_mk_add = QPushButton("用当前位置加标记")
        self.btn_mk_del = QPushButton("删除选中")
        addrow.addWidget(QLabel("时刻"))
        addrow.addWidget(self.spn_mk_t)
        addrow.addWidget(QLabel("朝向"))
        addrow.addWidget(self.spn_mk_y)
        mv2.addLayout(addrow)
        mv2.addWidget(self.btn_mk_add)
        mv2.addWidget(self.btn_mk_del)
        self.tbl_mk = QTableWidget(0, 2)
        self.tbl_mk.setHorizontalHeaderLabels(("时刻 s", "朝向 °"))
        self.tbl_mk.horizontalHeader().setSectionResizeMode(
            QHeaderView.ResizeMode.Stretch)
        self.tbl_mk.setSelectionBehavior(
            QAbstractItemView.SelectionBehavior.SelectRows)
        mv2.addWidget(self.tbl_mk)
        dirrow = QHBoxLayout()
        dirrow.addWidget(QLabel("跨界旋转方向"))
        self.cmb_dir = QComboBox()
        for key, label in DIR_LABELS:
            self.cmb_dir.addItem(label, key)
        dirrow.addWidget(self.cmb_dir)
        mv2.addLayout(dirrow)
        self.chk_auto = QRadioButton("按标记自动化播放(关闭时手动控制朝向)")
        mv2.addWidget(self.chk_auto)
        rv.addWidget(mk_box)
        rv.addStretch(1)

        root.addWidget(left)
        root.addWidget(center)
        root.addWidget(right)
        root.setStretchFactor(0, 5)
        root.setStretchFactor(1, 3)
        root.setStretchFactor(2, 3)
        self.setCentralWidget(root)
        self.statusBar().showMessage("就绪")

    def _wire(self) -> None:
        self.act_open.triggered.connect(self.open_wav)
        self.act_sample.triggered.connect(self.load_builtin_sample)
        self.act_save_sample.triggered.connect(self.save_sample_wav)
        self.act_export.triggered.connect(self.export_dialog)
        self.act_verify.triggered.connect(self.verify_dialog)
        self.act_check.triggered.connect(self.show_validation)

        self.btn_play.clicked.connect(self.engine.play)
        self.btn_pause.clicked.connect(self.engine.pause)
        self.btn_stop.clicked.connect(self.engine.stop)
        self.btn_loop.clicked.connect(self.toggle_loop)
        self.btn_clear_sel.clicked.connect(self._clear_selection)
        self.btn_reset_clip.clicked.connect(self.meter.reset_clip)

        self.dial.valueChanged.connect(self._on_yaw_widget)
        self.spn_yaw.valueChanged.connect(self._on_yaw_widget)
        self.sld_yaw.valueChanged.connect(self._on_yaw_widget)
        self.sld_angle.valueChanged.connect(self._on_angle_widget)
        self.spn_angle.valueChanged.connect(self._on_angle_widget)
        self.cmb_mode.currentIndexChanged.connect(self._on_mode_changed)
        self.mode_group.buttonToggled.connect(self._on_solo)

        self.wave.positionMoved.connect(self.engine.seek)
        self.wave.rangeChanged.connect(self._on_wave_selection)
        self.engine.positionChanged.connect(self._on_position)
        self.engine.levelsChanged.connect(self.meter.set_levels)
        self.engine.stateChanged.connect(self._on_state)
        self.engine.errorOccurred.connect(
            lambda msg: QMessageBox.warning(self, "音频错误", msg))

        self.btn_mk_add.clicked.connect(self._add_marker)
        self.btn_mk_del.clicked.connect(self._del_marker)
        self.tbl_mk.cellChanged.connect(self._on_marker_edited)
        self.cmb_dir.currentIndexChanged.connect(self._refresh_automation)
        self.chk_auto.toggled.connect(self._refresh_automation)

    # ------------------------------------------------------------------ 数据
    def open_wav(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "选择四声道 WAV", "", "WAV (*.wav *.wave)")
        if not path:
            return
        # 不受信任目录中的文件: 仅用 stdlib/numpy 读取样本, 不执行其中任何代码
        try:
            wav = read_wav(path)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "读取失败", str(exc))
            return
        if wav.channels != 4:
            QMessageBox.critical(
                self, "通道数不符", f"本工具只收四声道一阶 FOA, 该文件为 {wav.channels} 通道。")
            return
        dlg = ChannelOrderDialog(self)
        if dlg.exec() != ChannelOrderDialog.DialogCode.Accepted:
            return
        preset, perm = dlg.selection()
        if preset == "fuma":
            data = fuma_to_ambix(wav.data)
        elif preset == "custom":
            data = custom_to_ambix(wav.data, perm or (0, 1, 2, 3))
        else:
            data = wav.data
        self._load_data(
            data, wav.sample_rate, source_path=path,
            note=f"已导入 {os.path.basename(path)} ({preset}, {wav.bits}bit)")

    def load_builtin_sample(self) -> None:
        data = make_sample(48000)
        self._load_data(
            data, 48000, source_path=None,
            note="内置样例: 固定 +60° 声源 (440Hz) + 逆时针绕圈声源 (720Hz, 4s/圈), AmbiX")

    def save_sample_wav(self) -> None:
        if self.b is None:
            return
        path, _ = QFileDialog.getSaveFileName(
            self, "保存样例", "ambi_sample.wav", "WAV (*.wav)")
        if path:
            write_wav(path, self.b, self.sr, subtype="float32")
            self.statusBar().showMessage(f"样例已保存: {path}")

    def _load_data(self, data: np.ndarray, sr: int, *,
                   source_path: str | None, note: str) -> None:
        self.b = np.asarray(data, dtype=np.float64)
        self.sr = sr
        self.source_path = source_path
        n = self.b.shape[0]
        self.spn_mk_t.setMaximum(n / sr)
        self.engine.set_source(self.b, sr)
        self.engine.set_params(mode=self._current_mode(),
                               speaker_angle=self.spn_angle.value(),
                               yaw_deg=self.spn_yaw.value())
        self.wave.set_data(self.b, sr)
        self._sel_range = None
        self.markers.clear()
        self._reload_marker_table()
        self.chk_auto.setChecked(False)
        self.compass.set_markers([])
        self.lbl_time.setText(f"0.000 / {n / sr:.3f} s")
        self.act_save_sample.setEnabled(True)
        self.act_export.setEnabled(True)
        self.act_verify.setEnabled(True)
        self.statusBar().showMessage(note)

    # ------------------------------------------------------------------ 控制
    def _current_mode(self) -> str:
        return self.cmb_mode.currentData()

    def _on_yaw_widget(self, value: int) -> None:
        sender = self.sender()
        for w in (self.dial, self.spn_yaw, self.sld_yaw):
            if w is not sender:
                w.blockSignals(True)
                w.setValue(value)
                w.blockSignals(False)
        self.compass.set_yaw(value)
        self.engine.set_params(yaw_deg=value)
        self._refresh_out_az()

    def _on_angle_widget(self, value: int) -> None:
        sender = self.sender()
        for w in (self.sld_angle, self.spn_angle):
            if w is not sender:
                w.blockSignals(True)
                w.setValue(value)
                w.blockSignals(False)
        self.compass.set_speaker_angle(value)
        self.engine.set_params(speaker_angle=value)

    def _on_mode_changed(self, _idx: int) -> None:
        mode = self._current_mode()
        self.engine.set_params(mode=mode)
        if mode == "solo2":
            self.lbl_solo_note.setText(
                "提示: Z 为垂直分量, 水平虚拟扬声器无对应摆位; 试听时等幅送入 L/R 仅为监听。")
        elif mode in SOLO_MODES:
            ch = int(mode[-1])
            self.lbl_solo_note.setText(
                f"单独监听第 {ch + 1} 路 ({ACN_NAMES[ch]}): "
                f"{ACN_DESCRIPTIONS[ch].split('  ', 1)[-1]}")
        else:
            self.lbl_solo_note.setText("")
        self.meter.set_labels(("L", "R"))

    def _on_solo(self, button, checked: bool) -> None:
        if not checked:
            return
        idx = self.mode_group.id(button)
        # 单选按钮是另一种入口: 跳到对应 solo 模式
        self.cmb_mode.setCurrentIndex(3 + idx)

    def toggle_loop(self) -> None:
        loop = self.btn_loop.text().endswith("关")
        self.btn_loop.setText("循环: 开" if loop else "循环: 关")
        self.engine.set_loop(loop)

    def _on_wave_selection(self, start: int, end: int) -> None:
        self._sel_range = (start, end)
        self.engine.set_range(start, end)
        self.statusBar().showMessage(
            f"试听/导出选区: {start / self.sr:.3f}s – {end / self.sr:.3f}s")

    def _clear_selection(self) -> None:
        self._sel_range = None
        self.wave.clear_selection()
        if self.b is not None:
            self.engine.set_range(0, self.b.shape[0])

    def _on_position(self, frame: int) -> None:
        self.wave.set_position(frame)
        total = self.b.shape[0] / self.sr if self.b is not None else 0
        self.lbl_time.setText(f"{frame / self.sr:.3f} / {total:.3f} s")
        if self.chk_auto.isChecked() and self.markers:
            auto = self._build_automation()
            y = int(round(auto.yaw_at(frame / self.sr))) % 360
            for w in (self.dial, self.spn_yaw, self.sld_yaw):
                w.blockSignals(True)
                w.setValue(y)
                w.blockSignals(False)
            self.compass.set_yaw(y)
            self._refresh_out_az()

    def _on_state(self, state: str) -> None:
        self.btn_play.setEnabled(state != "playing")

    def _update_input_az(self) -> None:
        if self.b is None:
            return
        pos = self.engine._pos  # 当前帧
        block_n = min(self.sr // 10, self.b.shape[0])
        s = max(0, pos - block_n)
        block = self.b[s:s + block_n]
        if block.shape[0] < 16:
            return
        az = intensity_azimuth(block)
        if az is not None:
            self.compass.set_input_azimuth(math.degrees(az))
            self._refresh_out_az()

    def _refresh_out_az(self) -> None:
        az = self.compass._input_az
        if az is None:
            self.lbl_out_az.setText("旋转后声源方位: —")
            return
        res = (az - self.spn_yaw.value()) % 360.0
        self.lbl_out_az.setText(
            f"旋转后声源方位: {res:.1f}° (输入 {az:.1f}°)")

    # ------------------------------------------------------------------ 标记
    def _add_marker(self) -> None:
        if self.b is None:
            return
        t = self.spn_mk_t.value()
        y = self.spn_mk_y.value() % 360.0
        self.markers.append((float(t), float(y)))
        self._reload_marker_table()
        self._refresh_automation()

    def _del_marker(self) -> None:
        row = self.tbl_mk.currentRow()
        if 0 <= row < len(self.markers):
            del self.markers[row]
            self._reload_marker_table()
            self._refresh_automation()

    def _reload_marker_table(self) -> None:
        self.markers.sort()
        self.tbl_mk.blockSignals(True)
        self.tbl_mk.setRowCount(len(self.markers))
        for r, (t, y) in enumerate(self.markers):
            self.tbl_mk.setItem(r, 0, QTableWidgetItem(f"{t:.3f}"))
            self.tbl_mk.setItem(r, 1, QTableWidgetItem(f"{y:.1f}"))
        self.tbl_mk.blockSignals(False)
        self.compass.set_markers([y for _, y in self.markers])

    def _on_marker_edited(self, row: int, col: int) -> None:
        try:
            t = float(self.tbl_mk.item(row, 0).text())
            y = float(self.tbl_mk.item(row, 1).text()) % 360.0
        except (ValueError, AttributeError):
            self._reload_marker_table()
            return
        self.markers[row] = (t, y)
        self._reload_marker_table()
        self._refresh_automation()

    def _build_automation(self) -> YawMarkers:
        return YawMarkers(markers=list(self.markers),
                          direction=self.cmb_dir.currentData())

    def _refresh_automation(self) -> None:
        auto = self._build_automation() if self.chk_auto.isChecked() else None
        self.engine.set_automation(auto)
        enabled = self.chk_auto.isChecked()
        for w in (self.dial, self.spn_yaw, self.sld_yaw):
            w.setEnabled(not enabled)
        self.compass.set_markers([y for _, y in self.markers])

    # ------------------------------------------------------------------ 导出
    def export_dialog(self) -> None:
        if self.b is None:
            return
        dlg = _ExportDialog(self, self)
        dlg.exec()

    def verify_dialog(self) -> None:
        if self.b is None:
            return
        path, _ = QFileDialog.getOpenFileName(
            self, "选择导出设置 JSON", "", "JSON (*.json)")
        if not path:
            return
        try:
            report = verify_export(path, self.b, self.sr)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "回读失败", str(exc))
            return
        s = report["settings"]
        lines = [
            "✓ 通过" if report["ok"] else "✗ 不一致",
            f"起止时刻: {report['expected_start']:.3f}s – "
            f"{report['expected_end']:.3f}s "
            f"(期望 {report['expected_frames']} 帧, 实际 {report['actual_frames']} 帧)",
            f"左右声道顺序: {report['expected_order']}",
            f"扬声器夹角: {s.speaker_angle_deg:.1f}°, 模式: {s.mode}",
            (f"自动化: {len(s.markers)} 个标记, 方向={s.direction}"
             if s.use_automation else f"固定朝向: {s.fixed_yaw_deg:.1f}°"),
        ]
        if report["reasons"]:
            lines.append("问题:")
            lines.extend(f"  - {r}" for r in report["reasons"])
        QMessageBox.information(self, "导出回读校验", "\n".join(lines))

    # ------------------------------------------------------------------ 校验
    def show_validation(self) -> None:
        results = run_all_checks(self.sr)
        all_pass = all(r.passed for r in results)
        lines = ["== 本地数值校验 =="]
        for r in results:
            lines.append(("✓ " if r.passed else "✗ ") + r.name)
            lines.append("    " + r.detail)
        lines.append("")
        lines.append("== 四个输入通道含义 (AmbiX / ACN+SN3D) ==")
        for name, text in CHANNEL_EXPLANATION:
            lines.append(f"  {name}: {text}")
        lines.append("")
        lines.append(DECODER_EXPLANATION)
        box = QMessageBox(self)
        box.setWindowTitle("方位校验与通道说明")
        box.setText("\n".join(lines))
        box.setIcon(QMessageBox.Icon.Information if all_pass
                    else QMessageBox.Icon.Warning)
        box.exec()

    def closeEvent(self, ev):
        self.engine.teardown()
        ev.accept()


# ---------------------------------------------------------------------------
class _ExportDialog(QWidget):
    def __init__(self, parent, win: MainWindow):
        super().__init__(parent, Qt.WindowType.Dialog)
        self.win = win
        self.setWindowTitle("导出立体声与朝向设置")
        v = QVBoxLayout(self)
        n = win.b.shape[0]
        sr = win.sr
        i0, i1 = win._sel_range or (0, n)

        grid = QGridLayout()
        self.spn_t0 = QDoubleSpinBox()
        self.spn_t1 = QDoubleSpinBox()
        for sp in (self.spn_t0, self.spn_t1):
            sp.setDecimals(3)
            sp.setRange(0.0, n / sr)
            sp.setSingleStep(0.1)
            sp.setSuffix(" s")
        self.spn_t0.setValue(i0 / sr)
        self.spn_t1.setValue(i1 / sr)
        grid.addWidget(QLabel("起始时刻"), 0, 0)
        grid.addWidget(self.spn_t0, 0, 1)
        grid.addWidget(QLabel("结束时刻"), 1, 0)
        grid.addWidget(self.spn_t1, 1, 1)

        self.cmb_order = QComboBox()
        self.cmb_order.addItems(["LR (左,右)", "RL (右,左)"])
        grid.addWidget(QLabel("左右声道顺序"), 2, 0)
        grid.addWidget(self.cmb_order, 2, 1)

        self.cmb_sub = QComboBox()
        self.cmb_sub.addItems(["pcm16", "pcm24", "float32"])
        grid.addWidget(QLabel("WAV 格式"), 3, 0)
        grid.addWidget(self.cmb_sub, 3, 1)
        v.addLayout(grid)

        info = QLabel(
            f"扬声器夹角 {win.spn_angle.value()}°, 试听模式 {win._current_mode()}; "
            f"朝向: {'标记自动化' if win.chk_auto.isChecked() else f'固定 {win.spn_yaw.value()}°'}。\n"
            "导出由这些参数离线重算, 与当前播放/试听位置无关。")
        info.setWordWrap(True)
        v.addWidget(info)

        row = QHBoxLayout()
        btn_ok = QPushButton("导出")
        btn_cancel = QPushButton("取消")
        row.addStretch(1)
        row.addWidget(btn_ok)
        row.addWidget(btn_cancel)
        v.addLayout(row)
        btn_ok.clicked.connect(self._do_export)
        btn_cancel.clicked.connect(self.close)
        self.resize(460, 260)
        self.show()

    def _do_export(self) -> None:
        t0, t1 = self.spn_t0.value(), self.spn_t1.value()
        if t1 <= t0:
            QMessageBox.warning(self, "时间范围无效", "结束时刻必须晚于起始时刻。")
            return
        base, _ = QFileDialog.getSaveFileName(
            self, "导出立体声 WAV", "export_stereo.wav", "WAV (*.wav)")
        if not base:
            return
        settings_path = str(Path(base).with_suffix(".json"))
        auto = self.win._build_automation() if self.win.chk_auto.isChecked() else None
        try:
            export_stereo(
                base, settings_path, self.win.b, self.win.sr,
                start_time=t0, end_time=t1,
                speaker_angle_deg=self.win.spn_angle.value(),
                mode=self.win._current_mode(),
                fixed_yaw_deg=self.win.spn_yaw.value(),
                automation=auto,
                lr_order="RL" if self.cmb_order.currentIndex() == 1 else "LR",
                subtype=self.cmb_sub.currentText(),
                source_wav_path=self.win.source_path,
            )
            report = verify_export(settings_path, self.win.b, self.win.sr, base)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "导出失败", str(exc))
            return
        msg = (f"已导出:\n{base}\n{settings_path}\n\n"
               f"回读校验: {'通过' if report['ok'] else '不一致'}")
        if report["reasons"]:
            msg += "\n" + "\n".join(report["reasons"])
        QMessageBox.information(self, "导出完成", msg)
        self.close()
