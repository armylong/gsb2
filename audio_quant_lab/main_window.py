"""Main PySide6 window for local quantization comparisons."""

from __future__ import annotations

import re
from pathlib import Path

import numpy as np
from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QAction, QKeySequence, QShortcut
from PySide6.QtWidgets import (
    QButtonGroup,
    QCheckBox,
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
    QScrollArea,
    QSlider,
    QSpinBox,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

from .cache import ResultCache
from .dsp import (
    METHOD_LABELS,
    AudioData,
    QuantParams,
    analysis_slice,
    compute_spectrum,
    make_fading_tone,
    peak_db,
    rms_db,
    snr_db,
)
from .playback import PlaybackEngine
from .wav_io import export_quantized_wav, read_wav
from .widgets import (
    COLOR_DIRECT,
    COLOR_DITHER,
    COLOR_ERROR,
    COLOR_INPUT,
    COLOR_SHAPED,
    SpectrumWidget,
    WaveformWidget,
    format_time,
)

METHOD_COLORS = {
    "direct": COLOR_DIRECT,
    "dither": COLOR_DITHER,
    "noise_shaped": COLOR_SHAPED,
}


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("音频位深量化对照实验室")
        self.setMinimumSize(1040, 680)
        screen = self.screen()
        available = screen.availableGeometry() if screen is not None else None
        if available is not None:
            self.resize(
                min(1440, max(1040, available.width() - 24)),
                min(940, max(680, available.height() - 24)),
            )
        else:
            self.resize(1440, 940)

        self.audio: AudioData | None = None
        self.source_version = 0
        self.cache = ResultCache(max_parameter_sets=8)
        self.results: dict = {}
        self.quant_method = "direct"
        self.bypass_original = False
        self.play_state = "stopped"
        self.source_rail_count: int | None = None
        self.last_export_report = None

        self.engine = PlaybackEngine(self)
        self.engine.positionChanged.connect(self.on_position_changed)
        self.engine.stateChanged.connect(self.on_engine_state_changed)
        self.engine.errorMessage.connect(self.show_audio_error)

        self.recompute_timer = QTimer(self)
        self.recompute_timer.setSingleShot(True)
        self.recompute_timer.setInterval(120)
        self.recompute_timer.timeout.connect(self.recompute_results)

        self._build_ui()
        self._build_shortcuts()
        self.load_audio(make_fading_tone(), rail_count=None)

    # ------------------------------------------------------------------ UI
    def _build_ui(self) -> None:
        self._build_menus()

        central = QWidget()
        root = QHBoxLayout(central)
        root.setContentsMargins(10, 10, 10, 10)
        root.setSpacing(10)

        root.addWidget(self._build_control_panel(), 0)
        root.addWidget(self._build_plots(), 1)
        self.setCentralWidget(central)
        self.statusBar().showMessage("就绪：已生成 8 秒渐弱测试音，可直接开始对照。")

    def _build_menus(self) -> None:
        open_action = QAction("打开 WAV…", self)
        open_action.setShortcut(QKeySequence.StandardKey.Open)
        open_action.triggered.connect(self.open_wav)
        export_action = QAction("导出当前方案 WAV…", self)
        export_action.setShortcut(QKeySequence.StandardKey.Save)
        export_action.triggered.connect(self.export_wav)
        help_action = QAction("说明", self)
        help_action.triggered.connect(self.show_about)
        menu = self.menuBar().addMenu("文件")
        menu.addAction(open_action)
        menu.addAction(export_action)
        menu.addSeparator()
        menu.addAction(help_action)

    def _build_control_panel(self) -> QWidget:
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFixedWidth(330)
        scroll.setFrameShape(QFrame.Shape.NoFrame)

        panel = QWidget()
        layout = QVBoxLayout(panel)
        layout.setContentsMargins(2, 2, 8, 2)
        layout.setSpacing(10)

        source_box = QGroupBox("音源")
        source_layout = QVBoxLayout(source_box)
        button_row = QHBoxLayout()
        self.open_button = QPushButton("打开短 WAV…")
        self.tone_button = QPushButton("渐弱测试音")
        self.open_button.clicked.connect(self.open_wav)
        self.tone_button.clicked.connect(lambda: self.load_audio(make_fading_tone()))
        button_row.addWidget(self.open_button)
        button_row.addWidget(self.tone_button)
        source_layout.addLayout(button_row)
        self.file_label = QLabel("—")
        self.file_label.setWordWrap(True)
        self.file_label.setStyleSheet("color: #52514e;")
        source_layout.addWidget(self.file_label)
        layout.addWidget(source_box)

        quant_box = QGroupBox("目标位深与算法")
        quant_layout = QFormLayout(quant_box)
        quant_layout.setLabelAlignment(Qt.AlignmentFlag.AlignRight)

        self.bits_spin = QSpinBox()
        self.bits_spin.setRange(1, 32)
        self.bits_spin.setValue(8)
        self.bits_spin.setSuffix(" bit")
        self.bits_spin.valueChanged.connect(self.on_parameter_changed)
        quant_layout.addRow("目标位深", self.bits_spin)

        self.levels_label = QLabel()
        self.levels_label.setStyleSheet("color: #52514e;")
        quant_layout.addRow("目标级数", self.levels_label)

        method_widget = QWidget()
        method_layout = QVBoxLayout(method_widget)
        method_layout.setContentsMargins(0, 0, 0, 0)
        self.method_group = QButtonGroup(self)
        for key in ("direct", "dither", "noise_shaped"):
            radio = QRadioButton(METHOD_LABELS[key])
            radio.setProperty("method", key)
            if key == self.quant_method:
                radio.setChecked(True)
            radio.toggled.connect(lambda checked, k=key: checked and self.on_method_changed(k))
            self.method_group.addButton(radio)
            method_layout.addWidget(radio)
        self.bypass_check = QCheckBox("试听原始输入（0）")
        self.bypass_check.toggled.connect(self.on_bypass_toggled)
        method_layout.addWidget(self.bypass_check)
        quant_layout.addRow("方案", method_widget)

        self.seed_spin = QSpinBox()
        self.seed_spin.setRange(0, 2_147_483_647)
        self.seed_spin.setValue(15411)
        self.seed_spin.valueChanged.connect(self.on_parameter_changed)
        quant_layout.addRow("随机种子", self.seed_spin)

        self.dither_spin = QDoubleSpinBox()
        self.dither_spin.setRange(0.0, 4.0)
        self.dither_spin.setSingleStep(0.25)
        self.dither_spin.setValue(1.0)
        self.dither_spin.setDecimals(2)
        self.dither_spin.valueChanged.connect(self.on_parameter_changed)
        quant_layout.addRow("TPDF 强度", self.dither_spin)

        self.ns_order_combo = QComboBox()
        self.ns_order_combo.addItems(["一阶 (1−z⁻¹)", "二阶 (推荐)", "三阶"])
        self.ns_order_combo.setCurrentIndex(1)
        self.ns_order_combo.currentIndexChanged.connect(self.on_parameter_changed)
        quant_layout.addRow("整形阶数", self.ns_order_combo)

        self.auto_error_check = QCheckBox("误差波形自动放大")
        self.auto_error_check.setChecked(True)
        self.auto_error_check.toggled.connect(self.on_error_scale_toggled)
        quant_layout.addRow("", self.auto_error_check)
        layout.addWidget(quant_box)

        analysis_box = QGroupBox("频谱分析区间")
        analysis_layout = QFormLayout(analysis_box)
        self.spectrum_mode_combo = QComboBox()
        self.spectrum_mode_combo.addItem("整段 Welch 平均", "whole")
        self.spectrum_mode_combo.addItem("末尾分析窗", "tail")
        self.spectrum_mode_combo.addItem("跟随播放位置", "follow")
        self.spectrum_mode_combo.currentIndexChanged.connect(self.update_spectra)
        analysis_layout.addRow("范围", self.spectrum_mode_combo)

        self.window_combo = QComboBox()
        for value in (256, 512, 1024, 2048, 4096):
            self.window_combo.addItem(f"{value} 样本", value)
        self.window_combo.setCurrentIndex(3)
        self.window_combo.currentIndexChanged.connect(self.update_spectra)
        analysis_layout.addRow("窗口", self.window_combo)
        layout.addWidget(analysis_box)

        playback_box = QGroupBox("同位置试听")
        playback_layout = QVBoxLayout(playback_box)
        transport = QHBoxLayout()
        self.play_button = QPushButton("播放")
        self.pause_button = QPushButton("暂停")
        self.stop_button = QPushButton("停止")
        self.play_button.clicked.connect(self.engine.play)
        self.pause_button.clicked.connect(self.engine.pause)
        self.stop_button.clicked.connect(self.engine.stop)
        transport.addWidget(self.play_button)
        transport.addWidget(self.pause_button)
        transport.addWidget(self.stop_button)
        playback_layout.addLayout(transport)

        self.position_slider = QSlider(Qt.Orientation.Horizontal)
        self.position_slider.setRange(0, 0)
        self.position_slider.sliderMoved.connect(self.on_slider_moved)
        self.position_slider.sliderReleased.connect(self.on_slider_released)
        playback_layout.addWidget(self.position_slider)

        time_row = QHBoxLayout()
        self.time_label = QLabel("0:00.000 / 0:00.000")
        self.time_label.setStyleSheet("color: #52514e;")
        time_row.addWidget(self.time_label)
        time_row.addStretch(1)
        time_row.addWidget(QLabel("音量"))
        self.volume_slider = QSlider(Qt.Orientation.Horizontal)
        self.volume_slider.setRange(0, 100)
        self.volume_slider.setValue(100)
        self.volume_slider.setFixedWidth(110)
        self.volume_slider.valueChanged.connect(lambda v: self.engine.set_volume(v / 100.0))
        time_row.addWidget(self.volume_slider)
        playback_layout.addLayout(time_row)
        hint = QLabel("播放中按 1 / 2 / 3 可在同一采样位置即时切换方案。")
        hint.setWordWrap(True)
        hint.setStyleSheet("color: #898781;")
        playback_layout.addWidget(hint)
        layout.addWidget(playback_box)

        export_box = QGroupBox("导出与读回校验")
        export_layout = QFormLayout(export_box)
        self.container_combo = QComboBox()
        self.container_combo.addItem("自动（字节位深写真 WAV，否则最小宽容器）", "auto")
        for bits in (8, 16, 24, 32):
            self.container_combo.addItem(f"{bits}-bit 整数容器", bits)
        export_layout.addRow("编码", self.container_combo)
        self.export_button = QPushButton("导出当前量化方案 WAV…")
        self.export_button.clicked.connect(self.export_wav)
        export_layout.addRow(self.export_button)
        self.export_report = QLabel("尚未导出。")
        self.export_report.setWordWrap(True)
        self.export_report.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        self.export_report.setStyleSheet("color: #52514e;")
        export_layout.addRow(self.export_report)
        layout.addWidget(export_box)

        stats_box = QGroupBox("测量与饱和计数")
        stats_layout = QFormLayout(stats_box)
        self.stat_format = QLabel("—")
        self.stat_input_level = QLabel("—")
        self.stat_used = QLabel("—")
        self.stat_clip = QLabel("—")
        self.stat_rail = QLabel("—")
        self.stat_source_rail = QLabel("—")
        self.stat_snr = QLabel("—")
        for label in (
            ("格式", self.stat_format),
            ("输入峰值/RMS", self.stat_input_level),
            ("实际出现级数", self.stat_used),
            ("超出范围/钳制", self.stat_clip),
            ("目标满幅码样本", self.stat_rail),
            ("源文件满幅轨", self.stat_source_rail),
            ("输出/误差 SNR", self.stat_snr),
        ):
            value = label[1]
            value.setWordWrap(True)
            value.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
            stats_layout.addRow(label[0] + ":", value)
        layout.addWidget(stats_box)
        layout.addStretch(1)

        scroll.setWidget(panel)
        return scroll

    def _build_plots(self) -> QWidget:
        container = QWidget()
        outer = QVBoxLayout(container)
        outer.setContentsMargins(0, 0, 0, 0)

        splitter = QSplitter(Qt.Orientation.Vertical)
        splitter.setChildrenCollapsible(False)

        self.input_wave = WaveformWidget("输入波形", COLOR_INPUT, fixed_range=(-1, 1))
        self.input_spec = SpectrumWidget("输入频谱", COLOR_INPUT)
        self.output_wave = WaveformWidget("输出波形", COLOR_DIRECT, fixed_range=(-1, 1))
        self.output_spec = SpectrumWidget("输出频谱", COLOR_DIRECT)
        self.error_wave = WaveformWidget(
            "误差波形（输出 − 输入）", COLOR_ERROR, auto_range=True
        )
        self.error_spec = SpectrumWidget("误差频谱", COLOR_ERROR)

        for widget in (
            self.input_wave,
            self.output_wave,
            self.error_wave,
            self.input_spec,
            self.output_spec,
            self.error_spec,
        ):
            if hasattr(widget, "seekRequested"):
                widget.seekRequested.connect(self.engine.seek)
            widget.readoutChanged.connect(self.statusBar().showMessage)

        splitter.addWidget(self._trace_row(self.input_wave, self.input_spec))
        splitter.addWidget(self._trace_row(self.output_wave, self.output_spec))
        splitter.addWidget(self._trace_row(self.error_wave, self.error_spec))
        splitter.setSizes([280, 280, 280])
        outer.addWidget(splitter)
        return container

    def _trace_row(self, wave: WaveformWidget, spectrum: SpectrumWidget) -> QWidget:
        row = QWidget()
        layout = QHBoxLayout(row)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(8)
        layout.addWidget(wave, 3)
        layout.addWidget(spectrum, 2)
        return row

    def _build_shortcuts(self) -> None:
        for key, method in ((Qt.Key.Key_1, "direct"), (Qt.Key.Key_2, "dither"), (Qt.Key.Key_3, "noise_shaped")):
            shortcut = QShortcut(QKeySequence(key), self)
            shortcut.activated.connect(lambda m=method: self.select_method(m))
        bypass = QShortcut(QKeySequence(Qt.Key.Key_0), self)
        bypass.activated.connect(self.bypass_check.toggle)

    # ------------------------------------------------------------ state/data
    def current_params(self) -> QuantParams:
        return QuantParams(
            bits=int(self.bits_spin.value()),
            seed=int(self.seed_spin.value()),
            dither_strength=float(self.dither_spin.value()),
            ns_order=int(self.ns_order_combo.currentIndex()) + 1,
        )

    def load_audio(self, audio: AudioData, rail_count: int | None = None) -> None:
        self.audio = audio
        self.source_version += 1
        self.source_rail_count = rail_count
        self.cache.clear()
        self.results = {}
        self.last_export_report = None
        self.export_report.setText("参数或音源已更改，请重新导出并校验。")

        self.file_label.setText(audio.name)
        self.position_slider.setRange(0, max(0, audio.samples.size - 1))
        self.position_slider.setValue(0)
        self.engine.set_source(audio.samples, audio.sample_rate)

        input_alerts = np.flatnonzero(np.abs(audio.samples) >= 1.0)
        self.input_wave.set_data(audio.samples, audio.sample_rate, input_alerts)
        self.input_spec.sample_rate = audio.sample_rate
        self.output_spec.sample_rate = audio.sample_rate
        self.error_spec.sample_rate = audio.sample_rate

        self.recompute_results()
        self.statusBar().showMessage(
            f"已载入 {audio.name}：{audio.sample_rate:,} Hz，{audio.samples.size:,} 样本。"
        )

    def open_wav(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "打开短 WAV", "", "WAV 音频 (*.wav);;所有文件 (*)"
        )
        if not path:
            return
        try:
            loaded = read_wav(path)
        except Exception as exc:  # noqa: BLE001 - GUI boundary shows parser errors
            QMessageBox.critical(self, "无法读取 WAV", str(exc))
            return

        rail_count = None
        if loaded.raw_signed is not None:
            bits = loaded.container_bits
            qmin = -(1 << (bits - 1))
            qmax = (1 << (bits - 1)) - 1
            rail_count = int(
                np.count_nonzero((loaded.raw_signed == qmin) | (loaded.raw_signed == qmax))
            )
        self.load_audio(loaded.audio, rail_count=rail_count)

    def on_parameter_changed(self, *_args) -> None:
        self.levels_label.setText(f"{1 << self.bits_spin.value():,} 个可能整数级")
        self.recompute_timer.start()

    def recompute_results(self) -> None:
        if self.audio is None:
            return
        params = self.current_params()
        self.levels_label.setText(f"{params.target_levels:,} 个可能整数级")
        self.results = self.cache.get_all(self.source_version, self.audio, params)
        self.update_output_view()
        self.update_spectra()
        self.update_stats()

    def select_method(self, method: str) -> None:
        self.quant_method = method
        for button in self.method_group.buttons():
            if button.property("method") == method:
                button.setChecked(True)
        if self.bypass_original:
            self.bypass_check.setChecked(False)
        else:
            self.update_output_view()

    def on_method_changed(self, method: str) -> None:
        self.quant_method = method
        if not self.bypass_original:
            self.update_output_view()

    def on_bypass_toggled(self, checked: bool) -> None:
        self.bypass_original = bool(checked)
        self.update_output_view()

    def on_error_scale_toggled(self, checked: bool) -> None:
        self.error_wave.auto_range = checked
        self.error_wave.fixed_range = None if checked else (-1.0, 1.0)
        if checked and self.results:
            result = self.results[self.quant_method]
            self.error_wave.span_floor = result.step * 0.5
        self.error_wave.update()

    def displayed_output(self) -> tuple[np.ndarray, str, str]:
        assert self.audio is not None
        if self.bypass_original or not self.results:
            return self.audio.samples, COLOR_INPUT, "original"
        result = self.results[self.quant_method]
        return result.y, METHOD_COLORS[self.quant_method], self.quant_method

    def update_output_view(self) -> None:
        if self.audio is None or not self.results:
            return
        y, color, key = self.displayed_output()
        self.output_wave.set_color(color)
        self.output_spec.set_color(color)

        if key == "original":
            self.output_wave.set_data(y, self.audio.sample_rate)
            self.output_wave.title = "输出波形 · 原始旁路"
            self.error_wave.auto_range = True
            self.error_wave.span_floor = 1.0 / (1 << 23)
            self.error_wave.set_data(np.zeros_like(y), self.audio.sample_rate)
            self.error_wave.title = "误差波形 · 原始旁路（0）"
        else:
            result = self.results[key]
            self.error_wave.auto_range = self.auto_error_check.isChecked()
            self.error_wave.title = "误差波形（输出 − 输入）"
            scale = 1 << (result.bits - 1)
            qmin, qmax = -scale, scale - 1
            alerts = np.flatnonzero((result.codes == qmin) | (result.codes == qmax))
            self.output_wave.set_data(y, self.audio.sample_rate, alerts)
            self.output_wave.title = f"输出波形 · {METHOD_LABELS[key]}"
            self.error_wave.span_floor = result.step * 0.5
            self.error_wave.set_data(result.error, self.audio.sample_rate)

        # Preserve the comparison position when swapping the pull buffer.
        self.engine.set_samples_preserve_position(y)
        self.update_spectra()
        self.update_stats()

    def update_spectra(self, *_args) -> None:
        if self.audio is None:
            return
        n = self.audio.samples.size
        position = self.engine.position()
        mode = self.spectrum_mode_combo.currentData()
        window = int(self.window_combo.currentData())
        sl = analysis_slice(n, mode, position, window)

        input_segment = self.audio.samples[sl]
        freqs, db, seg_len, nfft = compute_spectrum(input_segment, self.audio.sample_rate)
        self.input_spec.set_spectrum(freqs, db, self.audio.sample_rate, seg_len, nfft)

        y, _color, key = self.displayed_output()
        out_freqs, out_db, out_seg, out_nfft = compute_spectrum(y[sl], self.audio.sample_rate)
        self.output_spec.set_spectrum(
            out_freqs, out_db, self.audio.sample_rate, out_seg, out_nfft
        )

        if key == "original":
            error = np.zeros_like(self.audio.samples)
        else:
            error = self.results[key].error
        err_freqs, err_db, err_seg, err_nfft = compute_spectrum(
            error[sl], self.audio.sample_rate
        )
        self.error_spec.set_spectrum(err_freqs, err_db, self.audio.sample_rate, err_seg, err_nfft)

    def update_stats(self) -> None:
        if self.audio is None:
            return
        audio = self.audio
        n = max(1, audio.samples.size)
        peak = peak_db(audio.samples)
        rms = rms_db(audio.samples)
        self.file_label.setText(audio.name)
        self.stat_format.setText(
            f"{audio.sample_rate:,} Hz · {audio.samples.size:,} 样本 · "
            f"时长 {format_time(audio.samples.size / audio.sample_rate)}"
            + (f" · 源 {audio.source_bits}-bit" if audio.source_bits else " · 合成/浮点")
        )
        self.stat_input_level.setText(f"{peak:.2f} dBFS peak / {rms:.2f} dBFS RMS")

        if not self.results:
            return
        result = self.results[self.quant_method]
        params = result.params
        self.levels_label.setText(f"{params.target_levels:,} 个可能整数级")
        self.stat_used.setText(
            f"{result.used_levels:,} / {result.target_levels:,} "
            f"({100.0 * result.used_levels / result.target_levels:.2f}%)"
        )
        clip_percent = 100.0 * result.clipped_samples / n
        self.stat_clip.setText(f"{result.clipped_samples:,} 样本 ({clip_percent:.4f}%)")
        self.stat_clip.setStyleSheet(
            "color: #d03b3b; font-weight: 700;" if result.clipped_samples else "color: #006300;"
        )
        rail_percent = 100.0 * result.rail_samples / n
        self.stat_rail.setText(f"{result.rail_samples:,} 样本 ({rail_percent:.3f}%)")
        self.stat_rail.setStyleSheet(
            "color: #d03b3b;" if result.rail_samples else "color: #52514e;"
        )
        if self.source_rail_count is None:
            self.stat_source_rail.setText("未知（合成音或浮点源）")
            self.stat_source_rail.setStyleSheet("color: #52514e;")
        else:
            self.stat_source_rail.setText(f"{self.source_rail_count:,} 个原始整数轨样本")
            self.stat_source_rail.setStyleSheet(
                "color: #d03b3b;" if self.source_rail_count else "color: #006300;"
            )

        if np.all(audio.samples == 0.0):
            self.stat_snr.setText("输入为数字静音；SNR 不作为指标")
        else:
            snr = snr_db(audio.samples, result.y)
            err_rms = rms_db(result.error)
            if np.isinf(snr):
                snr_text = "∞（误差全为 0）"
            else:
                snr_text = f"{snr:.2f} dB"
            self.stat_snr.setText(f"{snr_text}；误差 RMS {err_rms:.2f} dBFS")

    # ------------------------------------------------------------- playback
    def toggle_playback(self) -> None:
        if self.play_state == "playing":
            self.engine.pause()
        else:
            self.engine.play()

    def on_engine_state_changed(self, state: str) -> None:
        self.play_state = state
        self.play_button.setEnabled(state != "playing")
        self.pause_button.setEnabled(state == "playing")
        self.play_button.setText("继续" if state == "paused" else "播放")

    def on_position_changed(self, frame: int) -> None:
        if self.audio is None:
            return
        if not self.position_slider.isSliderDown():
            self.position_slider.blockSignals(True)
            self.position_slider.setValue(frame)
            self.position_slider.blockSignals(False)
        current_seconds = frame / self.audio.sample_rate
        total_seconds = self.audio.samples.size / self.audio.sample_rate
        self.time_label.setText(f"{format_time(current_seconds)} / {format_time(total_seconds)}")
        self.input_wave.set_playhead(frame)
        self.output_wave.set_playhead(frame)
        self.error_wave.set_playhead(frame)
        if self.spectrum_mode_combo.currentData() == "follow":
            self.update_spectra()

    def on_slider_moved(self, value: int) -> None:
        if self.audio is None:
            return
        # Immediate visual scrub; release restarts/repositions the sink.
        self.engine.preview_position(value)
        self.on_position_changed(value)

    def on_slider_released(self) -> None:
        self.engine.seek(self.position_slider.value())

    def show_audio_error(self, message: str) -> None:
        # Do not modal-block startup; the status bar remains available and the
        # analysis/export paths do not depend on the audio device.
        self.statusBar().setStyleSheet("color: #d03b3b; font-weight: 700;")
        self.statusBar().showMessage(message, 12_000)
        QTimer.singleShot(
            12_000,
            lambda: self.statusBar().setStyleSheet(""),
        )

    # --------------------------------------------------------------- export
    def export_wav(self) -> None:
        if self.audio is None or not self.results:
            QMessageBox.information(self, "暂无可导出数据", "请先打开或生成一段音频。")
            return
        result = self.results[self.quant_method]
        method_slug = self.quant_method.replace("_", "-")
        source_stem = re.sub(r"[^\w一-龥.-]+", "_", Path(self.audio.name).stem) or "audio"
        suggested = (
            f"{source_stem}_{method_slug}_{result.bits}bit_seed{result.params.seed}.wav"
        )
        path, _ = QFileDialog.getSaveFileName(
            self, "导出整数 WAV", suggested, "WAV 音频 (*.wav)"
        )
        if not path:
            return
        if not path.lower().endswith(".wav"):
            path += ".wav"
        try:
            report = export_quantized_wav(
                path,
                result,
                self.audio.sample_rate,
                container=self.container_combo.currentData(),
            )
        except Exception as exc:  # noqa: BLE001 - GUI boundary shows export errors
            QMessageBox.critical(self, "导出失败", str(exc))
            return

        self.last_export_report = report
        if report.true_native_depth:
            encoding = f"真正的 {report.target_bits}-bit 整数 PCM WAV"
        else:
            encoding = (
                f"{report.container_bits}-bit 整数容器，左移 {report.shift} bit；"
                f"文件只保留 {report.used_levels:,} 个目标实际级数"
            )
        status = "读回一致 ✓" if report.readback_matches else "读回不一致 ✗"
        color = "#006300" if report.readback_matches else "#d03b3b"
        self.export_report.setText(
            f"<span style='color:{color};font-weight:700'>{status}</span><br>"
            f"{Path(report.path).name}<br>{encoding}<br>"
            f"界面实际级数 {report.used_levels:,}；"
            f"读回不同整数 {report.readback_unique_levels:,}；"
            f"目标可能级数 {report.target_levels:,}"
        )
        self.statusBar().showMessage(f"已导出并读回校验：{report.path}")
        if not report.readback_matches:
            QMessageBox.warning(self, "校验失败", "WAV 已写出，但读回数据与界面级数不一致。")

    def show_about(self) -> None:
        QMessageBox.about(
            self,
            "说明",
            "所有方案都从同一份原始浮点样本计算。\n\n"
            "• 直接量化：四舍五入到目标二进制补码整数码。\n"
            "• 随机抖动：固定种子的 TPDF，可重复生成。\n"
            "• 噪声整形：误差反馈，一阶/二阶/三阶可选。\n\n"
            "波形中的红色标记表示落在目标最小/最大码的样本；测量区同时分别报告"
            "“被钳制的超范围样本”和“触轨样本”。\n\n"
            "频谱区间可切到末尾或跟随播放位置，以便观察渐弱测试音的低电平尾部。",
        )
