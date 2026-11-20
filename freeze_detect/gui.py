"""PySide6 图形界面。

界面分成三块：
* 左侧参数区：相似度、最短持续时间、前后检查帧数、漂移容差等；
* 右上视频预览 + 时间轴(命中区间可视化、点击跳转、前后帧步进)；
* 右下命中列表：双击定位、人工标注(静态/黑场/忽略/正常)、导出帧截图。
"""

from __future__ import annotations

import os
import sys
import traceback
from typing import List, Optional

from PySide6.QtCore import Qt, QTimer, QUrl, Signal
from PySide6.QtGui import QAction, QColor, QFont, QImage, QPainter, QPen, QPixmap
from PySide6.QtWidgets import (
    QApplication,
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
    QMainWindow,
    QMessageBox,
    QProgressBar,
    QPushButton,
    QSpinBox,
    QSplitter,
    QStatusBar,
    QTableWidget,
    QTableWidgetItem,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from .annotations import AnnotationStore, export_report, export_snapshots
from .config import DetectionParams
from .detect import (
    AnalysisResult,
    Segment,
    analyze,
    format_timecode,
    summarize,
)
from .sample import generate_sample
from .timeline import FFmpegError, VideoTimeline, read_timeline

try:  # QtMultimedia 在部分环境缺失时给出更友好的提示
    from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer, QVideoSink
    from PySide6.QtMultimediaWidgets import QVideoWidget

    MULTIMEDIA_OK = True
except Exception:  # pragma: no cover - 依赖运行环境
    MULTIMEDIA_OK = False


class TimelineBar(QWidget):
    """简易时间轴：显示命中区间，点击跳转。"""

    seekRequested = Signal(float)

    def __init__(self) -> None:
        super().__init__()
        self.setMinimumHeight(46)
        self._duration = 0.0
        self._segments: List[Segment] = []
        self._current = 0.0
        self._selected: Optional[Segment] = None

    def set_duration(self, duration: float) -> None:
        self._duration = max(duration, 1e-6)
        self.update()

    def set_segments(self, segments: List[Segment]) -> None:
        self._segments = list(segments)
        self.update()

    def set_position(self, seconds: float) -> None:
        self._current = max(0.0, seconds)
        self.update()

    def set_selected(self, segment: Optional[Segment]) -> None:
        self._selected = segment
        self.update()

    def _x(self, t: float) -> float:
        return 6.0 + (self.width() - 12.0) * min(max(t / self._duration, 0.0), 1.0)

    def paintEvent(self, event) -> None:  # noqa: N802
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing)
        rect = self.rect().adjusted(6, 10, -6, -10)
        painter.fillRect(rect, QColor("#1e2228"))
        for seg in self._segments:
            left = self._x(seg.start_time)
            right = max(left + 2.0, self._x(seg.end_time))
            color = {
                "freeze": QColor("#ff5d5d"),
                "static": QColor("#f0b429"),
                "black": QColor("#6b7a8f"),
            }.get(seg.auto_kind, QColor("#ff5d5d"))
            if seg.ignored:
                color = QColor(color.red(), color.green(), color.blue(), 70)
            painter.fillRect(
                int(left), rect.top(), max(2, int(right - left)), rect.height(), color
            )
            if seg is self._selected:
                painter.setPen(QPen(QColor("#ffffff"), 1.5, Qt.DashLine))
                painter.drawRect(
                    int(left), rect.top(), max(2, int(right - left)), rect.height()
                )
        painter.setPen(QPen(QColor("#59d1ff"), 2))
        x = int(self._x(self._current))
        painter.drawLine(x, rect.top() - 4, x, rect.bottom() + 4)
        painter.setPen(QColor("#8a94a3"))
        painter.drawRect(rect)

    def mousePressEvent(self, event) -> None:  # noqa: N802
        if self._duration <= 0:
            return
        ratio = (event.position().x() - 6.0) / max(self.width() - 12.0, 1.0)
        ratio = min(max(ratio, 0.0), 1.0)
        self.seekRequested.emit(ratio * self._duration)


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("卡顿冻结检测器")
        self.resize(1280, 820)

        self.timeline: Optional[VideoTimeline] = None
        self.result: Optional[AnalysisResult] = None
        self.store: Optional[AnnotationStore] = None
        self.video_path: Optional[str] = None
        self._frames_cache: dict = {}

        self.player: Optional["QMediaPlayer"] = None
        self.video_widget: Optional["QVideoWidget"] = None
        self.video_sink: Optional["QVideoSink"] = None
        self.audio: Optional["QAudioOutput"] = None

        self._build_ui()
        self._build_menu()
        self.setStatusBar(QStatusBar())
        self.statusBar().showMessage("请打开视频，或点『生成样例』")

    # ------------------------------------------------------------------ UI
    def _build_ui(self) -> None:
        splitter = QSplitter(Qt.Horizontal)
        splitter.addWidget(self._build_left_panel())
        splitter.addWidget(self._build_right_panel())
        splitter.setStretchFactor(0, 0)
        splitter.setStretchFactor(1, 1)
        splitter.setSizes([340, 940])
        self.setCentralWidget(splitter)

    def _build_left_panel(self) -> QWidget:
        panel = QWidget()
        layout = QVBoxLayout(panel)

        file_box = QGroupBox("视频")
        file_layout = QVBoxLayout(file_box)
        self.path_edit = QLineEdit()
        self.path_edit.setReadOnly(True)
        self.path_edit.setPlaceholderText("未选择视频")
        file_layout.addWidget(self.path_edit)
        row = QHBoxLayout()
        open_btn = QPushButton("打开视频…")
        open_btn.clicked.connect(self.open_video)
        sample_btn = QPushButton("生成样例")
        sample_btn.clicked.connect(self.make_sample)
        row.addWidget(open_btn)
        row.addWidget(sample_btn)
        file_layout.addLayout(row)
        layout.addWidget(file_box)

        param_box = QGroupBox("检测参数")
        form = QFormLayout(param_box)
        self.sim_spin = QDoubleSpinBox()
        self.sim_spin.setRange(0.5, 1.0)
        self.sim_spin.setSingleStep(0.001)
        self.sim_spin.setDecimals(3)
        self.sim_spin.setValue(DetectionParams.similarity)
        self.sim_spin.setToolTip("相邻帧相似度阈值；越大越严格")
        form.addRow("相似度 ≥", self.sim_spin)

        self.min_dur_spin = QSpinBox()
        self.min_dur_spin.setRange(0, 60000)
        self.min_dur_spin.setSingleStep(100)
        self.min_dur_spin.setValue(500)
        self.min_dur_spin.setSuffix(" ms")
        self.min_dur_spin.setToolTip("停住画面最短实际展示时长")
        form.addRow("最短持续", self.min_dur_spin)

        self.hold_spin = QSpinBox()
        self.hold_spin.setRange(0, 60000)
        self.hold_spin.setSingleStep(50)
        self.hold_spin.setValue(200)
        self.hold_spin.setSuffix(" ms")
        self.hold_spin.setToolTip(
            "单帧长驻留阈值：某帧展示时长超过它即视为冻结（解码器卡住跳帧）"
        )
        form.addRow("单帧驻留 ≥", self.hold_spin)

        self.drift_spin = QDoubleSpinBox()
        self.drift_spin.setRange(0.0, 0.5)
        self.drift_spin.setSingleStep(0.001)
        self.drift_spin.setDecimals(3)
        self.drift_spin.setValue(0.0)
        self.drift_spin.setSpecialValueText("自动")
        self.drift_spin.setToolTip("相对锚点帧的累计漂移容差；自动 = 2.5×(1-相似度)")
        form.addRow("漂移容差", self.drift_spin)

        self.before_spin = QSpinBox()
        self.before_spin.setRange(0, 60)
        self.before_spin.setValue(4)
        form.addRow("前检帧数", self.before_spin)

        self.after_spin = QSpinBox()
        self.after_spin.setRange(0, 60)
        self.after_spin.setValue(4)
        form.addRow("后检帧数", self.after_spin)

        self.black_spin = QDoubleSpinBox()
        self.black_spin.setRange(0.0, 1.0)
        self.black_spin.setSingleStep(0.01)
        self.black_spin.setDecimals(2)
        self.black_spin.setValue(0.08)
        form.addRow("黑场亮度 ≤", self.black_spin)

        self.static_spin = QSpinBox()
        self.static_spin.setRange(0, 60000)
        self.static_spin.setSingleStep(500)
        self.static_spin.setValue(2000)
        self.static_spin.setSuffix(" ms")
        form.addRow("静态提示 ≥", self.static_spin)

        self.width_combo = QComboBox()
        for width in (160, 240, 320, 480):
            self.width_combo.addItem(str(width), width)
        self.width_combo.setCurrentIndex(1)
        form.addRow("分析宽度", self.width_combo)
        layout.addWidget(param_box)

        buttons = QHBoxLayout()
        self.run_btn = QPushButton("开始检测")
        self.run_btn.setEnabled(False)
        self.run_btn.clicked.connect(self.run_detection)
        self.export_btn = QPushButton("导出…")
        self.export_btn.setEnabled(False)
        self.export_btn.clicked.connect(self.export_results)
        buttons.addWidget(self.run_btn)
        buttons.addWidget(self.export_btn)
        layout.addLayout(buttons)

        self.progress = QProgressBar()
        self.progress.setRange(0, 100)
        self.progress.setValue(0)
        layout.addWidget(self.progress)

        annot_box = QGroupBox("人工标注")
        annot_layout = QVBoxLayout(annot_box)
        self.annot_label = QLabel("未选择片段")
        self.annot_label.setWordWrap(True)
        annot_layout.addWidget(self.annot_label)
        grid = QHBoxLayout()
        for text, label in (
            ("正常(冻结)", ""),
            ("静态画面", "static"),
            ("黑场", "black"),
            ("忽略", "skip"),
        ):
            btn = QPushButton(text)
            btn.clicked.connect(lambda _=False, lb=label: self.set_label(lb))
            grid.addWidget(btn)
        annot_layout.addLayout(grid)
        self.note_edit = QTextEdit()
        self.note_edit.setPlaceholderText("备注（随标注保存）")
        self.note_edit.setMaximumHeight(70)
        annot_layout.addWidget(self.note_edit)
        save_btn = QPushButton("保存标注")
        save_btn.clicked.connect(self.save_annotations)
        annot_layout.addWidget(save_btn)
        layout.addWidget(annot_box)
        layout.addStretch(1)
        return panel

    def _build_right_panel(self) -> QWidget:
        panel = QWidget()
        layout = QVBoxLayout(panel)

        if MULTIMEDIA_OK:
            self.player = QMediaPlayer(self)
            self.audio = QAudioOutput(self)
            self.audio.setMuted(True)
            self.player.setAudioOutput(self.audio)
            self.video_widget = QVideoWidget()
            self.video_widget.setMinimumHeight(300)
            self.video_widget.setStyleSheet("background:#101214;")
            self.player.setVideoOutput(self.video_widget)
            self.video_sink = self.player.videoSink()
            self.video_sink.videoFrameChanged.connect(self._on_video_frame)
            self._overlay: Optional[QLabel] = None
            layout.addWidget(self.video_widget, 3)
        else:  # pragma: no cover
            self.preview = QLabel("当前环境缺少 QtMultimedia，播放功能不可用")
            self.preview.setAlignment(Qt.AlignCenter)
            layout.addWidget(self.preview, 3)

        controls = QHBoxLayout()
        self.play_btn = QPushButton("播放")
        self.play_btn.clicked.connect(self.toggle_play)
        self.prev_btn = QPushButton("◀ 前一帧")
        self.prev_btn.clicked.connect(lambda: self.step_frame(-1))
        self.next_btn = QPushButton("后一帧 ▶")
        self.next_btn.clicked.connect(lambda: self.step_frame(1))
        self.time_label = QLabel("00:00:00.000 / 00:00:00.000")
        self.time_label.setFont(QFont("Menlo", 11))
        controls.addWidget(self.play_btn)
        controls.addWidget(self.prev_btn)
        controls.addWidget(self.next_btn)
        controls.addStretch(1)
        controls.addWidget(self.time_label)
        layout.addLayout(controls)

        self.timeline_bar = TimelineBar()
        self.timeline_bar.seekRequested.connect(self.seek_to)
        layout.addWidget(self.timeline_bar)

        self.summary_label = QLabel("")
        self.summary_label.setWordWrap(True)
        layout.addWidget(self.summary_label)

        self.table = QTableWidget(0, 7)
        self.table.setHorizontalHeaderLabels(
            ["#", "开始", "结束", "时长(ms)", "帧区间", "自动分类", "标注"]
        )
        self.table.horizontalHeader().setSectionResizeMode(QHeaderView.Stretch)
        self.table.verticalHeader().setVisible(False)
        self.table.setSelectionBehavior(QTableWidget.SelectRows)
        self.table.setSelectionMode(QTableWidget.SingleSelection)
        self.table.itemSelectionChanged.connect(self._on_select_segment)
        self.table.cellDoubleClicked.connect(self._on_double_click)
        layout.addWidget(self.table, 2)

        self.detail_label = QLabel(
            "提示：双击列表行可跳到该段；选中后可用左侧按钮标注。"
        )
        self.detail_label.setWordWrap(True)
        layout.addWidget(self.detail_label)
        return panel

    def _build_menu(self) -> None:
        file_menu = self.menuBar().addMenu("文件")
        act_open = QAction("打开视频…", self)
        act_open.triggered.connect(self.open_video)
        file_menu.addAction(act_open)
        act_sample = QAction("生成样例…", self)
        act_sample.triggered.connect(self.make_sample)
        file_menu.addAction(act_sample)
        act_export = QAction("导出结果…", self)
        act_export.triggered.connect(self.export_results)
        file_menu.addAction(act_export)
        file_menu.addSeparator()
        act_quit = QAction("退出", self)
        act_quit.triggered.connect(self.close)
        file_menu.addAction(act_quit)

    # ------------------------------------------------------------- helpers
    def _params(self) -> DetectionParams:
        drift = self.drift_spin.value()
        return DetectionParams(
            similarity=round(self.sim_spin.value(), 4),
            min_duration_ms=int(self.min_dur_spin.value()),
            hold_duration_ms=int(self.hold_spin.value()),
            drift_tolerance=None if drift <= 0 else round(drift, 4),
            context_before=int(self.before_spin.value()),
            context_after=int(self.after_spin.value()),
            black_luma=round(self.black_spin.value(), 3),
            static_hint_ms=int(self.static_spin.value()),
            analysis_width=int(self.width_combo.currentData()),
        )

    def _load_video(self, path: str) -> None:
        try:
            self.timeline = read_timeline(path)
        except FFmpegError as exc:
            QMessageBox.critical(self, "读取失败", str(exc))
            return
        self.video_path = path
        self.result = None
        self._frames_cache.clear()
        self.path_edit.setText(path)
        self.run_btn.setEnabled(True)
        self.export_btn.setEnabled(False)
        self.store = AnnotationStore.load(path)
        self.table.setRowCount(0)
        self.timeline_bar.set_segments([])
        self.timeline_bar.set_duration(self.timeline.duration)
        if self.player is not None:
            self.player.stop()
            self.player.setSource(QUrl.fromLocalFile(path))
            self.player.setPosition(0)
        self.time_label.setText(
            f"00:00:00.000 / {format_timecode(self.timeline.duration)}"
        )
        mode = "VFR(不等间隔帧)" if self.timeline.is_vfr else "CFR(等间隔帧)"
        self.statusBar().showMessage(
            f"{os.path.basename(path)}  {self.timeline.width}x{self.timeline.height}  "
            f"{self.timeline.frame_count} 帧  {self.timeline.duration:.2f}s  {mode}"
        )
        self.summary_label.setText(
            f"{self.timeline.frame_count} 帧 / {self.timeline.duration:.2f}s / {mode}"
        )

    def open_video(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self,
            "打开视频",
            "",
            "视频文件 (*.mp4 *.mov *.mkv *.avi *.webm *.m4v);;所有文件 (*)",
        )
        if path:
            self._load_video(path)

    def make_sample(self) -> None:
        default_dir = os.path.join(os.path.expanduser("~"), "freeze_samples")
        directory = QFileDialog.getExistingDirectory(self, "选择样例输出目录", default_dir)
        if not directory:
            return
        try:
            self.statusBar().showMessage("正在生成样例…")
            QApplication.processEvents()
            info = generate_sample(directory)
        except (FFmpegError, ValueError) as exc:
            QMessageBox.critical(self, "生成样例失败", str(exc))
            return
        self._load_video(info["video"])
        self.statusBar().showMessage(f"样例已生成: {info['video']}")
        self.run_detection()

    # ------------------------------------------------------------ detection
    def run_detection(self) -> None:
        if not self.video_path or not self.timeline:
            return
        params = self._params()
        self.progress.setValue(0)
        self.run_btn.setEnabled(False)
        self.statusBar().showMessage("正在检测…")
        QApplication.processEvents()

        def on_progress(done: int, total: int) -> None:
            if total:
                self.progress.setValue(min(99, int(done * 100 / total)))
            QApplication.processEvents()

        try:
            result = analyze(self.timeline, params, on_progress)
        except FFmpegError as exc:
            self.run_btn.setEnabled(True)
            QMessageBox.critical(self, "检测失败", str(exc))
            return
        except Exception:  # pragma: no cover - 保底
            self.run_btn.setEnabled(True)
            QMessageBox.critical(self, "检测失败", traceback.format_exc())
            return

        self.result = result
        if self.store is not None:
            self.store.apply(result.segments)
        self.progress.setValue(100)
        self.run_btn.setEnabled(True)
        self.export_btn.setEnabled(True)
        self._refresh_result()

    def _refresh_result(self) -> None:
        if not self.result:
            return
        result = self.result
        segs = result.segments
        self.table.blockSignals(True)
        self.table.setRowCount(len(segs))
        for row, seg in enumerate(segs):
            values = [
                str(row + 1),
                format_timecode(seg.start_time),
                format_timecode(seg.end_time),
                str(seg.duration_ms),
                seg.frame_range_text,
                seg.kind_display,
                seg.label_display,
            ]
            for col, value in enumerate(values):
                item = QTableWidgetItem(value)
                item.setFlags(item.flags() & ~Qt.ItemIsEditable)
                if seg.ignored:
                    item.setForeground(QColor("#8a94a3"))
                elif seg.auto_kind == "freeze":
                    item.setForeground(QColor("#ff7b7b"))
                self.table.setItem(row, col, item)
        self.table.blockSignals(False)
        self.timeline_bar.set_segments(segs)

        stats = summarize(result)
        mode = "VFR" if result.timeline.is_vfr else "CFR"
        self.summary_label.setText(
            f"命中 {stats['total']} 段：冻结 {stats['by_kind']['freeze']} / "
            f"静态 {stats['by_kind']['static']} / 黑场 {stats['by_kind']['black']}；"
            f"计入问题 {stats['active']} 段，共 "
            f"{stats['active_duration_ms'] / 1000:.2f}s。"
            f"（{mode}，逐帧时长）"
        )
        self.statusBar().showMessage(
            f"检测完成：{stats['total']} 段，计入问题 {stats['active']} 段"
        )
        if result.warning:
            self.statusBar().showMessage(result.warning)

    # ------------------------------------------------------------- preview
    def seek_to(self, seconds: float, play: bool = False) -> None:
        if not self.timeline:
            return
        seconds = max(0.0, min(seconds, self.timeline.duration))
        overlay = getattr(self, "_overlay", None)
        if overlay is not None:
            overlay.hide()
        if self.player is not None:
            self.player.setPosition(int(seconds * 1000))
            if play:
                self.player.play()
            self.time_label.setText(
                f"{format_timecode(seconds)} / {format_timecode(self.timeline.duration)}"
            )
        else:
            self._show_frame_at(seconds)
        self.timeline_bar.set_position(seconds)

    def _on_video_frame(self, frame) -> None:
        if frame is None or not frame.isValid():
            return
        t = frame.startTime() / 1_000_000.0
        self.timeline_bar.set_position(t)
        if self.timeline:
            self.time_label.setText(
                f"{format_timecode(t)} / {format_timecode(self.timeline.duration)}"
            )

    def _show_frame_at(self, seconds: float) -> None:
        """把指定时间对应的帧显示到预览控件(无播放器或逐帧步进时)。"""
        if not self.timeline:
            return
        self._render_frame(self.timeline.index_at(seconds))

    def _render_frame(self, index: int) -> None:
        if not self.timeline:
            return
        if self.player is not None:
            self.player.pause()
        parent = self.video_widget if self.video_widget is not None else self
        image = self._frames_cache.get(index)
        if image is None:
            image = self._extract_qimage(index)
            if image is None:
                return
            if len(self._frames_cache) > 48:
                self._frames_cache.clear()
            self._frames_cache[index] = image
        pixmap = QPixmap.fromImage(image)
        label = getattr(self, "_overlay", None)
        if label is None:
            label = QLabel(parent)
            label.setAlignment(Qt.AlignCenter)
            label.setStyleSheet("background:#101214;")
            self._overlay = label
        target = self.video_widget if self.video_widget is not None else self
        label.setParent(target)
        label.resize(target.size())
        label.setPixmap(
            pixmap.scaled(
                label.size(), Qt.KeepAspectRatio, Qt.SmoothTransformation
            )
        )
        label.show()
        label.raise_()

    def _extract_qimage(self, index: int) -> Optional[QImage]:
        import subprocess
        import tempfile

        assert self.timeline is not None
        tl = self.timeline
        abs_time = tl.start_time + tl.pts[index]
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as fh:
            tmp = fh.name
        cmd = [
            "ffmpeg", "-hide_banner", "-v", "error", "-y",
            "-ss", f"{abs_time:.6f}", "-i", tl.path,
            "-frames:v", "1", "-vf", "scale=960:-2:flags=lanczos",
            "-fps_mode", "passthrough", tmp,
        ]
        subprocess.run(cmd, capture_output=True)
        image = QImage(tmp)
        try:
            os.unlink(tmp)
        except OSError:
            pass
        return None if image.isNull() else image

    def step_frame(self, delta: int) -> None:
        if not self.timeline:
            return
        current_ms = self.player.position() if self.player is not None else 0
        index = self.timeline.index_at(current_ms / 1000.0)
        index = max(0, min(self.timeline.frame_count - 1, index + delta))
        self._render_frame(index)
        start, end = self.timeline.frame_time_range(index)
        abs_ms = int(round((self.timeline.start_time + start) * 1000))
        if self.player is not None:
            self.player.pause()
            self.player.setPosition(abs_ms)
        self.timeline_bar.set_position(start)
        self.time_label.setText(
            f"{format_timecode(start)} / {format_timecode(self.timeline.duration)}"
            f"  帧 {index}  [{self.timeline.durations[index] * 1000:.1f}ms]"
        )

    def toggle_play(self) -> None:
        if self.player is None or not self.video_path:
            return
        label = getattr(self, "_overlay", None)
        if label is not None:
            label.hide()
        if self.player.playbackState() == QMediaPlayer.PlayingState:
            self.player.pause()
            self.play_btn.setText("播放")
        else:
            self.player.play()
            self.play_btn.setText("暂停")

    # ------------------------------------------------------------ segments
    def _selected_segment(self) -> Optional[Segment]:
        if not self.result:
            return None
        rows = self.table.selectionModel().selectedRows()
        if not rows:
            return None
        row = rows[0].row()
        if 0 <= row < len(self.result.segments):
            return self.result.segments[row]
        return None

    def _on_select_segment(self) -> None:
        seg = self._selected_segment()
        if seg is None:
            self.annot_label.setText("未选择片段")
            self.timeline_bar.set_selected(None)
            return
        self.annot_label.setText(
            f"帧 {seg.frame_range_text}，{format_timecode(seg.start_time)} → "
            f"{format_timecode(seg.end_time)}，{seg.duration_ms}ms，"
            f"自动分类 {seg.kind_display}"
        )
        self.note_edit.setPlainText(seg.note)
        self.timeline_bar.set_selected(seg)
        before = "、".join(str(f.index) for f in seg.context_before) or "无"
        after = "、".join(str(f.index) for f in seg.context_after) or "无"
        self.detail_label.setText(
            f"前 {len(seg.context_before)} 帧: {before}    "
            f"后 {len(seg.context_after)} 帧: {after}    "
            f"最小相邻相似度 {seg.min_step_similarity:.5f}，"
            f"最大锚点漂移 {seg.max_drift:.5f}，"
            f"平均亮度 {seg.mean_luma:.3f}"
        )

    def _on_double_click(self, row: int, _column: int) -> None:
        if not self.result or not (0 <= row < len(self.result.segments)):
            return
        seg = self.result.segments[row]
        self.seek_to(seg.start_time)

    def set_label(self, label: str) -> None:
        seg = self._selected_segment()
        if seg is None:
            QMessageBox.information(self, "提示", "请先在列表中选择一个片段")
            return
        seg.label = label
        seg.note = self.note_edit.toPlainText().strip()
        if self.store is not None:
            if label:
                self.store.set(seg, label, seg.note)
            else:
                self.store.remove(seg)
            self.store.save(self.video_path or "", self.result)
        self._refresh_result()
        # 恢复选中行
        row = self.result.segments.index(seg) if self.result else -1
        if row >= 0:
            self.table.selectRow(row)
        self.statusBar().showMessage(
            f"片段 {seg.frame_range_text} 标注为「{seg.label_display}」，已保存"
        )

    def save_annotations(self) -> None:
        if self.store is None or not self.video_path or not self.result:
            return
        seg = self._selected_segment()
        if seg is not None and seg.label:
            self.store.set(seg, seg.label, self.note_edit.toPlainText().strip())
        path = self.store.save(self.video_path, self.result)
        self.statusBar().showMessage(f"标注已保存: {path}")

    # -------------------------------------------------------------- export
    def export_results(self) -> None:
        if not self.result:
            return
        directory = QFileDialog.getExistingDirectory(self, "选择导出目录", "")
        if not directory:
            return
        try:
            paths = export_report(
                self.result, directory, snapshots=True, clips=False
            )
        except (FFmpegError, OSError) as exc:
            QMessageBox.critical(self, "导出失败", str(exc))
            return
        QMessageBox.information(
            self,
            "导出完成",
            f"CSV: {paths['csv']}\nJSON: {paths['json']}\n"
            f"截图: {len(paths['snapshots'])} 张",
        )

    def closeEvent(self, event) -> None:  # noqa: N802
        if self.player is not None:
            self.player.stop()
        super().closeEvent(event)


def run_gui(argv: Optional[List[str]] = None) -> int:
    app = QApplication.instance() or QApplication(argv or sys.argv)
    app.setApplicationName("卡顿冻结检测器")
    window = MainWindow()
    window.show()
    return app.exec()


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(run_gui())
