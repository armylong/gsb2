"""Main window for the interview loudness matcher.

Layout

    [ clip table / results ]   [ waveform for the selected clip        ]
                               [ selection + region controls           ]
                               [ lock / peak / target / audition       ]
                               [ provenance, warnings, render check    ]

The table is the clip list and the results view at once; selecting a row
selects the clip drawn on the right.
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QAction, QColor, QFont, QKeySequence
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
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QSplitter,
    QTableWidget,
    QTableWidgetItem,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from .. import samples
from ..audio_io import AudioLoadError, load_audio
from ..engine import (
    ExportRecord,
    MatchOutcome,
    evaluate,
    export_all,
)
from ..levels import (
    Interval,
    Region,
    measure_selection,
    selection_provenance_text,
    summarize_warning,
)
from ..matching import (
    PEAK_MODE_HEADROOM,
    PEAK_MODE_LIMITER,
    verify_render,
)
from ..playback import AudioPlayer, PlaybackRequest, audio_available
from ..project import ClipState, Project

COLOR_OK = QColor("#7fd1ae")
COLOR_WARN = QColor("#ffb14d")
COLOR_ERROR = QColor("#ff7b72")
COLOR_MUTED = QColor("#8b98a9")
COLOR_LOCKED = QColor("#9cc7ff")

FADE_SECONDS = 0.006


class MainWindow(QMainWindow):
    """The whole application state lives here; the engine modules stay UI-free."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("采访响度匹配 · Interview Loudness Matcher")
        self.resize(1320, 880)
        self.setMinimumSize(1080, 720)

        self.project = Project()
        self._audio: dict[str, np.ndarray] = {}
        self._rendered: dict[str, np.ndarray] = {}
        self._outcome: MatchOutcome | None = None
        self._current_clip_id: str | None = None
        self._detail_clip_id: str | None = None
        self._updating = False

        self.player = AudioPlayer(self)
        self.player.failed.connect(self._on_playback_failed)
        self.player.started.connect(
            lambda label: self._set_status(f"正在试听: {label}")
        )

        self._build_actions()
        self._build_ui()
        self._set_status(
            "就绪。导入音频或使用「文件 → 生成样例音频」。"
            + ("" if audio_available() else "（当前环境无音频输出，测量与导出仍可用）")
        )
        self._update_controls()

    # ------------------------------------------------------------------ setup

    def _build_actions(self) -> None:
        file_menu = self.menuBar().addMenu("文件(&F)")

        import_action = QAction("导入音频…", self)
        import_action.setShortcut(QKeySequence.StandardKey.Open)
        import_action.triggered.connect(self.import_audio_dialog)
        file_menu.addAction(import_action)

        demo_action = QAction("生成样例音频", self)
        demo_action.triggered.connect(self.load_generated_samples)
        file_menu.addAction(demo_action)

        file_menu.addSeparator()

        open_project = QAction("打开项目…", self)
        open_project.setShortcut(QKeySequence("Ctrl+Shift+O"))
        open_project.triggered.connect(self.open_project_dialog)
        file_menu.addAction(open_project)

        save_project = QAction("保存项目", self)
        save_project.setShortcut(QKeySequence.StandardKey.Save)
        save_project.triggered.connect(self.save_project)
        file_menu.addAction(save_project)

        save_as = QAction("项目另存为…", self)
        save_as.triggered.connect(self.save_project_as_dialog)
        file_menu.addAction(save_as)

        file_menu.addSeparator()

        export_action = QAction("导出全部匹配音频与报告…", self)
        export_action.setShortcut(QKeySequence("Ctrl+E"))
        export_action.triggered.connect(self.export_dialog)
        file_menu.addAction(export_action)

        recheck_action = QAction("用成品重新测量", self)
        recheck_action.triggered.connect(self.recheck_outputs)
        file_menu.addAction(recheck_action)

        file_menu.addSeparator()
        quit_action = QAction("退出", self)
        quit_action.setShortcut(QKeySequence.StandardKey.Quit)
        quit_action.triggered.connect(self.close)
        file_menu.addAction(quit_action)

        help_menu = self.menuBar().addMenu("帮助(&H)")
        about_action = QAction("关于 / 测量说明", self)
        about_action.triggered.connect(self.show_about)
        help_menu.addAction(about_action)

        play_action = QAction("试听当前选区", self)
        play_action.setShortcut(QKeySequence(Qt.Key.Key_Space))
        play_action.triggered.connect(self.play_current_selection)
        self.addAction(play_action)

    def _build_ui(self) -> None:
        central = QWidget(self)
        self.setCentralWidget(central)
        outer = QVBoxLayout(central)
        outer.setContentsMargins(10, 8, 10, 8)

        splitter = QSplitter(Qt.Orientation.Horizontal, central)
        outer.addWidget(splitter, 1)
        splitter.addWidget(self._build_left_panel())
        splitter.addWidget(self._build_right_panel())
        splitter.setStretchFactor(0, 4)
        splitter.setStretchFactor(1, 7)
        splitter.setSizes([520, 800])

        self.statusBar().showMessage("就绪")

    def _build_left_panel(self) -> QWidget:
        panel = QWidget(self)
        layout = QVBoxLayout(panel)
        layout.setContentsMargins(0, 0, 8, 0)

        buttons = QHBoxLayout()
        self.import_button = QPushButton("导入音频…")
        self.import_button.clicked.connect(self.import_audio_dialog)
        buttons.addWidget(self.import_button)
        self.demo_button = QPushButton("生成样例")
        self.demo_button.setToolTip(
            "在临时目录生成 5 段带首尾静音、不同峰均差的采访样例（含近满刻度敲击）"
        )
        self.demo_button.clicked.connect(self.load_generated_samples)
        buttons.addWidget(self.demo_button)
        self.remove_button = QPushButton("移除")
        self.remove_button.clicked.connect(self.remove_current_clip)
        buttons.addWidget(self.remove_button)
        layout.addLayout(buttons)

        reference_row = QHBoxLayout()
        self.reference_label = QLabel("参考段: —")
        self.reference_label.setWordWrap(True)
        reference_row.addWidget(self.reference_label, 1)
        self.set_reference_button = QPushButton("设为参考")
        self.set_reference_button.clicked.connect(self.set_current_as_reference)
        reference_row.addWidget(self.set_reference_button)
        layout.addLayout(reference_row)

        self.table = QTableWidget(0, 8, panel)
        self.table.setHorizontalHeaderLabels(
            ["文件", "参考", "锁", "有效", "实测 RMS", "峰值", "增益", "状态"]
        )
        self.table.verticalHeader().setVisible(False)
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.table.setAlternatingRowColors(True)
        header = self.table.horizontalHeader()
        header.setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        for column, width in ((1, 42), (2, 36), (3, 74), (4, 86), (5, 78), (6, 74), (7, 190)):
            self.table.setColumnWidth(column, width)
            header.setSectionResizeMode(column, QHeaderView.ResizeMode.Interactive)
        self.table.itemSelectionChanged.connect(self._on_table_selection)
        layout.addWidget(self.table, 1)

        target_box = QGroupBox("统一目标", panel)
        target_layout = QFormLayout(target_box)
        target_layout.setContentsMargins(8, 6, 8, 6)
        row = QHBoxLayout()
        self.follow_reference = QCheckBox("跟随参考段实测")
        self.follow_reference.setChecked(True)
        self.follow_reference.toggled.connect(self._on_follow_reference_toggled)
        row.addWidget(self.follow_reference)
        self.target_spin = QDoubleSpinBox(target_box)
        self.target_spin.setRange(-60.0, -3.0)
        self.target_spin.setDecimals(2)
        self.target_spin.setSingleStep(0.5)
        self.target_spin.setSuffix(" dBFS")
        self.target_spin.setValue(-20.0)
        self.target_spin.valueChanged.connect(self._on_target_edited)
        row.addWidget(self.target_spin, 1)
        self.match_button = QPushButton("重新匹配")
        self.match_button.clicked.connect(self.rematch_all)
        row.addWidget(self.match_button)
        target_layout.addRow(row)

        self.target_hint = QLabel("目标 = 参考段实测有效语音 RMS")
        self.target_hint.setWordWrap(True)
        self.target_hint.setStyleSheet("color: #8b98a9")
        target_layout.addRow(self.target_hint)

        suggestion_row = QHBoxLayout()
        self.suggestion_label = QLabel("")
        self.suggestion_label.setWordWrap(True)
        self.suggestion_label.setStyleSheet("color: #ffb14d")
        suggestion_row.addWidget(self.suggestion_label, 1)
        self.apply_suggestion_button = QPushButton("降到可达目标")
        self.apply_suggestion_button.setVisible(False)
        self.apply_suggestion_button.clicked.connect(self.apply_suggested_target)
        suggestion_row.addWidget(self.apply_suggestion_button)
        target_layout.addRow(suggestion_row)
        layout.addWidget(target_box)

        self.log = QTextEdit(panel)
        self.log.setReadOnly(True)
        self.log.setMinimumHeight(120)
        self.log.setPlaceholderText("匹配记录、峰值限制时间区间、成品复测结果会显示在这里")
        layout.addWidget(self.log, 1)
        return panel

    def _build_right_panel(self) -> QWidget:
        panel = QWidget(self)
        layout = QVBoxLayout(panel)
        layout.setContentsMargins(0, 0, 0, 0)

        self.wave_title = QLabel("未选择片段")
        title_font = QFont(self.font())
        title_font.setPointSize(title_font.pointSize() + 1)
        title_font.setBold(True)
        self.wave_title.setFont(title_font)
        layout.addWidget(self.wave_title)

        self.waveform = WaveformPanel(self)
        self.waveform.selectionChanged.connect(self._on_selection_changed)
        self.waveform.positionClicked.connect(self._on_position_clicked)
        self.waveform.regionDoubleClicked.connect(self._on_region_double_clicked)
        layout.addWidget(self.waveform, 3)

        selection_box = QGroupBox("选区（拖拽波形可精确划选）")
        selection_layout = QVBoxLayout(selection_box)
        selection_layout.setContentsMargins(8, 6, 8, 6)
        numbers = QHBoxLayout()
        self.sel_start = _seconds_spin(selection_box)
        self.sel_end = _seconds_spin(selection_box)
        numbers.addWidget(QLabel("起"))
        numbers.addWidget(self.sel_start)
        numbers.addWidget(QLabel("止"))
        numbers.addWidget(self.sel_end)
        numbers.addSpacing(8)
        self.sel_duration = QLabel("0.00 s")
        self.sel_duration.setStyleSheet("color: #8b98a9")
        numbers.addWidget(self.sel_duration)
        numbers.addStretch(1)
        selection_layout.addLayout(numbers)

        region_buttons = QHBoxLayout()
        self.add_speech_button = QPushButton("+ 讲话区")
        self.add_speech_button.setToolTip("把当前选区标为要计入电平的讲话区间（可多个）")
        self.add_speech_button.clicked.connect(lambda: self.add_region("speech"))
        region_buttons.addWidget(self.add_speech_button)
        self.add_exclude_button = QPushButton("+ 排除区")
        self.add_exclude_button.setToolTip(
            "把当前选区标为明确排除（咳嗽、敲击、翻纸）；重叠部分按实际覆盖扣除，不重复计入"
        )
        self.add_exclude_button.clicked.connect(lambda: self.add_region("exclude"))
        region_buttons.addWidget(self.add_exclude_button)
        self.undo_region_button = QPushButton("删除选中标记")
        self.undo_region_button.clicked.connect(self.remove_selected_region)
        region_buttons.addWidget(self.undo_region_button)
        self.clear_regions_button = QPushButton("清空标记")
        self.clear_regions_button.clicked.connect(self.clear_regions)
        region_buttons.addWidget(self.clear_regions_button)
        selection_layout.addLayout(region_buttons)
        layout.addWidget(selection_box)

        self.region_list = QListWidget(panel)
        self.region_list.setMaximumHeight(86)
        self.region_list.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.region_list.itemDoubleClicked.connect(lambda _item: self.remove_selected_region())
        layout.addWidget(self.region_list)

        settings_row = QHBoxLayout()
        self.lock_check = QCheckBox("锁定本段设置")
        self.lock_check.setToolTip(
            "锁定后，重新划选参考段或改目标都不会改动本段的增益与峰值设置"
        )
        self.lock_check.toggled.connect(self._on_lock_toggled)
        settings_row.addWidget(self.lock_check)

        self.peak_mode_combo = QComboBox(panel)
        self.peak_mode_combo.addItem("峰值模式: 降整体增益", PEAK_MODE_HEADROOM)
        self.peak_mode_combo.addItem("峰值模式: 仅限制局部峰值", PEAK_MODE_LIMITER)
        self.peak_mode_combo.currentIndexChanged.connect(self._on_peak_settings_changed)
        settings_row.addWidget(self.peak_mode_combo, 1)

        self.peak_check = QCheckBox("峰值上限")
        self.peak_check.toggled.connect(self._on_peak_settings_changed)
        settings_row.addWidget(self.peak_check)
        self.peak_spin = QDoubleSpinBox(panel)
        self.peak_spin.setRange(-24.0, -0.1)
        self.peak_spin.setSingleStep(0.5)
        self.peak_spin.setDecimals(1)
        self.peak_spin.setSuffix(" dBFS")
        self.peak_spin.setValue(-1.0)
        self.peak_spin.valueChanged.connect(self._on_peak_settings_changed)
        settings_row.addWidget(self.peak_spin)
        layout.addLayout(settings_row)

        audition_row = QHBoxLayout()
        self.play_selection_button = QPushButton("▶ 试听当前选区")
        self.play_selection_button.clicked.connect(self.play_current_selection)
        audition_row.addWidget(self.play_selection_button)
        self.play_reference_button = QPushButton("按同一选区试听参考")
        self.play_reference_button.setToolTip(
            "在参考段上播放与当前片段相同的有效选区，用于 A/B 比较"
        )
        self.play_reference_button.clicked.connect(self.play_reference_same_selection)
        audition_row.addWidget(self.play_reference_button)
        self.play_output_button = QPushButton("按同一选区试听成品")
        self.play_output_button.setToolTip(
            "在最近一次导出的成品上播放相同选区，确认实际写出的电平"
        )
        self.play_output_button.clicked.connect(self.play_output_same_selection)
        audition_row.addWidget(self.play_output_button)
        self.stop_button = QPushButton("停止")
        self.stop_button.clicked.connect(self.player.stop)
        audition_row.addWidget(self.stop_button)
        layout.addLayout(audition_row)

        self.detail = QTextEdit(panel)
        self.detail.setReadOnly(True)
        self.detail.setMinimumHeight(150)
        self.detail.setPlaceholderText("选中片段后显示实测来源、警告和成品复测")
        layout.addWidget(self.detail, 2)
        return panel

    # ------------------------------------------------------------- status/log

    def _set_status(self, text: str) -> None:
        self.statusBar().showMessage(text, 8000)

    def _log(self, text: str) -> None:
        self.log.append(text)

    def _log_html(self, html: str) -> None:
        self.log.append(html)

    # ------------------------------------------------------------------ clips

    def import_audio_dialog(self) -> None:
        paths, _ = QFileDialog.getOpenFileNames(
            self,
            "导入采访音频",
            "",
            "音频文件 (*.wav *.flac *.aiff *.aif *.ogg *.mp3 *.m4a);;所有文件 (*)",
        )
        if paths:
            self.import_paths(paths)

    def import_paths(self, paths: list[str]) -> None:
        added, errors = self.project.import_paths(paths)
        for path, message in errors:
            self._log(f'<span style="color:#ff7b72">导入失败</span> {path}: {message}')
        if errors:
            QMessageBox.warning(self, "部分文件未导入", "\n".join(m for _, m in errors))
        loaded = 0
        for clip in added:
            if self._load_clip_audio(clip):
                loaded += 1
        self.project.dirty = True
        self._refresh_table()
        if self.project.reference_clip_id:
            self._select_clip(self.project.reference_clip_id)
        if loaded:
            self.evaluate()
        self._set_status(f"已导入 {loaded} 段音频")

    def load_generated_samples(self) -> None:
        base = QFileDialog.getExistingDirectory(self, "选择样例输出目录（可取消则用临时目录）")
        if base:
            target = Path(base) / "interview_samples"
        else:
            import tempfile

            target = Path(tempfile.mkdtemp(prefix="interview_samples_"))
        try:
            paths = samples.write_samples(target)
        except OSError as exc:
            QMessageBox.critical(self, "生成样例失败", str(exc))
            return
        self.import_paths([str(p) for p in paths])
        # Apply the demo selections and the one clip that needs a peak ceiling.
        for clip in self.project.clips:
            if clip.name not in {p.name for p in paths}:
                continue
            rate = clip.sample_rate
            clip.regions = [
                Region("speech", int(a * rate), int(b * rate))
                for a, b in samples.demo_regions(clip.name)
            ] + [
                Region("exclude", int(a * rate), int(b * rate))
                for a, b in samples.demo_exclusions(clip.name)
            ]
            clip.measurement = None
            clip.measurement_signature = None
            if clip.name == "speaker_c_peak_clap.wav":
                clip.peak_limit_enabled = True
                clip.peak_limit_db = -1.0
                clip.peak_mode = PEAK_MODE_LIMITER
            if clip.name == "speaker_e_peak_knock.wav":
                clip.peak_limit_enabled = True
                clip.peak_limit_db = -1.0
                clip.peak_mode = PEAK_MODE_HEADROOM
        ref = next(
            (c for c in self.project.clips if c.name == "speaker_a_reference.wav"), None
        )
        if ref is not None:
            self.project.set_reference(ref.id)
        self.project.reset_target()
        self.evaluate()
        self._log(
            "已生成 5 段样例：首尾静音、不同峰均差；"
            "speaker_c 的敲击被排除区排除在电平之外但仍影响整段峰值（局部峰值限制），"
            "speaker_e 用整体降增益展示无法达到目标时的差值。"
        )
        self._set_status(f"样例已生成: {target}")

    def remove_current_clip(self) -> None:
        if not self._current_clip_id:
            return
        clip = self.project.find(self._current_clip_id)
        if clip is None:
            return
        answer = QMessageBox.question(
            self, "移除片段", f"从项目中移除 {clip.name}？（不会删除源文件）"
        )
        if answer != QMessageBox.StandardButton.Yes:
            return
        self.project.remove_clip(clip.id)
        self._audio.pop(clip.id, None)
        self._rendered.pop(clip.id, None)
        self._current_clip_id = None
        self._refresh_table()
        self.evaluate()

    def _load_clip_audio(
        self, clip: ClipState, force: bool = False, report_change: bool = True
    ) -> bool:
        if not force and clip.id in self._audio:
            return True
        try:
            audio = load_audio(clip.path)
        except AudioLoadError as exc:
            self._log(f'<span style="color:#ff7b72">加载失败</span> {clip.name}: {exc}')
            return False
        # A file whose bytes no longer match the project is a source
        # change, not a silent reload.  The old measurements are dropped and
        # the source identity is updated so the check does not fire again.
        if clip.source.fingerprint and audio.fingerprint != clip.source.fingerprint:
            from ..audio_io import SourceSnapshot

            clip.clear_measurement(reason="changed")
            clip.needs_rematch = True
            clip.source = SourceSnapshot(
                path=audio.path,
                fingerprint=audio.fingerprint,
                file_size=audio.file_size,
                file_mtime_ns=audio.file_mtime_ns,
            )
            if report_change:
                self._log(
                    f'<span style="color:#ffb14d">源文件已变更</span> {clip.name}：'
                    "旧测量已清除，请重新匹配"
                )
        # Regions are sample offsets; after a shorter replacement they must
        # not point past the new end (the measurements are already gone).
        if audio.frames != clip.frames:
            for region in clip.regions:
                region.start = max(0, min(region.start, audio.frames))
                region.end = max(0, min(region.end, audio.frames))
            clip.regions = [r for r in clip.regions if r.end > r.start]
        self._audio[clip.id] = audio.samples
        clip.sample_rate = audio.sample_rate
        clip.frames = audio.frames
        return True

    def set_current_as_reference(self) -> None:
        clip = self.project.find(self._current_clip_id or "")
        if clip is None:
            return
        self.project.set_reference(clip.id)
        self.project.reset_target()
        self._log(f"参考段改为: {clip.name}")
        self.evaluate()

    # ------------------------------------------------------------------ table

    def _refresh_table(self) -> None:
        self._updating = True
        try:
            by_id = self._outcome.by_clip() if self._outcome else {}
            self.table.setRowCount(len(self.project.clips))
            for row, clip in enumerate(self.project.clips):
                evaluation = by_id.get(clip.id)
                measurement = evaluation.measurement if evaluation else clip.measurement
                if clip.needs_rematch:
                    # Stale numbers must not look like current results.
                    measurement = None
                items = [
                    clip.name,
                    "●" if clip.id == self.project.reference_clip_id else "",
                    "🔒" if clip.locked else "",
                    f'{measurement.total_duration_s:.2f}s' if measurement else "—",
                    _fmt_db(measurement.rms_db if measurement else None),
                    _fmt_db(measurement.clip_peak_db if measurement else None),
                    _fmt_db(evaluation.plan.applied_gain_db if evaluation and evaluation.plan else None),
                    self._status_text(clip, evaluation),
                ]
                for column, text in enumerate(items):
                    item = QTableWidgetItem(text)
                    item.setData(Qt.ItemDataRole.UserRole, clip.id)
                    if column == 0:
                        if clip.needs_rematch:
                            item.setForeground(COLOR_WARN)
                            item.setToolTip("源文件内容变化，测量已清除，需要重新匹配")
                    elif column == 1 and text:
                        item.setForeground(COLOR_LOCKED)
                    elif column == 2 and text:
                        item.setForeground(COLOR_LOCKED)
                    elif column == 6:
                        item.setForeground(
                            COLOR_ERROR if evaluation and evaluation.limited else COLOR_OK
                        )
                    elif column == 7:
                        item.setForeground(self._status_color(clip, evaluation))
                    self.table.setItem(row, column, item)
                if clip.id == self._current_clip_id:
                    self.table.selectRow(row)
        finally:
            self._updating = False

    def _status_text(self, clip: ClipState, evaluation) -> str:
        if clip.needs_rematch:
            return "⚠ 源文件已变更，需重新匹配"
        if evaluation is None:
            return "未测量"
        measurement = evaluation.measurement
        if measurement is None:
            return "未测量"
        if measurement.silent:
            return "⚠ 无可用语音"
        if measurement.too_short:
            return "⚠ 选区太短"
        if clip.locked:
            return "🔒 已锁定（不随参考变化）"
        if evaluation.limited and evaluation.plan and evaluation.plan.mode == PEAK_MODE_HEADROOM:
            return f"⚠ 峰值限制差 {evaluation.plan.shortfall_db:.1f} dB"
        if evaluation.limited:
            return "峰值限制将改变局部"
        if evaluation.plan is None:
            return evaluation.blocked_reason
        return "✓ 匹配"

    def _status_color(self, clip: ClipState, evaluation) -> QColor:
        if clip.needs_rematch:
            return COLOR_WARN
        if evaluation is None or evaluation.plan is None:
            return COLOR_MUTED
        if evaluation.measurement and (
            evaluation.measurement.silent or evaluation.measurement.too_short
        ):
            return COLOR_WARN
        if evaluation.limited:
            return COLOR_WARN
        if clip.locked:
            return COLOR_LOCKED
        return COLOR_OK

    def _on_table_selection(self) -> None:
        if self._updating:
            return
        row = self.table.currentRow()
        if row < 0:
            return
        item = self.table.item(row, 0)
        if item is None:
            return
        self._select_clip(str(item.data(Qt.ItemDataRole.UserRole)))

    def _select_clip(self, clip_id: str) -> None:
        clip = self.project.find(clip_id)
        if clip is None:
            return
        self._current_clip_id = clip_id
        if not self._load_clip_audio(clip):
            self.waveform.set_clip(None, clip.sample_rate or 48000)
            self.wave_title.setText(f"{clip.name}（源文件不可读取）")
            return
        self._sync_detail(clip, select_row=False)
        self._refresh_table()

    # --------------------------------------------------------------- controls

    def _sync_detail(self, clip: ClipState, select_row: bool = True) -> None:
        # Re-rendering after a match must not throw away the range the user
        # just dragged; switching to another clip does start clean.
        same_clip = self._detail_clip_id == clip.id
        previous_selection = self.waveform.selection() if same_clip else None
        previous_playhead = self.waveform.view._playhead if same_clip else None
        self._updating = True
        try:
            if select_row:
                for row in range(self.table.rowCount()):
                    item = self.table.item(row, 0)
                    if item and item.data(Qt.ItemDataRole.UserRole) == clip.id:
                        self.table.selectRow(row)
                        break
            samples_data = self._audio.get(clip.id)
            evaluation = self._outcome.by_clip().get(clip.id) if self._outcome else None
            if (
                samples_data is not None
                and clip.measurement is None
                and not clip.needs_rematch
            ):
                clip.mark_measurement(
                    measure_selection(
                        samples_data,
                        clip.sample_rate,
                        clip.speech_regions(),
                        clip.exclude_regions(),
                    )
                )
            effective, _excluded = _effective_for_display(clip)
            self.waveform.set_clip(
                samples_data,
                clip.sample_rate,
                clip.regions,
                effective,
                title=clip.name,
            )
            self.wave_title.setText(
                f"{clip.name}   ·   {clip.frames / max(1, clip.sample_rate):.2f}s   ·   "
                f"{clip.sample_rate} Hz"
                + ("   ·   🔒 已锁定" if clip.locked else "")
                + ("   ·   ⚠ 需重新匹配" if clip.needs_rematch else "")
            )
            self.lock_check.setChecked(clip.locked)
            index = self.peak_mode_combo.findData(clip.peak_mode)
            self.peak_mode_combo.setCurrentIndex(max(0, index))
            self.peak_check.setChecked(clip.peak_limit_enabled)
            self.peak_spin.setValue(clip.peak_limit_db)
            self._refresh_region_list(clip)
            check = clip.last_render_check or {}
            self.waveform.set_limited_runs(
                [
                    (float(run.get("start_s", 0.0)), float(run.get("end_s", 0.0)))
                    for run in check.get("limited_runs", [])
                ]
            )
            self._update_controls()
            self._render_detail(clip, evaluation)
            self.sel_start.setMaximum(max(0.01, clip.frames / max(1, clip.sample_rate)))
            self.sel_end.setMaximum(max(0.01, clip.frames / max(1, clip.sample_rate)))
            if previous_selection is not None:
                start = min(max(0, previous_selection[0]), clip.frames)
                end = min(max(0, previous_selection[1]), clip.frames)
                self.waveform.set_selection(start, end)
            if previous_playhead is not None:
                self.waveform.set_playhead(min(previous_playhead, clip.frames))
            self._detail_clip_id = clip.id
            selected = self.waveform.selection()
            if selected is not None:
                self.sel_start.setValue(selected[0] / max(1, clip.sample_rate))
                self.sel_end.setValue(selected[1] / max(1, clip.sample_rate))
                self.sel_duration.setText(
                    f"{(selected[1] - selected[0]) / max(1, clip.sample_rate):.2f} s"
                )
            else:
                self.sel_duration.setText("0.00 s")
        finally:
            self._updating = False

    def _refresh_region_list(self, clip: ClipState) -> None:
        self.region_list.clear()
        rate = max(1, clip.sample_rate)
        for index, region in enumerate(clip.regions):
            kind = "讲话" if region.kind == "speech" else "排除"
            item = QListWidgetItem(
                f"{kind}  {region.start / rate:.2f} – {region.end / rate:.2f}s"
            )
            item.setData(Qt.ItemDataRole.UserRole, index)
            if region.kind == "exclude":
                item.setForeground(COLOR_ERROR)
            self.region_list.addItem(item)

    def _update_controls(self) -> None:
        clip = self.project.find(self._current_clip_id or "")
        has_clip = clip is not None
        self.remove_button.setEnabled(has_clip)
        self.set_reference_button.setEnabled(has_clip)
        self.lock_check.setEnabled(has_clip)
        locked = bool(clip and clip.locked)
        self.peak_mode_combo.setEnabled(has_clip and not locked)
        self.peak_check.setEnabled(has_clip and not locked)
        self.peak_spin.setEnabled(has_clip and not locked and bool(clip and clip.peak_limit_enabled))
        self.add_speech_button.setEnabled(has_clip)
        self.add_exclude_button.setEnabled(has_clip)
        self.play_selection_button.setEnabled(has_clip)
        self.play_reference_button.setEnabled(
            has_clip and self.project.reference_clip is not None
        )
        self.play_output_button.setEnabled(
            has_clip and bool(clip and clip.last_render_check)
        )
        self.match_button.setEnabled(bool(self.project.clips))
        if clip is not None:
            self.peak_spin.setEnabled(not locked and clip.peak_limit_enabled)

    # -------------------------------------------------------------- selection

    def _on_selection_changed(self, start: int, end: int) -> None:
        if self._updating:
            return
        rate = self.waveform.sample_rate
        self._updating = True
        try:
            self.sel_start.setValue(start / rate)
            self.sel_end.setValue(end / rate)
            self.sel_duration.setText(f"{(end - start) / rate:.2f} s")
        finally:
            self._updating = False

    def _on_position_clicked(self, sample: int) -> None:
        self.waveform.set_playhead(sample)

    def _on_region_double_clicked(self, index: int) -> None:
        clip = self.project.find(self._current_clip_id or "")
        if clip is None or not (0 <= index < len(clip.regions)):
            return
        region = clip.regions[index]
        rate = max(1, clip.sample_rate)
        self._log(
            f"移除{'讲话' if region.kind == 'speech' else '排除'}标记 "
            f"{region.start / rate:.2f}–{region.end / rate:.2f}s"
        )
        clip.regions.pop(index)
        clip.invalidate_if_stale()
        self.project.dirty = True
        self.evaluate()

    def _selection_seconds(self) -> tuple[float, float] | None:
        clip = self.project.find(self._current_clip_id or "")
        if clip is None or clip.frames <= 0:
            return None
        start = min(self.sel_start.value(), self.sel_end.value())
        end = max(self.sel_start.value(), self.sel_end.value())
        if end <= start:
            return None
        return start, end

    def add_region(self, kind: str) -> None:
        clip = self.project.find(self._current_clip_id or "")
        if clip is None:
            return
        seconds = self._selection_seconds()
        if seconds is None:
            QMessageBox.information(self, "没有选区", "先在波形上拖出一段，或输入起止时间。")
            return
        rate = clip.sample_rate
        region = self.project.add_region(
            clip.id, kind, int(round(seconds[0] * rate)), int(round(seconds[1] * rate))
        )
        if region is None:
            return
        self.project.dirty = True
        label = "讲话区" if kind == "speech" else "排除区"
        self._log(
            f"{clip.name}: 新增{label} {region.start / rate:.2f}–{region.end / rate:.2f}s"
        )
        self.evaluate()

    def remove_selected_region(self) -> None:
        clip = self.project.find(self._current_clip_id or "")
        if clip is None:
            return
        item = self.region_list.currentItem()
        if item is None:
            return
        index = int(item.data(Qt.ItemDataRole.UserRole))
        if 0 <= index < len(clip.regions):
            region = clip.regions.pop(index)
            region_kind = "讲话" if region.kind == "speech" else "排除"
            self._log(f"{clip.name}: 移除{region_kind}标记")
            clip.invalidate_if_stale()
            self.project.dirty = True
            self.evaluate()

    def clear_regions(self) -> None:
        clip = self.project.find(self._current_clip_id or "")
        if clip is None:
            return
        answer = QMessageBox.question(
            self, "清空标记", f"清空 {clip.name} 的全部讲话区与排除区？"
        )
        if answer != QMessageBox.StandardButton.Yes:
            return
        self.project.clear_regions(clip.id)
        self.evaluate()

    # ---------------------------------------------------------------- settings

    def _on_lock_toggled(self, checked: bool) -> None:
        if self._updating:
            return
        clip = self.project.find(self._current_clip_id or "")
        if clip is None:
            return
        evaluation = self._outcome.by_clip().get(clip.id) if self._outcome else None
        planned_gain = (
            evaluation.plan.applied_gain_db
            if evaluation and evaluation.plan and not clip.locked
            else None
        )
        self.project.set_locked(
            clip.id,
            checked,
            gain_db=planned_gain,
            ceiling_enabled=clip.peak_limit_enabled,
            ceiling_db=clip.peak_limit_db,
            mode=clip.peak_mode,
        )
        if checked:
            self._log(
                f"{clip.name}: 已锁定"
                + (
                    f"，增益固定为 {planned_gain:+.2f} dB"
                    if planned_gain is not None
                    else "（尚无匹配值，锁定为当前设置）"
                )
            )
        else:
            self._log(f"{clip.name}: 已解锁，将重新跟随参考目标")
        self.evaluate()

    def _on_peak_settings_changed(self) -> None:
        if self._updating:
            return
        clip = self.project.find(self._current_clip_id or "")
        if clip is None or clip.locked:
            return
        clip.peak_mode = str(self.peak_mode_combo.currentData())
        clip.peak_limit_enabled = self.peak_check.isChecked()
        clip.peak_limit_db = float(self.peak_spin.value())
        self.project.dirty = True
        self.evaluate()

    def _on_follow_reference_toggled(self, checked: bool) -> None:
        if self._updating:
            return
        if checked:
            self.project.reset_target()
        else:
            current = self.project.target_db(
                self.project.reference_clip.measurement
                if self.project.reference_clip
                else None
            )
            if current is not None:
                self.project.set_target(current)
        self.evaluate()

    def _on_target_edited(self, value: float) -> None:
        if self._updating:
            return
        self._updating = True
        try:
            self.follow_reference.setChecked(False)
        finally:
            self._updating = False
        self.project.set_target(value)
        self.evaluate()

    def apply_suggested_target(self) -> None:
        suggestion = self._outcome.suggested_target_db if self._outcome else None
        if suggestion is None:
            return
        self._updating = True
        try:
            self.follow_reference.setChecked(False)
            self.target_spin.setValue(round(suggestion, 2))
        finally:
            self._updating = False
        self.project.set_target(round(suggestion, 2))
        self._log(
            f"目标已降到 {suggestion:.2f} dBFS；这是峰值受限片段能达到的共同上限。"
        )
        self.evaluate()

    # ---------------------------------------------------------------- matching

    def rematch_all(self) -> None:
        """Explicit re-match: measures again and clears stale-source flags."""
        self.evaluate(force=True, refresh_needs_rematch=True)

    def evaluate(self, force: bool = False, refresh_needs_rematch: bool = False) -> None:
        if not self.project.clips:
            self._outcome = None
            self._refresh_table()
            self._update_controls()
            return
        for clip in self.project.clips:
            self._load_clip_audio(clip)
        self._outcome = evaluate(
            self.project,
            self._audio,
            force_measure=force,
            refresh_needs_rematch=refresh_needs_rematch,
        )
        target = self._outcome.target_rms_db
        self._updating = True
        try:
            self.follow_reference.setChecked(self.project.target_override_db is None)
            if target is not None:
                self.target_spin.setValue(round(target, 2))
            else:
                self.target_spin.setValue(-20.0)
            # The spin box stays editable: typing a value switches the project
            # from "follow the reference" to an explicit target.
            self.target_spin.setEnabled(True)
            self.target_hint.setText(
                "目标 = 参考段实测有效语音 RMS"
                if self.project.target_override_db is None
                else "目标已被手动设定；勾选「跟随参考段实测」可恢复"
            )
            suggestion = self._outcome.suggested_target_db
            if suggestion is not None and target is not None:
                self.suggestion_label.setText(
                    f"参考目标 {target:.1f} dBFS 无法被所有片段达到；"
                    f"峰值受限片段最多差 {max(e.shortfall_db for e in self._outcome.evaluations):.1f} dB。"
                    f"可把目标降到 {suggestion:.1f} dBFS。"
                )
                self.apply_suggestion_button.setVisible(True)
            else:
                self.suggestion_label.setText("")
                self.apply_suggestion_button.setVisible(False)
        finally:
            self._updating = False
        self._refresh_table()
        reference = self.project.reference_clip
        self.reference_label.setText(
            f"参考段: {reference.name}" if reference is not None else "参考段: —"
        )
        if self._current_clip_id:
            clip = self.project.find(self._current_clip_id)
            if clip is not None:
                self._sync_detail(clip, select_row=False)
        elif self.project.reference_clip is not None:
            self._select_clip(self.project.reference_clip.id)
        self._update_controls()

    # ----------------------------------------------------------------- render

    def _render_detail(self, clip: ClipState, evaluation) -> None:
        lines: list[str] = []
        if clip.needs_rematch:
            self.detail.setHtml(
                '<span style="color:#ffb14d"><b>源文件内容已变化</b>：旧测量与复测'
                "结果已清除。确认选区后点击「重新匹配」。</span>"
            )
            return
        measurement = evaluation.measurement if evaluation else clip.measurement
        if measurement is None:
            self.detail.setHtml('<span style="color:#8b98a9">尚未测量。</span>')
            return
        lines.append(f"<b>有效样本来源</b>：{selection_provenance_text(measurement)}")
        lines.append(
            f"有效时长 {measurement.selection_duration_s:.2f}s，"
            f"其中语音 {measurement.active_s:.2f}s；"
            f"有效语音 RMS <b>{_fmt_db(measurement.rms_db)}</b>；"
            f"整段峰值 {_fmt_db(measurement.clip_peak_db)}"
        )
        if measurement.warning_codes:
            color = "#ffb14d" if not measurement.silent else "#ff7b72"
            text = "；".join(summarize_warning(c) for c in measurement.warning_codes)
            lines.append(f'<span style="color:{color}">提示：{text}</span>')
        else:
            lines.append('<span style="color:#7fd1ae">选区可用。</span>')

        if evaluation and evaluation.plan:
            plan = evaluation.plan
            lines.append(
                f"<b>增益</b>：目标 {_fmt_db(self._outcome.target_rms_db if self._outcome else None)}，"
                f"需要 {plan.match_gain_db:+.2f} dB，实际 {plan.applied_gain_db:+.2f} dB；"
                f"预测成品 RMS {_fmt_db(plan.predicted_rms_db)}，峰值 {_fmt_db(plan.predicted_peak_db)}"
            )
            if plan.limited and plan.mode == PEAK_MODE_HEADROOM:
                lines.append(
                    f'<span style="color:#ffb14d"><b>峰值限制</b>：整段增益被压低 '
                    f"{plan.shortfall_db:.2f} dB，无法达到目标。</span>"
                )
            elif plan.limited:
                lines.append(
                    '<span style="color:#ffb14d">峰值限制已启用：会改变局部样本，'
                    "导出后列出具体时间区间。</span>"
                )
        if clip.locked:
            lines.append(
                f'<span style="color:#9cc7ff"><b>已锁定</b>：增益固定 '
                f"{_fmt_db(clip.locked_gain_db)}，重新划选参考不会覆盖。</span>"
            )
        if clip.needs_rematch:
            lines.append(
                '<span style="color:#ffb14d"><b>需重新匹配</b>：源文件内容已变化，'
                "旧测量已清除。</span>"
            )
        check = clip.last_render_check
        if check:
            lines.append("<hr>")
            lines.append("<b>最近一次成品复测</b>")
            lines.append(
                f"成品实测 RMS {_fmt_db(check.get('measured_rms_db'))}，"
                f"目标 {_fmt_db(check.get('target_rms_db'))}，"
                f"偏差 {_fmt_db(check.get('deviation_db'))} dB；"
                f"状态 {check.get('status', '')}"
            )
            runs = check.get("limited_runs") or []
            if runs:
                ranges = "，".join(
                    f"{r['start_s']:.3f}–{r['end_s']:.3f}s（-{abs(r['reduction_db']):.1f} dB）"
                    for r in runs
                )
                lines.append(
                    f'<span style="color:#ffb14d">峰值限制改动区间：{ranges}</span>'
                )
                if check.get("deviates_from_target"):
                    lines.append(
                        '<span style="color:#ff7b72">成品实测已偏离目标，'
                        "可提高峰值上限或调整目标。</span>"
                    )
            if check.get("note"):
                lines.append(f"备注：{check['note']}")
        self.detail.setHtml("<br>".join(lines))

    def export_dialog(self) -> None:
        if not self.project.clips:
            QMessageBox.information(self, "没有片段", "先导入音频。")
            return
        directory = QFileDialog.getExistingDirectory(
            self, "选择导出目录", self.project.output_dir or str(Path.home())
        )
        if not directory:
            return
        self.export_to(directory)

    def export_to(self, directory: str) -> None:
        if self._outcome is None:
            self.evaluate()
        if self._outcome is None:
            return
        try:
            result = export_all(
                self.project, self._outcome, self._audio, output_dir=directory
            )
        except Exception as exc:  # export failures must be visible, not fatal
            QMessageBox.critical(self, "导出失败", str(exc))
            self._log(f'<span style="color:#ff7b72">导出失败</span> {exc}')
            return
        self.project.output_dir = str(directory)
        self.project.dirty = True
        self._rendered = dict(result["rendered"])
        self._log(f"<b>已导出到</b> {result['output_dir']}")
        for record in result["records"]:
            self._log_export_record(record)
        self._log(
            f"报告：{Path(result['report_json']).name} / {Path(result['report_csv']).name}"
        )
        current = self.project.find(self._current_clip_id or "")
        if current is not None:
            self._sync_detail(current, select_row=False)
        self._refresh_table()
        self._set_status("导出完成，已用写出的文件重新测量")

    def _log_export_record(self, record: ExportRecord) -> None:
        color = {
            "ok": "#7fd1ae",
            "deviates": "#ffb14d",
            "below_target": "#ffb14d",
            "skipped": "#8b98a9",
        }.get(record.status, "#aab7c7")
        self._log(
            f'<span style="color:{color}">{record.clip_name}: {record.status}</span> '
            f"gain {_fmt_db(record.gain_db)} → 实测 {_fmt_db(record.measured_rms_db)} "
            f"(目标 {_fmt_db(record.target_rms_db)})"
            + (f" · {record.note}" if record.note else "")
        )
        for run in record.limited_runs:
            self._log(
                f"　峰值限制区间 {run['start_s']:.3f}–{run['end_s']:.3f}s，"
                f"降低 {abs(run['reduction_db']):.1f} dB"
            )

    def recheck_outputs(self) -> None:
        """Re-measure already exported files, without re-rendering anything."""
        if not self.project.clips:
            return
        self.evaluate()
        if self._outcome is None:
            return
        checked = 0
        for evaluation in self._outcome.evaluations:
            clip = evaluation.clip
            check = clip.last_render_check or {}
            path = check.get("output_path")
            if not path or not Path(path).is_file():
                continue
            try:
                written = load_audio(path)
            except AudioLoadError as exc:
                self._log(f'<span style="color:#ff7b72">复测失败</span> {clip.name}: {exc}')
                continue
            speech, exclude = _effective_for_display(clip)
            verification = verify_render(
                written.samples,
                written.sample_rate,
                speech,
                exclude,
                self._outcome.target_rms_db,
            )
            updated = dict(check)
            updated["measured_rms_db"] = verification.measured_rms_db
            updated["measured_peak_db"] = verification.measured_peak_db
            updated["deviation_db"] = verification.deviation_db
            updated["deviates_from_target"] = verification.deviates_from_target
            # Keep the more specific "below_target" verdict: the file can be
            # re-measured forever, but the peak ceiling is why it is short.
            if check.get("status") == "below_target":
                updated["status"] = "below_target"
            elif verification.deviates_from_target:
                updated["status"] = "deviates"
            else:
                updated["status"] = "ok"
            updated["note"] = (
                f"复测偏差 {verification.deviation_db:+.2f} dB"
                if verification.deviation_db is not None
                else "复测未能测量"
            )
            clip.last_render_check = updated
            checked += 1
            self._log(
                f'<span style="color:#9cc7ff">复测</span> {clip.name}: '
                f"成品 RMS {_fmt_db(verification.measured_rms_db)}，"
                f"偏差 {_fmt_db(verification.deviation_db)} dB"
            )
        if not checked:
            self._log("没有可复测的成品文件；先导出一次。")
        else:
            self._refresh_table()
            current = self.project.find(self._current_clip_id or "")
            if current is not None:
                self._sync_detail(current, select_row=False)

    # --------------------------------------------------------------- playback

    def _play_intervals(
        self, samples_data: np.ndarray, rate: int, intervals: list[Interval], label: str
    ) -> None:
        if samples_data is None or not intervals:
            self._set_status("没有可试听的有效选区")
            return
        merged = _concat_intervals(samples_data, rate, intervals)
        if merged.size == 0:
            self._set_status("选区超出音频范围")
            return
        self.player.play(PlaybackRequest(merged, rate, label))

    def play_current_selection(self) -> None:
        clip = self.project.find(self._current_clip_id or "")
        if clip is None:
            return
        samples_data = self._audio.get(clip.id)
        if samples_data is None:
            return
        effective, _ = _effective_for_display(clip)
        self._play_intervals(samples_data, clip.sample_rate, effective, f"{clip.name} 选区")

    def _selection_on_other(self, other: ClipState) -> list[Interval]:
        source = self.project.find(self._current_clip_id or "")
        if source is None:
            return []
        effective, _ = _effective_for_display(source)
        # Same *time* ranges, converted to the other clip's sample rate.
        return [
            Interval(
                int(round(part.start / max(1, source.sample_rate) * other.sample_rate)),
                int(round(part.end / max(1, source.sample_rate) * other.sample_rate)),
            )
            for part in effective
        ]

    def play_reference_same_selection(self) -> None:
        reference = self.project.reference_clip
        if reference is None:
            return
        self._load_clip_audio(reference)
        samples_data = self._audio.get(reference.id)
        if samples_data is None:
            self._set_status("参考段音频未加载")
            return
        self._play_intervals(
            samples_data,
            reference.sample_rate,
            self._selection_on_other(reference),
            f"参考段 {reference.name}（相同选区）",
        )

    def play_output_same_selection(self) -> None:
        clip = self.project.find(self._current_clip_id or "")
        if clip is None:
            return
        check = clip.last_render_check or {}
        path = check.get("output_path")
        if not path:
            self._set_status("该段还没有导出成品")
            return
        try:
            written = load_audio(path)
        except AudioLoadError as exc:
            self._set_status(f"成品无法读取: {exc}")
            return
        self._play_intervals(
            written.samples,
            written.sample_rate,
            self._selection_on_other(clip),
            f"成品 {clip.name}（相同选区）",
        )

    def _on_playback_failed(self, message: str) -> None:
        self._set_status(message)
        self._log(f'<span style="color:#ffb14d">{message}</span>')

    # ----------------------------------------------------------------- project

    def save_project(self) -> None:
        if not self.project.path:
            self.save_project_as_dialog()
            return
        try:
            path = self.project.save()
        except OSError as exc:
            QMessageBox.critical(self, "保存失败", str(exc))
            return
        self._log(f"项目已保存: {path}")
        self._set_status(f"项目已保存: {path}")

    def save_project_as_dialog(self) -> None:
        path, _ = QFileDialog.getSaveFileName(
            self, "保存项目", "interview_match.project.json", "项目文件 (*.json)"
        )
        if not path:
            return
        try:
            saved = self.project.save(path)
        except OSError as exc:
            QMessageBox.critical(self, "保存失败", str(exc))
            return
        self._log(f"项目已保存: {saved}")
        self._set_status(f"项目已保存: {saved}")

    def open_project_dialog(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "打开项目", "", "项目文件 (*.json);;所有文件 (*)"
        )
        if path:
            self.open_project(path)

    def open_project(self, path: str) -> None:
        try:
            project = Project.load(path)
        except Exception as exc:
            QMessageBox.critical(self, "打开项目失败", str(exc))
            return
        self.project = project
        self._audio.clear()
        self._rendered.clear()
        self._outcome = None
        self._current_clip_id = None
        # Source identity is checked *before* the audio is loaded: changed
        # bytes clear the stored measurements and put the clip into
        # "needs re-match", which is then shown in one dialog below.
        changes = self.project.check_sources()
        for clip in self.project.clips:
            self._load_clip_audio(
                clip, force=True, report_change=clip.id not in changes
            )
        self._refresh_table()
        if self.project.clips:
            self._select_clip(
                self.project.reference_clip_id or self.project.clips[0].id
            )
        if changes:
            names = "、".join(
                self.project.find(clip_id).name
                for clip_id in changes
                if self.project.find(clip_id)
            )
            QMessageBox.warning(
                self,
                "源文件已变化",
                f"以下片段的源文件内容与保存项目时不同，旧测量已清除：\n{names}\n\n"
                "请确认选区后点击「重新匹配」。",
            )
            self._log(
                f'<span style="color:#ffb14d">检测到源文件变化：{names}；'
                "旧测量已清除，需要重新匹配。</span>"
            )
        self.evaluate()
        self._set_status(f"已打开项目: {path}")

    # -------------------------------------------------------------------- misc

    def closeEvent(self, event) -> None:  # noqa: N802 - Qt override
        if self.project.dirty and self.project.clips:
            answer = QMessageBox.question(
                self,
                "未保存的项目",
                "项目有未保存的更改，退出前保存吗？",
                QMessageBox.StandardButton.Save
                | QMessageBox.StandardButton.Discard
                | QMessageBox.StandardButton.Cancel,
            )
            if answer == QMessageBox.StandardButton.Cancel:
                event.ignore()
                return
            if answer == QMessageBox.StandardButton.Save:
                self.save_project()
        self.player.stop()
        super().closeEvent(event)

    def show_about(self) -> None:
        QMessageBox.information(
            self,
            "测量与限制说明",
            "电平测量：50 ms 帧、相对门限 -35 dB / 绝对 -60 dBFS 的有效语音 RMS。\n"
            "目标：默认取参考段实测有效语音 RMS；可手动指定或降到可达值。\n"
            "讲话区可多个，重叠按并集计一次；排除区从覆盖中扣除。\n"
            "峰值模式：\n"
            "  · 降整体增益 —— 峰值不越过上限，代价是可能达不到目标（会显示差值）。\n"
            "  · 仅限制局部峰值 —— 达到目标，但会改变局部样本，导出后列出时间区间。\n"
            "导出：24-bit PCM WAV；导出后重新读取成品并复测，报告 JSON/CSV。",
        )


class WaveformPanel(QWidget):
    """The waveform plus a compact provenance bar (where samples came from)."""

    selectionChanged = Signal(int, int)
    positionClicked = Signal(int)
    regionDoubleClicked = Signal(int)

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        from .waveform import WaveformView

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(2)
        self.view = WaveformView(self)
        layout.addWidget(self.view, 1)
        self.provenance = QLabel("有效样本来源: —")
        self.provenance.setStyleSheet("color: #8b98a9; font-size: 11px;")
        layout.addWidget(self.provenance)
        self.view.selectionChanged.connect(self.selectionChanged)
        self.view.positionClicked.connect(self.positionClicked)
        self.view.regionDoubleClicked.connect(self.regionDoubleClicked)

    @property
    def sample_rate(self) -> int:
        return self.view.sample_rate

    def set_clip(self, samples, sample_rate, regions=None, effective=None, title="") -> None:
        self.view.set_clip(samples, sample_rate, regions, effective, title)
        if effective:
            rate = max(1, sample_rate)
            text = "，".join(
                f"{part.start / rate:.2f}–{part.end / rate:.2f}s" for part in effective
            )
            self.provenance.setText(f"有效样本来源: {text}")
        else:
            self.provenance.setText("有效样本来源: —")

    def set_selection(self, start, end) -> None:
        self.view.set_selection(start, end)

    def selection(self):
        return self.view.selection()

    def set_playhead(self, sample) -> None:
        self.view.set_playhead(sample)

    def set_limited_runs(self, runs) -> None:
        self.view.set_limited_runs(runs)

    def set_regions(self, regions, effective) -> None:
        self.view.set_regions(regions, effective)


def _effective_for_display(clip: ClipState) -> tuple[list[Interval], list[Interval]]:
    from ..levels import merge_intervals, subtract_intervals

    speech = merge_intervals(clip.speech_regions())
    exclude = merge_intervals(clip.exclude_regions())
    return subtract_intervals(speech, exclude), exclude


def _concat_intervals(
    samples_data: np.ndarray, rate: int, intervals: list[Interval]
) -> np.ndarray:
    """Concatenate interval slices, with a short fade so joins do not click."""
    data = np.asarray(samples_data, dtype=np.float64)
    fade = max(1, int(FADE_SECONDS * rate))
    pieces: list[np.ndarray] = []
    for part in intervals:
        start = max(0, min(part.start, data.size))
        end = max(0, min(part.end, data.size))
        if end <= start:
            continue
        segment = data[start:end].copy()
        if segment.size > 2 * fade:
            ramp = np.linspace(0.0, 1.0, fade)
            segment[:fade] *= ramp
            segment[-fade:] *= ramp[::-1]
        pieces.append(segment)
    if not pieces:
        return np.zeros(0, dtype=np.float64)
    return np.concatenate(pieces)


def _fmt_db(value: float | None) -> str:
    if value is None:
        return "—"
    if not math.isfinite(float(value)):
        return "—"
    return f"{float(value):.2f} dB"


def _seconds_spin(parent: QWidget) -> QDoubleSpinBox:
    spin = QDoubleSpinBox(parent)
    spin.setRange(0.0, 3600.0)
    spin.setDecimals(2)
    spin.setSingleStep(0.05)
    spin.setSuffix(" s")
    return spin

