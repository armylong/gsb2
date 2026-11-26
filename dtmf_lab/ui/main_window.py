"""主窗口: 左侧是合成与检测参数, 中间是波形/频谱, 下面是识别结果/历史/差异.

界面上的数据流:
  合成参数 --synthesize--> 内存音频 --detect--> DetectionResult
  本地 wav --load_wav-----^
每次识别都追加一条 DetectionRun 到历史, 因此调整检测设定后可以对照"旧结果里
有、新结果里没了"的段落.
"""

from __future__ import annotations

import datetime as _dt
from pathlib import Path

import numpy as np
from PySide6.QtCore import Qt
from PySide6.QtGui import QColor
from PySide6.QtWidgets import (
    QAbstractItemView,
    QCheckBox,
    QComboBox,
    QDoubleSpinBox,
    QFileDialog,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QScrollArea,
    QSlider,
    QSpinBox,
    QSplitter,
    QTabWidget,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from ..analysis import (
    DetectionResult,
    DetectionRun,
    DetectionSettings,
    SegmentAnalysis,
    detect,
    diff_results,
    diff_summary,
    export_result_json,
    export_segments_csv,
    frame_readout,
    run_to_dict,
    spectrum_at,
)
from ..audio import AudioPlayer
from ..samples import SCENARIOS, render_scenario
from ..tones import SynthSettings, normalize_key_input, synthesize
from ..wavio import AudioClip, load_wav, save_wav
from .widgets import COLOR_ACCEPT, SpectrumView, WaveformView

STATUS_COLOR = {
    "accept": QColor("#1d5138"),
    "review": QColor("#5a441b"),
    "reject": QColor("#5a2422"),
}


def _fmt_ms(ms: float) -> str:
    return f"{ms:.0f}"


class SettingsPanel(QGroupBox):
    """检测设定的编辑区和"重新识别"按钮."""

    def __init__(self, on_apply, parent: QWidget | None = None) -> None:
        super().__init__("检测设定", parent)
        self._on_apply = on_apply
        self._editors: dict[str, QDoubleSpinBox | QSpinBox] = {}
        layout = QFormLayout(self)
        layout.setLabelAlignment(Qt.AlignmentFlag.AlignRight)
        self._add(layout, "frame_ms", "分析窗 (毫秒)", 10, 120, 1, 1)
        self._add(layout, "hop_ms", "帧移 (毫秒)", 2, 60, 1, 0)
        self._add(layout, "edge_trim_ms", "去掉起落沿 (毫秒)", 0, 30, 1, 0)
        self._add(layout, "min_key_ms", "最短按键 (毫秒)", 10, 500, 5, 0)
        self._add(layout, "min_release_ms", "最小可分辨空白 (毫秒)", 0, 500, 5, 0)
        self._add(layout, "activation_depth_db", "有声门限退让 (dB)", 3, 40, 1, 1)
        self._add(layout, "tone_prominence_db", "单音突出度 (dB)", 3, 40, 1, 1)
        self._add(layout, "min_snr_db", "最低信噪比 (dB)", -10, 40, 1, 1)
        self._add(layout, "review_snr_db", "待核对信噪比 (dB)", 0, 60, 1, 1)
        self._add(layout, "max_twist_db", "最大强弱差 (dB)", 1, 40, 1, 1)
        self._add(layout, "review_twist_db", "待核对强弱差 (dB)", 1, 40, 1, 1)
        self._add(layout, "freq_tolerance_pct", "频率容差 (%)", 0.1, 20, 0.1, 1)
        self._add(layout, "freq_tolerance_hz", "频率容差下限 (Hz)", 0, 100, 0.5, 1)
        self._add(layout, "min_component_amplitude", "单支最低振幅", 0.0, 0.5, 0.005, 3)

        self.envelope_cb = QCheckBox("波形上叠加电平曲线")
        self.envelope_cb.setChecked(True)
        layout.addRow(self.envelope_cb)

        btn_row = QHBoxLayout()
        self.apply_btn = QPushButton("应用设定并重新识别")
        self.apply_btn.clicked.connect(self._apply)
        self.defaults_btn = QPushButton("恢复默认")
        self.defaults_btn.clicked.connect(self.load_defaults)
        btn_row.addWidget(self.apply_btn)
        btn_row.addWidget(self.defaults_btn)
        layout.addRow(btn_row)
        self.load_defaults()

    def _add(self, layout, key, label, lo, hi, step, decimals) -> None:
        if decimals <= 0:
            box: QDoubleSpinBox | QSpinBox = QSpinBox()
            box.setRange(int(lo), int(hi))
            box.setSingleStep(max(1, int(step)))
        else:
            box = QDoubleSpinBox()
            box.setRange(lo, hi)
            box.setSingleStep(step)
            box.setDecimals(decimals)
        box.setMinimumWidth(96)
        layout.addRow(label, box)
        self._editors[key] = box

    def load_defaults(self) -> None:
        defaults = DetectionSettings()
        for key, box in self._editors.items():
            value = getattr(defaults, key)
            if isinstance(box, QSpinBox):
                box.setValue(int(round(value)))
            else:
                box.setValue(float(value))

    def settings(self) -> DetectionSettings:
        values: dict[str, float] = {}
        for key, box in self._editors.items():
            values[key] = float(box.value()) if isinstance(box, QDoubleSpinBox) else float(box.value())
        return DetectionSettings(**values)

    def _apply(self) -> None:
        try:
            settings = self.settings()
            settings.validate()
        except ValueError as exc:
            QMessageBox.warning(self, "检测设定有误", str(exc))
            return
        self._on_apply(settings)


class SynthPanel(QGroupBox):
    def __init__(self, on_synth, parent: QWidget | None = None) -> None:
        super().__init__("合成按键音", parent)
        self._on_synth = on_synth
        layout = QFormLayout(self)
        layout.setLabelAlignment(Qt.AlignmentFlag.AlignRight)
        self.keys_edit = QLineEdit("123A")
        self.keys_edit.setPlaceholderText("例如 123A 或 555 (空格/逗号都可)")
        layout.addRow("按键序列", self.keys_edit)
        self.low_gain = self._gain_slider(layout, "低频组强弱", 50)
        self.high_gain = self._gain_slider(layout, "高频组强弱", 50)
        self.key_ms = QSpinBox()
        self.key_ms.setRange(10, 3000)
        self.key_ms.setValue(90)
        self.key_ms.setSuffix(" ms")
        layout.addRow("键音持续", self.key_ms)
        self.gap_ms = QSpinBox()
        self.gap_ms.setRange(0, 3000)
        self.gap_ms.setValue(70)
        self.gap_ms.setSuffix(" ms")
        layout.addRow("键间空白", self.gap_ms)
        self.sample_rate = QComboBox()
        for sr in (8000, 16000, 44100):
            self.sample_rate.addItem(f"{sr} Hz", sr)
        layout.addRow("采样率", self.sample_rate)
        self.noise = QDoubleSpinBox()
        self.noise.setRange(0.0, 3.0)
        self.noise.setSingleStep(0.05)
        self.noise.setDecimals(2)
        self.noise.setValue(0.0)
        layout.addRow("背景声强度", self.noise)

        row = QHBoxLayout()
        self.make_btn = QPushButton("生成并载入")
        self.make_btn.clicked.connect(self._make)
        self.save_btn = QPushButton("另存为 wav…")
        self.save_btn.clicked.connect(self._save)
        row.addWidget(self.make_btn)
        row.addWidget(self.save_btn)
        layout.addRow(row)
        self._last_samples: np.ndarray | None = None
        self._last_sr = 8000

    def _gain_slider(self, layout, label, value) -> QSlider:
        holder = QWidget()
        h = QHBoxLayout(holder)
        h.setContentsMargins(0, 0, 0, 0)
        slider = QSlider(Qt.Orientation.Horizontal)
        slider.setRange(0, 100)
        slider.setValue(value)
        readout = QLabel(f"{value / 100:.2f}")
        readout.setMinimumWidth(36)
        slider.valueChanged.connect(lambda v: readout.setText(f"{v / 100:.2f}"))
        h.addWidget(slider)
        h.addWidget(readout)
        layout.addRow(label, holder)
        return slider

    def synth_settings(self) -> SynthSettings:
        return SynthSettings(
            sample_rate=int(self.sample_rate.currentData()),
            low_gain=self.low_gain.value() / 100.0,
            high_gain=self.high_gain.value() / 100.0,
            key_ms=int(self.key_ms.value()),
            gap_ms=int(self.gap_ms.value()),
            noise_level=float(self.noise.value()),
        )

    def _build(self):
        keys = normalize_key_input(self.keys_edit.text())
        if not keys:
            raise ValueError("请先输入至少一个键")
        settings = self.synth_settings()
        settings.validate()
        return synthesize(keys, settings)

    def _make(self) -> None:
        try:
            result = self._build()
        except ValueError as exc:
            QMessageBox.warning(self, "合成参数有误", str(exc))
            return
        self._last_samples = result.samples
        self._last_sr = result.sample_rate
        self._on_synth(result)

    def _save(self) -> None:
        try:
            result = self._build()
        except ValueError as exc:
            QMessageBox.warning(self, "合成参数有误", str(exc))
            return
        path, _ = QFileDialog.getSaveFileName(self, "保存合成的 wav", "synth.wav", "WAV (*.wav)")
        if not path:
            return
        save_wav(path, result.samples, result.sample_rate)
        QMessageBox.information(self, "已保存", f"已写出 {path}")


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("双音按键辨认工作台")
        self.resize(1360, 900)

        self.clip: AudioClip | None = None
        self.result: DetectionResult | None = None
        self.history: list[DetectionRun] = []
        self._selected_segment_index: int | None = None
        self._player = AudioPlayer(self)
        self._player.stateChanged.connect(self._on_player_state)

        central = QWidget()
        self.setCentralWidget(central)
        outer = QHBoxLayout(central)
        splitter = QSplitter(Qt.Orientation.Horizontal)
        outer.addWidget(splitter)

        splitter.addWidget(self._build_left_panel())
        splitter.addWidget(self._build_center())
        splitter.setStretchFactor(0, 0)
        splitter.setStretchFactor(1, 1)
        splitter.setSizes([380, 980])

        # 波形上"叠加电平曲线"的开关要在 center 建好之后再连
        self.settings_panel.envelope_cb.toggled.connect(self.wave_view.set_show_envelope)

        self._build_status_bar()
        self._load_initial_scenario()

    # ---- 布局 ----

    def _build_left_panel(self) -> QWidget:
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setMinimumWidth(360)
        host = QWidget()
        layout = QVBoxLayout(host)

        io_box = QGroupBox("音频")
        io_layout = QVBoxLayout(io_box)
        row = QHBoxLayout()
        self.load_btn = QPushButton("导入本地 wav…")
        self.load_btn.clicked.connect(self._load_wav_dialog)
        self.play_all_btn = QPushButton("整段试听")
        self.play_all_btn.clicked.connect(self._play_all)
        row.addWidget(self.load_btn)
        row.addWidget(self.play_all_btn)
        io_layout.addLayout(row)
        self.audio_label = QLabel("未载入音频")
        self.audio_label.setWordWrap(True)
        io_layout.addWidget(self.audio_label)
        layout.addWidget(io_box)

        self.synth_panel = SynthPanel(self._on_synthesis, self)
        layout.addWidget(self.synth_panel)

        self.settings_panel = SettingsPanel(self._on_apply_settings, self)
        layout.addWidget(self.settings_panel)

        scenario_box = QGroupBox("预置对照样音")
        sc_layout = QVBoxLayout(scenario_box)
        self.scenario_list = QListWidget()
        for scenario in SCENARIOS:
            item = QListWidgetItem(f"{scenario.title}  ({scenario.keys})")
            item.setData(Qt.ItemDataRole.UserRole, scenario.name)
            item.setToolTip(scenario.summary + "\n期望: " + scenario.expect)
            self.scenario_list.addItem(item)
        self.scenario_list.currentRowChanged.connect(self._on_scenario_selected)
        sc_layout.addWidget(self.scenario_list, 1)
        self.scenario_expect = QLabel("选择一个样音查看期望结果")
        self.scenario_expect.setWordWrap(True)
        sc_layout.addWidget(self.scenario_expect)
        load_scenario_btn = QPushButton("生成该样音并重新识别")
        load_scenario_btn.clicked.connect(self._use_scenario)
        sc_layout.addWidget(load_scenario_btn)
        layout.addWidget(scenario_box, 1)

        export_box = QGroupBox("导出")
        ex_layout = QVBoxLayout(export_box)
        row2 = QHBoxLayout()
        self.export_csv_btn = QPushButton("导出清单 csv…")
        self.export_csv_btn.clicked.connect(self._export_csv)
        self.export_json_btn = QPushButton("导出完整 json…")
        self.export_json_btn.clicked.connect(self._export_json)
        row2.addWidget(self.export_csv_btn)
        row2.addWidget(self.export_json_btn)
        ex_layout.addLayout(row2)
        self.export_hint = QLabel("清单含确定/待核对/拒绝候选三类, 拒绝项带原因")
        self.export_hint.setWordWrap(True)
        ex_layout.addWidget(self.export_hint)
        layout.addWidget(export_box)

        scroll.setWidget(host)
        return scroll

    def _build_center(self) -> QWidget:
        host = QWidget()
        layout = QVBoxLayout(host)
        layout.setContentsMargins(0, 0, 0, 0)

        self.wave_view = WaveformView()
        self.wave_view.cursorMoved.connect(self._on_cursor)
        self.wave_view.selectionChanged.connect(self._on_selection)
        layout.addWidget(self.wave_view, 3)

        split2 = QSplitter(Qt.Orientation.Horizontal)
        self.spectrum_view = SpectrumView()
        split2.addWidget(self.spectrum_view)

        readout_box = QGroupBox("光标读数")
        rb_layout = QVBoxLayout(readout_box)
        self.readout_title = QLabel("移动光标或选中一段查看判读")
        self.readout_title.setWordWrap(True)
        rb_layout.addWidget(self.readout_title)
        self.readout_detail = QPlainTextEdit()
        self.readout_detail.setReadOnly(True)
        self.readout_detail.setMaximumBlockCount(200)
        rb_layout.addWidget(self.readout_detail, 1)
        play_sel_row = QHBoxLayout()
        self.play_sel_btn = QPushButton("试听选中段")
        self.play_sel_btn.clicked.connect(self._play_selection)
        self.play_sel_btn.setEnabled(False)
        self.play_seg_btn = QPushButton("试听当前按键")
        self.play_seg_btn.clicked.connect(self._play_current_segment)
        self.play_seg_btn.setEnabled(False)
        play_sel_row.addWidget(self.play_sel_btn)
        play_sel_row.addWidget(self.play_seg_btn)
        rb_layout.addLayout(play_sel_row)
        split2.addWidget(readout_box)
        split2.setSizes([560, 400])
        layout.addWidget(split2, 2)

        self.tabs = QTabWidget()
        self.result_table = self._make_result_table()
        self.tabs.addTab(self.result_table, "识别结果")
        self.rejected_table = self._make_rejected_table()
        self.tabs.addTab(self.rejected_table, "拒绝候选")
        self.history_list = QListWidget()
        self.history_list.currentRowChanged.connect(self._on_history_selected)
        self.tabs.addTab(self.history_list, "历史结果")
        self.diff_box = QPlainTextEdit()
        self.diff_box.setReadOnly(True)
        self.tabs.addTab(self.diff_box, "与旧结果对比")
        self.explain_box = QPlainTextEdit()
        self.explain_box.setReadOnly(True)
        self.tabs.addTab(self.explain_box, "判读说明")
        layout.addWidget(self.tabs, 3)
        return host

    def _make_result_table(self) -> QTableWidget:
        table = QTableWidget(0, 7)
        table.setHorizontalHeaderLabels(
            ["序号", "按键", "状态", "开始 (秒)", "结束 (秒)", "时长 (毫秒)", "原因/备注"]
        )
        table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        table.itemSelectionChanged.connect(self._on_table_selected)
        return table

    def _make_rejected_table(self) -> QTableWidget:
        table = QTableWidget(0, 7)
        table.setHorizontalHeaderLabels(
            ["序号", "候选键", "开始 (秒)", "结束 (秒)", "时长 (毫秒)", "原因", "明细"]
        )
        table.horizontalHeader().setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        table.itemSelectionChanged.connect(self._on_rejected_selected)
        return table

    def _build_status_bar(self) -> None:
        self.status_label = QLabel("就绪")
        self.statusBar().addWidget(self.status_label, 1)
        self.player_label = QLabel("播放器: 待机")
        self.statusBar().addPermanentWidget(self.player_label)

    # ---- 初始数据 ----

    def _load_initial_scenario(self) -> None:
        self.scenario_list.setCurrentRow(0)
        self._use_scenario()

    # ---- 音频载入 ----

    def _set_clip(self, clip: AudioClip, source_note: str) -> None:
        self.clip = clip
        self.wave_view.set_audio(clip.samples, clip.sample_rate)
        self.wave_view.set_show_envelope(self.settings_panel.envelope_cb.isChecked())
        self.audio_label.setText(
            f"{source_note}\n{clip.duration:.3f} 秒, {clip.sample_rate} Hz, 单声道"
        )
        self._player.stop()

    def _load_wav_dialog(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "导入单声道 wav", "", "WAV (*.wav)")
        if not path:
            return
        try:
            clip = load_wav(path)
        except Exception as exc:  # 读失败要给用户明确反馈
            QMessageBox.critical(self, "读取失败", f"{type(exc).__name__}: {exc}")
            return
        self._set_clip(clip, Path(path).name)
        self._run_detection(self.settings_panel.settings())

    def _on_synthesis(self, result) -> None:
        clip = AudioClip(samples=result.samples, sample_rate=result.sample_rate, source="合成")
        self._set_clip(clip, f"合成: 按键 {result.keys}")
        self._run_detection(self.settings_panel.settings())

    # ---- 场景 ----

    def _on_scenario_selected(self, row: int) -> None:
        if row < 0 or row >= len(SCENARIOS):
            return
        scenario = SCENARIOS[row]
        self.scenario_expect.setText(
            f"{scenario.summary}\n期望: {scenario.expect}"
        )

    def _use_scenario(self) -> None:
        row = self.scenario_list.currentRow()
        if row < 0:
            return
        scenario = SCENARIOS[row]
        result = render_scenario(scenario)
        clip = AudioClip(samples=result.samples, sample_rate=result.sample_rate, source=scenario.name)
        self._set_clip(clip, f"样音: {scenario.title}")
        self.synth_panel.keys_edit.setText(scenario.keys)
        self.settings_panel.load_defaults()
        self._run_detection(self.settings_panel.settings(), note=f"样音 {scenario.title}")

    # ---- 识别 ----

    def _run_detection(self, settings: DetectionSettings, note: str = "") -> None:
        if self.clip is None:
            return
        try:
            result = detect(self.clip.samples, self.clip.sample_rate, settings)
        except ValueError as exc:
            QMessageBox.warning(self, "识别失败", str(exc))
            return
        self.result = result
        run = DetectionRun(
            label=f"识别 #{len(self.history) + 1}" + (f" ({note})" if note else ""),
            created_at=_dt.datetime.now().strftime("%H:%M:%S"),
            audio_name=self.clip.source or "内存音频",
            result=result,
        )
        self.history.append(run)
        self._refresh_history()
        self._refresh_tables()
        self._refresh_waveform()
        self._update_status()

    def _on_apply_settings(self, settings: DetectionSettings) -> None:
        self._run_detection(settings, note="调整设定后重识别")

    def _refresh_history(self) -> None:
        self.history_list.blockSignals(True)
        self.history_list.clear()
        for i, run in enumerate(self.history):
            item = QListWidgetItem(
                f"{run.created_at}  {run.summary()}  [最短键 {run.result.settings.min_key_ms:.0f}ms, "
                f"空白 {run.result.settings.min_release_ms:.0f}ms]"
            )
            self.history_list.addItem(item)
        self.history_list.setCurrentRow(len(self.history) - 1)
        self.history_list.blockSignals(False)

    def _refresh_tables(self) -> None:
        assert self.result is not None
        accepted = self.result.accepted
        self.result_table.blockSignals(True)
        self.result_table.setRowCount(len(accepted))
        for row, seg in enumerate(accepted):
            values = [
                str(row + 1),
                seg.key or "?",
                seg.status_label,
                f"{seg.start_s:.3f}",
                f"{seg.end_s:.3f}",
                _fmt_ms(seg.duration_ms),
                seg.reason + ("; " + "; ".join(seg.notes) if seg.notes else ""),
            ]
            for col, text in enumerate(values):
                item = QTableWidgetItem(text)
                if col == 2:
                    item.setBackground(STATUS_COLOR[seg.verdict])
                if col == 6:
                    item.setToolTip(seg.detail)
                self.result_table.setItem(row, col, item)
        self.result_table.blockSignals(False)

        rejected = self.result.rejected
        self.rejected_table.blockSignals(True)
        self.rejected_table.setRowCount(len(rejected))
        for row, seg in enumerate(rejected):
            values = [
                str(row + 1),
                seg.key or "—",
                f"{seg.start_s:.3f}",
                f"{seg.end_s:.3f}",
                _fmt_ms(seg.duration_ms),
                seg.reason,
                seg.detail,
            ]
            for col, text in enumerate(values):
                item = QTableWidgetItem(text)
                if col == 5:
                    item.setBackground(STATUS_COLOR["reject"])
                if col == 6:
                    item.setToolTip(seg.detail)
                self.rejected_table.setItem(row, col, item)
        self.rejected_table.blockSignals(False)
        self._refresh_diff()

    def _refresh_diff(self) -> None:
        if len(self.history) < 2:
            self.diff_box.setPlainText("至少识别两次以后, 这里显示本次与上一次的差异, 重点列出旧结果里有、本次没识别到的段落。")
            return
        current = self.history[-1].result
        previous = self.history[-2].result
        entries = diff_results(current, previous)
        lines = [
            f"本次 {self.history[-1].label}  vs  上次 {self.history[-2].label}",
            diff_summary(entries),
            "",
        ]
        for entry in entries:
            if entry.kind == "same":
                continue
            key = entry.key or (entry.previous.key if entry.previous else "?")
            if entry.kind == "lost":
                seg = entry.previous
                lines.append(
                    f"[丢失] 键 {key!r}  {seg.start_s:.3f}-{seg.end_s:.3f} s  "
                    f"旧判读: {seg.status_label} / {seg.reason}"
                )
            elif entry.kind == "new":
                seg = entry.current
                lines.append(
                    f"[新增] 键 {key!r}  {seg.start_s:.3f}-{seg.end_s:.3f} s  "
                    f"{seg.status_label} / {seg.reason}"
                )
            elif entry.kind == "changed":
                lines.append(
                    f"[改判] {entry.previous.start_s:.3f}-{entry.previous.end_s:.3f} s  "
                    f"{entry.previous.key!r} -> {entry.key!r}"
                )
            elif entry.kind == "moved":
                cur = entry.current
                prev = entry.previous
                lines.append(
                    f"[边界移动] 键 {key!r}  {prev.start_s:.3f}-{prev.end_s:.3f} -> "
                    f"{cur.start_s:.3f}-{cur.end_s:.3f} s"
                )
        self.diff_box.setPlainText("\n".join(lines))

    def _refresh_waveform(self) -> None:
        self.wave_view.set_result(self.result)
        self._attach_levels(self.result)
        self.wave_view.update()
        if self.result is not None and self.result.frame_level_db:
            self.wave_view.zoom_reset()

    def _attach_levels(self, result: DetectionResult | None) -> None:
        self.wave_view._levels_db = np.asarray(result.frame_level_db) if result else None
        self.wave_view._levels_times = np.asarray(result.frame_times) if result else None

    def _update_status(self) -> None:
        if self.result is None:
            self.status_label.setText("就绪")
            return
        r = self.result
        self.status_label.setText(
            f"识别到 {r.keys or '（无）'}   确定 {len(r.confirmed)} / 待核对 {len(r.review)} / "
            f"拒绝候选 {len(r.rejected)}   有声门限 {r.active_threshold_db:.1f} dBFS"
        )

    # ---- 点选 / 读数 ----

    def _on_cursor(self, t: float) -> None:
        if self.clip is None:
            return
        settings = self.result.settings if self.result is not None else self.settings_panel.settings()
        seg = frame_readout(self.clip.samples, self.clip.sample_rate, t, settings)
        self.readout_title.setText(
            f"{t:.3f} 秒: {seg.status_label} · {seg.reason}"
        )
        lines = [seg.reason]
        if seg.low is not None:
            lines.append(
                f"低组: 峰值 {seg.low.peak_hz:.1f} Hz, 标称 {seg.low.nominal:.0f} Hz, "
                f"偏差 {seg.low.offset_hz:+.1f} Hz (容差 {seg.low.tolerance_hz:.1f} Hz), "
                f"振幅 {seg.low.amplitude:.3f}, 突出 {seg.low.prominence_db:.1f} dB"
            )
        if seg.high is not None:
            lines.append(
                f"高组: 峰值 {seg.high.peak_hz:.1f} Hz, 标称 {seg.high.nominal:.0f} Hz, "
                f"偏差 {seg.high.offset_hz:+.1f} Hz (容差 {seg.high.tolerance_hz:.1f} Hz), "
                f"振幅 {seg.high.amplitude:.3f}, 突出 {seg.high.prominence_db:.1f} dB"
            )
        lines.append(
            f"强弱差 {seg.twist_db:+.1f} dB (上限 {settings.max_twist_db:.1f}), "
            f"纯音占比 {seg.tone_share * 100:.0f}%, 信噪比 {seg.snr_db:.1f} dB"
        )
        self.readout_detail.setPlainText("\n".join(lines))
        self.explain_box.appendPlainText(f"[{t:.3f}s] " + lines[0])
        self._refresh_spectrum(t, settings)
        self._highlight_segment_at(t)

    def _refresh_spectrum(self, t: float, settings: DetectionSettings) -> None:
        if self.clip is None:
            return
        freqs, mag = spectrum_at(self.clip.samples, self.clip.sample_rate, t, window_ms=max(40.0, settings.frame_ms))
        markers: dict[float, QColor] = {}
        if self.result is not None:
            seg = self._segment_at(t)
            if seg is not None and seg.low is not None and seg.high is not None:
                markers[seg.low.peak_hz] = COLOR_ACCEPT
                markers[seg.high.peak_hz] = COLOR_ACCEPT
        self.spectrum_view.set_spectrum(freqs, mag, markers)

    def _segment_at(self, t: float) -> SegmentAnalysis | None:
        if self.result is None:
            return None
        for seg in self.result.all_segments():
            if seg.start_s <= t <= seg.end_s:
                return seg
        return None

    def _on_selection(self, start: float, end: float) -> None:
        self.play_sel_btn.setEnabled(end - start > 0.002)
        if self.result is None or self.clip is None:
            return
        chosen = [
            seg
            for seg in self.result.all_segments()
            if seg.start_s >= start - 1e-6 and seg.end_s <= end + 1e-6
        ]
        if chosen:
            keys = " ".join(s.key or "?" for s in chosen)
            self.status_label.setText(
                f"选中 {start:.3f}-{end:.3f} 秒, 覆盖 {len(chosen)} 段: {keys}"
            )

    def _highlight_segment_at(self, t: float) -> None:
        seg = self._segment_at(t)
        if seg is None:
            self.play_seg_btn.setEnabled(False)
            self._selected_segment_index = None
            return
        self.play_seg_btn.setEnabled(True)
        segments = self.result.all_segments() if self.result else []
        try:
            self._selected_segment_index = segments.index(seg)
        except ValueError:
            self._selected_segment_index = None

    def _on_table_selected(self) -> None:
        rows = self.result_table.selectionModel().selectedRows()
        if not rows or self.result is None:
            return
        row = rows[0].row()
        if row >= len(self.result.accepted):
            return
        seg = self.result.accepted[row]
        self._focus_segment(seg)

    def _on_rejected_selected(self) -> None:
        rows = self.rejected_table.selectionModel().selectedRows()
        if not rows or self.result is None:
            return
        row = rows[0].row()
        if row >= len(self.result.rejected):
            return
        seg = self.result.rejected[row]
        self._focus_segment(seg)
        self.readout_title.setText(f"拒绝候选 {seg_label(seg)}: {seg.reason}")
        self.readout_detail.setPlainText(seg.detail)

    def _focus_segment(self, seg: SegmentAnalysis) -> None:
        self.wave_view.set_cursor(seg.start_s, emit=True)
        self.wave_view.set_selection(seg.start_s, seg.end_s)
        self.readout_title.setText(
            f"{seg.status_label} · {seg.reason}" + (f" · 键 {seg.key!r}" if seg.key else "")
        )
        self.readout_detail.setPlainText(seg.detail)
        self.play_seg_btn.setEnabled(True)

    # ---- 播放 ----

    def _play_all(self) -> None:
        if self.clip is None:
            return
        self._player.play(self.clip.samples, self.clip.sample_rate)

    def _play_selection(self) -> None:
        if self.clip is None:
            return
        sel = self.wave_view.selection()
        if sel is None:
            return
        a = int(round(sel.start * self.clip.sample_rate))
        b = int(round(sel.end * self.clip.sample_rate))
        self._player.play(self.clip.samples[a:b], self.clip.sample_rate)

    def _play_current_segment(self) -> None:
        if self.clip is None or self.result is None:
            return
        seg = self._segment_at(self.wave_view.cursor)
        if seg is None:
            return
        a = int(round(seg.start_s * self.clip.sample_rate))
        b = int(round(seg.end_s * self.clip.sample_rate))
        self._player.play(self.clip.samples[a:b], self.clip.sample_rate)

    def _on_player_state(self, text: str) -> None:
        self.player_label.setText(f"播放器: {text}")

    # ---- 历史 ----

    def _on_history_selected(self, row: int) -> None:
        if row < 0 or row >= len(self.history):
            return
        run = self.history[row]
        self.result = run.result
        self._refresh_tables()
        self.wave_view.set_result(run.result)
        self._attach_levels(run.result)
        self.wave_view.update()
        self._update_status()
        self.tabs.setCurrentWidget(self.history_list)

    # ---- 导出 ----

    def _export_csv(self) -> None:
        if self.result is None:
            QMessageBox.information(self, "没有结果", "请先识别一段音频")
            return
        path, _ = QFileDialog.getSaveFileName(self, "导出按键时间清单", "按键清单.csv", "CSV (*.csv)")
        if not path:
            return
        export_segments_csv(path, self.result)
        QMessageBox.information(
            self,
            "已导出",
            f"已写出 {path}\n确定 {len(self.result.confirmed)} 条, "
            f"待核对 {len(self.result.review)} 条, 拒绝候选 {len(self.result.rejected)} 条",
        )

    def _export_json(self) -> None:
        if self.result is None:
            QMessageBox.information(self, "没有结果", "请先识别一段音频")
            return
        path, _ = QFileDialog.getSaveFileName(self, "导出完整识别结果", "识别结果.json", "JSON (*.json)")
        if not path:
            return
        export_result_json(path, self.result, history=[run_to_dict(r) for r in self.history])
        QMessageBox.information(self, "已导出", f"已写出 {path}")

    # ---- 关闭 ----

    def closeEvent(self, event) -> None:  # noqa: N802
        self._player.stop()
        super().closeEvent(event)


def seg_label(seg: SegmentAnalysis) -> str:
    return f"{seg.start_s:.3f}-{seg.end_s:.3f} 秒"
