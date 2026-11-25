"""PySide6 window for the local two-microphone cancellation listening bench."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import soundfile as sf
from PySide6.QtCore import Qt, QTimer
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDoubleSpinBox,
    QFileDialog,
    QFrame,
    QGridLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QSizePolicy,
    QSlider,
    QSplitter,
    QToolButton,
    QVBoxLayout,
    QWidget,
)

from .audio import AudioPlayer
from .dsp import (
    Alignment,
    AudioData,
    analyze_band,
    analyze_spectrum,
    apply_alignment,
    comb_notch_frequencies,
    estimate_relative_delay,
    interpret_band,
    power_db,
)
from .examples import EXAMPLE_INDEPENDENT, EXAMPLE_ONE_SIDED, EXAMPLE_REFLECTION, make_example
from .widgets import (
    BLUE,
    GREEN,
    INK,
    MUTED,
    ORANGE,
    PlotSeries,
    PlotWidget,
    MetricCard,
    RED,
    VIOLET,
    WaveformWidget,
)


DB_TICKS = [(-90, "-90"), (-75, "-75"), (-60, "-60"), (-45, "-45"), (-30, "-30"), (-15, "-15"), (0, "0")]
PHASE_TICKS = [(-np.pi, "-180°"), (-np.pi / 2, "-90°"), (0, "0°"), (np.pi / 2, "90°"), (np.pi, "180°")]
COH_TICKS = [(0, "0"), (0.25, ".25"), (0.50, ".50"), (0.75, ".75"), (1.0, "1")]


def fmt_db(value: float) -> str:
    if value <= -115.0:
        return "静音"
    return f"{value:.1f}"


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("双麦反射相消试听台")
        self.resize(1440, 940)
        self.setMinimumSize(1180, 760)

        self.audio: AudioData | None = None
        self.alignment: Alignment | None = None
        self.analysis = None
        self.band_metrics = None
        self.selection = (0, 0)
        self.band: tuple[float, float] | None = None
        self.base_delay: int | None = None
        self.estimated_base_delay: int | None = None
        self._playback_start = 0

        self.player = AudioPlayer()
        self.player.positionChanged.connect(self._on_player_position)
        self.player.playbackStopped.connect(lambda: self.waveform.set_playhead(None))

        self._analysis_timer = QTimer(self)
        self._analysis_timer.setSingleShot(True)
        self._analysis_timer.timeout.connect(self.refresh_analysis)

        self._build_ui()
        self.load_audio(make_example(EXAMPLE_REFLECTION))

    # ------------------------------------------------------------------ UI
    def _build_ui(self) -> None:
        root = QWidget()
        self.setCentralWidget(root)
        layout = QVBoxLayout(root)
        layout.setContentsMargins(12, 12, 12, 10)
        layout.setSpacing(9)

        layout.addWidget(self._build_file_bar())
        layout.addWidget(self._build_control_bar())
        layout.addWidget(self._build_band_bar())
        layout.addWidget(self._build_cards())

        self.waveform = WaveformWidget()
        self.waveform.selectionChanged.connect(self._on_waveform_selection)

        self.spectrum_plot = PlotWidget("两路频谱与合并能量（在图上横向拖选频带）", (-100, 6), DB_TICKS)
        self.spectrum_plot.y_formatter = lambda y: f"{y:.0f} dB"
        self.phase_plot = PlotWidget("相对相位 ∠S₁₂（灰点=低置信 bin）", (-3.55, 3.55), PHASE_TICKS)
        self.phase_plot.y_formatter = lambda y: f"{np.degrees(y):+.0f}°"
        self.coherence_plot = PlotWidget("相干性 γ² 与可用门槛", (-0.05, 1.05), COH_TICKS)
        self.coherence_plot.y_formatter = lambda y: f"{y:.2f}"

        for plot in (self.spectrum_plot, self.phase_plot, self.coherence_plot):
            plot.bandSelected.connect(self.on_band_selected)
            plot.hoverMessage.connect(lambda msg: self.hover_label.setText(msg))

        right_plots = QWidget()
        right_layout = QVBoxLayout(right_plots)
        right_layout.setContentsMargins(0, 0, 0, 0)
        right_layout.setSpacing(8)
        right_layout.addWidget(self.phase_plot, 1)
        right_layout.addWidget(self.coherence_plot, 1)

        plot_splitter = QSplitter(Qt.Orientation.Horizontal)
        plot_splitter.addWidget(self.spectrum_plot)
        plot_splitter.addWidget(right_plots)
        plot_splitter.setStretchFactor(0, 3)
        plot_splitter.setStretchFactor(1, 2)
        plot_splitter.setSizes([820, 520])

        vertical = QSplitter(Qt.Orientation.Vertical)
        vertical.addWidget(self.waveform)
        vertical.addWidget(plot_splitter)
        vertical.setStretchFactor(0, 2)
        vertical.setStretchFactor(1, 3)
        vertical.setSizes([270, 500])
        layout.addWidget(vertical, 1)

        self.explain_label = QLabel("")
        self.explain_label.setWordWrap(True)
        self.explain_label.setStyleSheet(
            "background:#fcfcfb; border:1px solid #e1e0d9; border-radius:10px; padding:9px 12px; color:#0b0b0b;"
        )
        layout.addWidget(self.explain_label)

        self.footnote_label = QLabel(
            "边界规则：固定原时间轴长度；正延时使第 2 路右移，开头补零、右端超出样本丢弃，负延时相反。"
            "分析、试听和 WAV 导出都调用同一个 apply_alignment()。"
        )
        self.footnote_label.setWordWrap(True)
        self.footnote_label.setStyleSheet("color:#898781; font-size:12px;")
        layout.addWidget(self.footnote_label)

        self.statusBar().showMessage("就绪")

    def _build_file_bar(self) -> QWidget:
        box = QFrame()
        lay = QHBoxLayout(box)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(8)

        open_btn = QPushButton("打开双路 WAV…")
        open_btn.clicked.connect(self.choose_wav)
        lay.addWidget(open_btn)

        self.example_combo = QComboBox()
        self.example_combo.addItem("近声 + 延迟反射（周期相消）", EXAMPLE_REFLECTION)
        self.example_combo.addItem("两路无关（低置信对照）", EXAMPLE_INDEPENDENT)
        self.example_combo.addItem("仅一路 + 尾部静音", EXAMPLE_ONE_SIDED)
        self.example_combo.setMinimumWidth(260)
        lay.addWidget(self.example_combo)

        example_btn = QPushButton("载入内置示例")
        example_btn.clicked.connect(self.load_selected_example)
        lay.addWidget(example_btn)

        self.file_label = QLabel("未载入")
        self.file_label.setStyleSheet("color:#52514e;")
        self.file_label.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Preferred)
        lay.addWidget(self.file_label, 1)
        return box

    def _build_control_bar(self) -> QWidget:
        host = QWidget()
        lay = QHBoxLayout(host)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(8)

        align_group = QGroupBox("第 2 路对齐")
        ag = QGridLayout(align_group)
        ag.setContentsMargins(10, 8, 10, 8)
        ag.setHorizontalSpacing(8)
        self.delay_spin = self._make_delay_spin()
        self.delay_spin.valueChanged.connect(self.on_alignment_control_changed)
        self.invert_check = QCheckBox("极性反转")
        self.invert_check.toggled.connect(self.on_alignment_control_changed)
        estimate_btn = QPushButton("估计偏移/极性")
        estimate_btn.clicked.connect(self.estimate_offset)
        reset_btn = QPushButton("归零")
        reset_btn.clicked.connect(self.reset_alignment)
        ag.addWidget(QLabel("细小采样延时"), 0, 0)
        ag.addWidget(self.delay_spin, 0, 1)
        ag.addWidget(self.invert_check, 0, 2)
        ag.addWidget(estimate_btn, 0, 3)
        ag.addWidget(reset_btn, 0, 4)
        self.effective_label = QLabel("")
        self.effective_label.setStyleSheet("color:#52514e;")
        ag.addWidget(self.effective_label, 1, 0, 1, 5)
        lay.addWidget(align_group, 2)

        play_group = QGroupBox("试听当前时域选区")
        pg = QHBoxLayout(play_group)
        pg.setContentsMargins(10, 8, 10, 8)
        self.play_first_btn = QPushButton("独奏麦 1")
        self.play_second_btn = QPushButton("独奏麦 2")
        self.play_mix_btn = QPushButton("合并")
        stop_btn = QPushButton("停止")
        for btn, mode in ((self.play_first_btn, 0), (self.play_second_btn, 1), (self.play_mix_btn, 2)):
            btn.clicked.connect(lambda _checked=False, m=mode: self.play_selection(m))
            pg.addWidget(btn)
        stop_btn.clicked.connect(self.player.stop)
        pg.addWidget(stop_btn)
        self.loop_check = QCheckBox("循环")
        pg.addWidget(self.loop_check)
        pg.addWidget(QLabel("音量"))
        self.volume_slider = QSlider(Qt.Orientation.Horizontal)
        self.volume_slider.setRange(0, 100)
        self.volume_slider.setValue(80)
        self.volume_slider.setFixedWidth(90)
        self.volume_slider.setToolTip("监听音量；预览另有固定 -6 dB 防爆音余量，不影响导出电平")
        self.volume_slider.valueChanged.connect(lambda v: self.player.set_volume(v / 100.0))
        pg.addWidget(self.volume_slider)
        lay.addWidget(play_group, 3)

        export_group = QGroupBox("导出")
        eg = QHBoxLayout(export_group)
        eg.setContentsMargins(10, 8, 10, 8)
        self.export_selection_check = QCheckBox("仅选区（同试听）")
        self.export_selection_check.setChecked(True)
        eg.addWidget(self.export_selection_check)
        export_btn = QToolButton()
        export_btn.setText("导出 WAV ▾")
        export_btn.setPopupMode(QToolButton.ToolButtonPopupMode.InstantPopup)
        menu = export_btn.menu() if export_btn.menu() else None
        from PySide6.QtWidgets import QMenu

        menu = QMenu(export_btn)
        menu.addAction("导出合并单声道…", lambda: self.export_wav(stereo=False))
        menu.addAction("导出对齐双声道…", lambda: self.export_wav(stereo=True))
        export_btn.setMenu(menu)
        eg.addWidget(export_btn)
        lay.addWidget(export_group, 1)
        return host

    def _make_delay_spin(self):
        from PySide6.QtWidgets import QSpinBox

        spin = QSpinBox()
        spin.setRange(-50_000, 50_000)
        spin.setSingleStep(1)
        spin.setSuffix(" smp")
        spin.setValue(0)
        spin.setKeyboardTracking(False)
        return spin

    def _build_band_bar(self) -> QWidget:
        host = QFrame()
        lay = QHBoxLayout(host)
        lay.setContentsMargins(2, 0, 2, 0)
        lay.setSpacing(7)
        lay.addWidget(QLabel("分析频带"))
        self.low_spin = QDoubleSpinBox()
        self.high_spin = QDoubleSpinBox()
        for spin in (self.low_spin, self.high_spin):
            spin.setDecimals(1)
            spin.setRange(1.0, 24_000.0)
            spin.setSingleStep(10.0)
            spin.setSuffix(" Hz")
            spin.setFixedWidth(112)
            spin.setKeyboardTracking(False)
            spin.valueChanged.connect(self.on_band_spin)
        lay.addWidget(self.low_spin)
        lay.addWidget(QLabel("–"))
        lay.addWidget(self.high_spin)
        lay.addWidget(QLabel("可在左侧频谱或右侧相位图上拖选"))
        self.hover_label = QLabel("悬停曲线查看读数")
        self.hover_label.setStyleSheet("color:#898781;")
        lay.addWidget(self.hover_label, 1)
        return host

    def _build_cards(self) -> QWidget:
        host = QWidget()
        lay = QHBoxLayout(host)
        lay.setContentsMargins(0, 0, 0, 0)
        lay.setSpacing(8)
        self.cards: dict[str, MetricCard] = {}
        specs = [
            ("verdict", "判定", 2),
            ("levels", "频带电平 M1 / M2 / 合并", 2),
            ("cancel", "相消量（相对两路均值）", 1),
            ("phase", "中心相对相位", 1),
            ("coherence", "相干 γ²", 1),
            ("confidence", "共同信号置信", 1),
        ]
        for key, title, stretch in specs:
            card = MetricCard(title)
            card.setMinimumWidth(150 if key != "verdict" else 250)
            if key == "verdict":
                card.value.setWordWrap(True)
            lay.addWidget(card, stretch)
            self.cards[key] = card
        return host

    # ------------------------------------------------------------ loading
    def choose_wav(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "选择双路同步 WAV", "", "WAV 文件 (*.wav *.wave)")
        if not path:
            return
        try:
            data = self._load_user_wav(Path(path))
        except Exception as exc:
            QMessageBox.critical(self, "无法读取 WAV", str(exc))
            return
        self.load_audio(data)

    @staticmethod
    def _load_user_wav(path: Path) -> AudioData:
        # Imported here to keep file selection errors close to the user.
        from .dsp import load_wav

        return load_wav(path)

    def load_selected_example(self) -> None:
        key = self.example_combo.currentData()
        self.load_audio(make_example(key))

    def load_audio(self, data: AudioData) -> None:
        self.player.stop()
        self.audio = data
        self.base_delay = data.known_delay
        self.estimated_base_delay = data.known_delay

        self.delay_spin.blockSignals(True)
        self.delay_spin.setValue(0)
        self.delay_spin.blockSignals(False)
        self.invert_check.blockSignals(True)
        self.invert_check.setChecked(False)
        self.invert_check.blockSignals(False)

        self.selection = (0, len(data.samples))
        self.band = None
        self.file_label.setText(f"{data.name} · {data.sample_rate / 1000:.1f} kHz · {len(data.samples) / data.sample_rate:.2f} s")
        self.file_label.setToolTip(data.notes)
        self.statusBar().showMessage(data.notes or "已载入 WAV")
        self.rebuild_alignment(reset_wave_selection=True)

    # --------------------------------------------------------- alignment
    def reset_alignment(self) -> None:
        self.delay_spin.setValue(0)
        self.invert_check.setChecked(False)

    def on_alignment_control_changed(self, *_args) -> None:
        if self.audio is None:
            return
        self.player.stop()
        self.rebuild_alignment(reset_wave_selection=False)
        self._analysis_timer.start(45)

    def rebuild_alignment(self, reset_wave_selection: bool) -> None:
        if self.audio is None:
            return
        delay = int(self.delay_spin.value())
        inverted = self.invert_check.isChecked()
        self.alignment = apply_alignment(self.audio.samples, delay, inverted)

        if reset_wave_selection:
            self.waveform.set_alignment(self.alignment.samples, self.audio.sample_rate, delay)
            self.waveform.set_selection(0, len(self.audio.samples))
        else:
            current = self.waveform.selection
            self.waveform.set_alignment(self.alignment.samples, self.audio.sample_rate, delay)
            self.waveform.set_selection(*current)
        self.selection = self.waveform.selection
        self.refresh_analysis(initial_band=self.band is None)

    def estimate_offset(self) -> None:
        if self.audio is None or self.alignment is None:
            return
        a, b = self.waveform.selection
        d, strength = estimate_relative_delay(
            self.audio.samples[a:b, 0],
            self.audio.samples[a:b, 1],
            self.audio.sample_rate,
        )
        self.estimated_base_delay = d
        self.base_delay = d
        if strength < -0.55:
            self.invert_check.setChecked(True)
        self.statusBar().showMessage(f"估计原始偏移 {d:+d} samples，归一化相关强度 {strength:+.2f}（负值提示反相）")
        self.update_notch_markers()

    def _effective_delay(self) -> int | None:
        if self.base_delay is None:
            return None
        return int(self.base_delay + self.delay_spin.value())

    def update_notch_markers(self) -> None:
        if self.audio is None:
            return
        sr = self.audio.sample_rate
        nyquist = sr / 2.0
        for plot in (self.spectrum_plot, self.phase_plot, self.coherence_plot):
            plot.x_range = (20.0, float(nyquist))

        effective = self._effective_delay()
        inverted = self.invert_check.isChecked()
        if effective is None:
            markers = np.array([])
            self.effective_label.setText("原始偏移未知；可用“估计偏移”，或直接观察追加延时后凹点如何移动。")
        else:
            markers = comb_notch_frequencies(effective, sr, inverted, 20.0, nyquist)
            if effective == 0 and inverted:
                text = "有效偏移 0 且反相：理想情况下全频带抵消（不是梳状栅格）。"
            elif effective == 0:
                text = "有效偏移 0 且同相：没有梳状凹点，理想合并整体增强约 6 dB。"
            elif len(markers):
                shown = ", ".join(f"{f:.0f}" for f in markers[:7])
                period = sr / abs(effective)
                text = f"有效偏移 {effective:+d} smp；凹点间隔 {period:.0f} Hz，前几个：{shown} Hz"
            else:
                text = f"有效偏移 {effective:+d} smp；预测第一凹点高于 Nyquist。"
            self.effective_label.setText(text)

        for plot in (self.spectrum_plot, self.phase_plot, self.coherence_plot):
            plot.set_markers(markers, VIOLET)

    # --------------------------------------------------------- analysis
    def _on_waveform_selection(self, start: int, end: int) -> None:
        self.selection = (start, end)
        self._analysis_timer.start(55)

    def refresh_analysis(self, initial_band: bool = False) -> None:
        if self.audio is None or self.alignment is None:
            return
        self.selection = self.waveform.selection
        self.analysis = analyze_spectrum(self.alignment.samples, self.audio.sample_rate, self.selection)

        sr = self.audio.sample_rate
        nyquist = sr / 2.0
        for plot in (self.spectrum_plot, self.phase_plot, self.coherence_plot):
            plot.x_range = (20.0, float(nyquist))

        if self.analysis is None:
            for plot in (self.spectrum_plot, self.phase_plot, self.coherence_plot):
                plot.set_series([])
            self.waveform.set_frame_spans(np.array([]), np.array([]), np.array([]))
            self.band_metrics = None
            self._set_empty_cards("选区太短")
            self.explain_label.setText("选区少于约 32 个样本，无法做 FFT；请把波形选区拖宽。")
            return

        an = self.analysis
        freq = an.frequencies
        self.spectrum_plot.set_series(
            [
                PlotSeries(freq, power_db(an.p11), BLUE, "麦 1", 1.8),
                PlotSeries(freq, power_db(an.p22), ORANGE, "麦 2", 1.8),
                PlotSeries(freq, power_db(an.psum), GREEN, "合并", 2.5),
            ]
        )

        phase_high = np.where(an.confidence >= 0.40, an.phase, np.nan)
        phase_low = np.where(an.confidence < 0.40, an.phase, np.nan)
        self.phase_plot.set_series(
            [
                PlotSeries(freq, phase_low, MUTED, "低置信", 1.0, alpha=0.55, dots=True, dot_radius=1.25, draw_line=False),
                PlotSeries(freq, phase_high, VIOLET, "可信相位", 1.8),
            ]
        )
        threshold = np.full_like(freq, 0.45, dtype=float)
        self.coherence_plot.set_series(
            [
                PlotSeries(freq, threshold, MUTED, "门槛 .45", 1.2, style=Qt.PenStyle.DashLine),
                PlotSeries(freq, an.coherence, VIOLET, "γ²", 2.1, fill_to=0.0),
            ]
        )

        self.update_notch_markers()

        if initial_band or self.band is None:
            self.band = self._suggest_band()
        else:
            lo, hi = self.band
            self.band = (max(1.0, min(lo, nyquist)), max(1.0, min(hi, nyquist)))
        self.low_spin.blockSignals(True)
        self.high_spin.blockSignals(True)
        self.low_spin.setMaximum(float(nyquist))
        self.high_spin.setMaximum(float(nyquist))
        self.low_spin.setValue(self.band[0])
        self.high_spin.setValue(self.band[1])
        self.low_spin.blockSignals(False)
        self.high_spin.blockSignals(False)
        self.update_band_analysis()

    def _suggest_band(self) -> tuple[float, float]:
        assert self.analysis is not None and self.audio is not None
        sr = self.audio.sample_rate
        nyquist = sr / 2.0
        effective = self._effective_delay()
        if self.audio.known_delay is not None and effective not in (None, 0):
            f0 = sr / (2.0 * abs(effective))
            if 30 < f0 < nyquist:
                return (max(20.0, f0 * 0.90), min(nyquist, f0 * 1.10))

        an = self.analysis
        df = float(an.frequencies[1] - an.frequencies[0]) if len(an.frequencies) > 1 else 1.0
        cancel_bin = power_db(an.psum) - power_db(0.5 * (an.p11 + an.p22))
        opposition = 0.5 * (1 - np.cos(an.phase))
        candidates = np.where((an.confidence > 0.55) & (cancel_bin < -6.0) & (opposition > 0.72))[0]
        candidates = candidates[candidates > 0]
        if len(candidates):
            j = int(candidates[np.argmin(cancel_bin[candidates])])
            half = max(2.2 * df, an.frequencies[j] * 0.055)
            return (max(20.0, an.frequencies[j] - half), min(nyquist, an.frequencies[j] + half))
        return (300.0, min(1200.0, nyquist * 0.8))

    def on_band_selected(self, low: float, high: float) -> None:
        if self.analysis is None or self.audio is None:
            return
        if low > high:
            low, high = high, low
        df = float(self.analysis.frequencies[1] - self.analysis.frequencies[0]) if len(self.analysis.frequencies) > 1 else 1.0
        if high - low < 4.0 * df or abs(high - low) < 1e-6:
            center = low if abs(high - low) < 1e-6 else 0.5 * (low + high)
            half = max(2.2 * df, center * 0.055)
            low, high = center - half, center + half
        nyquist = self.audio.sample_rate / 2.0
        low = max(20.0, low)
        high = min(nyquist, high)
        if high - low < 2.0 * df:
            high = min(nyquist, low + 3.0 * df)
        self.band = (low, high)
        self.low_spin.blockSignals(True)
        self.high_spin.blockSignals(True)
        self.low_spin.setValue(low)
        self.high_spin.setValue(high)
        self.low_spin.blockSignals(False)
        self.high_spin.blockSignals(False)
        self.update_band_analysis()

    def on_band_spin(self, *_args) -> None:
        low, high = float(self.low_spin.value()), float(self.high_spin.value())
        if low > high:
            return
        self.band = (low, high)
        self.update_band_analysis()

    def update_band_analysis(self) -> None:
        if self.analysis is None or self.band is None:
            return
        bm = analyze_band(self.analysis, *self.band, aligned_samples=self.alignment.samples)
        self.band_metrics = bm
        if bm is None:
            return

        for plot in (self.spectrum_plot, self.phase_plot, self.coherence_plot):
            plot.set_band(bm.low_hz, bm.high_hz)
        self.waveform.set_frame_spans(bm.frame_starts, bm.frame_ends, bm.frame_weights)

        category, headline, explanation = interpret_band(bm)
        tone = {
            "cancellation": "#006300",
            "weak_cancellation": "#8a5a00",
            "low_confidence": "#9a5b00",
            "low_level": "#1c5cab",
            "normal": INK,
            "empty": MUTED,
        }.get(category, INK)
        short_headline = {
            "cancellation": "反相相消",
            "weak_cancellation": "可能相消",
            "low_confidence": "置信不足",
            "low_level": "整体电平小",
            "normal": "无明显相消",
            "empty": "无法估计",
        }.get(category, headline)
        self.cards["verdict"].set_value(short_headline, headline, tone)
        self.explain_label.setText(explanation)

        self.cards["levels"].set_value(
            f"{fmt_db(bm.rms1_db)} / {fmt_db(bm.rms2_db)} / {fmt_db(bm.sum_db)}",
            "dBFS，顺序为麦 1 / 麦 2 / 合并；“静音”表示低于显示底限",
        )
        cancel_tone = "#006300" if bm.cancel_db <= -8 and bm.confidence > 0.55 else INK
        self.cards["cancel"].set_value(f"{bm.cancel_db:+.1f} dB", "负值=合并比两路能量参考更空", cancel_tone)

        if bm.reason_code in {"silence", "only_first", "only_second", "unstable", "short", "no_frames"} or bm.confidence < 0.40:
            phase_value = "—"
            phase_sub = "缺少稳定共同信号；单点相位无代表性，请看灰点/紫线趋势"
            phase_tone = MUTED
        else:
            phase_value = f"{bm.phase_deg:+.0f}°"
            focus = "窄带相位一致" if (bm.phase_focus or 0) > 0.72 else "频带较宽时相位会旋转"
            delay_txt = "" if bm.delay_estimate_samples is None else f"；拟合斜率约 {bm.delay_estimate_samples:+.1f} smp"
            phase_sub = f"中心 bin；{focus}{delay_txt}"
            phase_tone = "#006300" if bm.opposition > 0.78 and bm.confidence > 0.55 else VIOLET
        self.cards["phase"].set_value(phase_value, phase_sub, phase_tone)

        coh_tone = RED if bm.coherence < 0.35 else ("#8a5a00" if bm.coherence < 0.62 else "#006300")
        self.cards["coherence"].set_value(f"{bm.coherence:.2f}", "γ² 越高，跨帧相位关系越稳定", coh_tone)
        conf_tone = RED if bm.confidence < 0.2 else ("#8a5a00" if bm.confidence < 0.72 else "#006300")
        self.cards["confidence"].set_value(
            f"{bm.confidence:.2f} · {bm.confidence_label}",
            f"{bm.n_frames} 个 Hann/FFT 帧；{bm.reason}",
            conf_tone,
        )

    def _set_empty_cards(self, sub: str) -> None:
        for key, card in self.cards.items():
            card.set_value("—", sub if key == "verdict" else "")

    # -------------------------------------------------------- playback/io
    def play_selection(self, mode: int) -> None:
        if self.alignment is None or self.audio is None:
            return
        a, b = self.waveform.selection
        if b - a < 2:
            QMessageBox.information(self, "选区太短", "请先在波形上拖出一段再试听。")
            return
        if mode == 0:
            mono = self.alignment.samples[a:b, 0]
            name = "麦 1"
        elif mode == 1:
            mono = self.alignment.samples[a:b, 1]
            name = "麦 2"
        else:
            mono = np.sum(self.alignment.samples[a:b, :], axis=1)
            name = "合并"
        self._playback_start = a
        self.player.set_volume(self.volume_slider.value() / 100.0)
        self.player.play_samples(mono, self.audio.sample_rate, loop=self.loop_check.isChecked())
        self.statusBar().showMessage(f"正在试听选区 {a / self.audio.sample_rate:.2f}–{b / self.audio.sample_rate:.2f} s：{name}")

    def _on_player_position(self, relative_frame: int) -> None:
        if relative_frame < 0:
            self.waveform.set_playhead(None)
        else:
            self.waveform.set_playhead(self._playback_start + relative_frame)

    def export_wav(self, stereo: bool) -> None:
        if self.audio is None or self.alignment is None:
            return
        default_name = Path(self.audio.name).stem + ("_aligned_stereo.wav" if stereo else "_mix.wav")
        path, _ = QFileDialog.getSaveFileName(self, "导出 WAV", default_name, "WAV 文件 (*.wav)")
        if not path:
            return
        if not Path(path).suffix:
            path += ".wav"
        if self.export_selection_check.isChecked():
            a, b = self.waveform.selection
            data = self.alignment.samples[a:b, :]
            range_text = "当前选区"
        else:
            data = self.alignment.samples
            range_text = "整段"
        out = data if stereo else np.sum(data, axis=1)
        try:
            # 32-bit float keeps a legal correlated sum above 0 dBFS instead of
            # clipping; preview has a fixed headroom trim but same alignment.
            sf.write(path, out, self.audio.sample_rate, subtype="FLOAT")
        except Exception as exc:
            QMessageBox.critical(self, "导出失败", str(exc))
            return
        self.statusBar().showMessage(f"已导出{range_text}（相同延时/极性/边界规则）：{path}")

    def closeEvent(self, event) -> None:  # noqa: N802
        self.player.stop()
        super().closeEvent(event)
