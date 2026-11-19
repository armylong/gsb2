"""卷积混响试听工具的 Qt 界面。"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from PySide6.QtCore import QEvent, Qt, QTimer
from PySide6.QtGui import QFont
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QFileDialog,
    QFrame,
    QGridLayout,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QSlider,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

from .audio_io import AudioLoadError, LoadedAudio, load_dry, load_impulse, write_wav
from .dsp import (
    MAX_GAIN_DB,
    MAX_PREDELAY_MS,
    MIN_GAIN_DB,
    RenderResult,
    ReverbParams,
    linear_to_db,
)
from .player import PlaybackUnavailable, Player, slice_clip
from .render import RenderController, RenderJob
from .widgets import (
    ACCENT,
    DRY_MARK,
    INK,
    INK_MUTED,
    INK_SECONDARY,
    PAGE,
    PREDELAY,
    SERIES_L,
    SERIES_R,
    SURFACE,
    SURFACE_RAISED,
    TAIL_MARK,
    Band,
    LevelMeter,
    Marker,
    StatusPill,
    WaveformView,
)

APP_TITLE = "卷积混响试听台"
SAMPLE_DIR = Path(__file__).resolve().parent.parent / "samples"

STYLESHEET = f"""
QMainWindow, QWidget#Root {{ background: {PAGE.name()}; color: {INK.name()}; }}
QWidget {{ color: {INK.name()}; font-size: 13px; }}
QFrame#Card {{ background: {SURFACE.name()}; border: 1px solid #2c2c2a; border-radius: 8px; }}
QLabel#CardTitle {{ color: {INK.name()}; font-size: 13px; font-weight: 600; }}
QLabel#Muted {{ color: {INK_MUTED.name()}; }}
QLabel#Secondary {{ color: {INK_SECONDARY.name()}; }}
QLabel#Value {{ color: {INK.name()}; font-weight: 600; }}
QPushButton {{
    background: {SURFACE_RAISED.name()}; color: {INK.name()};
    border: 1px solid #383835; border-radius: 6px; padding: 6px 12px;
}}
QPushButton:hover {{ background: #2c2c2a; }}
QPushButton:pressed {{ background: #333331; }}
QPushButton:disabled {{ color: #6b6a66; border-color: #2c2c2a; }}
QPushButton#Primary {{ background: #1c5cab; border-color: #2a78d6; }}
QPushButton#Primary:hover {{ background: #2a78d6; }}
QPushButton#Danger {{ background: #4a1f1f; border-color: #8a3333; }}
QPushButton#Danger:hover {{ background: #6b2a2a; }}
QComboBox {{ background: {SURFACE_RAISED.name()}; border: 1px solid #383835;
    border-radius: 6px; padding: 4px 8px; }}
QComboBox QAbstractItemView {{ background: {SURFACE_RAISED.name()};
    selection-background-color: #1c5cab; }}
QSlider::groove:horizontal {{ height: 4px; background: #383835; border-radius: 2px; }}
QSlider::sub-page:horizontal {{ background: {ACCENT.name()}; border-radius: 2px; }}
QSlider::handle:horizontal {{ background: {INK.name()}; width: 14px; height: 14px;
    margin: -6px 0; border-radius: 7px; }}
QCheckBox {{ spacing: 8px; }}
QCheckBox::indicator {{ width: 16px; height: 16px; border-radius: 4px;
    border: 1px solid #55544f; background: #1a1a19; }}
QCheckBox::indicator:checked {{ background: {ACCENT.name()}; border-color: {ACCENT.name()}; }}
QSplitter::handle {{ background: #222221; }}
QScrollBar:vertical {{ background: {PAGE.name()}; width: 10px; }}
QScrollBar::handle:vertical {{ background: #383835; border-radius: 5px; min-height: 30px; }}
QToolTip {{ background: #222221; color: {INK.name()}; border: 1px solid #383835; padding: 4px; }}
"""


def db_text(value: float) -> str:
    if value <= 0:
        return "-∞ dBFS"
    return f"{20.0 * math.log10(value):+.1f} dBFS"


def seconds_text(frames: int, sample_rate: int) -> str:
    return f"{frames / sample_rate:.3f} s"


class Card(QFrame):
    def __init__(self, title: str, parent=None) -> None:
        super().__init__(parent)
        self.setObjectName("Card")
        self._layout = QVBoxLayout(self)
        self._layout.setContentsMargins(12, 10, 12, 10)
        self._layout.setSpacing(6)
        header = QLabel(title)
        header.setObjectName("CardTitle")
        self._layout.addWidget(header)

    def body(self) -> QVBoxLayout:
        return self._layout

    def add(self, widget: QWidget) -> QWidget:
        self._layout.addWidget(widget)
        return widget


class SliderRow(QWidget):
    """标签 + 数值 + 滑杆，数值与滑杆双向同步。"""

    def __init__(
        self,
        title: str,
        minimum: int,
        maximum: int,
        initial: int,
        formatter,
        *,
        left_hint: str = "",
        right_hint: str = "",
        parent=None,
    ) -> None:
        super().__init__(parent)
        self.formatter = formatter
        self._minimum = minimum
        self._maximum = maximum
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(2)
        top = QHBoxLayout()
        top.setContentsMargins(0, 0, 0, 0)
        self.title_label = QLabel(title)
        self.title_label.setObjectName("Secondary")
        self.value_label = QLabel()
        self.value_label.setObjectName("Value")
        self.value_label.setAlignment(Qt.AlignmentFlag.AlignRight)
        top.addWidget(self.title_label)
        top.addStretch(1)
        top.addWidget(self.value_label)
        layout.addLayout(top)
        self.slider = QSlider(Qt.Orientation.Horizontal)
        self.slider.setRange(minimum, maximum)
        self.slider.setValue(initial)
        self.slider.setSingleStep(1)
        self.slider.setPageStep(max(1, (maximum - minimum) // 20))
        layout.addWidget(self.slider)
        if left_hint or right_hint:
            hints = QHBoxLayout()
            hints.setContentsMargins(0, 0, 0, 0)
            left = QLabel(left_hint)
            left.setObjectName("Muted")
            right = QLabel(right_hint)
            right.setObjectName("Muted")
            right.setAlignment(Qt.AlignmentFlag.AlignRight)
            hints.addWidget(left)
            hints.addStretch(1)
            hints.addWidget(right)
            layout.addLayout(hints)
        self.slider.valueChanged.connect(self._sync_value)
        self._sync_value(initial)

    def _sync_value(self, value: int) -> None:
        self.value_label.setText(self.formatter(value))

    def value(self) -> int:
        return self.slider.value()

    def set_value(self, value: int) -> None:
        self.slider.setValue(int(value))

    def fraction(self) -> float:
        span = self._maximum - self._minimum
        return 0.0 if span <= 0 else (self.slider.value() - self._minimum) / span


class ExportReadback(QFrame):
    """导出后回读的独立小面板。"""

    def __init__(self, parent=None) -> None:
        super().__init__(parent)
        self.setVisible(False)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 6, 0, 0)
        layout.setSpacing(4)
        title = QLabel("导出回读")
        title.setObjectName("CardTitle")
        layout.addWidget(title)
        self.info = QLabel("尚未导出")
        self.info.setObjectName("Secondary")
        self.info.setWordWrap(True)
        layout.addWidget(self.info)
        self.wave = WaveformView()
        self.wave.setMinimumHeight(64)
        self.wave.setMaximumHeight(110)
        layout.addWidget(self.wave)


class MainWindow(QMainWindow):
    def __init__(self, player: Player | None = None) -> None:
        super().__init__()
        self.setWindowTitle(APP_TITLE)
        self.resize(1320, 900)
        self.setMinimumSize(1080, 760)

        self._dry: LoadedAudio | None = None
        self._ir: LoadedAudio | None = None
        self._ir_markers: list[Marker] = []
        self._result: RenderResult | None = None
        self._job: RenderJob | None = None
        self._active_render_serial: int | None = None
        self._rendering = False
        self._cursor_frame = 0
        self._selection: tuple[int, int] | None = None
        self._last_range: tuple[int, int] | None = None
        self._ab_mode = "wet"
        self._export_last: tuple[Path, int, int] | None = None

        self._resume_after_scrub = False
        self._player = player or Player()
        self._render_controller = RenderController(
            self._on_render_ready, self._on_render_error, parent=self
        )

        self._param_timer = QTimer(self)
        self._param_timer.setSingleShot(True)
        self._param_timer.setInterval(120)
        self._param_timer.timeout.connect(self._start_render)

        self._playhead_timer = QTimer(self)
        self._playhead_timer.setInterval(33)
        self._playhead_timer.timeout.connect(self._tick_playhead)

        self._build_ui()
        self.setStyleSheet(STYLESHEET)
        self._update_transport_state()
        self._update_parameter_readout()

    # ------------------------------------------------------------------ UI
    def _build_ui(self) -> None:
        root = QWidget()
        root.setObjectName("Root")
        self.setCentralWidget(root)
        outer = QVBoxLayout(root)
        outer.setContentsMargins(14, 12, 14, 12)
        outer.setSpacing(10)

        outer.addLayout(self._build_header())

        splitter = QSplitter(Qt.Orientation.Horizontal)
        splitter.setChildrenCollapsible(False)
        splitter.addWidget(self._build_left_panel())
        splitter.addWidget(self._build_right_panel())
        splitter.setStretchFactor(0, 0)
        splitter.setStretchFactor(1, 1)
        splitter.setSizes([380, 930])
        outer.addWidget(splitter, 1)

    def _build_header(self) -> QHBoxLayout:
        row = QHBoxLayout()
        title = QLabel(APP_TITLE)
        title_font = QFont(self.font())
        title_font.setPointSizeF(title_font.pointSizeF() + 5)
        title_font.setBold(True)
        title.setFont(title_font)
        row.addWidget(title)
        subtitle = QLabel("干声 × 房间响应 · 完整尾音试听与导出")
        subtitle.setObjectName("Muted")
        row.addWidget(subtitle)
        row.addStretch(1)

        self.sample_btn = QPushButton("生成样例")
        self.sample_btn.setToolTip("在 samples/ 目录生成可核对的干声与响应")
        self.sample_btn.clicked.connect(self._open_sample_menu)
        row.addWidget(self.sample_btn)

        self.load_dry_btn = QPushButton("载入干声…")
        self.load_dry_btn.clicked.connect(self._choose_dry)
        row.addWidget(self.load_dry_btn)

        self.load_ir_btn = QPushButton("载入响应…")
        self.load_ir_btn.clicked.connect(self._choose_ir)
        row.addWidget(self.load_ir_btn)
        return row

    def _build_left_panel(self) -> QWidget:
        panel = QWidget()
        layout = QVBoxLayout(panel)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(10)

        self.dry_card = Card("干声")
        self.dry_info = QLabel("尚未载入 · 单声道/立体声 · ≤ 10 s")
        self.dry_info.setObjectName("Muted")
        self.dry_info.setWordWrap(True)
        self.dry_card.add(self.dry_info)
        self.dry_wave = WaveformView()
        self.dry_wave.setMinimumHeight(84)
        self.dry_wave.setMaximumHeight(120)
        self.dry_card.add(self.dry_wave)
        layout.addWidget(self.dry_card)

        self.ir_card = Card("脉冲响应")
        self.ir_info = QLabel("尚未载入 · 单声道 · ≤ 3 s")
        self.ir_info.setObjectName("Muted")
        self.ir_info.setWordWrap(True)
        self.ir_card.add(self.ir_info)
        self.ir_wave = WaveformView()
        self.ir_wave.setMinimumHeight(84)
        self.ir_wave.setMaximumHeight(120)
        self.ir_wave.set_colors([SERIES_R])
        self.ir_card.add(self.ir_wave)
        self._ir_used_note = QLabel("实际使用长度：—")
        self._ir_used_note.setObjectName("Secondary")
        self._ir_used_note.setWordWrap(True)
        self.ir_card.add(self._ir_used_note)
        layout.addWidget(self.ir_card)

        params_card = Card("处理参数")
        self.mix_row = SliderRow(
            "干湿比例",
            0,
            1000,
            500,
            lambda v: f"{v / 10:.0f} % 混响",
            left_hint="纯干声",
            right_hint="纯混响",
        )
        # 滑块拖动时读数与状态立即更新；计算走 120 ms 防抖，连续调参
        # 只提交最后一轮，旧任务的结果由 RenderController 丢弃。
        self.mix_row.slider.valueChanged.connect(self._on_param_scrub)
        self.mix_row.slider.sliderReleased.connect(self._on_param_released)
        params_card.add(self.mix_row)

        self.predelay_row = SliderRow(
            "预延迟",
            0,
            int(MAX_PREDELAY_MS),
            0,
            lambda v: f"{v} ms",
            left_hint="0 ms",
            right_hint=f"{int(MAX_PREDELAY_MS)} ms",
        )
        self.predelay_row.slider.valueChanged.connect(self._on_param_scrub)
        self.predelay_row.slider.sliderReleased.connect(self._on_param_released)
        params_card.add(self.predelay_row)

        self.gain_row = SliderRow(
            "输出增益",
            int(MIN_GAIN_DB * 10),
            int(MAX_GAIN_DB * 10),
            0,
            lambda v: f"{v / 10:+.1f} dB",
            left_hint=f"{int(MIN_GAIN_DB)} dB",
            right_hint=f"+{int(MAX_GAIN_DB)} dB",
        )
        self.gain_row.slider.valueChanged.connect(self._on_param_scrub)
        self.gain_row.slider.sliderReleased.connect(self._on_param_released)
        params_card.add(self.gain_row)

        protect_box = QFrame()
        protect_layout = QVBoxLayout(protect_box)
        protect_layout.setContentsMargins(0, 4, 0, 0)
        protect_layout.setSpacing(3)
        self.protect_check = QCheckBox("统一衰减保护（推荐）")
        self.protect_check.setChecked(True)
        self.protect_check.setToolTip(
            "整段输出乘同一个标量，把保护前峰值压到 -0.1 dBFS 以下；"
            "左右声道共用该标量，比例不变。"
        )
        self.protect_check.toggled.connect(self._on_param_changed)
        protect_layout.addWidget(self.protect_check)
        self.protect_hint = QLabel("上限 -0.1 dBFS · 只在超幅时介入 · 不改变左右比例")
        self.protect_hint.setObjectName("Muted")
        self.protect_hint.setWordWrap(True)
        protect_layout.addWidget(self.protect_hint)
        params_card.add(protect_box)

        reset = QPushButton("恢复默认参数")
        reset.clicked.connect(self._reset_params)
        params_card.add(reset)
        layout.addWidget(params_card)
        layout.addStretch(1)
        return panel

    def _build_right_panel(self) -> QWidget:
        panel = QWidget()
        layout = QVBoxLayout(panel)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(10)

        output_card = Card("输出（完整尾音）")
        status_row = QHBoxLayout()
        self.status_pill = StatusPill("等待载入素材")
        status_row.addWidget(self.status_pill, 1)
        self.output_info = QLabel("")
        self.output_info.setObjectName("Secondary")
        self.output_info.setAlignment(Qt.AlignmentFlag.AlignRight)
        status_row.addWidget(self.output_info, 2)
        output_card.body().addLayout(status_row)

        self.output_wave = WaveformView(interactive=True)
        self.output_wave.setMinimumHeight(220)
        self.output_wave.seek_requested.connect(self._on_seek)
        self.output_wave.scrub_started.connect(self._on_scrub_start)
        self.output_wave.scrub_finished.connect(self._on_scrub_finished)
        self.output_wave.selection_changed.connect(self._on_selection_changed)
        self.output_wave.selection_cleared.connect(self._on_selection_cleared)
        output_card.add(self.output_wave)

        transport = QHBoxLayout()
        transport.setSpacing(6)
        self.play_all_btn = QPushButton("▶ 整段")
        self.play_all_btn.setObjectName("Primary")
        self.play_all_btn.clicked.connect(self._play_all)
        self.play_sel_btn = QPushButton("▶ 选区")
        self.play_sel_btn.clicked.connect(self._play_selection)
        self.play_tail_btn = QPushButton("▶ 只听尾音")
        self.play_tail_btn.clicked.connect(self._play_tail)
        self.stop_btn = QPushButton("■ 停止")
        self.stop_btn.setObjectName("Danger")
        self.stop_btn.clicked.connect(self._stop_playback)
        transport.addWidget(self.play_all_btn)
        transport.addWidget(self.play_sel_btn)
        transport.addWidget(self.play_tail_btn)
        transport.addWidget(self.stop_btn)
        transport.addSpacing(10)
        transport.addWidget(QLabel("试听"))
        self.ab_combo = QComboBox()
        self.ab_combo.addItem("当前结果", "wet")
        self.ab_combo.addItem("原声（干声）", "dry")
        self.ab_combo.setToolTip(
            "原声也经过同一输出增益与保护标量，便于等响 A/B。"
        )
        self.ab_combo.currentIndexChanged.connect(self._on_ab_changed)
        transport.addWidget(self.ab_combo)
        transport.addStretch(1)
        self.playhead_label = QLabel("播放头 0.000 s")
        self.playhead_label.setObjectName("Secondary")
        transport.addWidget(self.playhead_label)
        output_card.body().addLayout(transport)

        self.selection_label = QLabel("未选择区间 · 在波形上拖动可截取短区间，双击清除")
        self.selection_label.setObjectName("Muted")
        output_card.body().addWidget(self.selection_label)
        layout.addWidget(output_card, 1)

        lower = QHBoxLayout()
        lower.setSpacing(10)
        lower.addWidget(self._build_level_card(), 3)
        lower.addWidget(self._build_export_card(), 4)
        layout.addLayout(lower)
        return panel

    def _build_level_card(self) -> QWidget:
        card = Card("电平")
        grid = QGridLayout()
        grid.setContentsMargins(0, 0, 0, 0)
        grid.setHorizontalSpacing(12)
        grid.setVerticalSpacing(4)
        self.dry_peak_label = QLabel("—")
        self.raw_peak_label = QLabel("—")
        self.out_peak_label = QLabel("—")
        self.protect_label = QLabel("—")
        for label in (self.dry_peak_label, self.raw_peak_label, self.out_peak_label, self.protect_label):
            label.setObjectName("Value")
            label.setAlignment(Qt.AlignmentFlag.AlignRight)
        for row, (name, widget) in enumerate(
            (
                ("干声峰值", self.dry_peak_label),
                ("保护前峰值", self.raw_peak_label),
                ("输出峰值", self.out_peak_label),
                ("保护衰减", self.protect_label),
            )
        ):
            key = QLabel(name)
            key.setObjectName("Secondary")
            grid.addWidget(key, row, 0)
            grid.addWidget(widget, row, 1)
        grid.setColumnStretch(1, 1)
        card.body().addLayout(grid)

        meter_row = QHBoxLayout()
        meter_row.addWidget(QLabel("输出"))
        self.meter = LevelMeter()
        self.meter.setMinimumHeight(16)
        meter_row.addWidget(self.meter, 1)
        card.body().addLayout(meter_row)
        self.overshoot_pill = StatusPill("")
        card.body().addWidget(self.overshoot_pill)
        card.body().addStretch(1)
        return card

    def _build_export_card(self) -> QWidget:
        card = Card("导出")
        hint = QLabel("写出当前采样率、当前参数与完整尾音的 wav；导出后回读显示真实长度与峰值。")
        hint.setObjectName("Muted")
        hint.setWordWrap(True)
        card.add(hint)
        row = QHBoxLayout()
        self.export_stereo_btn = QPushButton("导出立体声 WAV…")
        self.export_stereo_btn.setObjectName("Primary")
        self.export_stereo_btn.clicked.connect(lambda: self._export(stereo=True))
        self.export_mono_btn = QPushButton("导出单声道 WAV…")
        self.export_mono_btn.clicked.connect(lambda: self._export(stereo=False))
        row.addWidget(self.export_stereo_btn)
        row.addWidget(self.export_mono_btn)
        row.addStretch(1)
        card.body().addLayout(row)
        self.export_readback = ExportReadback()
        card.body().addWidget(self.export_readback)
        card.body().addStretch(1)
        return card

    # ------------------------------------------------------------- 素材载入
    def _choose_dry(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "选择干声（≤10 s，单/立体声）", str(SAMPLE_DIR), "WAV (*.wav *.WAV)"
        )
        if path:
            self.load_dry(path)

    def _choose_ir(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "选择脉冲响应（≤3 s，单声道）", str(SAMPLE_DIR), "WAV (*.wav *.WAV)"
        )
        if path:
            self.load_ir(path)

    def load_dry(self, path: str | Path) -> bool:
        try:
            loaded = load_dry(path)
        except AudioLoadError as exc:
            self._show_error("干声载入失败", str(exc))
            return False
        self._stop_playback()
        self._dry = loaded
        self.dry_wave.set_audio(loaded.samples, loaded.sample_rate, [SERIES_L])
        channel_text = "立体声" if loaded.is_stereo else "单声道"
        self.dry_info.setText(
            f"{loaded.path.name} · {channel_text} · {loaded.sample_rate} Hz · "
            f"{loaded.frames:,} 点 · {loaded.duration_s:.3f} s · 峰值 {db_text(loaded.peak)}"
        )
        self._clear_output(self._pending_status())
        self._schedule_render()
        return True

    def load_ir(self, path: str | Path, markers: list[Marker] | None = None) -> bool:
        try:
            loaded = load_impulse(path)
        except AudioLoadError as exc:
            self._show_error("响应载入失败", str(exc))
            return False
        self._stop_playback()
        self._ir = loaded
        self._ir_markers = list(markers or [])
        self.ir_wave.set_audio(loaded.samples, loaded.sample_rate, [SERIES_R])
        self.ir_wave.set_markers(self._ir_markers)
        self.ir_info.setText(
            f"{loaded.path.name} · 单声道 · {loaded.sample_rate} Hz · "
            f"{loaded.frames:,} 点 · {loaded.duration_s:.3f} s · 峰值 {db_text(loaded.peak)}"
        )
        self._ir_used_note.setText("实际使用长度：等待计算…")
        self._clear_output(self._pending_status())
        self._schedule_render()
        return True

    def _open_sample_menu(self) -> None:
        from PySide6.QtWidgets import QMenu

        menu = QMenu(self)
        actions = [
            ("单点脉冲干声（48 kHz）", self._load_sample_click),
            ("短音符干声（48 kHz）", self._load_sample_note),
            ("立体声短音符干声（48 kHz）", self._load_sample_stereo_note),
            ("离散回声响应（48 kHz）", self._load_sample_echo_ir),
            ("指数衰减噪声响应（48 kHz）", self._load_sample_noise_ir),
            ("44.1 kHz 离散回声响应", self._load_sample_mismatched_ir),
            ("一次生成全部样例", self._generate_all_samples),
        ]
        for text, handler in actions:
            action = menu.addAction(text)
            action.triggered.connect(handler)
        menu.exec(self.sample_btn.mapToGlobal(self.sample_btn.rect().bottomLeft()))

    def _sample_spec(self, factory, filename: str):
        SAMPLE_DIR.mkdir(parents=True, exist_ok=True)
        return factory(SAMPLE_DIR / filename)

    def _load_sample_click(self) -> None:
        from .samples import click_dry

        spec = self._sample_spec(click_dry, "dry_click_48k.wav")
        self.load_dry(spec.path)

    def _load_sample_note(self) -> None:
        from .samples import short_note

        spec = self._sample_spec(short_note, "dry_note_48k.wav")
        self.load_dry(spec.path)

    def _load_sample_stereo_note(self) -> None:
        from .samples import stereo_note

        spec = self._sample_spec(stereo_note, "dry_stereo_48k.wav")
        self.load_dry(spec.path)

    def _load_sample_echo_ir(self) -> None:
        from .samples import impulse_response

        spec = self._sample_spec(impulse_response, "ir_echoes_48k.wav")
        self.load_ir(spec.path, self._taps_to_markers(spec))

    def _load_sample_noise_ir(self) -> None:
        from .samples import synthetic_ir

        spec = self._sample_spec(synthetic_ir, "ir_noise_48k.wav")
        self.load_ir(spec.path)

    def _load_sample_mismatched_ir(self) -> None:
        from .samples import mismatched_rate_ir

        spec = self._sample_spec(mismatched_rate_ir, "ir_echoes_44k1.wav")
        self.load_ir(spec.path, self._taps_to_markers(spec))

    def _generate_all_samples(self) -> None:
        from .samples import write_all

        specs = write_all(SAMPLE_DIR)
        lines = [f"{s.path.name}: {s.description}" for s in specs]
        QMessageBox.information(
            self,
            "样例已生成",
            f"已写入 {SAMPLE_DIR}\n\n" + "\n".join(lines),
        )

    @staticmethod
    def _taps_to_markers(spec) -> list[Marker]:
        taps = spec.expected.get("taps", ())
        markers = []
        for index, (delay_s, gain) in enumerate(taps):
            frame = int(round(delay_s * spec.sample_rate))
            markers.append(
                Marker(
                    label=f"{delay_s * 1000:.0f}ms {gain:+.2f}",
                    frame=frame,
                    color=DRY_MARK if index == 0 else SERIES_R,
                    row=index % 2,
                )
            )
        return markers

    # ------------------------------------------------------------- 参数/渲染
    def current_params(self) -> ReverbParams:
        return ReverbParams(
            mix=self.mix_row.value() / 1000.0,
            predelay_ms=float(self.predelay_row.value()),
            output_gain_db=self.gain_row.value() / 10.0,
            protection=self.protect_check.isChecked(),
            ceiling_db=-0.1,
        )

    def _reset_params(self) -> None:
        for row, value in (
            (self.mix_row, 500),
            (self.predelay_row, 0),
            (self.gain_row, 0),
        ):
            row.blockSignals(True)
            row.set_value(value)
            row.blockSignals(False)
        self.protect_check.blockSignals(True)
        self.protect_check.setChecked(True)
        self.protect_check.blockSignals(False)
        self._update_parameter_readout()
        self._on_param_changed()

    def _update_parameter_readout(self) -> None:
        params = self.current_params()
        self.mix_row.value_label.setText(f"{params.mix * 100:.0f} % 混响")
        self.predelay_row.value_label.setText(f"{params.predelay_ms:.0f} ms")
        self.gain_row.value_label.setText(f"{params.output_gain_db:+.1f} dB")

    def _on_param_scrub(self, *args) -> None:
        """拖动中：读数立即更新、旧结果立即失效；计算按防抖延时排队。"""
        self._update_parameter_readout()
        self._stop_playback()
        self._clear_output("参数已改变，正在重新计算…")
        self._param_timer.start()  # restart(): 连续拖动时只算最后一轮

    def _on_param_released(self, *args) -> None:
        self._param_timer.start()

    def _on_param_changed(self, *args) -> None:
        """离散控件（复选框、恢复默认）：立即排一次计算。"""
        self._update_parameter_readout()
        self._stop_playback()
        self._clear_output("参数已改变，正在重新计算…")
        self._param_timer.start()

    def _schedule_render(self) -> None:
        self._param_timer.start()

    def _start_render(self) -> None:
        if self._dry is None or self._ir is None:
            self._rendering = False
            self._set_status(self._pending_status(), "muted")
            self._update_transport_state()
            return
        self._rendering = True
        self._result = None
        self._job = self._render_controller.submit(
            self._dry, self._ir, self.current_params()
        )
        self._active_render_serial = self._job.serial
        self._set_status("计算中…", "muted")
        self._update_transport_state()

    def _pending_status(self) -> str:
        if self._dry is None or self._ir is None:
            if self._dry is None and self._ir is None:
                return "请载入干声和脉冲响应"
            return "请载入脉冲响应" if self._dry is not None else "请载入干声"
        return "素材已更新，正在重新计算…"

    def _clear_output(self, status: str) -> None:
        """让旧参数的结果立即失效：不留在预览、波形或导出路径上。"""
        self._result = None
        self._rendering = False
        # 作废旧任务：即使旧素材/旧参数的结果已经算完，也不会被应用。
        self._active_render_serial = None
        self.output_wave.clear()
        self.output_info.setText("")
        self._set_status(status, "muted")
        self._update_peak_readout(None)
        self._update_transport_state()

    def _on_render_ready(self, result: RenderResult, serial: int | None = None) -> None:
        # RenderController 已确认序号是"最新提交"；这里再核对本窗口当前有效的序号，
        # 防止换素材后、旧素材结果恰好在新任务提交前到达。
        if serial is not None and serial != self._active_render_serial:
            return
        if self._dry is None or self._ir is None:
            return
        if result.params.key(result.dry_sample_rate) != self.current_params().key(
            result.dry_sample_rate
        ):
            return
        self._rendering = False
        self._result = result
        self._cursor_frame = 0
        self._selection = None
        self._last_range = None
        self.selection_label.setText(
            "未选择区间 · 在波形上拖动可截取短区间，双击清除"
        )
        self._update_output_view()
        self._update_peak_readout(result)
        self._update_transport_state()
        self._set_status(f"就绪 · {result.duration_s:.3f} s", "good")

    def _on_render_error(self, message: str) -> None:
        self._rendering = False
        self._result = None
        self._set_status("计算失败", "critical")
        self._show_error("处理失败", message)
        self._update_transport_state()

    def _update_output_view(self) -> None:
        result = self._result
        if result is None:
            self.output_wave.clear()
            return
        self.output_wave.set_audio(
            result.samples, result.dry_sample_rate, [SERIES_L, SERIES_R]
        )
        markers = [
            Marker("干声终点", result.dry_end_frame, DRY_MARK, row=0),
            Marker("尾音终点", result.frames, TAIL_MARK, row=1),
        ]
        if result.predelay_frames > 0:
            markers.append(
                Marker(
                    f"预延迟 {result.params.predelay_ms:.0f} ms",
                    result.predelay_frames,
                    PREDELAY,
                    row=1,
                )
            )
        bands = []
        if result.predelay_frames > 0:
            bands.append(Band(0, result.predelay_frames, PREDELAY))
        bands.append(Band(result.dry_end_frame, result.frames, TAIL_MARK))
        self.output_wave.set_markers(markers, bands)
        self.output_wave.set_selection(self._selection)
        self.output_wave.set_playhead(self._cursor_frame)
        self.output_info.setText(
            f"干声 {result.dry_frames:,} 点 ({result.dry_duration_s:.3f} s) + "
            f"响应 {result.ir_frames_used:,} 点 + 预延迟 {result.predelay_frames:,} 点 "
            f"→ 共 {result.frames:,} 点 ({result.duration_s:.3f} s)"
        )
        if result.ir_sample_rate == result.dry_sample_rate:
            self._ir_used_note.setText(
                f"实际使用长度：{result.ir_frames_used:,} 点 / "
                f"{result.ir_used_duration_s:.3f} s（原始采样率相同，未重采样）"
            )
        else:
            self._ir_used_note.setText(
                f"实际使用长度：{result.ir_frames_used:,} 点 / "
                f"{result.ir_used_duration_s:.3f} s（已从 {result.ir_sample_rate} Hz "
                f"重采样到干声 {result.dry_sample_rate} Hz；原始 "
                f"{result.ir_frames_input:,} 点 / {result.ir_input_duration_s:.3f} s）"
            )
        self._update_playhead_label(self._cursor_frame)

    def _update_peak_readout(self, result: RenderResult | None) -> None:
        if result is None:
            for label in (
                self.dry_peak_label,
                self.raw_peak_label,
                self.out_peak_label,
                self.protect_label,
            ):
                label.setText("—")
            self.meter.set_level(-math.inf, "")
            self.overshoot_pill.set_status("等待计算", "muted")
            self.export_stereo_btn.setEnabled(False)
            self.export_mono_btn.setEnabled(False)
            return

        self.dry_peak_label.setText(db_text(result.dry_peak))
        self.raw_peak_label.setText(db_text(result.raw_peak))
        self.out_peak_label.setText(db_text(result.output_peak))
        if result.protection_active:
            self.protect_label.setText(f"{result.protection_gain_db:+.2f} dB")
        elif result.params.protection:
            self.protect_label.setText("未触发")
        else:
            self.protect_label.setText("关闭")
        self.meter.set_level(linear_to_db(result.output_peak), db_text(result.output_peak))
        if result.overshoot and not result.params.protection:
            self.overshoot_pill.set_status(
                "超幅！未保护输出会失真，请开启统一衰减或降低增益", "critical"
            )
        elif result.overshoot and result.params.protection:
            self.overshoot_pill.set_status(
                f"保护前超幅 {result.overshoot_db:+.1f} dBFS，已统一衰减 "
                f"{result.protection_gain_db:+.2f} dB",
                "warning",
            )
        else:
            self.overshoot_pill.set_status("未超幅，输出在 0 dBFS 以内", "good")
        can_export = self._result is not None and not self._rendering
        self.export_stereo_btn.setEnabled(can_export)
        self.export_mono_btn.setEnabled(can_export)

    def _update_transport_state(self) -> None:
        has_result = self._result is not None and not self._rendering
        for button in (self.play_all_btn, self.play_sel_btn, self.play_tail_btn):
            button.setEnabled(has_result)
        self.play_sel_btn.setEnabled(has_result and self._selection is not None)
        self.stop_btn.setEnabled(bool(self._player.active))
        self.export_stereo_btn.setEnabled(has_result)
        self.export_mono_btn.setEnabled(has_result)

    def _set_status(self, text: str, level: str) -> None:
        self.status_pill.set_status(text, level)

    # ------------------------------------------------------------- 播放
    def _current_monitor(self) -> np.ndarray | None:
        result = self._result
        if result is None:
            return None
        return result.samples if self._ab_mode == "wet" else result.dry_monitor

    def _play_range(self, start_frame: int, end_frame: int) -> None:
        result = self._result
        samples = self._current_monitor()
        if result is None or samples is None:
            return
        start = int(np.clip(start_frame, 0, result.frames))
        end = int(np.clip(end_frame, start, result.frames))
        if end <= start:
            return
        clip = slice_clip(samples, result.dry_sample_rate, start, end)
        self._last_range = (start, end)
        self._cursor_frame = start
        try:
            self._player.play(clip)
        except PlaybackUnavailable as exc:
            self._show_error("无法播放", str(exc))
            return
        except Exception as exc:  # 设备被占用等
            self._show_error("播放失败", f"{type(exc).__name__}: {exc}")
            return
        self.output_wave.set_playhead(start)
        self._playhead_timer.start()
        self.stop_btn.setEnabled(True)
        self._update_playhead_label(start)

    def _play_all(self) -> None:
        result = self._result
        if result is None:
            return
        self._play_range(0, result.frames)

    def _play_selection(self) -> None:
        if self._selection is None:
            self.selection_label.setText(
                "没有选区 · 在波形上横向拖动即可截取短区间（双击清除）"
            )
            return
        self._play_range(*self._selection)

    def _play_tail(self) -> None:
        result = self._result
        if result is None:
            return
        self._play_range(result.dry_end_frame, result.frames)

    def _stop_playback(self) -> None:
        # 停止前记下声卡实际消费到的位置，播放头停在"声音断开的地方"。
        position = self._player.position_frame() if self._player.clip is not None else None
        self._player.stop()
        self._playhead_timer.stop()
        if self._result is not None:
            if position is not None:
                self._cursor_frame = int(np.clip(position, 0, self._result.frames))
            cursor = int(np.clip(self._cursor_frame, 0, self._result.frames))
            self.output_wave.set_playhead(cursor)
            self._update_playhead_label(cursor)
        else:
            self.output_wave.set_playhead(None)
        self._update_transport_state()

    def _tick_playhead(self) -> None:
        result = self._result
        if result is None:
            self._playhead_timer.stop()
            return
        if not self._player.active:
            self._playhead_timer.stop()
            # 播完：播放头停在最后一个实际位置，不残留声音
            end = self._last_range[1] if self._last_range else self._cursor_frame
            self._cursor_frame = min(end, result.frames)
            self.output_wave.set_playhead(self._cursor_frame)
            self._update_playhead_label(self._cursor_frame)
            self._update_transport_state()
            return
        position = self._player.position_frame()
        self.output_wave.set_playhead(position)
        self._update_playhead_label(position)

    def _update_playhead_label(self, frame: int) -> None:
        result = self._result
        if result is None:
            self.playhead_label.setText("播放头 0.000 s")
            return
        self.playhead_label.setText(
            f"播放头 {frame / result.dry_sample_rate:.3f} s / {result.duration_s:.3f} s"
        )

    def _on_scrub_start(self) -> None:
        # 位置变化的第一时间切断旧声音，队列里不会残留上一段。
        self._resume_after_scrub = self._player.active
        self._stop_playback()

    def _on_scrub_finished(self) -> None:
        if not getattr(self, "_resume_after_scrub", False):
            return
        self._resume_after_scrub = False
        result = self._result
        if result is None:
            return
        end = self._last_range[1] if self._last_range else result.frames
        if self._cursor_frame < end:
            self._play_range(self._cursor_frame, end)

    def _on_seek(self, frame: int) -> None:
        result = self._result
        if result is None:
            return
        self._cursor_frame = int(np.clip(frame, 0, result.frames))
        self.output_wave.set_playhead(self._cursor_frame)
        self._update_playhead_label(self._cursor_frame)

    def _on_selection_changed(self, start: int, end: int) -> None:
        self._resume_after_scrub = False
        self._selection = (start, end)
        result = self._result
        if result is not None:
            self.selection_label.setText(
                f"选区 {start / result.dry_sample_rate:.3f} – "
                f"{end / result.dry_sample_rate:.3f} s "
                f"（{end - start:,} 点 / {(end - start) / result.dry_sample_rate:.3f} s）"
            )
        self._stop_playback()
        self._update_transport_state()

    def _on_selection_cleared(self) -> None:
        self._resume_after_scrub = False
        self._selection = None
        self.selection_label.setText("未选择区间 · 在波形上拖动可截取短区间，双击清除")
        self._update_transport_state()

    def _on_ab_changed(self, index: int) -> None:
        self._ab_mode = self.ab_combo.itemData(index)
        if self._player.active:
            if self._last_range is not None:
                self._play_range(*self._last_range)
            else:
                self._stop_playback()

    # ------------------------------------------------------------- 导出
    def _export(self, stereo: bool) -> None:
        result = self._result
        if result is None or self._rendering:
            self._show_error("无法导出", "当前没有与参数一致的计算结果，请等待计算完成。")
            return

        if result.overshoot and not result.params.protection:
            box = QMessageBox(self)
            box.setIcon(QMessageBox.Icon.Warning)
            box.setWindowTitle("未保护的超幅输出")
            box.setText(
                f"保护前峰值为 {result.overshoot_db:+.1f} dBFS，超过 0 dBFS。\n"
                "直接导出会在播放或转码时失真。"
            )
            box.setInformativeText(
                "建议先勾选“统一衰减保护”再导出；也可以继续导出 float32 wav"
                "（文件不会截断，但仍会有超幅）。"
            )
            keep = box.addButton("仍然导出", QMessageBox.ButtonRole.DestructiveRole)
            cancel = box.addButton("取消", QMessageBox.ButtonRole.RejectRole)
            box.setDefaultButton(cancel)
            box.exec()
            if box.clickedButton() is not keep:
                return

        samples = result.samples
        if not stereo:
            samples = np.mean(samples, axis=1, keepdims=True)
        channel_name = "立体声" if stereo else "单声道"
        default_name = (
            f"reverb_{result.dry_sample_rate // 1000}k_"
            f"{'stereo' if stereo else 'mono'}_mix{result.params.mix:.2f}.wav"
        )
        path, _ = QFileDialog.getSaveFileName(
            self, f"导出{channel_name} WAV", str(SAMPLE_DIR / default_name), "WAV (*.wav)"
        )
        if not path:
            return
        path_obj = Path(path)
        if path_obj.suffix.lower() != ".wav":
            path_obj = path_obj.with_suffix(".wav")
        try:
            write_wav(path_obj, samples, result.dry_sample_rate)
        except Exception as exc:
            self._show_error("导出失败", f"{type(exc).__name__}: {exc}")
            return
        self._show_readback(path_obj, result)

    def _show_readback(self, path: Path, result: RenderResult) -> None:
        import soundfile as sf

        try:
            data, sample_rate = sf.read(str(path), dtype="float64", always_2d=True)
        except Exception as exc:
            self._show_error("回读失败", f"{type(exc).__name__}: {exc}")
            return
        frames, channels = data.shape
        peak = float(np.max(np.abs(data))) if data.size else 0.0
        length_ok = frames == result.frames
        length_note = "与预览长度一致 ✓" if length_ok else f"与预览 {result.frames:,} 点不一致！"
        self.export_readback.setVisible(True)
        self.export_readback.info.setText(
            f"{path.name} · {sample_rate} Hz · {channels} 声道 · "
            f"{frames:,} 点 · {frames / sample_rate:.3f} s · 峰值 {db_text(peak)}"
            f" · {length_note}\n"
            f"导出参数：混响 {result.params.mix * 100:.0f}% · 预延迟 "
            f"{result.params.predelay_ms:.0f} ms · 增益 {result.params.output_gain_db:+.1f} dB · "
            f"保护 {'开' if result.params.protection else '关'}"
        )
        if channels == 1:
            self.export_readback.wave.set_audio(data[:, 0], sample_rate, [SERIES_L])
        else:
            self.export_readback.wave.set_audio(data, sample_rate, [SERIES_L, SERIES_R])
        self.export_readback.wave.set_markers(
            [
                Marker("干声终点", result.dry_end_frame, DRY_MARK, row=0),
                Marker("尾音终点", frames, TAIL_MARK, row=1),
            ]
        )
        self._export_last = (path, frames, channels)
        QMessageBox.information(
            self,
            "导出完成",
            f"{path}\n\n回读长度 {frames:,} 点（{frames / sample_rate:.3f} s）\n"
            f"回读峰值 {db_text(peak)}\n{length_note}",
        )

    def _show_error(self, title: str, message: str) -> None:
        QMessageBox.critical(self, title, message)

    # ------------------------------------------------------------- 生命周期
    def closeEvent(self, event: QEvent) -> None:
        self._param_timer.stop()
        self._playhead_timer.stop()
        self._player.stop()
        self._render_controller.shutdown()
        super().closeEvent(event)


def create_app(argv: list[str] | None = None) -> tuple[QApplication, MainWindow]:
    app = QApplication.instance() or QApplication(argv or [])
    app.setApplicationName(APP_TITLE)
    app.setStyle("Fusion")
    window = MainWindow()
    return app, window


def main() -> int:
    import sys

    app, window = create_app(sys.argv)
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
