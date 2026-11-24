from __future__ import annotations

import html
import json
from dataclasses import asdict
from pathlib import Path

import numpy as np
from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QAction, QCloseEvent, QColor, QKeySequence
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QDoubleSpinBox,
    QFileDialog,
    QFormLayout,
    QFrame,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QSplitter,
    QTableWidget,
    QTableWidgetItem,
    QTextBrowser,
    QVBoxLayout,
    QWidget,
)

from .analysis import AnalysisConfig, AnalysisResult, analyze_audio
from .audio_io import AudioData, load_wav
from .demo import CASE_LABELS, make_demo_audio
from .export import export_csv, export_json
from .models import (
    BAND_LOSS,
    CHANNEL_LOSS,
    KIND_COLORS,
    KIND_LABELS,
    QUIET,
    Annotation,
)
from .playback import PlaybackController
from .widgets import HeatmapWidget, RelationWidget, WaveformWidget


def fmt_db(value) -> str:
    if value is None:
        return "—"
    try:
        f = float(value)
        if not np.isfinite(f):
            return "—"
        return f"{f:.2f} dB"
    except Exception:
        return str(value)


class ManualAnnotationDialog(QDialog):
    def __init__(self, duration: float, bands: list, n_channels: int = 2, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("手工新增并确认区间")
        self.setMinimumWidth(390)
        form = QFormLayout(self)

        self.start_spin = QDoubleSpinBox()
        self.start_spin.setRange(0.0, duration)
        self.start_spin.setDecimals(3)
        self.start_spin.setSuffix(" s")
        self.end_spin = QDoubleSpinBox()
        self.end_spin.setRange(0.0, duration)
        self.end_spin.setDecimals(3)
        self.end_spin.setSuffix(" s")
        self.end_spin.setValue(min(0.5, duration))

        self.kind_combo = QComboBox()
        for key, label in KIND_LABELS.items():
            if key != "manual":
                self.kind_combo.addItem(label, key)
        self.channel_combo = QComboBox()
        self.channel_combo.addItem("全部声道", [])
        self.channel_combo.addItem("第 1 路", [0])
        if n_channels == 2:
            self.channel_combo.addItem("右/第 2 路", [1])

        self.band_combo = QComboBox()
        self.band_combo.addItem("全频（不指定频带）", None)
        for band in bands:
            self.band_combo.addItem(band.name, band.key)

        self.note_edit = QLineEdit()
        self.note_edit.setPlaceholderText("可填写人耳复核、扬声器编号等备注")

        form.addRow("开始", self.start_spin)
        form.addRow("结束", self.end_spin)
        form.addRow("类型", self.kind_combo)
        form.addRow("声道", self.channel_combo)
        form.addRow("频段", self.band_combo)
        form.addRow("备注", self.note_edit)

        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel)
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        form.addRow(buttons)

    def make_annotation(self) -> Annotation:
        start = float(self.start_spin.value())
        end = max(start + 0.02, float(self.end_spin.value()))
        kind = self.kind_combo.currentData()
        channels = list(self.channel_combo.currentData() or [])
        band_key = self.band_combo.currentData()
        bands = [band_key] if kind == BAND_LOSS and band_key else []
        return Annotation(
            start=start,
            end=end,
            kind=kind,
            channels=channels,
            bands=bands,
            status="confirmed",
            source="human",
            note=self.note_edit.text().strip(),
            metrics={"manual": True, "criteria": "人工框定并直接确认，未依赖自动阈值"},
        )


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("音频完整性观察台 · 只观察/标记/试听，不自动补音")
        self.resize(1480, 960)

        self.audio: AudioData | None = None
        self.result: AnalysisResult | None = None
        self.annotations: list[Annotation] = []
        self.selected_id: str | None = None
        self.reference_start = 0.0
        self.reference_end = 2.0
        self._loading_controls = False

        self.playback = PlaybackController(self)
        self.playback.positionChanged.connect(self._on_play_position)
        self.playback.playbackFinished.connect(self._on_play_finished)
        self.playback.error.connect(self._show_transient_error)

        self._debounce = QTimer(self)
        self._debounce.setSingleShot(True)
        self._debounce.setInterval(220)
        self._debounce.timeout.connect(self._reanalyze)

        self._status_base = "就绪"
        self._status_timer = QTimer(self)
        self._status_timer.setSingleShot(True)
        self._status_timer.timeout.connect(self._restore_status)

        self._build_ui()
        self._build_menus()
        self.load_demo("composite")

    # ------------------------------------------------------------------ UI
    def _build_ui(self) -> None:
        root = QWidget()
        self.setCentralWidget(root)
        outer = QVBoxLayout(root)
        outer.setContentsMargins(10, 10, 10, 10)
        outer.setSpacing(8)

        outer.addWidget(self._build_file_bar())

        splitter = QSplitter(Qt.Orientation.Horizontal)
        outer.addWidget(splitter, 1)

        charts = QSplitter(Qt.Orientation.Vertical)
        self.wave = WaveformWidget()
        self.heatmap = HeatmapWidget()
        self.relation = RelationWidget()
        for w in (self.wave, self.heatmap, self.relation):
            w.annotationSelected.connect(self.select_annotation)
            w.referenceDrawn.connect(self.set_reference_range)
            w.statusMessage.connect(lambda msg: self._set_status(msg, 3000))
        charts.addWidget(self._wrap_chart("① 录音波形与参考区（横向拖动可重划参考区）", self.wave))
        charts.addWidget(self._wrap_chart("② 各频带 × 时间能量（悬停可追数值）", self.heatmap))
        charts.addWidget(self._wrap_chart("③ 通道能量与关系", self.relation))
        charts.setStretchFactor(0, 3)
        charts.setStretchFactor(1, 4)
        charts.setStretchFactor(2, 2)
        charts.setSizes([230, 330, 190])
        splitter.addWidget(charts)

        side = QWidget()
        side_layout = QVBoxLayout(side)
        side_layout.setContentsMargins(0, 0, 0, 0)
        side_layout.setSpacing(8)
        side_layout.addWidget(self._build_playback_group())
        side_layout.addWidget(self._build_threshold_group())
        side_layout.addWidget(self._build_marker_group(), 2)
        side_layout.addWidget(self._build_detail_group(), 1)
        side.setMinimumWidth(470)
        side.setMaximumWidth(620)
        splitter.addWidget(side)
        splitter.setStretchFactor(0, 1)
        splitter.setStretchFactor(1, 0)
        splitter.setSizes([930, 550])

        self.status_label = QLabel("就绪")
        self.statusBar().addWidget(self.status_label, 1)
        self.partial_label = QLabel("")
        self.statusBar().addPermanentWidget(self.partial_label)

    def _wrap_chart(self, title: str, widget: QWidget) -> QGroupBox:
        box = QGroupBox(title)
        layout = QVBoxLayout(box)
        layout.setContentsMargins(6, 14, 6, 6)
        layout.addWidget(widget)
        return box

    def _build_file_bar(self) -> QWidget:
        bar = QFrame()
        lay = QHBoxLayout(bar)
        lay.setContentsMargins(8, 6, 8, 6)

        btn_import = QPushButton("导入 WAV")
        btn_import.setShortcut(QKeySequence.StandardKey.Open)
        btn_import.clicked.connect(self.import_wav)
        lay.addWidget(btn_import)

        lay.addWidget(QLabel("内置案例："))
        self.demo_combo = QComboBox()
        for key, label in CASE_LABELS.items():
            self.demo_combo.addItem(label, key)
        lay.addWidget(self.demo_combo, 1)
        btn_demo = QPushButton("载入案例")
        btn_demo.clicked.connect(lambda: self.load_demo(self.demo_combo.currentData()))
        lay.addWidget(btn_demo)

        lay.addSpacing(16)
        lay.addWidget(QLabel("参考区："))
        self.ref_start_spin = self._double_spin(0.0, 99999.0, 0.05, 0.0, " s", 3)
        self.ref_end_spin = self._double_spin(0.0, 99999.0, 0.05, 2.0, " s", 3)
        self.ref_start_spin.valueChanged.connect(self._reference_spin_changed)
        self.ref_end_spin.valueChanged.connect(self._reference_spin_changed)
        lay.addWidget(self.ref_start_spin)
        lay.addWidget(QLabel("→"))
        lay.addWidget(self.ref_end_spin)

        btn_manual = QPushButton("手工新增区间")
        btn_manual.clicked.connect(self.add_manual_annotation)
        lay.addWidget(btn_manual)

        btn_json = QPushButton("导出确认 JSON")
        btn_json.clicked.connect(self.export_confirmed_json)
        lay.addWidget(btn_json)
        btn_csv = QPushButton("导出 CSV")
        btn_csv.clicked.connect(self.export_confirmed_csv)
        lay.addWidget(btn_csv)
        return bar

    def _build_playback_group(self) -> QGroupBox:
        box = QGroupBox("④ 标记间跳转与对照试听（不修改音频）")
        v = QVBoxLayout(box)
        row1 = QHBoxLayout()
        self.prev_btn = QPushButton("← 上一标记并试听")
        self.prev_btn.clicked.connect(lambda: self.step_marker(-1, play=True))
        self.next_btn = QPushButton("下一标记并试听 →")
        self.next_btn.clicked.connect(lambda: self.step_marker(1, play=True))
        row1.addWidget(self.prev_btn)
        row1.addWidget(self.next_btn)
        v.addLayout(row1)

        row2 = QHBoxLayout()
        self.play_full_btn = QPushButton("全频试听同一区间")
        self.play_full_btn.clicked.connect(self.play_full)
        self.play_band_btn = QPushButton("指定频带试听同一区间")
        self.play_band_btn.clicked.connect(self.play_band)
        self.stop_btn = QPushButton("停止")
        self.stop_btn.clicked.connect(lambda: self.playback.stop())
        row2.addWidget(self.play_full_btn)
        row2.addWidget(self.play_band_btn)
        row2.addWidget(self.stop_btn)
        v.addLayout(row2)

        row3 = QHBoxLayout()
        row3.addWidget(QLabel("试听频带"))
        self.band_combo = QComboBox()
        self.band_combo.currentIndexChanged.connect(self._band_combo_changed)
        row3.addWidget(self.band_combo, 2)
        row3.addWidget(QLabel("声道"))
        self.channel_combo = QComboBox()
        self.channel_combo.addItem("按标记自动", "auto")
        self.channel_combo.addItem("全部", "all")
        self.channel_combo.addItem("左/第 1 路", "left")
        self.channel_combo.addItem("右/第 2 路", "right")
        row3.addWidget(self.channel_combo)
        self.loop_check = QCheckBox("循环")
        row3.addWidget(self.loop_check)
        v.addLayout(row3)

        self.play_interval_label = QLabel("尚未选择标记")
        self.play_interval_label.setStyleSheet("color: #52514e;")
        v.addWidget(self.play_interval_label)
        return box

    def _build_threshold_group(self) -> QGroupBox:
        box = QGroupBox("⑤ 阈值可调；重算只替换待确认标记，不动已确认项")
        form = QFormLayout(box)
        form.setLabelAlignment(Qt.AlignmentFlag.AlignRight)
        cfg = AnalysisConfig()
        self.spin_band = self._double_spin(4.0, 45.0, 0.5, cfg.band_drop_db, " dB")
        self.spin_channel = self._double_spin(8.0, 70.0, 0.5, cfg.channel_drop_db, " dB")
        self.spin_quiet = self._double_spin(-80.0, -18.0, 1.0, cfg.quiet_abs_db, " dBFS")
        self.spin_min_ms = self._double_spin(20.0, 1000.0, 10.0, cfg.min_event_ms, " ms", 0)
        self.spin_gap_ms = self._double_spin(0.0, 300.0, 5.0, cfg.merge_gap_ms, " ms", 0)
        for sp in (self.spin_band, self.spin_channel, self.spin_quiet, self.spin_min_ms, self.spin_gap_ms):
            sp.valueChanged.connect(self._schedule_reanalyze)
        form.addRow("频带突断：低于参考", self.spin_band)
        form.addRow("整路缺音：低于参考", self.spin_channel)
        form.addRow("安静：绝对 RMS 上限", self.spin_quiet)
        form.addRow("最短事件", self.spin_min_ms)
        form.addRow("合并小间隔", self.spin_gap_ms)

        row = QHBoxLayout()
        self.heat_mode_combo = QComboBox()
        self.heat_mode_combo.addItem("绝对能量", "absolute")
        self.heat_mode_combo.addItem("相对参考下降", "relative")
        self.heat_mode_combo.currentIndexChanged.connect(
            lambda: self.heatmap.set_display_mode(self.heat_mode_combo.currentData())
        )
        row.addWidget(QLabel("热图"))
        row.addWidget(self.heat_mode_combo)
        self.heat_channel_combo = QComboBox()
        self.heat_channel_combo.addItem("全部通道", -1)
        self.heat_channel_combo.addItem("第 1 路", 0)
        self.heat_channel_combo.addItem("第 2 路", 1)
        self.heat_channel_combo.currentIndexChanged.connect(
            lambda: self.heatmap.set_channel_filter(int(self.heat_channel_combo.currentData()))
        )
        row.addWidget(self.heat_channel_combo)
        wrap = QWidget()
        wrap.setLayout(row)
        form.addRow("显示", wrap)
        return box

    def _build_marker_group(self) -> QGroupBox:
        box = QGroupBox("标记列表（点击行或图上色块追踪数值）")
        v = QVBoxLayout(box)
        top = QHBoxLayout()
        self.filter_confirmed_check = QCheckBox("只看已确认")
        self.filter_confirmed_check.toggled.connect(self.refresh_table)
        top.addWidget(self.filter_confirmed_check)
        top.addStretch(1)
        self.count_label = QLabel("0 项")
        top.addWidget(self.count_label)
        v.addLayout(top)

        self.table = QTableWidget(0, 6)
        self.table.setHorizontalHeaderLabels(["状态", "时间", "类别", "声道", "频段", "关键实测值"])
        self.table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        self.table.setSelectionMode(QTableWidget.SelectionMode.SingleSelection)
        self.table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        self.table.verticalHeader().setVisible(False)
        header = self.table.horizontalHeader()
        header.setSectionResizeMode(QHeaderView.ResizeMode.Interactive)
        self.table.setColumnWidth(0, 76)
        self.table.setColumnWidth(1, 100)
        self.table.setColumnWidth(2, 82)
        self.table.setColumnWidth(3, 48)
        self.table.setColumnWidth(4, 62)
        header.setSectionResizeMode(5, QHeaderView.ResizeMode.Stretch)
        self.table.itemSelectionChanged.connect(self._table_selection_changed)
        v.addWidget(self.table, 1)

        actions = QHBoxLayout()
        self.confirm_btn = QPushButton("✓ 确认选中标记")
        self.confirm_btn.setStyleSheet("font-weight: 700;")
        self.confirm_btn.clicked.connect(self.confirm_selected)
        actions.addWidget(self.confirm_btn)
        self.unconfirm_btn = QPushButton("取消确认")
        self.unconfirm_btn.clicked.connect(self.unconfirm_selected)
        actions.addWidget(self.unconfirm_btn)
        self.copy_metrics_btn = QPushButton("复制数值 JSON")
        self.copy_metrics_btn.clicked.connect(self.copy_selected_metrics)
        actions.addWidget(self.copy_metrics_btn)
        v.addLayout(actions)

        note_row = QHBoxLayout()
        note_row.addWidget(QLabel("备注"))
        self.note_edit = QLineEdit()
        self.note_edit.setPlaceholderText("选中已确认项后可写备注，回车保存")
        self.note_edit.returnPressed.connect(self.save_selected_note)
        note_row.addWidget(self.note_edit, 1)
        save_note = QPushButton("保存备注")
        save_note.clicked.connect(self.save_selected_note)
        note_row.addWidget(save_note)
        v.addLayout(note_row)
        return box

    def _build_detail_group(self) -> QGroupBox:
        box = QGroupBox("判断依据 / 实际数值")
        layout = QVBoxLayout(box)
        self.detail = QTextBrowser()
        self.detail.setOpenExternalLinks(False)
        self.detail.setMinimumHeight(170)
        layout.addWidget(self.detail)
        return box

    def _build_menus(self) -> None:
        file_menu = self.menuBar().addMenu("文件")
        act_open = QAction("导入 WAV…", self)
        act_open.setShortcut(QKeySequence.StandardKey.Open)
        act_open.triggered.connect(self.import_wav)
        file_menu.addAction(act_open)

        act_json = QAction("导出人工确认 JSON…", self)
        act_json.triggered.connect(self.export_confirmed_json)
        file_menu.addAction(act_json)
        act_csv = QAction("导出人工确认 CSV…", self)
        act_csv.triggered.connect(self.export_confirmed_csv)
        file_menu.addAction(act_csv)

        case_menu = self.menuBar().addMenu("内置案例")
        for key, label in CASE_LABELS.items():
            act = QAction(label, self)
            act.triggered.connect(lambda checked=False, k=key: self.load_demo(k))
            case_menu.addAction(act)

        help_menu = self.menuBar().addMenu("帮助")
        about = QAction("说明", self)
        about.triggered.connect(self.show_about)
        help_menu.addAction(about)

    def _double_spin(self, minimum: float, maximum: float, step: float, value: float, suffix: str, decimals: int = 1) -> QDoubleSpinBox:
        sp = QDoubleSpinBox()
        sp.setRange(minimum, maximum)
        sp.setSingleStep(step)
        sp.setValue(value)
        sp.setSuffix(suffix)
        sp.setDecimals(decimals)
        sp.setKeyboardTracking(False)
        return sp

    # ------------------------------------------------------------ loading
    def import_wav(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "选择短 WAV", "", "WAV 音频 (*.wav *.wave)")
        if not path:
            return
        try:
            audio = load_wav(path)
        except Exception as exc:
            QMessageBox.critical(self, "WAV 读取失败", f"{path}\n\n{exc}")
            return
        self.load_audio(audio)
        self._set_status(f"已导入 {path}", 5000)

    def load_demo(self, case: str) -> None:
        try:
            audio = make_demo_audio(case)
        except Exception as exc:
            QMessageBox.critical(self, "内置案例生成失败", str(exc))
            return
        self.load_audio(audio)
        self._set_status(f"已载入内置案例：{CASE_LABELS.get(case, case)}", 5000)

    def load_audio(self, audio: AudioData) -> None:
        self.playback.stop(notify=False)
        self.audio = audio
        self.annotations = []
        self.selected_id = None
        self.reference_start = 0.0
        self.reference_end = min(2.0, audio.duration * 0.35)

        self._loading_controls = True
        self.ref_start_spin.setMaximum(audio.duration)
        self.ref_end_spin.setMaximum(audio.duration)
        self.ref_start_spin.setValue(self.reference_start)
        self.ref_end_spin.setValue(self.reference_end)
        if audio.n_channels == 1:
            self.heat_channel_combo.setCurrentIndex(0)
            self.heatmap.set_channel_filter(-1)
            self.heat_channel_combo.model().item(2).setEnabled(False)
        else:
            self.heat_channel_combo.model().item(2).setEnabled(True)
        self._loading_controls = False

        self.setWindowTitle(f"音频完整性观察台 · {Path(audio.path or '内置案例').name} · {audio.format_description}")
        self._reanalyze()

    # ------------------------------------------------------------ analysis
    def _schedule_reanalyze(self, *_args) -> None:
        if self.audio is None or self._loading_controls:
            return
        self._debounce.start()

    def _reference_spin_changed(self) -> None:
        if self._loading_controls or self.audio is None:
            return
        start = float(self.ref_start_spin.value())
        end = float(self.ref_end_spin.value())
        if end <= start:
            return
        self.reference_start = start
        self.reference_end = end
        self._reanalyze()

    def set_reference_range(self, start: float, end: float) -> None:
        if self.audio is None:
            return
        self.reference_start = max(0.0, start)
        self.reference_end = min(self.audio.duration, end)
        self._loading_controls = True
        self.ref_start_spin.setValue(self.reference_start)
        self.ref_end_spin.setValue(self.reference_end)
        self._loading_controls = False
        self._reanalyze()

    def _current_config(self) -> AnalysisConfig:
        return AnalysisConfig(
            band_drop_db=float(self.spin_band.value()),
            channel_drop_db=float(self.spin_channel.value()),
            quiet_abs_db=float(self.spin_quiet.value()),
            min_event_ms=float(self.spin_min_ms.value()),
            merge_gap_ms=float(self.spin_gap_ms.value()),
        )

    def _reanalyze(self) -> None:
        if self.audio is None:
            return
        try:
            cfg = self._current_config()
            self.result = analyze_audio(
                self.audio.samples,
                self.audio.sample_rate,
                cfg,
                reference_start=self.reference_start,
                reference_end=self.reference_end,
            )
        except Exception as exc:
            QMessageBox.critical(self, "分析失败", str(exc))
            return

        self.reference_start = self.result.reference.start
        self.reference_end = self.result.reference.end
        self._loading_controls = True
        self.ref_start_spin.setValue(self.reference_start)
        self.ref_end_spin.setValue(self.reference_end)
        self._loading_controls = False

        # Critical invariant: parameter/reference changes replace only the
        # auto-generated suggestions; human-confirmed objects are retained.
        confirmed = [a for a in self.annotations if a.status == "confirmed"]
        self.annotations = sorted(
            list(self.result.annotations) + confirmed,
            key=lambda a: (a.start, a.end, a.kind),
        )
        if self.selected_id and not any(a.id == self.selected_id for a in self.annotations):
            self.selected_id = None

        self._populate_band_combo()
        self.refresh_table()
        self.refresh_views()
        self.refresh_detail()
        self.refresh_status()

    def _populate_band_combo(self) -> None:
        if self.result is None:
            return
        current_key = self.band_combo.currentData()
        self.band_combo.blockSignals(True)
        self.band_combo.clear()
        for band in self.result.bands:
            self.band_combo.addItem(band.name, (band.key, band.low_hz, band.high_hz))
        idx = self.band_combo.findData(current_key)
        if idx >= 0:
            self.band_combo.setCurrentIndex(idx)
        self.band_combo.blockSignals(False)

    def _set_status(self, message: str, timeout_ms: int = 0) -> None:
        self.status_label.setText(message)
        self._status_timer.stop()
        if timeout_ms > 0:
            self._status_timer.start(timeout_ms)
        else:
            self._status_base = message

    def _restore_status(self) -> None:
        self.status_label.setText(self._status_base)

    def refresh_status(self) -> None:
        if self.audio is None or self.result is None:
            return
        suggested = sum(a.status != "confirmed" for a in self.annotations)
        confirmed = sum(a.status == "confirmed" for a in self.annotations)
        self._set_status(
            f"{self.audio.n_channels} 声道 · {self.audio.sample_rate} Hz · {self.audio.duration:.2f}s · "
            f"待确认 {suggested} · 已确认 {confirmed} · {self.result.reference.warning or '参考区基线有效'}"
        )
        partial = self.result.partial_frame_indices
        if partial.size:
            last_i = int(partial[-1])
            first_i = int(partial[0])
            expected = int(round(self.result.config.window_ms / 1000 * self.audio.sample_rate))
            if partial.size == 1:
                text = f"⚠ 尾窗 {int(self.result.valid_samples[last_i])}/{expected}（斜纹）"
            else:
                text = f"⚠ {partial.size} 个尾窗，最短 {int(self.result.valid_samples[last_i])}/{expected}（斜纹）"
            self.partial_label.setText(text)
            self.partial_label.setToolTip(
                f"短窗区起点 {self.result.frame_starts[first_i] / self.audio.sample_rate:.6f} 秒；"
                f"最后一窗起点 {self.result.frame_starts[last_i] / self.audio.sample_rate:.6f} 秒"
            )
        else:
            self.partial_label.setText("结尾分析窗完整")

    def refresh_views(self) -> None:
        if self.audio is None:
            return
        for w in (self.wave, self.heatmap, self.relation):
            w.set_context(
                audio=self.audio,
                result=self.result,
                annotations=self.annotations,
                selected_id=self.selected_id,
                reference_start=self.reference_start,
                reference_end=self.reference_end,
                playhead=getattr(w, "playhead", None),
            )

    # ------------------------------------------------------------ markers
    def _visible_annotations(self) -> list[Annotation]:
        anns = sorted(self.annotations, key=lambda a: (a.start, a.end))
        if self.filter_confirmed_check.isChecked():
            anns = [a for a in anns if a.status == "confirmed"]
        return anns

    def refresh_table(self) -> None:
        if not hasattr(self, "table"):
            return
        anns = self._visible_annotations()
        self.table.blockSignals(True)
        self.table.setRowCount(len(anns))
        selected_row = -1
        for row, ann in enumerate(anns):
            status = "✓ 已确认" if ann.is_confirmed else "○ 待确认"
            values = [
                status,
                ann.time_text(),
                KIND_LABELS.get(ann.kind, ann.kind),
                self._channel_text(ann.channels),
                self._band_text(ann.bands, short=True),
                self._metric_summary(ann),
            ]
            for col, value in enumerate(values):
                item = QTableWidgetItem(value)
                if col == 0:
                    item.setData(Qt.ItemDataRole.UserRole, ann.id)
                if col == 4:
                    item.setToolTip(self._band_text(ann.bands))
                elif col == 5:
                    item.setToolTip(value)
                if ann.is_confirmed:
                    item.setBackground(QColor(12, 163, 12, 28))
                elif col == 2:
                    item.setForeground(QColor(KIND_COLORS.get(ann.kind, "#374151")))
                self.table.setItem(row, col, item)
            if ann.id == self.selected_id:
                selected_row = row
        if selected_row >= 0:
            self.table.selectRow(selected_row)
        self.table.blockSignals(False)
        self.count_label.setText(f"{len(anns)} / 共 {len(self.annotations)} 项")

    def _channel_text(self, channels: list[int]) -> str:
        if not channels:
            return "全部"
        if self.audio and self.audio.n_channels == 1:
            return "单声道"
        return "/".join("左" if c == 0 else "右" for c in channels)

    def _band_text(self, keys: list[str], short: bool = False) -> str:
        if not keys or self.result is None:
            return "全频"
        names = []
        for key in keys:
            band = next((b for b in self.result.bands if b.key == key), None)
            name = band.name if band else key
            names.append(name.split()[0] if short else name)
        return "、".join(names)

    def _metric_summary(self, ann: Annotation) -> str:
        m = ann.metrics

        def num(key: str) -> str:
            value = m.get(key)
            if value is None:
                return "—"
            try:
                return f"{float(value):.1f}"
            except (TypeError, ValueError):
                return str(value)

        if ann.kind == BAND_LOSS:
            return f"降 {num('band_drop_db')} dB · 实测 {num('observed_band_db')} / 基线 {num('reference_band_db')}"
        if ann.kind == CHANNEL_LOSS:
            other = m.get("other_channel_rms_db")
            other_text = f" · 另路 {num('other_channel_rms_db')}" if other is not None else ""
            return f"降 {num('rms_drop_db')} dB · 本路 {num('observed_rms_db')}{other_text}"
        if ann.kind == QUIET:
            vals = m.get("rms_db_by_channel") or []
            return "RMS " + "/".join(
                "—" if v is None else f"{float(v):.1f}" for v in vals
            ) + " dB，全声道同低"
        return str(m.get("criteria", "人工标记"))

    def _table_selection_changed(self) -> None:
        rows = self.table.selectionModel().selectedRows()
        if not rows:
            return
        item = self.table.item(rows[0].row(), 0)
        if item is None:
            return
        marker_id = item.data(Qt.ItemDataRole.UserRole)
        if marker_id and marker_id != self.selected_id:
            self.select_annotation(marker_id, sync_table=False)

    def select_annotation(self, marker_id: str, sync_table: bool = True) -> None:
        ann = next((a for a in self.annotations if a.id == marker_id), None)
        if ann is None:
            return
        self.selected_id = marker_id
        for w in (self.wave, self.heatmap, self.relation):
            w.selected_id = marker_id
            w.update()
        if sync_table:
            anns = self._visible_annotations()
            if self.filter_confirmed_check.isChecked() and not ann.is_confirmed:
                self.filter_confirmed_check.setChecked(False)
                anns = self._visible_annotations()
            for row, item_ann in enumerate(anns):
                if item_ann.id == marker_id:
                    self.table.selectRow(row)
                    break
        self.refresh_detail()
        self._select_band_for_annotation(ann)
        mode = "自动（按标记）"
        self.play_interval_label.setText(
            f"当前区间 {ann.time_text()} · {KIND_LABELS.get(ann.kind, ann.kind)} · {self._channel_text(ann.channels)}"
        )

    def _select_band_for_annotation(self, ann: Annotation) -> None:
        if not ann.bands:
            return
        key = ann.bands[0]
        for i in range(self.band_combo.count()):
            data = self.band_combo.itemData(i)
            if data and data[0] == key:
                self.band_combo.setCurrentIndex(i)
                break

    def _selected_annotation(self) -> Annotation | None:
        if self.selected_id is None:
            return None
        return next((a for a in self.annotations if a.id == self.selected_id), None)

    def step_marker(self, delta: int, play: bool = True) -> None:
        anns = self._visible_annotations()
        if not anns:
            self._set_status("当前没有可跳转标记", 2500)
            return
        if self.selected_id is None:
            idx = 0 if delta > 0 else len(anns) - 1
        else:
            current = next((i for i, a in enumerate(anns) if a.id == self.selected_id), None)
            if current is None:
                idx = 0 if delta > 0 else len(anns) - 1
            else:
                idx = (current + delta) % len(anns)
        ann = anns[idx]
        self.select_annotation(ann.id)
        if play:
            self.play_full()

    def confirm_selected(self) -> None:
        ann = self._selected_annotation()
        if ann is None:
            QMessageBox.information(self, "未选择标记", "请先在表格或图上选择一个标记。")
            return
        ann.status = "confirmed"
        ann.source = "human"
        self.refresh_table()
        self.refresh_views()
        self.refresh_detail()
        self.refresh_status()
        self._set_status(f"已人工确认 {ann.time_text()}；之后调阈值不会覆盖它", 4000)

    def unconfirm_selected(self) -> None:
        ann = self._selected_annotation()
        if ann is None:
            return
        ann.status = "suggested"
        ann.source = "auto"
        self.refresh_table()
        self.refresh_views()
        self.refresh_detail()
        self.refresh_status()

    def save_selected_note(self) -> None:
        ann = self._selected_annotation()
        if ann is None:
            return
        ann.note = self.note_edit.text().strip()
        self.refresh_detail()
        self._set_status("备注已保存到当前会话与导出 JSON", 2500)

    def copy_selected_metrics(self) -> None:
        ann = self._selected_annotation()
        if ann is None:
            return
        QApplication.clipboard().setText(json.dumps(ann.to_dict(), ensure_ascii=False, indent=2))
        self._set_status("已复制该标记的完整判断数值", 2500)

    def add_manual_annotation(self) -> None:
        if self.audio is None or self.result is None:
            QMessageBox.information(self, "没有音频", "请先导入 WAV 或载入内置案例。")
            return
        dlg = ManualAnnotationDialog(self.audio.duration, self.result.bands, self.audio.n_channels, self)
        if dlg.exec() != QDialog.DialogCode.Accepted:
            return
        ann = dlg.make_annotation()
        self.annotations.append(ann)
        self.filter_confirmed_check.setChecked(False)
        self.selected_id = ann.id
        self.refresh_table()
        self.refresh_views()
        self.refresh_detail()
        self.refresh_status()
        self._set_status("已新增并确认人工区间", 3000)

    # ------------------------------------------------------------ detail
    def refresh_detail(self) -> None:
        if not hasattr(self, "detail"):
            return
        ann = self._selected_annotation()
        if ann is None:
            self.detail.setHtml("<p style='color:#52514e'>选择一个标记后，这里会显示参考值、实测值、阈值、代表帧和声道关系。</p>")
            self.note_edit.setText("")
            return
        self.note_edit.setText(ann.note)
        m = ann.metrics
        rows = "".join(
            f"<tr><td style='color:#52514e;padding:1px 10px 1px 0'>{html.escape(str(k))}</td>"
            f"<td style='font-family:ui-monospace,Menlo,monospace'>{html.escape(json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else str(v))}</td></tr>"
            for k, v in m.items()
            if k != "criteria"
        )
        frame_table = self._frame_evidence_html(ann)
        sample0, sample1 = (0, 0)
        sr = self.audio.sample_rate if self.audio else 0
        if sr:
            sample0, sample1 = int(round(ann.start * sr)), int(round(ann.end * sr))
        self.detail.setHtml(
            f"""
            <div style='font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:13px'>
              <h3 style='margin:0 0 4px 0;color:{KIND_COLORS.get(ann.kind, "#111")}'>
                {'✓ ' if ann.is_confirmed else ''}{html.escape(ann.label)}
              </h3>
              <p style='margin:2px 0'>{ann.time_text()} · 采样 {sample0}–{sample1} ·
              {self._channel_text(ann.channels)} · {self._band_text(ann.bands)} ·
              状态 {('已人工确认' if ann.is_confirmed else '待确认')}</p>
              <p style='background:#f8fafc;border-left:3px solid {KIND_COLORS.get(ann.kind, "#64748b")};padding:6px;margin:6px 0'>
                {html.escape(str(m.get('criteria', '人工标记')))}
              </p>
              <table>{rows}</table>
              {frame_table}
            </div>
            """
        )

    def _frame_evidence_html(self, ann: Annotation) -> str:
        if self.result is None:
            return ""
        decision = ann.metrics.get("decision_frame")
        if not isinstance(decision, int):
            return ""
        lines = ["<h4 style='margin:8px 0 4px'>代表帧附近原始计算值</h4><table border='1' cellspacing='0' cellpadding='3' style='border-collapse:collapse;font-family:ui-monospace,Menlo,monospace;font-size:11px'>"]
        lines.append("<tr><th>帧</th><th>时间</th><th>完整</th><th>RMS dB/声道</th><th>目标频带 dB</th><th>相关</th></tr>")
        bi = None
        if ann.bands:
            bi = next((i for i, b in enumerate(self.result.bands) if b.key == ann.bands[0]), None)
        for i in range(max(0, decision - 2), min(self.result.n_frames, decision + 3)):
            rms = "/".join(f"{v:.1f}" for v in self.result.rms_db[i])
            band = "—"
            if bi is not None:
                band = "/".join(f"{v:.1f}" for v in self.result.band_db[i, :, bi])
            corr = self.result.correlation[i]
            corr_text = "NaN" if not np.isfinite(corr) else f"{corr:.2f}"
            current = " style='background:#fef3c7;font-weight:bold'" if i == decision else ""
            complete = "是" if self.result.complete[i] else "<b style='color:#b45309'>短窗</b>"
            lines.append(
                f"<tr{current}><td>{i}</td><td>{self.result.centers[i]:.4f}</td><td>{complete}</td>"
                f"<td>{rms}</td><td>{band}</td><td>{corr_text}</td></tr>"
            )
        lines.append("</table>")
        return "".join(lines)

    # ------------------------------------------------------------ playback
    def _band_request(self, ann: Annotation | None = None) -> tuple[str, float, float] | None:
        data = self.band_combo.currentData()
        if ann is not None and ann.bands:
            self._select_band_for_annotation(ann)
            data = self.band_combo.currentData()
        if not data:
            return None
        key, low, high = data
        return key, float(low), float(high)

    def _channel_mode(self, ann: Annotation) -> str:
        mode = self.channel_combo.currentData()
        if mode != "auto":
            return mode
        if len(ann.channels) == 1 and self.audio is not None and self.audio.n_channels == 2:
            return "left" if ann.channels[0] == 0 else "right"
        return "all"

    def play_full(self) -> None:
        ann = self._selected_annotation()
        if not self._require_playable(ann):
            return
        assert self.audio is not None and ann is not None
        self.playback.play_interval(
            self.audio, ann.start, ann.end,
            band=None,
            channel_mode=self._channel_mode(ann),
            loop=self.loop_check.isChecked(),
        )

    def play_band(self) -> None:
        ann = self._selected_annotation()
        if not self._require_playable(ann):
            return
        assert self.audio is not None and ann is not None
        band_info = self._band_request(ann)
        if band_info is None:
            QMessageBox.information(self, "没有可用频带", "请先选择指定频带。")
            return
        key, low, high = band_info
        self.playback.play_interval(
            self.audio, ann.start, ann.end,
            band=(low, high),
            channel_mode=self._channel_mode(ann),
            loop=self.loop_check.isChecked(),
        )
        self._set_status(f"频带试听：{low:.0f}–{high:.0f}Hz；与全频使用相同起止 {ann.time_text()}", 4000)

    def _require_playable(self, ann: Annotation | None) -> bool:
        if self.audio is None:
            QMessageBox.information(self, "没有音频", "请先导入 WAV 或载入内置案例。")
            return False
        if ann is None:
            QMessageBox.information(self, "没有选择标记", "请先选择或跳转一个标记，两种试听会严格使用同一区间。")
            return False
        return True

    def _on_play_position(self, t: float) -> None:
        for w in (self.wave, self.heatmap, self.relation):
            w.playhead = t
            w.update()

    def _on_play_finished(self) -> None:
        for w in (self.wave, self.heatmap, self.relation):
            w.playhead = None
            w.update()

    def _show_transient_error(self, message: str) -> None:
        self._set_status(message, 8000)
        QMessageBox.warning(self, "试听不可用", message)

    def _band_combo_changed(self) -> None:
        # Intentional no-op: band is read when play_band is clicked, allowing
        # quick switching without restarting hidden state.
        return None

    # ------------------------------------------------------------ export
    def _default_export_stem(self, suffix: str) -> Path:
        if self.audio and self.audio.path and not str(self.audio.path).startswith("<"):
            base = Path(self.audio.path)
            return base.with_name(base.stem + suffix)
        return Path.cwd() / f"audio_integrity{suffix}"

    def export_confirmed_json(self) -> None:
        if self.audio is None or self.result is None:
            return
        confirmed = [a for a in self.annotations if a.status == "confirmed"]
        if not confirmed:
            QMessageBox.information(self, "没有人工确认项", "请先在列表中确认区间，或手工新增确认区间。")
            return
        path, _ = QFileDialog.getSaveFileName(
            self, "导出人工确认区间 JSON", str(self._default_export_stem(".confirmed.json")), "JSON (*.json)"
        )
        if not path:
            return
        reference = {
            "start_seconds": self.result.reference.start,
            "end_seconds": self.result.reference.end,
            "warning": self.result.reference.warning,
            "rms_db_by_channel": self.result.reference.rms_db.tolist(),
            "band_db_by_channel_band": self.result.reference.band_db.tolist(),
            "median_cross_channel_correlation": self.result.reference.correlation,
        }
        out = export_json(
            path,
            self.annotations,
            audio_path=self.audio.path,
            sample_rate=self.audio.sample_rate,
            n_channels=self.audio.n_channels,
            duration=self.audio.duration,
            analysis_config=self.result.config.as_dict(),
            bands=[asdict(b) for b in self.result.bands],
            reference=reference,
        )
        self._set_status(f"已导出 {len(confirmed)} 条人工确认：{out}", 8000)
        QMessageBox.information(self, "导出完成", f"已导出 {len(confirmed)} 条人工确认区间：\n{out}")

    def export_confirmed_csv(self) -> None:
        if self.audio is None:
            return
        confirmed = [a for a in self.annotations if a.status == "confirmed"]
        if not confirmed:
            QMessageBox.information(self, "没有人工确认项", "请先确认至少一个区间。")
            return
        path, _ = QFileDialog.getSaveFileName(
            self, "导出人工确认区间 CSV", str(self._default_export_stem(".confirmed.csv")), "CSV (*.csv)"
        )
        if not path:
            return
        out = export_csv(path, self.annotations, sample_rate=self.audio.sample_rate)
        self._set_status(f"已导出 CSV：{out}", 8000)

    def show_about(self) -> None:
        QMessageBox.about(
            self,
            "音频完整性观察台",
            "面向不同扬声器录音的本地完整性观察工具。\n\n"
            "• WAV 读取、参考频带基线、频带能量热图和通道关系\n"
            "• 频带突断 / 整路缺音 / 正常安静三类标记\n"
            "• 阈值可调，标记保留代表帧的实测值与阈值\n"
            "• 全频和指定频带在完全相同的起止时间试听\n"
            "• 只导出人工确认结果，不做自动补音或修复\n\n"
            "结尾不足一个完整分析窗的帧会以斜纹和状态条明确标出。",
        )

    def closeEvent(self, event: QCloseEvent) -> None:  # noqa: N802
        try:
            self.playback.stop(notify=False)
        finally:
            super().closeEvent(event)


def run() -> int:
    import sys

    app = QApplication.instance() or QApplication(sys.argv)
    app.setApplicationName("音频完整性观察台")
    win = MainWindow()
    win.show()
    return app.exec()
