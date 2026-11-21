"""主窗口: 文件、分析参数、人工编辑、逐段试听与导出。"""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path

from PySide6.QtCore import QSignalBlocker, QStandardPaths, Qt
from PySide6.QtGui import QAction, QCloseEvent, QKeySequence
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
    QMainWindow,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QSpinBox,
    QSplitter,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from ..audio import AudioData, AudioError
from ..demo import make_demo_wav
from ..editing import (
    clear_pins,
    delete_segment,
    insert_segment,
    move_segment,
    resize_segment,
)
from ..export import ExportError, export_segments, format_timecode, open_in_file_manager
from ..player import SegmentPlayer
from ..segmentation import AnalysisParams, Segment, analyze
from .waveform import WaveformView

TABLE_HEADERS = ("#", "起点 (样本)", "终点 (样本)", "时长", "时间码", "锁定", "来源")


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("口述录音离线切分标记")
        self.resize(1240, 860)

        self.audio: AudioData | None = None
        self.params = AnalysisParams()
        self.segments: list[Segment] = []
        self.export_dir: Path | None = None
        self._undo_stack: list[list[Segment]] = []
        self._suppress_table = False
        self._play_source_start = 0
        self._drag_undo_pending = False

        self.player = SegmentPlayer(self)
        self.player.playingChanged.connect(self._on_playing_changed)
        self.player.positionChanged.connect(self._on_player_position)
        self.player.failed.connect(self._on_player_failed)

        self._build_ui()
        self._build_shortcuts()
        self._update_controls()

    # ------------------------------------------------------------------ UI
    def _build_ui(self) -> None:
        central = QWidget(self)
        outer = QHBoxLayout(central)
        outer.setContentsMargins(10, 10, 10, 10)
        outer.setSpacing(10)

        side = QWidget(self)
        side_layout = QVBoxLayout(side)
        side_layout.setContentsMargins(0, 0, 4, 0)
        side_layout.setSpacing(6)
        side_layout.addWidget(self._build_file_group())
        side_layout.addWidget(self._build_analysis_group())
        side_layout.addWidget(self._build_edit_group())
        side_layout.addWidget(self._build_play_group())
        side_layout.addWidget(self._build_export_group())
        side_layout.addStretch(1)
        side.setFixedWidth(364)

        scroll = QScrollArea(self)
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QScrollArea.NoFrame)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        scroll.setWidget(side)
        scroll.setFixedWidth(376)

        right = QWidget(self)
        right_layout = QVBoxLayout(right)
        right_layout.setContentsMargins(0, 0, 0, 0)
        right_layout.setSpacing(8)

        self.waveform = WaveformView(self)
        self.waveform.selectionChanged.connect(self._on_selection_changed)
        self.waveform.editBegan.connect(self._arm_drag_undo)
        self.waveform.editEnded.connect(self._clear_drag_undo)
        self.waveform.segmentEdited.connect(self._on_segment_edited)
        self.waveform.segmentMoved.connect(self._on_segment_moved)
        self.waveform.createRequested.connect(self._on_create_requested)
        self.waveform.seekRequested.connect(self._on_seek)
        self.waveform.playRequested.connect(self._play_selected)

        self.table = QTableWidget(0, len(TABLE_HEADERS), self)
        self.table.setHorizontalHeaderLabels(TABLE_HEADERS)
        self.table.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.table.setSelectionMode(QAbstractItemView.SingleSelection)
        self.table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.table.verticalHeader().setVisible(False)
        self.table.setAlternatingRowColors(True)
        header = self.table.horizontalHeader()
        header.setSectionResizeMode(QHeaderView.ResizeToContents)
        header.setSectionResizeMode(4, QHeaderView.Stretch)
        self.table.itemSelectionChanged.connect(self._on_table_selection)

        splitter = QSplitter(Qt.Vertical, self)
        splitter.addWidget(self.waveform)
        splitter.addWidget(self.table)
        splitter.setStretchFactor(0, 3)
        splitter.setStretchFactor(1, 2)
        splitter.setSizes([380, 260])
        right_layout.addWidget(splitter, 1)

        self.status = QLabel("就绪", self)
        self.status.setStyleSheet("color:#555; padding:2px 2px;")
        right_layout.addWidget(self.status)

        outer.addWidget(scroll)
        outer.addWidget(right, 1)
        self.setCentralWidget(central)

    def _build_file_group(self) -> QGroupBox:
        box = QGroupBox("1. 音频", self)
        layout = QVBoxLayout(box)
        row = QHBoxLayout()
        self.open_button = QPushButton("打开 WAV…", box)
        self.open_button.clicked.connect(self._open_dialog)
        self.demo_button = QPushButton("生成样例", box)
        self.demo_button.setToolTip("在系统临时目录生成 4.06 秒的合成口述样例并载入")
        self.demo_button.clicked.connect(self._load_demo)
        row.addWidget(self.open_button)
        row.addWidget(self.demo_button)
        layout.addLayout(row)
        self.file_label = QLabel("未载入音频", box)
        self.file_label.setWordWrap(True)
        self.file_label.setStyleSheet("color:#444;")
        layout.addWidget(self.file_label)
        return box

    @staticmethod
    def _spin(minimum: float, maximum: float, value: float, step: float,
              suffix: str) -> QDoubleSpinBox:
        spin = QDoubleSpinBox()
        spin.setRange(minimum, maximum)
        spin.setDecimals(1)
        spin.setSingleStep(step)
        spin.setValue(value)
        spin.setSuffix(suffix)
        return spin

    def _build_analysis_group(self) -> QGroupBox:
        box = QGroupBox("2. 分析参数", self)
        form = QFormLayout(box)
        form.setLabelAlignment(Qt.AlignRight)
        p = AnalysisParams()
        self.window_spin = self._spin(5, 200, p.window_ms, 5, " ms")
        self.hop_spin = self._spin(1, 100, p.hop_ms, 5, " ms")
        self.open_spin = self._spin(-90, 0, p.open_db, 1, " dBFS")
        self.close_spin = self._spin(-90, 0, p.close_db, 1, " dBFS")
        self.pause_spin = self._spin(0, 5000, p.min_pause_ms, 50, " ms")
        self.mins_seg_spin = self._spin(0, 5000, p.min_segment_ms, 20, " ms")
        self.lead_spin = self._spin(0, 2000, p.lead_ms, 10, " ms")
        self.tail_spin = self._spin(0, 2000, p.tail_ms, 10, " ms")
        self.conflict_combo = QComboBox(box)
        self.conflict_combo.addItem("重叠时合并 (merge)", "merge")
        self.conflict_combo.addItem("重叠时中点截断 (truncate)", "truncate")
        self.keep_pinned_check = QCheckBox("重新分析时保留锁定段", box)
        self.keep_pinned_check.setChecked(True)
        self.keep_pinned_check.setToolTip(
            "勾选后, 人工移动/调整过的段在重新分析时原样保留, 自动结果绕开它们"
        )

        form.addRow("分析窗", self.window_spin)
        form.addRow("窗移", self.hop_spin)
        form.addRow("开启门限", self.open_spin)
        form.addRow("关闭门限", self.close_spin)
        form.addRow("最短停顿切段", self.pause_spin)
        form.addRow("最短语音段", self.mins_seg_spin)
        form.addRow("段首余量", self.lead_spin)
        form.addRow("段尾余量", self.tail_spin)
        form.addRow("边界冲突", self.conflict_combo)
        form.addRow("", self.keep_pinned_check)

        self.analyze_button = QPushButton("重新分析", box)
        self.analyze_button.clicked.connect(self._analyze)
        form.addRow("", self.analyze_button)
        return box

    def _build_edit_group(self) -> QGroupBox:
        box = QGroupBox("3. 人工校对", self)
        layout = QVBoxLayout(box)
        hint = QLabel(
            "拖动段块平移 · 拖两端改边界 · 空白处拖拽新建。\n任何修改都会锁定该段。",
            box,
        )
        hint.setWordWrap(True)
        hint.setStyleSheet("color:#666; font-size:11px;")
        layout.addWidget(hint)

        row1 = QHBoxLayout()
        self.pin_button = QPushButton("切换锁定", box)
        self.pin_button.clicked.connect(self._toggle_pin)
        self.delete_button = QPushButton("删除段", box)
        self.delete_button.clicked.connect(self._delete_selected)
        row1.addWidget(self.pin_button)
        row1.addWidget(self.delete_button)
        layout.addLayout(row1)

        row2 = QHBoxLayout()
        self.unpin_all_button = QPushButton("全部解锁", box)
        self.unpin_all_button.clicked.connect(self._unpin_all)
        self.undo_button = QPushButton("撤销", box)
        self.undo_button.clicked.connect(self._undo)
        row2.addWidget(self.unpin_all_button)
        row2.addWidget(self.undo_button)
        layout.addLayout(row2)

        form = QFormLayout()
        self.start_spin = QSpinBox(box)
        self.start_spin.setRange(0, 2_000_000_000)
        self.end_spin = QSpinBox(box)
        self.end_spin.setRange(0, 2_000_000_000)
        self.start_spin.editingFinished.connect(self._on_boundary_spins)
        self.end_spin.editingFinished.connect(self._on_boundary_spins)
        form.addRow("起点样本", self.start_spin)
        form.addRow("终点样本", self.end_spin)
        layout.addLayout(form)
        return box

    def _build_play_group(self) -> QGroupBox:
        box = QGroupBox("4. 逐段试听", self)
        layout = QVBoxLayout(box)
        row = QHBoxLayout()
        self.play_button = QPushButton("播放选中段", box)
        self.play_button.setToolTip("Ctrl+P; 或在波形区按空格")
        self.play_button.clicked.connect(self._play_selected)
        self.stop_button = QPushButton("停止", box)
        self.stop_button.clicked.connect(self.player.stop)
        row.addWidget(self.play_button)
        row.addWidget(self.stop_button)
        layout.addLayout(row)
        self.loop_check = QCheckBox("循环播放当前段", box)
        self.loop_check.toggled.connect(self.player.set_loop)
        layout.addWidget(self.loop_check)
        self.play_label = QLabel("播放头: —", box)
        self.play_label.setStyleSheet("color:#444; font-family:monospace;")
        layout.addWidget(self.play_label)
        return box

    def _build_export_group(self) -> QGroupBox:
        box = QGroupBox("5. 导出", self)
        layout = QVBoxLayout(box)
        self.export_button = QPushButton("导出清单与片段…", box)
        self.export_button.clicked.connect(self._export)
        layout.addWidget(self.export_button)
        self.open_dir_button = QPushButton("打开导出目录", box)
        self.open_dir_button.clicked.connect(
            lambda: self.export_dir and open_in_file_manager(self.export_dir)
        )
        layout.addWidget(self.open_dir_button)
        self.export_label = QLabel("尚未导出", box)
        self.export_label.setWordWrap(True)
        self.export_label.setStyleSheet("color:#666; font-size:11px;")
        layout.addWidget(self.export_label)
        return box

    def _build_shortcuts(self) -> None:
        # 全局快捷只用不会和文本输入冲突的组合键。
        for keys, slot in (
            ("Ctrl+R", self._analyze),
            ("Ctrl+P", self._play_selected),
            ("Ctrl+E", self._export),
        ):
            action = QAction(self)
            action.setShortcut(QKeySequence(keys))
            action.setShortcutContext(Qt.WindowShortcut)
            action.triggered.connect(slot)
            self.addAction(action)

        # Delete/撤销只作用于波形区和切分表, 避免在输入框里按退格/撤销时
        # 误删整段或抢走输入框自己的撤销。
        for keys, slot in (
            (QKeySequence.Delete, self._delete_selected),
            (QKeySequence.Undo, self._undo),
        ):
            action = QAction(self)
            action.setShortcut(keys)
            action.setShortcutContext(Qt.WidgetWithChildrenShortcut)
            action.triggered.connect(slot)
            for widget in (self.waveform, self.table):
                widget.addAction(action)

    # ------------------------------------------------------------- 状态
    def _update_controls(self) -> None:
        has_audio = self.audio is not None
        has_segment = has_audio and 0 <= self.waveform.selected_index() < len(
            self.segments
        )
        for widget in (
            self.analyze_button,
            self.play_button,
            self.delete_button,
            self.pin_button,
            self.unpin_all_button,
            self.export_button,
        ):
            widget.setEnabled(has_audio)
        self.delete_button.setEnabled(has_segment)
        self.pin_button.setEnabled(has_segment)
        self.play_button.setEnabled(has_segment)
        self.export_button.setEnabled(has_audio and bool(self.segments))
        self.undo_button.setEnabled(bool(self._undo_stack))
        self.open_dir_button.setEnabled(self.export_dir is not None)
        self.start_spin.setEnabled(has_segment)
        self.end_spin.setEnabled(has_segment)
        self.loop_check.setEnabled(has_segment)

    def _set_status(self, text: str) -> None:
        self.status.setText(text)

    def _audio_ready(self) -> bool:
        if self.audio is None:
            QMessageBox.information(self, "提示", "请先打开 WAV 或生成样例。")
            return False
        return True

    # ------------------------------------------------------------- 文件
    def _open_dialog(self) -> None:
        start_dir = QStandardPaths.writableLocation(
            QStandardPaths.MusicLocation
        ) or str(Path.home())
        path, _ = QFileDialog.getOpenFileName(
            self, "选择 WAV 文件", start_dir, "WAV 音频 (*.wav *.WAV)"
        )
        if path:
            self.load_audio(path)

    def _load_demo(self) -> None:
        base = QStandardPaths.writableLocation(QStandardPaths.TempLocation) or str(
            Path.home()
        )
        target = Path(base) / "oral_segmenter_demo" / "oral_demo.wav"
        try:
            make_demo_wav(target)
        except OSError as exc:
            QMessageBox.critical(self, "生成样例失败", str(exc))
            return
        self.load_audio(target)
        self._set_status("已生成并载入 4.06 秒合成样例; 点“重新分析”即可。")

    def load_audio(self, path: str | Path) -> bool:
        try:
            audio = AudioData.from_wav(path)
        except AudioError as exc:
            QMessageBox.critical(self, "无法打开音频", str(exc))
            return False
        self.player.stop()
        self.audio = audio
        self.segments = []
        self._undo_stack.clear()
        self.export_dir = None
        self.export_label.setText("尚未导出")
        self.waveform.set_audio(audio)
        self.waveform.set_segments([])
        self.start_spin.setRange(0, audio.frame_count)
        self.end_spin.setRange(0, audio.frame_count)
        self.pause_spin.setMaximum(max(5000.0, audio.duration_seconds * 1000 / 2))
        self.file_label.setText(
            f"{Path(path).name}\n"
            f"{audio.sample_rate} Hz · {audio.channels} 声道 · "
            f"{audio.bit_depth} bit\n"
            f"{audio.frame_count} 帧 · {audio.duration_seconds:.3f} 秒"
        )
        self.play_label.setText("播放头: —")
        self._refresh_table()
        self._update_controls()
        self._set_status("已载入音频, 点“重新分析”生成初始切分。")
        return True

    # ------------------------------------------------------------- 分析
    def _collect_params(self) -> AnalysisParams:
        return AnalysisParams(
            window_ms=self.window_spin.value(),
            hop_ms=self.hop_spin.value(),
            open_db=self.open_spin.value(),
            close_db=self.close_spin.value(),
            min_pause_ms=self.pause_spin.value(),
            min_segment_ms=self.mins_seg_spin.value(),
            lead_ms=self.lead_spin.value(),
            tail_ms=self.tail_spin.value(),
            conflict_policy=self.conflict_combo.currentData(),
            keep_pinned=self.keep_pinned_check.isChecked(),
        )

    def _analyze(self) -> None:
        if not self._audio_ready():
            return
        self.player.stop()
        try:
            params = self._collect_params()
            pins = [seg for seg in self.segments if seg.pinned]
            segments = analyze(self.audio, params, pins=pins)
        except (ValueError, AudioError) as exc:
            QMessageBox.warning(self, "分析失败", str(exc))
            return
        self.params = params
        self._push_undo()
        self.segments = segments
        selected = 0 if segments else -1
        self.waveform.set_segments(self.segments)
        self.waveform.set_selected(selected)
        self._refresh_table(selected)
        self._update_controls()
        kept = len(pins) if params.keep_pinned else 0
        merged = sum(1 for seg in segments if seg.origin == "merged")
        message = f"分析完成: {len(segments)} 段"
        if kept:
            message += f", 保留 {kept} 个锁定段"
        if merged:
            message += f", {merged} 次重叠合并"
        self._set_status(message)

    # ------------------------------------------------------------- 编辑
    def _arm_drag_undo(self) -> None:
        self._drag_undo_pending = True

    def _clear_drag_undo(self) -> None:
        self._drag_undo_pending = False

    def _push_undo(self) -> None:
        self._undo_stack.append(list(self.segments))
        if len(self._undo_stack) > 50:
            self._undo_stack.pop(0)

    def _undo(self) -> None:
        if not self._undo_stack:
            return
        self.player.stop()
        self.segments = self._undo_stack.pop()
        index = self.waveform.selected_index()
        index = min(index, len(self.segments) - 1) if self.segments else -1
        self.waveform.set_segments(self.segments)
        self.waveform.set_selected(index)
        self._refresh_table(index)
        self._update_controls()
        self._set_status("已撤销上一步")

    def _after_edit(self, segments: list[Segment], index: int,
                    message: str | None = None) -> None:
        self.segments = segments
        self.waveform.set_segments(segments)
        self.waveform.set_selected(index)
        self._refresh_table(index)
        self._sync_boundary_spins(index)
        self._update_controls()
        if message:
            self._set_status(message)

    def _on_segment_edited(self, index: int, start: int, end: int) -> None:
        if self.audio is None or not (0 <= index < len(self.segments)):
            return
        self.player.stop()
        updated = resize_segment(
            self.segments, index, start, end, self.audio.frame_count, 1
        )
        if updated[index] == self.segments[index]:
            return
        if self._drag_undo_pending:
            self._push_undo()
            self._drag_undo_pending = False
        self._after_edit(updated, index)

    def _on_segment_moved(self, index: int, new_start: int) -> None:
        if self.audio is None or not (0 <= index < len(self.segments)):
            return
        if new_start == self.segments[index].start:
            return
        self.player.stop()
        updated = move_segment(
            self.segments, index, new_start, self.audio.frame_count, min_length=1
        )
        if updated[index] == self.segments[index]:
            return
        if self._drag_undo_pending:
            self._push_undo()
            self._drag_undo_pending = False
        self._after_edit(updated, index)

    def _on_create_requested(self, start: int, end: int) -> None:
        if self.audio is None:
            return
        self.player.stop()
        updated, index = insert_segment(
            self.segments, start, end, self.audio.frame_count, 1
        )
        if index is None:
            self._set_status("选区与已有段重叠或过短, 未新建")
            return
        self._push_undo()
        self._after_edit(updated, index, f"新建第 {index + 1} 段")

    def _on_boundary_spins(self) -> None:
        index = self.waveform.selected_index()
        if self.audio is None or not (0 <= index < len(self.segments)):
            return
        if self._suppress_table:
            return
        start = self.start_spin.value()
        end = self.end_spin.value()
        if (start, end) == (self.segments[index].start, self.segments[index].end):
            return
        updated = resize_segment(
            self.segments, index, start, end, self.audio.frame_count, 1
        )
        if updated[index] == self.segments[index]:
            # 数值被相邻段/文件边界夹住, 回写实际生效的边界
            self._sync_boundary_spins(index)
            return
        self._push_undo()
        self._after_edit(updated, index)

    def _delete_selected(self) -> None:
        index = self.waveform.selected_index()
        if not (0 <= index < len(self.segments)):
            return
        self.player.stop()
        self._push_undo()
        updated = delete_segment(self.segments, index)
        new_index = min(index, len(updated) - 1) if updated else -1
        self._after_edit(updated, new_index, f"已删除第 {index + 1} 段")

    def _toggle_pin(self) -> None:
        index = self.waveform.selected_index()
        if not (0 <= index < len(self.segments)):
            return
        self._push_undo()
        updated = list(self.segments)
        old = updated[index]
        if old.pinned:
            updated[index] = replace(old, pinned=False, adjusted=False)
        else:
            updated[index] = replace(old, pinned=True, adjusted=True,
                                     origin="manual")
        self._after_edit(updated, index)

    def _unpin_all(self) -> None:
        if not any(seg.pinned for seg in self.segments):
            return
        self._push_undo()
        self._after_edit(clear_pins(self.segments), self.waveform.selected_index(),
                         "已取消全部锁定")

    # ------------------------------------------------------------- 选择
    def _on_selection_changed(self, index: int) -> None:
        if index != self.waveform.selected_index():
            self.waveform.set_selected(index)
        if 0 <= index < len(self.segments):
            self._sync_table_selection(index)
        self._sync_boundary_spins(index)
        self._update_controls()
        if self.loop_check.isChecked() != self.player.is_looping:
            with QSignalBlocker(self.loop_check):
                self.loop_check.setChecked(self.player.is_looping)

    def _on_table_selection(self) -> None:
        if self._suppress_table:
            return
        rows = self.table.selectionModel().selectedRows()
        if not rows:
            return
        index = rows[0].row()
        if index != self.waveform.selected_index():
            self.waveform.set_selected(index)
        self._sync_boundary_spins(index)
        self._update_controls()
        if self.loop_check.isChecked() != self.player.is_looping:
            with QSignalBlocker(self.loop_check):
                self.loop_check.setChecked(self.player.is_looping)

    def _on_seek(self, sample: int) -> None:
        if self.audio is None:
            return
        if self.player.is_playing:
            self.player.stop()
        self.waveform.set_playhead(sample)
        self.play_label.setText(
            f"播放头: {sample} 样本  {format_timecode(sample, self.audio.sample_rate)}"
        )

    def _sync_boundary_spins(self, index: int) -> None:
        self._suppress_table = True
        try:
            has = 0 <= index < len(self.segments)
            self.start_spin.setEnabled(has)
            self.end_spin.setEnabled(has)
            if has:
                seg = self.segments[index]
                with QSignalBlocker(self.start_spin), QSignalBlocker(self.end_spin):
                    self.start_spin.setValue(seg.start)
                    self.end_spin.setValue(seg.end)
        finally:
            self._suppress_table = False

    # ------------------------------------------------------------- 播放
    def _play_selected(self) -> None:
        if self.audio is None:
            return
        index = self.waveform.selected_index()
        if not (0 <= index < len(self.segments)):
            self._set_status("先选中一段再试听")
            return
        if self.player.is_playing:
            self.player.stop()
            return
        seg = self.segments[index]
        start = seg.start
        playhead = self.waveform.playhead()  # 同一时间轴上的定位点
        if playhead is not None and seg.start <= playhead < seg.end:
            start = playhead
        self._play_source_start = start
        self.player.play_segment(self.audio, start, seg.end,
                                 loop=self.loop_check.isChecked())
        self._set_status(
            f"试听第 {index + 1} 段: 原始样本 {start}–{seg.end} "
            f"({format_timecode(start, self.audio.sample_rate)} → "
            f"{format_timecode(seg.end, self.audio.sample_rate)})"
        )

    def _on_player_position(self, played: int) -> None:
        if self.audio is None:
            return
        sample = min(
            max(0, self._play_source_start + played), self.audio.frame_count
        )
        self.waveform.set_playhead(sample)
        self.play_label.setText(
            f"播放头: {sample} 样本  {format_timecode(sample, self.audio.sample_rate)}"
        )

    def _on_playing_changed(self, playing: bool) -> None:
        self.play_button.setText("停止" if playing else "播放选中段")

    def _on_player_failed(self, message: str) -> None:
        self._set_status(message)
        QMessageBox.warning(self, "播放问题", message)

    # ------------------------------------------------------------- 表格
    def _refresh_table(self, selected: int | None = None) -> None:
        self._suppress_table = True
        try:
            self.table.setRowCount(len(self.segments))
            rate = self.audio.sample_rate if self.audio else 1
            for row, seg in enumerate(self.segments):
                values = (
                    str(row + 1),
                    str(seg.start),
                    str(seg.end),
                    f"{seg.length / rate:.3f}s",
                    f"{format_timecode(seg.start, rate)} → "
                    f"{format_timecode(seg.end, rate)}",
                    "●" if seg.pinned else "",
                    seg.origin,
                )
                for column, value in enumerate(values):
                    item = QTableWidgetItem(value)
                    if column in (0, 1, 2, 3, 5):
                        item.setTextAlignment(Qt.AlignRight | Qt.AlignVCenter)
                    self.table.setItem(row, column, item)
            if selected is not None and 0 <= selected < len(self.segments):
                self.table.selectRow(selected)
            elif not self.segments:
                self.table.clearSelection()
        finally:
            self._suppress_table = False

    def _sync_table_selection(self, index: int) -> None:
        self._suppress_table = True
        try:
            if 0 <= index < self.table.rowCount():
                self.table.selectRow(index)
        finally:
            self._suppress_table = False

    # ------------------------------------------------------------- 导出
    def _export(self) -> None:
        if not self._audio_ready():
            return
        if not self.segments:
            QMessageBox.information(self, "提示", "当前没有可导出的段。")
            return
        if any(seg.pinned for seg in self.segments):
            choice = QMessageBox.question(
                self,
                "包含锁定段",
                "当前切分里有保留的锁定段, 它们会按当前边界原样导出。继续?",
            )
            if choice != QMessageBox.Yes:
                return
        base = self.audio.path.parent if self.audio.path else Path.home()
        suggested = base / f"{self.audio.source_name}_segments"
        self.player.stop()
        directory = QFileDialog.getExistingDirectory(
            self, "选择导出目录", str(suggested)
        )
        if not directory:
            return
        target = Path(directory)
        if target.name != f"{self.audio.source_name}_segments":
            target = target / f"{self.audio.source_name}_segments"
        try:
            result = export_segments(
                self.audio,
                self.segments,
                target,
                params=self.params,
            )
        except (ExportError, AudioError, OSError) as exc:
            QMessageBox.critical(self, "导出失败", str(exc))
            return
        self.export_dir = result.directory
        self.export_label.setText(
            f"{result.directory}\n{len(result.wav_paths)} 个 WAV + CSV + manifest"
        )
        self._set_status(
            f"已导出 {len(result.wav_paths)} 段, 共 {result.total_samples} 样本"
        )
        self._update_controls()
        QMessageBox.information(
            self,
            "导出完成",
            f"目录: {result.directory}\n"
            f"清单: {result.csv_path.name}, {result.manifest_path.name}\n"
            f"片段: {len(result.wav_paths)} 个",
        )

    # ------------------------------------------------------------- 生命周期
    def closeEvent(self, event: QCloseEvent) -> None:  # noqa: N802
        self.player.release()
        super().closeEvent(event)
