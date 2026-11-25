"""主窗口: 声源管理 + 电平/时刻控制 + 谱图与频带能量 + 试听播放。"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PySide6.QtCore import Qt, QTimer
from PySide6.QtWidgets import (
    QButtonGroup,
    QComboBox,
    QDoubleSpinBox,
    QFileDialog,
    QFormLayout,
    QFrame,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QRadioButton,
    QSlider,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

from . import audio_io, examples, project as project_io
from .analysis import analyze
from .dialogs import GenerateDialog
from .mixer import (
    MAX_CUES,
    MODE_BG,
    MODE_CUE,
    MODE_MIX,
    ProjectState,
    CueState,
    background_stem,
    cue_stem,
    lin_to_db,
    render_mode,
    segment_sample_range,
    test_sample_range,
)
from .player import SegmentPlayer
from .widgets import EnergyGridWidget, SpectrogramWidget


def _h_line() -> QFrame:
    f = QFrame()
    f.setFrameShape(QFrame.Shape.HLine)
    f.setFrameShadow(QFrame.Shadow.Plain)
    return f


class GainSlider(QWidget):
    """-40..+12 dB 的水平推子, 旁边实时显示数值。"""

    def __init__(self, changed_cb, parent=None):
        super().__init__(parent)
        self.cb = changed_cb
        lay = QHBoxLayout(self)
        lay.setContentsMargins(0, 0, 0, 0)
        self.slider = QSlider(Qt.Orientation.Horizontal)
        self.slider.setRange(-400, 120)  # 0.1 dB 步进
        self.slider.setValue(0)
        self.label = QLabel("0.0 dB")
        self.label.setMinimumWidth(64)
        self.slider.valueChanged.connect(self._on_slider)
        lay.addWidget(self.slider)
        lay.addWidget(self.label)

    def _on_slider(self, raw: int):
        db = raw / 10.0
        self.label.setText(f"{db:+.1f} dB")
        self.cb()

    def value_db(self) -> float:
        return self.slider.value() / 10.0

    def set_value_db(self, db: float):
        self.slider.blockSignals(True)
        self.slider.setValue(int(round(db * 10)))
        self.slider.blockSignals(False)
        self.label.setText(f"{db:+.1f} dB")


class MainWindow(QMainWindow):
    def __init__(self, state: ProjectState | None = None):
        super().__init__()
        self.setWindowTitle("提示音试听对比实验室 cue lab")
        self.resize(1280, 860)
        sr = state.sr if state else examples.SR
        self.state = state or ProjectState(sr=sr, test_end=6.0)
        self.state.clamp_segment()

        self.player = SegmentPlayer(self.state.sr, self)
        self.player.positionChanged.connect(self._on_position)
        self.player.finished.connect(self._on_playback_finished)

        self._analysis_cache: dict[str, dict] = {}
        self._ready = False
        self._rebuild_timer = QTimer(self)
        self._rebuild_timer.setSingleShot(True)
        self._rebuild_timer.setInterval(80)
        self._rebuild_timer.timeout.connect(self._rebuild)

        self._build_menus()
        self._build_ui()
        self._ready = True
        self._refresh_cue_panel()
        self._sync_controls_from_state()
        self._rebuild()

    # ------------------------------------------------------------------ UI
    def _build_menus(self):
        bar = self.menuBar()
        m_file = bar.addMenu("文件")
        for text, slot in [
            ("导入背景 wav…", self._import_bg),
            ("生成背景声…", lambda: self._generate("background")),
            ("导入提示音 wav…", self._import_cue),
            ("生成提示音…", lambda: self._generate("cue")),
            ("保存工程…", self._save_project),
            ("打开工程…", self._open_project),
            ("导出当前混合 wav…", self._export_mix_wav),
            ("导出各路电平设置…", self._export_levels),
        ]:
            act = m_file.addAction(text)
            act.triggered.connect(slot)
        m_example = bar.addMenu("内置示例")
        for label, builder in examples.EXAMPLES.items():
            act = m_example.addAction(label)
            act.triggered.connect(lambda checked=False, b=builder: self._load_example(b))
        m_help = bar.addMenu("帮助")
        act = m_help.addAction("使用说明")
        act.triggered.connect(self._show_help)

    def _build_ui(self):
        splitter = QSplitter(Qt.Orientation.Horizontal)
        left = QWidget()
        left.setMaximumWidth(330)
        left.setMinimumWidth(280)
        lv = QVBoxLayout(left)
        lv.setContentsMargins(8, 8, 8, 8)

        # ---- 背景 ----
        g_bg = QGroupBox("背景声")
        f = QFormLayout(g_bg)
        self.bg_label = QLabel("(未加载)")
        self.bg_label.setWordWrap(True)
        f.addRow("声源", self.bg_label)
        self.bg_gain = GainSlider(self._schedule_rebuild)
        f.addRow("电平", self.bg_gain)
        row = QHBoxLayout()
        b = QPushButton("导入 wav")
        b.clicked.connect(self._import_bg)
        row.addWidget(b)
        b = QPushButton("生成")
        b.clicked.connect(lambda: self._generate("background"))
        row.addWidget(b)
        b = QPushButton("移除")
        b.clicked.connect(self._remove_bg)
        row.addWidget(b)
        f.addRow(row)
        lv.addWidget(g_bg)

        # ---- 提示音 ----
        g_cue = QGroupBox(f"提示音 (最多 {MAX_CUES} 路)")
        cv = QVBoxLayout(g_cue)
        self.cue_combo = QComboBox()
        self.cue_combo.currentIndexChanged.connect(self._on_cue_selected)
        cv.addWidget(self.cue_combo)
        cf = QFormLayout()
        cv.addLayout(cf)
        self.cue_gain = GainSlider(self._on_cue_gain)
        cf.addRow("电平", self.cue_gain)
        self.cue_start = QDoubleSpinBox()
        self.cue_start.setRange(0.0, 3600.0)
        self.cue_start.setDecimals(3)
        self.cue_start.setSingleStep(0.05)
        self.cue_start.setSuffix(" s")
        self.cue_start.valueChanged.connect(self._on_cue_start)
        cf.addRow("开始时刻", self.cue_start)
        row = QHBoxLayout()
        b = QPushButton("导入 wav")
        b.clicked.connect(self._import_cue)
        row.addWidget(b)
        b = QPushButton("生成")
        b.clicked.connect(lambda: self._generate("cue"))
        row.addWidget(b)
        b = QPushButton("移除本路")
        b.clicked.connect(self._remove_cue)
        row.addWidget(b)
        cv.addLayout(row)
        lv.addWidget(g_cue)

        # ---- 区间 ----
        g_range = QGroupBox("测试区间 / 试听短段")
        rf = QFormLayout(g_range)
        self.test_start_sp = self._time_spin(0.0, 3600.0)
        self.test_end_sp = self._time_spin(0.0, 3600.0)
        self.seg_start_sp = self._time_spin(0.0, 3600.0)
        self.seg_dur_sp = self._time_spin(0.05, 600.0, step=0.05)
        for sp, cb in [
            (self.test_start_sp, self._on_test_edited),
            (self.test_end_sp, self._on_test_edited),
            (self.seg_start_sp, self._on_seg_edited),
            (self.seg_dur_sp, self._on_seg_edited),
        ]:
            sp.valueChanged.connect(cb)
        rf.addRow("测试起点", self.test_start_sp)
        rf.addRow("测试终点", self.test_end_sp)
        rf.addRow("试听段起点", self.seg_start_sp)
        rf.addRow("试听段时长", self.seg_dur_sp)
        lv.addWidget(g_range)

        # ---- 监听模式与播放 ----
        g_play = QGroupBox("监听 (三种模式时间位置一致)")
        pv = QVBoxLayout(g_play)
        self.mode_group = QButtonGroup(self)
        self.mode_buttons = {}
        for mode, label in [
            (MODE_MIX, "混合 (背景+提示)"),
            (MODE_CUE, "只听提示音"),
            (MODE_BG, "只听背景"),
        ]:
            rb = QRadioButton(label)
            self.mode_group.addButton(rb)
            self.mode_buttons[mode] = rb
            rb.toggled.connect(self._on_mode_changed)
            pv.addWidget(rb)
        self.mode_buttons[MODE_MIX].setChecked(True)
        row = QHBoxLayout()
        self.play_btn = QPushButton("▶ 试听短段")
        self.play_btn.clicked.connect(self._toggle_play)
        row.addWidget(self.play_btn)
        self.loop_btn = QPushButton("循环: 开")
        self.loop_btn.setCheckable(True)
        self.loop_btn.setChecked(True)
        self.loop_btn.clicked.connect(self._on_loop_toggled)
        row.addWidget(self.loop_btn)
        pv.addLayout(row)
        self.position_label = QLabel("播放头 0.000 s")
        pv.addWidget(self.position_label)
        lv.addWidget(g_play)
        lv.addStretch(1)

        # ---- 右侧图 ----
        right = QWidget()
        rv = QVBoxLayout(right)
        rv.setContentsMargins(4, 4, 4, 4)
        spec_row = QHBoxLayout()
        spec_row.addWidget(QLabel("谱图声源:"))
        self.spec_source = QComboBox()
        self.spec_source.addItem("混合", MODE_MIX)
        self.spec_source.addItem("背景", MODE_BG)
        for i in range(MAX_CUES):
            self.spec_source.addItem(f"提示音 {i+1}", ("cue", i))
        self.spec_source.currentIndexChanged.connect(self._rebuild)
        spec_row.addWidget(self.spec_source)
        spec_row.addStretch(1)
        rv.addLayout(spec_row)

        self.spectrogram = SpectrogramWidget()
        self.spectrogram.selectionMade.connect(self._on_spectro_click)
        self.spectrogram.rangeChanged.connect(self._on_spectro_drag)
        self.energy = EnergyGridWidget()
        self.energy.bandSelected.connect(self._on_band_selected)
        self.energy.timeClicked.connect(self._on_energy_time_click)
        splitter2 = QSplitter(Qt.Orientation.Vertical)
        splitter2.addWidget(self.spectrogram)
        splitter2.addWidget(self.energy)
        splitter2.setStretchFactor(0, 1)
        splitter2.setStretchFactor(1, 1)
        rv.addWidget(splitter2, 1)

        splitter.addWidget(left)
        splitter.addWidget(right)
        splitter.setStretchFactor(0, 0)
        splitter.setStretchFactor(1, 1)
        self.setCentralWidget(splitter)
        self.statusBar().showMessage("就绪")

    def _time_spin(self, lo: float, hi: float, step: float = 0.01) -> QDoubleSpinBox:
        sp = QDoubleSpinBox()
        sp.setRange(lo, hi)
        sp.setDecimals(3)
        sp.setSingleStep(step)
        sp.setSuffix(" s")
        return sp

    # ------------------------------------------------------------ 数据源
    def _import_wav(self) -> tuple[np.ndarray, int] | None:
        path, _ = QFileDialog.getOpenFileName(
            self, "选择 wav 文件", "", "WAV 音频 (*.wav *.WAV)"
        )
        if not path:
            return None
        try:
            x, sr = audio_io.read_wav(path)
            if sr != self.state.sr:
                x = audio_io.resample_linear(x, sr, self.state.sr)
            return x, self.state.sr
        except Exception as exc:  # 损坏文件不应让程序退出
            QMessageBox.critical(self, "导入失败", f"无法读取 {Path(path).name}:\n{exc}")
            return None

    def _import_bg(self):
        loaded = self._import_wav()
        if loaded is None:
            return
        x, _ = loaded
        self.state.background = x
        self._after_source_change(f"已导入背景 ({len(x)/self.state.sr:.2f}s)")

    def _import_cue(self):
        if len(self.state.cues) >= MAX_CUES:
            QMessageBox.information(self, "提示", f"最多对比 {MAX_CUES} 路提示音")
            return
        loaded = self._import_wav()
        if loaded is None:
            return
        x, _ = loaded
        start = self._suggest_cue_start()
        cue = CueState(name=f"提示音 {len(self.state.cues)+1}", audio=x, start=start)
        self.state.cues.append(cue)
        self.state.current_cue = len(self.state.cues) - 1
        self._after_source_change(f"已加入提示音 ({len(x)/self.state.sr:.2f}s)")

    def _generate(self, role: str):
        dlg = GenerateDialog(role, self.state.sr, self)
        if not dlg.exec():
            return
        x = dlg.build_audio()
        if role == "background":
            self.state.background = x
            self._after_source_change("已生成背景声")
            return
        if len(self.state.cues) >= MAX_CUES:
            QMessageBox.information(self, "提示", f"最多对比 {MAX_CUES} 路提示音")
            return
        cue = CueState(
            name=f"提示音 {len(self.state.cues)+1}",
            audio=x,
            start=self._suggest_cue_start(),
        )
        self.state.cues.append(cue)
        self.state.current_cue = len(self.state.cues) - 1
        self._after_source_change("已生成提示音")

    def _remove_bg(self):
        self.state.background = None
        self._after_source_change("已移除背景声")

    def _remove_cue(self):
        if not self.state.cues:
            return
        idx = self.state.current_cue
        del self.state.cues[idx]
        self.state.current_cue = min(idx, len(self.state.cues) - 1)
        self._after_source_change("已移除提示音")

    def _load_example(self, builder):
        self.player.stop()
        self.state = builder()
        self._analysis_cache.clear()
        self._refresh_cue_panel()
        self._sync_controls_from_state()
        self._rebuild()
        self.statusBar().showMessage("已载入内置示例")

    def _suggest_cue_start(self) -> float:
        # 默认落在测试区间起点之后 0.4s, 或直接取试听段起点
        return round(min(self.state.seg_start + 0.2, self.state.test_end - 0.2), 3)

    def _after_source_change(self, message: str):
        self.state.clamp_segment()
        self._analysis_cache.clear()
        self._refresh_cue_panel()
        self._sync_controls_from_state()
        self._rebuild()
        self.statusBar().showMessage(message)

    # ------------------------------------------------------------ 控件同步
    def _refresh_cue_panel(self):
        self.cue_combo.blockSignals(True)
        self.cue_combo.clear()
        for i, cue in enumerate(self.state.cues):
            self.cue_combo.addItem(f"{i+1}. {cue.name}", i)
        self.cue_combo.setEnabled(bool(self.state.cues))
        if self.state.cues:
            self.state.current_cue = min(self.state.current_cue, len(self.state.cues) - 1)
            self.cue_combo.setCurrentIndex(self.state.current_cue)
        self.cue_combo.blockSignals(False)
        self._sync_cue_editors()
        self._sync_bg_label()

    def _sync_bg_label(self):
        if self.state.background is not None and self.state.background.size:
            dur = len(self.state.background) / self.state.sr
            self.bg_label.setText(f"已加载, {dur:.2f} s")
        else:
            self.bg_label.setText("(未加载)")

    def _sync_cue_editors(self):
        has = bool(self.state.cues)
        for w in (self.cue_gain, self.cue_start):
            w.setEnabled(has)
        if not has:
            return
        cue = self.state.cues[self.state.current_cue]
        self.cue_gain.set_value_db(cue.gain_db)
        self.cue_start.blockSignals(True)
        self.cue_start.setValue(cue.start)
        self.cue_start.blockSignals(False)

    def _sync_controls_from_state(self):
        s = self.state
        self.bg_gain.set_value_db(s.bg_gain_db)
        # 推子以状态为准, 显式回写一次, 避免控件默认值反向覆盖工程值
        s.bg_gain_db = self.bg_gain.value_db()
        self._sync_cue_editors()
        for sp, val in [
            (self.test_start_sp, s.test_start),
            (self.test_end_sp, s.test_end),
            (self.seg_start_sp, s.seg_start),
            (self.seg_dur_sp, s.seg_dur),
        ]:
            sp.blockSignals(True)
            sp.setValue(val)
            sp.blockSignals(False)
        btn = self.mode_buttons.get(s.mode)
        if btn is not None:
            btn.setChecked(True)

    # ------------------------------------------------------------ 编辑回调
    def _schedule_rebuild(self):
        if not self._ready:
            return
        self.state.bg_gain_db = self.bg_gain.value_db()
        self._rebuild_timer.start()

    def _on_cue_gain(self):
        if not self.state.cues:
            return
        self.state.cues[self.state.current_cue].gain_db = self.cue_gain.value_db()
        self._rebuild_timer.start()

    def _on_cue_start(self):
        if not self.state.cues:
            return
        self.state.cues[self.state.current_cue].start = self.cue_start.value()
        self.state.clamp_segment()
        self._rebuild_timer.start()

    def _on_cue_selected(self, idx: int):
        if idx < 0 or idx >= len(self.state.cues):
            return
        self.state.current_cue = idx
        # 切到"只听提示音"时, 监听对象跟着当前选择走
        self._sync_cue_editors()
        self._rebuild()

    def _on_test_edited(self):
        s = self.state
        s.test_start = self.test_start_sp.value()
        s.test_end = max(self.test_end_sp.value(), s.test_start + 0.05)
        s.clamp_segment()
        self._sync_controls_from_state()
        self._rebuild()

    def _on_seg_edited(self):
        s = self.state
        s.seg_start = self.seg_start_sp.value()
        s.seg_dur = self.seg_dur_sp.value()
        s.clamp_segment()
        self._sync_controls_from_state()
        self._rebuild()

    def _on_mode_changed(self):
        if not self._ready:
            return
        for mode, rb in self.mode_buttons.items():
            if rb.isChecked():
                self.state.mode = mode
                break
        self._rebuild()

    def _on_loop_toggled(self):
        loop = self.loop_btn.isChecked()
        self.player.set_loop(loop)
        self.loop_btn.setText("循环: 开" if loop else "循环: 关")

    # ------------------------------------------------------------ 图上交互
    def _on_band_selected(self, band: int):
        self.state.selected_band = band
        self._rebuild()

    def _on_energy_time_click(self, t: float):
        self._move_segment_start(t)

    def _on_spectro_click(self, t: float, band: int):
        self.state.selected_band = band
        self._move_segment_start(t)
        self._rebuild()

    def _on_spectro_drag(self, t0: float, dur: float):
        s = self.state
        s.seg_start = float(np.clip(t0, s.test_start, s.test_end - 0.05))
        s.seg_dur = float(np.clip(dur, 0.05, s.test_end - s.seg_start))
        s.clamp_segment()
        self._sync_controls_from_state()
        self._rebuild()

    def _move_segment_start(self, t: float):
        s = self.state
        s.seg_start = float(np.clip(t, s.test_start, s.test_end - s.seg_dur))
        s.clamp_segment()
        self._sync_controls_from_state()
        self._rebuild()
        if self.player.is_playing():
            self.player.seek_seconds(s.seg_start)

    # ------------------------------------------------------------ 核心重建
    def _source_audio_for_key(self, key):
        s = self.state
        if key == MODE_MIX:
            return render_mode(s, MODE_MIX)
        if key == MODE_BG:
            return background_stem(s)
        if isinstance(key, tuple) and key[0] == "cue":
            return cue_stem(s, key[1])
        return np.zeros(s.total_samples())

    def _get_analysis(self, key) -> dict:
        if key not in self._analysis_cache:
            audio = self._source_audio_for_key(key)
            self._analysis_cache[key] = analyze(audio, self.state.sr)
        return self._analysis_cache[key]

    def _rebuild(self):
        s = self.state
        s.clamp_segment()
        self._analysis_cache.clear()  # 增益/时刻变了, 分析必须重算
        t0, t1 = s.test_start, s.test_end

        # ---- 频带能量: 背景 + 每路提示音 (均为已加增益的 stem, 保证可比) ----
        bg_audio = background_stem(s)
        bg_an = analyze(bg_audio, s.sr)
        cue_ans, cue_names = [], []
        for i, cue in enumerate(s.cues):
            cue_ans.append(analyze(cue_stem(s, i), s.sr))
            cue_names.append(cue.name)

        def mask_times(an):
            m = (an["times"] >= t0) & (an["times"] <= t1)
            return m

        m_bg = mask_times(bg_an)
        bg_db = bg_an["band_db"][m_bg, :]
        times = bg_an["times"][m_bg]
        cue_db = [an["band_db"][mask_times(an), :] for an in cue_ans]
        self.energy.set_data(
            times, bg_db, cue_db, cue_names, bg_an["edges"], t0, t1
        )
        self.energy.set_state(s.selected_band, (s.seg_start, s.seg_end()),
                              self.player.position_seconds())

        # ---- 谱图: 按下拉选择的声源 ----
        key = self.spec_source.currentData()
        if isinstance(key, tuple) and key[0] == "cue":
            if key[1] >= len(s.cues):
                key = MODE_MIX
        spec_an = self._get_analysis(key)
        m_spec = (spec_an["times"] >= t0) & (spec_an["times"] <= t1)
        self.spectrogram.set_data(
            spec_an["heat_db"][:, m_spec],
            spec_an["times"][m_spec],
            spec_an["heat_f_edges"],
            spec_an["edges"],
            t0, t1,
        )
        cue_ranges = [(c.start, c.end_time(s.sr)) for c in s.cues]
        self.spectrogram.set_overlays(
            (t0, t1), (s.seg_start, s.seg_end()), cue_ranges,
            s.selected_band, self.player.position_seconds(),
        )

        # ---- 播放器缓冲 (整条时间轴, 当前模式) ----
        mix = render_mode(s, s.mode)
        seg = segment_sample_range(s)
        self.player.set_mix(mix, seg, playing=self.player.is_playing())
        self.position_label.setText(f"播放头 {self.player.position_seconds():.3f} s")
        self._update_status_levels(bg_audio, cue_ans, s)

    def _update_status_levels(self, bg_audio, cue_ans, s):
        i0, i1 = test_sample_range(s)
        parts = [f"测试区间 {s.test_start:.2f}–{s.test_end:.2f}s"]
        if bg_audio.size:
            parts.append("背景 RMS " + self._rms_text(bg_audio[i0:i1]))
        for i, cue in enumerate(s.cues):
            stem = cue_stem(s, i)
            parts.append(f"提示{i+1} RMS " + self._rms_text(stem[i0:i1]))
        self.statusBar().showMessage("   |   ".join(parts))

    @staticmethod
    def _rms_text(x: np.ndarray) -> str:
        rms = float(np.sqrt(np.mean(x**2))) if x.size else 0.0
        return f"{lin_to_db(rms):.1f} dBFS"

    # ------------------------------------------------------------ 播放
    def _toggle_play(self):
        if self.player.is_playing():
            self.player.stop()
            self.play_btn.setText("▶ 试听短段")
            return
        if not self.player.has_audio():
            self.statusBar().showMessage("没有可播放的声音: 请先导入或生成背景/提示音")
            return
        # 每次从试听段起点重新开始, 保证三种模式位置对齐
        self.player.seek_seconds(self.state.seg_start)
        self.player.play()
        self.play_btn.setText("⏸ 停止")

    def _on_playback_finished(self):
        # 非循环模式自然播完: 引擎已自行置停, 这里只同步按钮文案
        self.play_btn.setText("▶ 试听短段")

    def _on_position(self, t: float):
        self.position_label.setText(f"播放头 {t:.3f} s")
        self.spectrogram.set_overlays(
            (self.state.test_start, self.state.test_end),
            (self.state.seg_start, self.state.seg_end()),
            [(c.start, c.end_time(self.state.sr)) for c in self.state.cues],
            self.state.selected_band, t,
        )
        self.energy.set_state(
            self.state.selected_band,
            (self.state.seg_start, self.state.seg_end()),
            t,
        )

    # ------------------------------------------------------------ 文件菜单
    def _save_project(self):
        path, _ = QFileDialog.getSaveFileName(
            self, "保存工程", "comparison.cuelab.json", "cue lab 工程 (*.cuelab.json *.json)"
        )
        if not path:
            return
        try:
            project_io.save_project(path, self.state)
            self.statusBar().showMessage(f"工程已保存: {path}")
        except Exception as exc:
            QMessageBox.critical(self, "保存失败", str(exc))

    def _open_project(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "打开工程", "", "cue lab 工程 (*.cuelab.json *.json)"
        )
        if not path:
            return
        try:
            state = project_io.load_project(path)
        except Exception as exc:
            QMessageBox.critical(self, "打开失败", f"工程文件无法解析:\n{exc}")
            return
        self.player.stop()
        self.state = state
        self._analysis_cache.clear()
        self._refresh_cue_panel()
        self._sync_controls_from_state()
        self._rebuild()
        self.statusBar().showMessage(f"已打开工程: {Path(path).name}")

    def _export_mix_wav(self):
        path, _ = QFileDialog.getSaveFileName(
            self, "导出当前混合", "mix.wav", "WAV (*.wav)"
        )
        if not path:
            return
        y = render_mode(self.state, MODE_MIX)
        audio_io.write_wav_int16(path, y, self.state.sr)
        self.statusBar().showMessage(f"已导出混合 wav: {path}")

    def _export_levels(self):
        path, _ = QFileDialog.getSaveFileName(
            self, "导出电平设置", "levels.levels.json", "电平设置 (*.json)"
        )
        if not path:
            return
        project_io.export_levels(path, self.state)
        self.statusBar().showMessage(f"已导出电平设置: {path}")

    def _show_help(self):
        QMessageBox.information(
            self,
            "使用说明",
            "1. 导入或生成一条背景声与最多三路提示音。\n"
            "2. 推子只改电平、开始时刻只改位置, 两者互不影响。\n"
            "3. 谱图上点击可同时选定频带并把试听段起点移到该处, "
            "横向拖拽可直接框出试听段。\n"
            "4. 下方小多联逐频带比较背景(灰)与提示音(彩色)的时变能量, "
            "可看出提示音哪一段被背景盖住、哪一段露出来。\n"
            "5. 混合/只听提示/只听背景三种模式共用同一条时间轴和播放游标, "
            "切换不挪位置; 提示音超出试听段时只在交集内发声。\n"
            "6. 保存工程后重新打开可完整重现本次比较; 也可导出混合 wav 与各路电平。",
        )

    def closeEvent(self, event):  # noqa: N802
        self.player.stop()
        super().closeEvent(event)
