"""主窗口: 把音频、时间轴、词表、边界报告和导出串起来."""

from __future__ import annotations

import os
import subprocess
import time

from PySide6.QtCore import QSettings, Qt
from PySide6.QtGui import QAction, QKeySequence
from PySide6.QtWidgets import (QApplication, QCheckBox, QComboBox, QDialog,
                               QDialogButtonBox, QFileDialog, QFrame, QHBoxLayout,
                               QLabel, QMainWindow, QMessageBox,
                               QPlainTextEdit, QProgressDialog, QPushButton,
                               QScrollArea, QSlider, QSpinBox,
                               QSplitter, QTabWidget, QToolButton,
                               QVBoxLayout, QWidget)

from . import __version__
from .audio import AudioError, AudioPlayer, ffmpeg_available
from .boundary_panel import BoundaryPanel
from .cue_table import CueTable
from .export import (ExportError, blocking_issues, export_bundle,
                     export_srt, export_video)
from .model import Cue, OperationResult, Timeline, format_ms
from .sample import build_sample
from .segmentation import segment_text
from .text_panel import TextPanel
from .timeline_view import TimelineView
from .video_preview import VideoPreview

APP_NAME = "wordcue"
STYLE = """
QMainWindow, QWidget { background:#0F1319; color:#D6DDE8; }
QWidget#Panel { background:#131820; border:1px solid #1F2732; border-radius:6px; }
QLabel#SectionTitle { color:#8E9BB0; font-size:11px; font-weight:600; letter-spacing:1px; }
QLabel#Time { color:#F5B942; font-size:15px; font-weight:600;
              font-family:"SF Mono","Menlo","Consolas",monospace; }
QLabel#Hint { color:#6E798B; }
QPushButton { background:#1E2733; color:#C3CAD6; border:1px solid #2E3A49;
              border-radius:4px; padding:5px 12px; }
QPushButton:hover { background:#273240; border-color:#3C4B5F; }
QPushButton:pressed { background:#151C25; }
QPushButton:disabled { color:#4C5563; border-color:#232B36; }
QPushButton#Accent { background:#F5B942; color:#14181F; border:0; font-weight:600; }
QPushButton#Accent:hover { background:#FFC95C; }
QPushButton#Accent:disabled { background:#5C4C26; color:#9A8A64; }
QPushButton#Ghost { background:transparent; border:1px solid #2E3A49; }
QToolButton { background:transparent; color:#C3CAD6; border:1px solid transparent;
              border-radius:4px; padding:4px; font-size:16px; }
QToolButton:hover { background:#1E2733; border-color:#2E3A49; }
QToolButton:checked { background:#2E2716; color:#F5B942; border-color:#5C4C26; }
QComboBox, QSpinBox, QLineEdit { background:#1A212B; color:#D6DDE8; border:1px solid #2A3442;
              border-radius:4px; padding:3px 6px; }
QComboBox::drop-down { border:0; width:16px; }
QSlider::groove:horizontal { height:4px; background:#242E3B; border-radius:2px; }
QSlider::sub-page:horizontal { background:#F5B942; border-radius:2px; }
QSlider::handle:horizontal { background:#F2F4F8; width:12px; margin:-5px 0;
              border-radius:6px; }
QTabWidget::pane { border:1px solid #1F2732; border-radius:4px; top:-1px; }
QTabBar::tab { background:#131820; color:#7D8899; padding:6px 14px; border:0;
               border-bottom:2px solid transparent; }
QTabBar::tab:selected { color:#E6EBF2; border-bottom-color:#F5B942; }
QTabBar::tab:hover { color:#C3CAD6; }
QSplitter::handle { background:#0F1319; }
QSplitter::handle:horizontal { width:4px; }
QSplitter::handle:vertical { height:4px; }
QScrollBar:vertical { background:#0F1319; width:10px; }
QScrollBar::handle:vertical { background:#2A3442; border-radius:5px; min-height:24px; }
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height:0; }
QScrollBar:horizontal { background:#0F1319; height:10px; }
QScrollBar::handle:horizontal { background:#2A3442; border-radius:5px; min-width:24px; }
QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal { width:0; }
QMessageBox { background:#131820; }
QProgressDialog { background:#131820; }
"""


def _section(title: str) -> QLabel:
    label = QLabel(title.upper())
    label.setObjectName("SectionTitle")
    return label


def _panel(*widgets: QWidget) -> QFrame:
    frame = QFrame()
    frame.setObjectName("Panel")
    layout = QVBoxLayout(frame)
    layout.setContentsMargins(10, 8, 10, 8)
    layout.setSpacing(6)
    for w in widgets:
        layout.addWidget(w)
    return frame


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("wordcue — 朗读逐词打轴")
        self.resize(1440, 900)
        self.timeline = Timeline(duration=10_000)
        self.player = AudioPlayer(self)
        self.settings = QSettings(APP_NAME, APP_NAME)
        self.project_path: str | None = None
        self._loop_cue: int | None = None
        self._loop_started = 0.0
        self._suppress = False
        self._dirty = False
        self._last_status = ""

        self._build_ui()
        self._build_menu()
        self._connect()
        self._load_timeline(self.timeline, peaks=None)
        self._status("就绪 · 「样例」按钮可生成一首带朗读的短诗")

    # ================================================================== UI
    def _build_ui(self) -> None:
        self.timeline_view = TimelineView()
        self.text_panel = TextPanel()
        self.video_preview = VideoPreview()
        self.cue_table = CueTable()
        self.boundary_panel = BoundaryPanel()

        # ---- 顶栏: 文件与播放
        self.btn_sample = QPushButton("生成样例")
        self.btn_open = QPushButton("打开项目…")
        self.btn_save = QPushButton("保存项目")
        self.btn_audio = QPushButton("载入音频…")
        self.btn_text = QPushButton("导入文本…")
        self.project_label = QLabel("未命名项目")
        self.project_label.setStyleSheet("color:#8E9BB0;")
        for b in (self.btn_sample, self.btn_open, self.btn_save, self.btn_audio,
                  self.btn_text):
            b.setStyleSheet(_ghost())
        self.btn_save.setObjectName("Ghost")

        self.btn_play = QToolButton()
        self.btn_play.setText("▶")
        self.btn_play.setToolTip("播放 / 暂停 (空格)")
        self.btn_prev_word = QToolButton(); self.btn_prev_word.setText("⏴|")
        self.btn_prev_word.setToolTip("跳到上一个词 (←)")
        self.btn_next_word = QToolButton(); self.btn_next_word.setText("|⏵")
        self.btn_next_word.setToolTip("跳到下一个词 (→)")
        self.btn_stop = QToolButton(); self.btn_stop.setText("■")
        self.btn_stop.setToolTip("回到开头 (Home)")
        self.btn_loop = QToolButton(); self.btn_loop.setText("⟲")
        self.btn_loop.setCheckable(True)
        self.btn_loop.setToolTip("循环播放选区/当前词 (L)")
        self.time_label = QLabel("0:00.000 / 0:00.000")
        self.time_label.setObjectName("Time")
        self.speed = QComboBox()
        for value in ("1.0x",):
            self.speed.addItem(value)
        self.speed.setEnabled(False)
        self.speed.setToolTip("打轴时固定 1.0x; 变速会破坏耳朵判断的节奏")
        self.vol = QSlider(Qt.Orientation.Horizontal)
        self.vol.setRange(0, 100)
        self.vol.setValue(90)
        self.vol.setFixedWidth(80)
        self.vol.setToolTip("音量")

        top = QWidget()
        top_layout = QHBoxLayout(top)
        top_layout.setContentsMargins(12, 8, 12, 6)
        top_layout.setSpacing(6)
        for w in (self.btn_sample, self.btn_open, self.btn_save, self.btn_audio,
                  self.btn_text):
            top_layout.addWidget(w)
        top_layout.addWidget(self.project_label, 1)
        top_layout.addWidget(self.btn_prev_word)
        top_layout.addWidget(self.btn_play)
        top_layout.addWidget(self.btn_next_word)
        top_layout.addWidget(self.btn_stop)
        top_layout.addWidget(self.btn_loop)
        top_layout.addWidget(self.time_label)
        top_layout.addWidget(self.speed)
        top_layout.addWidget(QLabel("🔊"))
        top_layout.addWidget(self.vol)

        # ---- 左侧: 文本 + 词表
        self.text_scroll = QScrollArea()
        self.text_scroll.setWidgetResizable(True)
        self.text_scroll.setWidget(self.text_panel)
        self.text_scroll.setFrameShape(QFrame.Shape.NoFrame)
        self.text_scroll.setMinimumHeight(90)

        self.tabs = QTabWidget()
        self.tabs.addTab(self.cue_table, "词表")
        self.tabs.addTab(self.boundary_panel, "边界报告")

        left = QWidget()
        left_layout = QVBoxLayout(left)
        left_layout.setContentsMargins(8, 4, 4, 8)
        left_layout.setSpacing(6)
        split = QSplitter(Qt.Orientation.Vertical)
        text_box = QWidget()
        text_layout = QVBoxLayout(text_box)
        text_layout.setContentsMargins(0, 0, 0, 0)
        text_layout.setSpacing(2)
        text_layout.addWidget(_section("文本 · 按词切分"))
        text_layout.addWidget(self.text_scroll, 1)
        split.addWidget(text_box)
        split.addWidget(self.tabs)
        split.setSizes([150, 530])
        split.setChildrenCollapsible(False)
        left_layout.addWidget(split, 1)

        # ---- 右侧: 预览
        right = QWidget()
        right_layout = QVBoxLayout(right)
        right_layout.setContentsMargins(4, 4, 8, 8)
        right_layout.setSpacing(4)
        right_layout.addWidget(_section("视频预览 · 9:16"))
        right_layout.addWidget(self.video_preview, 1)
        self.preview_hint = QLabel("预览与导出使用同一渲染器")
        self.preview_hint.setObjectName("Hint")
        self.preview_hint.setAlignment(Qt.AlignmentFlag.AlignCenter)
        right_layout.addWidget(self.preview_hint)
        right.setMinimumWidth(220)
        right.setMaximumWidth(420)

        body = QSplitter(Qt.Orientation.Horizontal)
        body.addWidget(left)
        body.addWidget(right)
        body.setStretchFactor(0, 1)
        body.setStretchFactor(1, 0)
        body.setSizes([1080, 300])
        body.setChildrenCollapsible(False)

        # ---- 时间轴
        timeline_box = QWidget()
        tl_layout = QVBoxLayout(timeline_box)
        tl_layout.setContentsMargins(10, 2, 10, 4)
        tl_layout.setSpacing(3)
        tl_layout.addWidget(self.timeline_view)
        tl_layout.setStretch(0, 1)

        # ---- 编辑工具条
        tools = self._build_toolbar()

        central = QWidget()
        main_layout = QVBoxLayout(central)
        main_layout.setContentsMargins(0, 0, 0, 0)
        main_layout.setSpacing(0)
        main_layout.addWidget(top)
        main_layout.addWidget(body, 1)
        main_layout.addWidget(tools)
        main_layout.addWidget(timeline_box)
        self.setCentralWidget(central)

        self.status_label = QLabel("")
        self.statusBar().addWidget(self.status_label, 1)
        self.statusBar().setStyleSheet("QStatusBar { background:#0B0E12; color:#8E9BB0; }")
        self._refresh_project_label()

    def _build_toolbar(self) -> QWidget:
        bar = QWidget()
        bar.setStyleSheet("QWidget { background:#0F1319; }")
        layout = QHBoxLayout(bar)
        layout.setContentsMargins(12, 2, 12, 4)
        layout.setSpacing(6)

        self.btn_split = QPushButton("拆分")
        self.btn_split.setToolTip("在光标处拆开选中的词 (S)")
        self.split_offset = QSpinBox()
        self.split_offset.setRange(-4000, 4000)
        self.split_offset.setSingleStep(10)
        self.split_offset.setSuffix(" ms")
        self.split_offset.setValue(0)
        self.split_offset.setToolTip("拆分点的微调 (相对光标)")
        self.btn_merge = QPushButton("合并")
        self.btn_merge.setToolTip("把选中的相邻词合并 (M)")
        self.btn_delete = QPushButton("删除词")
        self.btn_delete.setToolTip("删除选中的词, 不移动其他词 (Delete)")
        self.btn_pause = QPushButton("加停顿")
        self.btn_pause.setToolTip("在选中词后插入一个停顿区间")
        self.btn_set_start = QPushButton("设为开始")
        self.btn_set_start.setToolTip("把选中词的开始设为当前游标 ( [ )")
        self.btn_set_end = QPushButton("设为结束")
        self.btn_set_end.setToolTip("把选中词的结束设为当前游标 ( ] )")
        self.ripple = QToolButton()
        self.ripple.setText("联动")
        self.ripple.setCheckable(True)
        self.ripple.setChecked(True)
        self.ripple.setToolTip("拖动边界时同步相邻词的边界, 不留下空隙/重叠")

        self.shift_amount = QSpinBox()
        self.shift_amount.setRange(-60000, 60000)
        self.shift_amount.setSingleStep(10)
        self.shift_amount.setSuffix(" ms")
        self.shift_amount.setValue(50)
        self.btn_shift_minus = QPushButton("← 批量平移")
        self.btn_shift_plus = QPushButton("批量平移 →")
        self.btn_shift_minus.setToolTip("把选中的词整体左移; 会先预检边界")
        self.btn_shift_plus.setToolTip("把选中的词整体右移; 会先预检边界")

        for b in (self.btn_split, self.btn_merge, self.btn_delete, self.btn_pause,
                  self.btn_set_start, self.btn_set_end, self.btn_shift_minus,
                  self.btn_shift_plus):
            b.setStyleSheet(_ghost())
        self.btn_delete.setStyleSheet(_ghost(danger=True))

        layout.addWidget(self.ripple)
        layout.addWidget(self.btn_split)
        layout.addWidget(self.split_offset)
        layout.addWidget(self.btn_merge)
        layout.addWidget(self.btn_set_start)
        layout.addWidget(self.btn_set_end)
        layout.addWidget(self.btn_pause)
        layout.addWidget(self.btn_delete)
        layout.addSpacing(14)
        layout.addWidget(QLabel("批量平移"))
        layout.addWidget(self.btn_shift_minus)
        layout.addWidget(self.shift_amount)
        layout.addWidget(self.btn_shift_plus)
        layout.addStretch(1)

        self.btn_export_video = QPushButton("导出视频…")
        self.btn_export_srt = QPushButton("导出字幕")
        self.btn_export_srt.setStyleSheet(_ghost())
        layout.addWidget(self.btn_export_srt)
        layout.addWidget(self.btn_export_video)
        self.btn_export_video.setStyleSheet(
            "QPushButton { background:#F5B942; color:#14181F; border:0; border-radius:4px;"
            " padding:5px 14px; font-weight:600; }"
            " QPushButton:hover { background:#FFC95C; }"
            " QPushButton:disabled { background:#4A3F22; color:#8F8261; }")
        return bar

    def _build_menu(self) -> None:
        file_menu = self.menuBar().addMenu("文件")
        act_sample = QAction("生成样例项目", self, triggered=self.on_sample)
        act_open = QAction("打开项目…", self, shortcut=QKeySequence.StandardKey.Open,
                           triggered=self.on_open)
        act_save = QAction("保存项目", self, shortcut=QKeySequence.StandardKey.Save,
                           triggered=self.on_save)
        act_save_as = QAction("另存项目包…", self, triggered=self.on_save_bundle)
        act_audio = QAction("载入音频…", self, triggered=self.on_load_audio)
        act_text = QAction("导入文本…", self, shortcut=QKeySequence("Ctrl+Shift+T"),
                           triggered=self.on_import_text)
        act_quit = QAction("退出", self, shortcut=QKeySequence.StandardKey.Quit,
                           triggered=self.close)
        for a in (act_sample, act_open, act_save, act_save_as, act_audio, act_text):
            file_menu.addAction(a)
        file_menu.addSeparator()
        file_menu.addAction(act_quit)

        export_menu = self.menuBar().addMenu("导出")
        export_menu.addAction(QAction("导出视频…", self, triggered=self.on_export_video))
        export_menu.addAction(QAction("导出 SRT 字幕…", self, triggered=self.on_export_srt))
        export_menu.addAction(QAction("另存项目包 (含音频)…", self, triggered=self.on_save_bundle))

        help_menu = self.menuBar().addMenu("帮助")
        help_menu.addAction(QAction("快捷键", self, triggered=self.on_shortcuts))
        help_menu.addAction(QAction(f"关于 wordcue {__version__}", self, triggered=self.on_about))

        play = QAction(self, shortcut=QKeySequence(Qt.Key.Key_Space), triggered=self.toggle_play)
        play.setShortcutContext(Qt.ShortcutContext.ApplicationShortcut)
        self.addAction(play)
        for key, slot in (
            (Qt.Key.Key_Home, self.go_start),
            (Qt.Key.Key_End, self.go_end),
            (Qt.Key.Key_BracketLeft, lambda: self._set_selected_edge("start")),
            (Qt.Key.Key_BracketRight, lambda: self._set_selected_edge("end")),
            (Qt.Key.Key_S, self.on_split),
            (Qt.Key.Key_M, self.on_merge),
            (Qt.Key.Key_L, lambda: self.btn_loop.toggle()),
            (Qt.Key.Key_Delete, self.on_delete),
            (Qt.Key.Key_Backspace, self.on_delete),
        ):
            action = QAction(self)
            action.setShortcut(QKeySequence(key))
            action.triggered.connect(slot)
            self.addAction(action)

    def _connect(self) -> None:
        self.player.positionChanged.connect(self._on_position)
        self.player.playingChanged.connect(self._on_playing)
        self.timeline_view.positionClicked.connect(self.seek)
        self.timeline_view.selectionChanged.connect(self._select_from_view)
        self.timeline_view.cueActivated.connect(self.loop_cue)
        self.timeline_view.edgeDragged.connect(self._on_edge_dragged)
        self.timeline_view.cueMoved.connect(self._on_cue_moved)
        self.text_panel.selectionChanged.connect(self._select_from_view)
        self.text_panel.cueActivated.connect(self.loop_cue)
        self.cue_table.selectionChanged.connect(self._select_from_view)
        self.cue_table.cueSelected.connect(self.timeline_view.ensure_visible)
        self.cue_table.cueChanged.connect(self._on_cue_field)
        self.cue_table.cuePreview.connect(self._on_cue_preview)
        self.cue_table.seekRequested.connect(self.seek)
        self.boundary_panel.playPair.connect(self.play_pair)
        self.boundary_panel.selectionChanged.connect(self._select_from_view)

        self.btn_sample.clicked.connect(self.on_sample)
        self.btn_open.clicked.connect(self.on_open)
        self.btn_save.clicked.connect(self.on_save)
        self.btn_audio.clicked.connect(self.on_load_audio)
        self.btn_text.clicked.connect(self.on_import_text)
        self.btn_play.clicked.connect(self.toggle_play)
        self.btn_stop.clicked.connect(self.go_start)
        self.btn_prev_word.clicked.connect(lambda: self.jump_word(-1))
        self.btn_next_word.clicked.connect(lambda: self.jump_word(1))
        self.btn_loop.toggled.connect(self._on_loop_toggled)
        self.vol.valueChanged.connect(lambda v: self.player.set_volume(v / 100))
        self.btn_split.clicked.connect(self.on_split)
        self.btn_merge.clicked.connect(self.on_merge)
        self.btn_delete.clicked.connect(self.on_delete)
        self.btn_pause.clicked.connect(self.on_add_pause)
        self.btn_set_start.clicked.connect(lambda: self._set_selected_edge("start"))
        self.btn_set_end.clicked.connect(lambda: self._set_selected_edge("end"))
        self.btn_shift_minus.clicked.connect(lambda: self.on_shift(-1))
        self.btn_shift_plus.clicked.connect(lambda: self.on_shift(1))
        self.btn_export_video.clicked.connect(self.on_export_video)
        self.btn_export_srt.clicked.connect(self.on_export_srt)
        self.ripple.toggled.connect(lambda v: setattr(self.timeline_view, "ripple", v))

    # ============================================================== 数据加载
    def _load_timeline(self, timeline: Timeline, peaks=None, path: str | None = None) -> None:
        self.timeline = timeline
        self.project_path = path
        self._loop_cue = None
        self.timeline_view.set_timeline(timeline, peaks)
        self.timeline_view.set_selection([])
        self.text_panel.set_timeline(timeline)
        self.video_preview.set_timeline(timeline)
        self.cue_table.set_timeline(timeline)
        self.boundary_panel.set_timeline(timeline)
        self._on_position(self.player.position_ms if self.player.has_audio else 0)
        self._update_time_label(0)
        self._refresh_project_label()
        self._dirty = False
        self._update_actions()

    def _refresh_project_label(self) -> None:
        if self.project_path:
            name = os.path.basename(self.project_path)
        else:
            name = self.timeline.title or "未命名项目"
        audio = self.timeline.audio_path or "无音频"
        self.project_label.setText(f"{name}   ·   {os.path.basename(audio) if audio else '无音频'}"
                                   + ("   ●" if self._dirty else ""))

    def _mark_dirty(self) -> None:
        self._dirty = True
        self._refresh_project_label()

    def _update_actions(self) -> None:
        has_audio = self.player.has_audio
        for w in (self.btn_play, self.btn_stop, self.btn_prev_word, self.btn_next_word,
                  self.btn_loop):
            w.setEnabled(has_audio)
        self.btn_export_video.setEnabled(has_audio and ffmpeg_available())
        if not ffmpeg_available():
            self.btn_export_video.setToolTip("视频导出需要 FFmpeg; 可先导出 SRT 或项目包")

    # ============================================================== 播放
    def _on_position(self, ms: int) -> None:
        self.timeline_view.set_position(ms)
        self.text_panel.set_position(ms)
        self.video_preview.set_position(ms)
        self._update_time_label(ms)
        active = self._active_cue_at(ms)
        self.timeline_view.set_active_loop(self._loop_cue)
        self.text_panel.set_active(active)
        self.cue_table.set_active(active)
        if self._loop_cue is not None and self.player.is_playing:
            self.timeline_view.ensure_visible(ms)

    def _active_cue_at(self, ms: int) -> int | None:
        """当前游标所在的 word (停顿内返回 None), 与导出渲染使用同一判定."""
        for c in self.timeline.ordered_cues():
            if c.is_timed and c.start <= ms < c.end:
                return None if c.kind == "pause" else c.id
        return None

    def _update_time_label(self, ms: int) -> None:
        total = self.player.duration_ms or self.timeline.duration
        self.time_label.setText(f"{format_ms(ms)} / {format_ms(total)}")

    def _on_playing(self, playing: bool) -> None:
        self.btn_play.setText("❚❚" if playing else "▶")

    def toggle_play(self) -> None:
        if not self.player.has_audio:
            self._status("先载入音频或生成样例")
            return
        if self.player.is_playing:
            self.player.pause()
            return
        if self._loop_cue is not None:
            self.loop_cue(self._loop_cue, force=True)
        else:
            self.player.toggle()

    def seek(self, ms: int) -> None:
        self.player.seek(ms)
        self.timeline_view.ensure_visible(ms)

    def go_start(self) -> None:
        self.player.stop()
        self._loop_cue = None
        self.timeline_view.set_active_loop(None)

    def go_end(self) -> None:
        self.seek(self.player.duration_ms or self.timeline.duration)

    def jump_word(self, direction: int) -> None:
        cues = self.timeline.ordered_cues()
        if not cues:
            return
        pos = self.player.position_ms
        audio_time = sorted(cues, key=lambda c: c.start)
        if direction > 0:
            target = next((c for c in audio_time if c.start > pos + 2), None)
        else:
            target = next((c for c in reversed(audio_time) if c.start < pos - 60), None)
            if target is None:
                target = audio_time[0]
        if target:
            self._loop_cue = None
            self.seek(target.start)

    def loop_cue(self, cue_id: int, force: bool = False) -> None:
        try:
            cue = self.timeline.cue(cue_id)
        except KeyError:
            return
        if not cue.is_timed:
            self._status(f"「{cue.text}」尚未打轴, 先设置起止时间")
            return
        if self._loop_cue == cue_id and self.player.is_playing and not force:
            self.player.pause()
            return
        self._loop_cue = cue_id
        self.timeline_view.set_active_loop(cue_id)
        self.player.play_region(cue.start, cue.end, loop=True)
        self._status(f"循环听「{cue.text}」 {format_ms(cue.start)}–{format_ms(cue.end)}   (再按一次暂停)")

    def play_pair(self, prev_id: int, next_id: int) -> None:
        try:
            a = self.timeline.cue(prev_id)
            b = self.timeline.cue(next_id)
        except KeyError:
            return
        self._loop_cue = None
        self.timeline_view.set_active_loop(None)
        start = a.start - 120
        end = b.end + 120
        self.player.play_region(start, end, loop=False)
        self._status(f"试听边界「{a.text}」→「{b.text}」")

    def _on_loop_toggled(self, checked: bool) -> None:
        ids = self.timeline_view.selected
        if checked and ids:
            position = {c.id: i for i, c in enumerate(self.timeline.ordered_cues())}
            first = min(ids, key=lambda i: position.get(i, 1 << 30))
            self.loop_cue(first, force=True)
        elif not checked:
            self._loop_cue = None
            self.timeline_view.set_active_loop(None)
            if self.player.is_playing:
                self.player.pause()

    # ============================================================== 选择
    def _select_from_view(self, ids: list[int]) -> None:
        self.timeline_view.set_selection(ids)
        self.text_panel.set_selection(ids)
        self.cue_table.set_selection(ids)
        self._update_actions_for_selection()

    def _update_actions_for_selection(self) -> None:
        count = len(self.timeline_view.selected)
        self.btn_merge.setEnabled(count >= 2)
        self.btn_split.setEnabled(count == 1)
        self.btn_delete.setEnabled(count >= 1)
        self.btn_set_start.setEnabled(count >= 1)
        self.btn_set_end.setEnabled(count >= 1)
        self.btn_shift_minus.setEnabled(count >= 1)
        self.btn_shift_plus.setEnabled(count >= 1)
        self.btn_pause.setEnabled(count >= 1)

    def _selected(self) -> list[int]:
        return sorted(self.timeline_view.selected)

    # ============================================================== 编辑
    def _apply(self, result: OperationResult, *, quiet_info: bool = False) -> bool:
        if result.ok:
            self._after_change(result)
            msgs = result.warnings
            if msgs:
                self._status("⚠️ " + " / ".join(msgs))
            elif not quiet_info:
                infos = result.messages(("info",))
                if infos:
                    self._status(infos[-1])
            return True
        errors = result.errors
        self._status("⛔ " + " / ".join(errors))
        box = QMessageBox(self)
        box.setIcon(QMessageBox.Icon.Warning)
        box.setWindowTitle("操作被拦下")
        box.setText("这次修改没有生效:")
        box.setInformativeText("\n".join(f"• {e}" for e in errors))
        box.exec()
        return False

    def _after_change(self, result: OperationResult | None = None) -> None:
        self._dirty = True
        if result and result.changed_ids:
            keep = set(self.timeline_view.selected) | set(result.changed_ids)
            self.timeline_view.set_selection(sorted(keep))
        self.timeline_view.refresh_issues()
        self.text_panel.set_timeline(self.timeline)
        self.cue_table.set_timeline(self.timeline)
        self.boundary_panel.set_timeline(self.timeline)
        self.video_preview.set_timeline(self.timeline)
        self._update_actions_for_selection()
        self._refresh_project_label()
        self._on_position(self.player.position_ms)

    def on_split(self) -> None:
        ids = self._selected()
        if len(ids) != 1:
            self._status("拆分: 请只选中一个词, 并把游标放到拆分点")
            return
        cue = self.timeline.cue(ids[0])
        if not cue.is_timed:
            self._status(f"「{cue.text}」尚未打轴, 无法拆分")
            return
        cursor = self.player.position_ms + self.split_offset.value()
        if not (cue.start < cursor < cue.end):
            cursor = (cue.start + cue.end) // 2
            self._status("游标不在词内部, 已按中点拆分")
        if len(cue.text) <= 1:
            self._status("单个字的词不能拆分; 可以先合并再拆")
            return
        # 按游标位置选择最接近的字符边界
        ratio = (cursor - cue.start) / max(1, cue.duration)
        at = max(1, min(len(cue.text) - 1, int(round(ratio * len(cue.text)))))
        result = self.timeline.split_cue(cue.id, at, cursor)
        self._apply(result, quiet_info=False)

    def on_merge(self) -> None:
        ids = self._selected()
        if len(ids) < 2:
            self._status("合并: 请选中阅读顺序上连续的至少两个词")
            return
        preview = self.timeline.preview_merge(ids)
        if not preview.ok:
            self._apply(preview)
            return
        warnings = preview.warnings
        if warnings:
            answer = QMessageBox.question(
                self, "合并前确认",
                "合并后的区间会包含未选中的词:\n" + "\n".join(f"• {w}" for w in warnings)
                + "\n\n仍要合并吗?",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No)
            if answer != QMessageBox.StandardButton.Yes:
                self._status("已取消合并")
                return
        self._apply(self.timeline.merge_cues(ids))

    def on_delete(self) -> None:
        ids = self._selected()
        if not ids:
            return
        self._apply(self.timeline.delete_cues(ids))

    def on_add_pause(self) -> None:
        ids = self._selected()
        if len(ids) != 1:
            self._status("加停顿: 请选中停顿前的那个词")
            return
        cue = self.timeline.cue(ids[0])
        start = cue.end
        end = start + 250
        result = self.timeline.add_cue("停顿", start, end, "pause", after_id=cue.id)
        self._apply(result)

    def _set_selected_edge(self, edge: str) -> None:
        ids = self._selected()
        if len(ids) != 1:
            self._status("请只选中一个词")
            return
        value = self.player.position_ms
        result = self.timeline.set_edge(ids[0], edge, value, ripple=False)
        self._apply(result)

    def _on_edge_dragged(self, cue_id: int, edge: str, value: int, finished: bool) -> None:
        if self._suppress:
            return
        result = self.timeline.set_edge(cue_id, edge, value, ripple=self.ripple.isChecked())
        if result.ok:
            self.timeline_view.refresh_issues()
            self.cue_table.rebuild()
            self.text_panel.update()
            self.video_preview.set_timeline(self.timeline)
            self.boundary_panel.rebuild()
            self._dirty = True
            if finished:
                self._refresh_project_label()
        else:
            self._status("⛔ " + " / ".join(result.errors))

    def _on_cue_moved(self, cue_id: int, new_start: int, finished: bool) -> None:
        if self._suppress:
            return
        cue = self.timeline.cue(cue_id)
        result = self.timeline.move_cue(cue_id, new_start, new_start + cue.duration)
        if result.ok:
            self.timeline_view.refresh_issues()
            self.cue_table.rebuild()
            self.text_panel.set_timeline(self.timeline)
            self.video_preview.set_timeline(self.timeline)
            self.boundary_panel.rebuild()
            self._dirty = True
            if finished:
                self._status(result.messages(("info", "warning"))[-1] if result.issues else "")
                self._refresh_project_label()
        else:
            self._status("⛔ " + " / ".join(result.errors))

    def _on_cue_preview(self, cue_id: int, field: str, value: int) -> None:
        result = self.timeline.set_edge(cue_id, field, value, ripple=self.ripple.isChecked())
        if result.ok:
            self._after_change(result)
            self._status(result.messages(("info",))[-1] if result.issues else "")
        else:
            self._status("⛔ " + " / ".join(result.errors))
            self.cue_table.rebuild()

    def _on_cue_field(self, cue_id: int, field: str, value) -> None:
        if field == "text":
            result = self.timeline.set_cue_text(cue_id, value)
        elif field == "kind":
            result = self.timeline.set_cue_kind(cue_id, value)
        elif field == "note":
            result = self.timeline.set_cue_note(cue_id, value)
        else:
            return
        self._apply(result)
        if field == "text" and result.ok:
            self.text_panel.set_timeline(self.timeline)
            self.video_preview.set_timeline(self.timeline)

    def on_shift(self, direction: int) -> None:
        ids = self._selected()
        if not ids:
            self._status("批量平移: 请先选中要移动的词")
            return
        delta = direction * abs(self.shift_amount.value())
        if delta == 0:
            return
        preview = self.timeline.preview_shift(ids, delta)
        if not preview.ok:
            self._apply(preview)
            return
        # 预检通过也要让用户确认一次: 逐词边界是手工活, 批量移动最容易出错。
        notes = preview.warnings
        detail = "\n".join(f"• {n}" for n in notes) if notes else "平移后不会与相邻词重叠, 也不会越界。"
        answer = QMessageBox.question(
            self, "确认批量平移",
            f"将 {len(ids)} 个词整体平移 {delta:+d} ms。\n\n{detail}\n\n确认应用?",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.Yes)
        if answer != QMessageBox.StandardButton.Yes:
            self._status("已取消批量平移")
            return
        self._apply(self.timeline.shift_cues(ids, delta))

    # ============================================================== 文件
    def on_sample(self) -> None:
        if self._dirty and not self._confirm_discard():
            return
        folder = self.settings.value("last_sample_dir", "") or os.path.expanduser("~/Movies/wordcue")
        try:
            timeline = build_sample(folder)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "生成样例失败", str(exc))
            return
        self.settings.setValue("last_sample_dir", folder)
        try:
            self.player.load(timeline.audio_path)
        except AudioError as exc:
            QMessageBox.critical(self, "载入样例音频失败", str(exc))
            return
        self._load_timeline(timeline, peaks=self.player.peaks)
        self._status(f"样例已生成: {timeline.audio_path}  ·  {len(timeline.cues)} 个词, "
                     f"{format_ms(timeline.duration)}")

    def on_load_audio(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "选择朗读音频", self.settings.value("last_dir", ""),
            "音频 (*.wav *.mp3 *.m4a *.aac *.flac *.ogg *.opus *.aiff *.aif);;所有文件 (*)")
        if not path:
            return
        self.settings.setValue("last_dir", os.path.dirname(path))
        try:
            self.player.load(path)
        except AudioError as exc:
            QMessageBox.critical(self, "无法载入音频", str(exc))
            return
        timeline = Timeline(audio_path=path, duration=self.player.duration_ms,
                            sample_rate=48_000)
        # 保留已打好的轴, 只更新音频
        timeline.text = self.timeline.text
        timeline.title = self.timeline.title
        if self.timeline.cues:
            self.timeline.audio_path = path
            self.timeline.duration = self.player.duration_ms
            self.timeline_view.set_timeline(self.timeline, self.player.peaks)
            self._status(f"已替换音频: {os.path.basename(path)}; 原有时间轴保留, 请检查越界")
        else:
            self._load_timeline(timeline, peaks=self.player.peaks)
            self._status(f"已载入音频: {os.path.basename(path)} · {format_ms(timeline.duration)}")
        self._dirty = True
        self._refresh_project_label()
        self._update_actions()

    def on_import_text(self) -> None:
        if self.timeline.cues and self._dirty:
            answer = QMessageBox.question(
                self, "导入文本会替换现有词轴",
                f"当前已有 {len(self.timeline.cues)} 个词/停顿。导入新文本会替换掉现有词轴。\n\n继续?",
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
                QMessageBox.StandardButton.No)
            if answer != QMessageBox.StandardButton.Yes:
                return
        dialog = TextImportDialog(self.timeline.text_from_cues(), self)
        if dialog.exec() != QDialog.DialogCode.Accepted:
            return
        text = dialog.text()
        if not text:
            self._status("文本为空")
            return
        tokens = segment_text(text, cjk_chunk=dialog.chunk_size())
        duration = self.player.duration_ms or (self.timeline.duration if self.timeline.cues else 60_000)
        timeline = Timeline(duration=duration,
                            text=text, sample_rate=48_000,
                            audio_path=self.player.path or self.timeline.audio_path,
                            title=self.timeline.title)
        for word, kind in tokens:
            timeline.cues.append(Cue(timeline.new_id(), word, 0, 0, kind))
        timeline.reading_order = [c.id for c in timeline.cues]
        timeline.text = "".join(t for t, _ in tokens)
        if dialog.auto_layout():
            timeline.assign_untimed(0, timeline.duration)
        self._load_timeline(timeline, peaks=self.player.peaks)
        self._dirty = True
        self._refresh_project_label()
        self._status(f"已按 {len(tokens)} 个词/停顿切分"
                     + ("并临时铺开时间, 请逐词校正" if dialog.auto_layout() else "; 请逐个设置起止时间"))

    def on_open(self) -> None:
        if self._dirty and not self._confirm_discard():
            return
        path, _ = QFileDialog.getOpenFileName(
            self, "打开 wordcue 项目", self.settings.value("last_project_dir", ""),
            "wordcue 项目 (*.json);;所有文件 (*)")
        if not path:
            return
        self.settings.setValue("last_project_dir", os.path.dirname(path))
        try:
            timeline = Timeline.load(path)
        except (OSError, ValueError) as exc:
            QMessageBox.critical(self, "无法打开项目", str(exc))
            return
        audio = timeline.audio_path
        if audio and not os.path.isabs(audio):
            audio = os.path.join(os.path.dirname(path), audio)
        peaks = None
        if audio and os.path.exists(audio):
            try:
                self.player.load(audio)
                peaks = self.player.peaks
                timeline.audio_path = audio
                timeline.duration = self.player.duration_ms or timeline.duration
            except AudioError as exc:
                self._status(f"音频载入失败, 仅打开时间轴: {exc}")
        self._load_timeline(timeline, peaks=peaks, path=path)
        self._status(f"已打开 {os.path.basename(path)}")

    def on_save(self) -> None:
        if not self.project_path:
            self.on_save_bundle()
            return
        try:
            if self.player.has_audio:
                export_bundle(self.timeline, self.project_path, self.player.path)
            else:
                self.timeline.save(self.project_path)
        except OSError as exc:
            QMessageBox.critical(self, "保存失败", str(exc))
            return
        self._dirty = False
        self._refresh_project_label()
        self._status(f"已保存 {self.project_path}")

    def on_save_bundle(self) -> None:
        default = self.project_path or os.path.join(
            self.settings.value("last_project_dir", os.path.expanduser("~/Movies/wordcue")),
            "timeline.json")
        path, _ = QFileDialog.getSaveFileName(self, "保存项目包 (时间轴 + 音频)",
                                              default, "wordcue 项目 (*.json)")
        if not path:
            return
        self.settings.setValue("last_project_dir", os.path.dirname(path))
        try:
            export_bundle(self.timeline, path, self.player.path or self.timeline.audio_path)
        except OSError as exc:
            QMessageBox.critical(self, "保存失败", str(exc))
            return
        self.project_path = path
        self.timeline = Timeline.load(path)
        if self.timeline.audio_path:
            audio = os.path.join(os.path.dirname(path), self.timeline.audio_path)
            self.timeline.audio_path = audio
        self._dirty = False
        self._refresh_project_label()
        self._status(f"已保存项目包 {path}")

    def _confirm_discard(self) -> bool:
        answer = QMessageBox.question(
            self, "有未保存的修改", "当前项目有未保存的修改, 继续会丢失这些修改。",
            QMessageBox.StandardButton.Save | QMessageBox.StandardButton.Discard
            | QMessageBox.StandardButton.Cancel)
        if answer == QMessageBox.StandardButton.Save:
            self.on_save()
            return not self._dirty
        return answer == QMessageBox.StandardButton.Discard

    # ============================================================== 导出
    def _preflight(self) -> bool:
        blocking = blocking_issues(self.timeline)
        if not blocking:
            return True
        box = QMessageBox(self)
        box.setIcon(QMessageBox.Icon.Warning)
        box.setWindowTitle("导出前检查")
        box.setText("还有边界冲突未解决:")
        box.setInformativeText("\n".join(f"• {b}" for b in blocking[:8])
                               + ("\n…" if len(blocking) > 8 else ""))
        box.setStandardButtons(QMessageBox.StandardButton.Cancel | QMessageBox.StandardButton.Ignore)
        box.button(QMessageBox.StandardButton.Ignore).setText("仍然导出")
        return box.exec() == QMessageBox.StandardButton.Ignore

    def on_export_srt(self) -> None:
        if not self.timeline.cues:
            self._status("没有可导出的词")
            return
        base = os.path.splitext(self.project_path or "timeline.srt")[0]
        if base.endswith(".json"):
            base = base[:-5]
        path, _ = QFileDialog.getSaveFileName(self, "导出 SRT", base + ".srt", "SRT 字幕 (*.srt)")
        if not path:
            return
        count = export_srt(self.timeline, path)
        self._status(f"已导出 {count} 条字幕: {path}")

    def on_export_video(self) -> None:
        if not self.player.has_audio:
            self._status("导出视频需要音频")
            return
        if not self._preflight():
            return
        default_dir = os.path.dirname(self.project_path) if self.project_path else os.path.expanduser("~/Movies/wordcue")
        os.makedirs(default_dir, exist_ok=True)
        default = os.path.join(default_dir, "wordcue_" + time.strftime("%Y%m%d_%H%M%S") + ".mp4")
        path, _ = QFileDialog.getSaveFileName(self, "导出短视频", default, "MP4 视频 (*.mp4)")
        if not path:
            return

        dialog = QProgressDialog("准备导出…", "取消", 0, 100, self)
        dialog.setWindowTitle("导出视频")
        dialog.setWindowModality(Qt.WindowModality.WindowModal)
        dialog.setMinimumDuration(0)
        dialog.setAutoClose(False)

        def progress(fraction: float, message: str) -> bool:
            dialog.setValue(int(fraction * 100))
            dialog.setLabelText(message)
            QApplication.processEvents()
            return not dialog.wasCanceled()

        try:
            export_video(self.timeline, self.player.path, path,
                         progress=progress)
        except ExportError as exc:
            dialog.close()
            QMessageBox.critical(self, "导出失败", str(exc))
            return
        dialog.close()
        self._status(f"已导出视频: {path}")
        answer = QMessageBox.question(
            self, "导出完成", f"视频已保存:\n{path}\n\n现在打开所在文件夹?",
            QMessageBox.StandardButton.Open | QMessageBox.StandardButton.Close)
        if answer == QMessageBox.StandardButton.Open:
            self._reveal(path)

    def _reveal(self, path: str) -> None:
        try:
            if os.name == "posix" and os.uname().sysname == "Darwin":
                subprocess.Popen(["open", "-R", path])
            elif os.name == "nt":
                subprocess.Popen(["explorer", "/select,", path])
            else:
                subprocess.Popen(["xdg-open", os.path.dirname(path)])
        except OSError:
            pass

    # ============================================================== 杂项
    def _status(self, text: str) -> None:
        self._last_status = text
        self.status_label.setText(text)

    def on_shortcuts(self) -> None:
        QMessageBox.information(
            self, "快捷键",
            "空格  播放 / 暂停\n"
            "← / →  游标前后 1 ms, Shift 加速 100 ms\n"
            "双击词  循环听该词 (再双击取消)\n"
            "L  循环播放选中词\n"
            "S  在游标处拆分选中的词\n"
            "M  合并选中的相邻词\n"
            "[ / ]  把选中词的开始 / 结束设为游标\n"
            "Delete  删除选中的词 (不移动其他词)\n"
            "滚轮  时间轴缩放; Shift+滚轮 平移\n"
            "Home / End  回到开头 / 末尾")

    def on_about(self) -> None:
        QMessageBox.about(
            self, "关于 wordcue",
            f"wordcue {__version__}\n\n本地朗读逐词打轴: 手工标记词与停顿的时间, "
            "合并/拆分词, 批量平移, 导出可重开的项目包与带高亮的短视频。\n\n"
            "音频解码与视频合成使用 FFmpeg; 界面基于 PySide6。")

    def closeEvent(self, event) -> None:  # noqa: N802
        if self._dirty and not self._confirm_discard():
            event.ignore()
            return
        self.player.pause()
        event.accept()


def _ghost(danger: bool = False) -> str:
    color = "#E45757" if danger else "#C3CAD6"
    hover = "#3A2026" if danger else "#273240"
    return (f"QPushButton {{ background:#1A212B; color:{color}; border:1px solid #2A3442;"
            f" border-radius:4px; padding:4px 10px; }}"
            f" QPushButton:hover {{ background:{hover}; }}"
            " QPushButton:disabled { color:#4C5563; border-color:#232B36; }")


class TextImportDialog(QDialog):
    """粘贴一段文本, 选择切词粒度, 预览切分结果。"""

    def __init__(self, initial: str = "", parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("导入文本")
        self.resize(620, 520)
        self.editor = QPlainTextEdit(initial)
        self.editor.setPlaceholderText("把朗读稿粘贴到这里, 标点会单独成为停顿……")
        self.editor.setStyleSheet(
            "QPlainTextEdit { background:#12161D; color:#D6DDE8; border:1px solid #2A3442;"
            " border-radius:4px; padding:6px; font-size:14px; }")
        self.chunk = QSpinBox()
        self.chunk.setRange(1, 6)
        self.chunk.setValue(2)
        self.chunk.setPrefix("每 ")
        self.chunk.setSuffix(" 个字切一词")
        self.auto = QCheckBox("先按字数临时铺开时间 (之后逐词校正)")
        self.auto.setChecked(True)
        self.preview = QLabel("")
        self.preview.setWordWrap(True)
        self.preview.setStyleSheet("color:#8E9BB0; background:#12161D; border:1px solid #222B37;"
                                   " border-radius:4px; padding:6px;")
        self.preview.setMinimumHeight(90)
        self.preview.setAlignment(Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignLeft)
        self._refresh()

        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Ok
                                   | QDialogButtonBox.StandardButton.Cancel)
        buttons.button(QDialogButtonBox.StandardButton.Ok).setText("导入")
        buttons.button(QDialogButtonBox.StandardButton.Cancel).setText("取消")
        buttons.button(QDialogButtonBox.StandardButton.Ok).setStyleSheet(
            "QPushButton { background:#F5B942; color:#14181F; border:0; border-radius:4px;"
            " padding:5px 16px; font-weight:600; }")
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)

        layout = QVBoxLayout(self)
        layout.addWidget(self.editor, 1)
        row = QHBoxLayout()
        row.addWidget(self.chunk)
        row.addWidget(self.auto)
        row.addStretch(1)
        layout.addLayout(row)
        layout.addWidget(QLabel("切分预览:"))
        layout.addWidget(self.preview)
        layout.addWidget(buttons)
        self.editor.textChanged.connect(self._refresh)
        self.chunk.valueChanged.connect(self._refresh)

    def _refresh(self) -> None:
        tokens = segment_text(self.editor.toPlainText(), self.chunk.value())
        if not tokens:
            self.preview.setText("—")
            return
        words = sum(1 for _, k in tokens if k == "word")
        pauses = len(tokens) - words
        chips = "  ".join(("⏸ " if k == "pause" else "") + t for t, k in tokens[:80])
        self.preview.setText(f"{words} 个词 + {pauses} 个停顿\n{chips}"
                             + (" …" if len(tokens) > 80 else ""))

    def text(self) -> str:
        return self.editor.toPlainText().strip()

    def chunk_size(self) -> int:
        return self.chunk.value()

    def auto_layout(self) -> bool:
        return self.auto.isChecked()
