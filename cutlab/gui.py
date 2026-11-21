"""CutLab 主窗口。"""

from __future__ import annotations

import html
import os
import tempfile
from pathlib import Path

from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QAction, QColor
from PySide6.QtWidgets import (QAbstractItemView, QApplication, QCheckBox,
                               QComboBox, QDoubleSpinBox, QFileDialog,
                               QFormLayout, QFrame, QGridLayout, QGroupBox,
                               QHBoxLayout, QHeaderView, QLabel, QLineEdit,
                               QMainWindow, QMessageBox, QProgressBar,
                               QPushButton, QSpinBox,
                               QSplitter, QTableWidget, QTableWidgetItem,
                               QTabWidget, QTextBrowser, QVBoxLayout, QWidget)

from . import (__version__, audio, barcode, cut, ffmpeg, gui_tasks, media,
               sample, timemap, verify)
from .gui_widgets import FrameTile, TimelineWidget


def _fmt(value: float | None, digits: int = 3, suffix: str = "") -> str:
    if value is None:
        return "—"
    return f"{value:.{digits}f}{suffix}"


def _severity_color(level: str) -> str:
    return {"ok": "#7ee7a0", "warn": "#ffd05c", "bad": "#ff7668"}.get(level, "#d8e0f0")


SEVERITY_TEXT = {"ok": "正常", "warn": "注意", "bad": "偏差大"}


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle(f"CutLab · 短视频截取检查  v{__version__}")
        self.resize(1280, 880)
        self.setMinimumSize(1040, 720)

        self.workdir = Path(tempfile.mkdtemp(prefix="cutlab-"))
        self.info: media.MediaInfo | None = None
        self._thumb_cache: dict[str, Path] = {}
        self._copy_out: cut.OutputMeasure | None = None
        self._reenc_out: cut.OutputMeasure | None = None
        self._copy_align: audio.Alignment | None = None
        self._reenc_align: audio.Alignment | None = None
        self._last_deviations: list[cut.Deviation] = []

        self._build_actions()
        self._build_ui()
        self._apply_style()
        self.statusBar().showMessage(
            f"输出目录 {self.workdir} · {ffmpeg.version_line()}")

    # ------------------------------------------------------------------
    # 外观 / 菜单
    # ------------------------------------------------------------------
    def _apply_style(self) -> None:
        self.setStyleSheet("""
            QMainWindow, QWidget { background: #161a24; color: #d8e0f0; }
            QGroupBox {
                border: 1px solid #2c3442; border-radius: 6px;
                margin-top: 14px; padding-top: 6px; font-weight: 600;
            }
            QGroupBox::title {
                subcontrol-origin: margin; left: 10px; padding: 0 4px;
                color: #8fb4e8;
            }
            QLineEdit, QComboBox, QDoubleSpinBox, QSpinBox {
                background: #1e2431; border: 1px solid #333d4d;
                border-radius: 4px; padding: 4px 6px; selection-background-color: #3b6ea5;
            }
            QPushButton {
                background: #262e3d; border: 1px solid #3a4558;
                border-radius: 4px; padding: 5px 12px;
            }
            QPushButton:hover { background: #303a4c; }
            QPushButton:disabled { color: #6b7688; background: #1d222c; }
            QPushButton#primary {
                background: #2f6fb5; border-color: #3f83cc; font-weight: 600;
            }
            QPushButton#primary:hover { background: #3a7ec6; }
            QTabWidget::pane { border: 1px solid #2c3442; border-radius: 6px; }
            QTabBar::tab {
                background: #1c2230; padding: 7px 16px; margin-right: 2px;
                border-top-left-radius: 5px; border-top-right-radius: 5px;
            }
            QTabBar::tab:selected { background: #2a3346; color: #9cc9ff; }
            QTableWidget {
                background: #1a202b; gridline-color: #2a3242;
                border: 1px solid #2c3442; alternate-background-color: #1e2532;
            }
            QHeaderView::section {
                background: #232b3a; color: #a9b8d2; border: none;
                padding: 5px; border-bottom: 1px solid #2c3442;
            }
            QProgressBar {
                background: #1c2230; border: 1px solid #333d4d;
                border-radius: 4px; text-align: center;
            }
            QProgressBar::chunk { background: #2f6fb5; border-radius: 3px; }
            QTextBrowser {
                background: #1a202b; border: 1px solid #2c3442;
                border-radius: 4px;
            }
            QSplitter::handle { background: #2a3242; }
            QFrame#frameTile {
                background: #1b2130; border: 1px solid #2c3442; border-radius: 6px;
            }
            QLabel#tileTitle { color: #9cc9ff; font-weight: 600; }
            QLabel#tileImage { color: #6d7a90; background: #12161f; border-radius: 4px; }
            QLabel#tileCaption { color: #b6c3da; font-size: 11px; }
            QLabel#badge {
                border-radius: 8px; padding: 2px 8px; font-weight: 600;
            }
        """)

    def _build_actions(self) -> None:
        open_action = QAction("打开视频…", self)
        open_action.setShortcut("Ctrl+O")
        open_action.triggered.connect(self.open_file)
        sample_action = QAction("使用内置样例", self)
        sample_action.setShortcut("Ctrl+D")
        sample_action.triggered.connect(lambda: self.load_builtin_sample(False))
        offset_action = QAction("使用非零起点样例", self)
        offset_action.triggered.connect(lambda: self.load_builtin_sample(True))
        quit_action = QAction("退出", self)
        quit_action.setShortcut("Ctrl+Q")
        quit_action.triggered.connect(self.close)

        menu = self.menuBar().addMenu("文件")
        menu.addAction(open_action)
        menu.addSeparator()
        menu.addAction(sample_action)
        menu.addAction(offset_action)
        menu.addSeparator()
        menu.addAction(quit_action)

        help_menu = self.menuBar().addMenu("帮助")
        about = QAction("关于 / 工作原理", self)
        about.triggered.connect(self.show_about)
        help_menu.addAction(about)

    def _build_ui(self) -> None:
        central = QWidget()
        root = QVBoxLayout(central)
        root.setContentsMargins(12, 10, 12, 10)
        root.setSpacing(8)

        root.addWidget(self._build_toolbar())

        self.tabs = QTabWidget()
        self.tabs.addTab(self._build_keyframe_tab(), "① 关键帧与范围")
        self.tabs.addTab(self._build_compare_tab(), "② 截取对比")
        self.tabs.addTab(self._build_timemap_tab(), "③ 非零起点定位")
        self.tabs.addTab(self._build_verify_tab(), "④ 样例与验证")
        root.addWidget(self.tabs, 1)
        self.setCentralWidget(central)

    def _build_toolbar(self) -> QWidget:
        bar = QFrame()
        bar.setObjectName("toolbar")
        layout = QHBoxLayout(bar)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(8)

        self.path_edit = QLineEdit()
        self.path_edit.setPlaceholderText("选择本地短视频，或直接使用内置样例")
        self.path_edit.setReadOnly(True)
        open_btn = QPushButton("打开视频…")
        open_btn.clicked.connect(self.open_file)
        sample_btn = QPushButton("内置样例")
        sample_btn.clicked.connect(lambda: self.load_builtin_sample(False))
        layout.addWidget(QLabel("视频"))
        layout.addWidget(self.path_edit, 1)
        layout.addWidget(open_btn)
        layout.addWidget(sample_btn)

        self.progress = QProgressBar()
        self.progress.setFixedWidth(180)
        self.progress.setRange(0, 100)
        self.progress.setValue(0)
        self.progress.setTextVisible(True)
        self.progress.setFormat("%p%")
        layout.addWidget(self.progress)
        return bar

    # ------------------------------------------------------------------
    # ① 关键帧
    # ------------------------------------------------------------------
    def _build_keyframe_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setContentsMargins(12, 12, 12, 12)
        layout.setSpacing(10)

        self.media_summary = QLabel("尚未导入视频")
        self.media_summary.setWordWrap(True)
        self.media_summary.setObjectName("mediaSummary")
        layout.addWidget(self.media_summary)

        self.timeline = TimelineWidget()
        self.timeline.seekRequested.connect(self._on_timeline_seek)
        layout.addWidget(self.timeline)

        splitter = QSplitter(Qt.Orientation.Horizontal)

        left = QWidget()
        left_layout = QVBoxLayout(left)
        left_layout.setContentsMargins(0, 0, 0, 0)
        table_title = QLabel("可用作起点的关键画面（内容时间为实际帧时间）")
        table_title.setStyleSheet("color:#9cc9ff; font-weight:600;")
        self.kf_table = QTableWidget(0, 4)
        self.kf_table.setHorizontalHeaderLabels(
            ["关键帧", "内容时间", "绝对 PTS", "帧号"])
        self.kf_table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.kf_table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.kf_table.setAlternatingRowColors(True)
        self.kf_table.verticalHeader().setVisible(False)
        header = self.kf_table.horizontalHeader()
        header.setSectionResizeMode(QHeaderView.ResizeMode.Stretch)
        self.kf_table.itemSelectionChanged.connect(self._on_keyframe_selected)
        self.kf_table.itemDoubleClicked.connect(self._on_keyframe_double_clicked)
        left_layout.addWidget(table_title)
        left_layout.addWidget(self.kf_table, 1)

        right = QWidget()
        right_layout = QVBoxLayout(right)
        right_layout.setContentsMargins(0, 0, 0, 0)
        self.kf_preview = FrameTile("关键帧预览")
        self.kf_preview.setMinimumSize(320, 240)
        right_layout.addWidget(self.kf_preview, 1)
        self.kf_meta = QLabel("在左侧选一个关键帧查看详情")
        self.kf_meta.setWordWrap(True)
        right_layout.addWidget(self.kf_meta)

        splitter.addWidget(left)
        splitter.addWidget(right)
        splitter.setStretchFactor(0, 3)
        splitter.setStretchFactor(1, 2)
        layout.addWidget(splitter, 1)

        layout.addWidget(self._build_range_group())
        return page

    def _build_range_group(self) -> QWidget:
        group = QGroupBox("截取范围（内容时间，0 = 视频首帧）")
        layout = QGridLayout(group)
        layout.setContentsMargins(12, 16, 12, 10)
        layout.setHorizontalSpacing(10)

        self.start_spin = self._time_spin()
        self.end_spin = self._time_spin()
        self.start_spin.valueChanged.connect(self._on_range_changed)
        self.end_spin.valueChanged.connect(self._on_range_changed)
        self.start_spin.valueChanged.connect(lambda v: self.timeline.set_cursor(v))

        self.snap_start_btn = QPushButton("吸附到前一关键帧")
        self.snap_start_btn.clicked.connect(lambda: self._snap(True))
        self.snap_end_btn = QPushButton("吸附到后一关键帧")
        self.snap_end_btn.clicked.connect(lambda: self._snap(False))
        self.use_key_range_btn = QPushButton("使用当前关键帧区间")
        self.use_key_range_btn.clicked.connect(self._use_keyframe_range)

        self.range_hint = QLabel("导入视频后可用")
        self.range_hint.setWordWrap(True)
        self.range_hint.setStyleSheet("color:#8f9db6;")

        layout.addWidget(QLabel("开始"), 0, 0)
        layout.addWidget(self.start_spin, 0, 1)
        layout.addWidget(self.snap_start_btn, 0, 2)
        layout.addWidget(QLabel("结束"), 0, 3)
        layout.addWidget(self.end_spin, 0, 4)
        layout.addWidget(self.snap_end_btn, 0, 5)
        layout.addWidget(self.use_key_range_btn, 0, 6)
        layout.addWidget(self.range_hint, 1, 1, 1, 6)

        self.go_compare_btn = QPushButton("开始对比 →")
        self.go_compare_btn.setObjectName("primary")
        self.go_compare_btn.clicked.connect(lambda: self.tabs.setCurrentIndex(1))
        layout.addWidget(self.go_compare_btn, 0, 7)
        return group

    def _time_spin(self) -> QDoubleSpinBox:
        spin = QDoubleSpinBox()
        spin.setDecimals(3)
        spin.setSingleStep(0.1)
        spin.setRange(0.0, 86400.0)
        spin.setSuffix(" s")
        spin.setMinimumWidth(120)
        return spin

    # ------------------------------------------------------------------
    # ② 对比
    # ------------------------------------------------------------------
    def _build_compare_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setContentsMargins(12, 12, 12, 12)
        layout.setSpacing(10)

        controls = QGroupBox("执行")
        grid = QGridLayout(controls)
        grid.setContentsMargins(12, 16, 12, 10)
        self.container_combo = QComboBox()
        self.container_combo.addItems(["mp4", "mkv", "ts"])
        self.preset_combo = QComboBox()
        self.preset_combo.addItems(["ultrafast", "veryfast", "medium"])
        self.preset_combo.setCurrentText("veryfast")
        self.crf_spin = QSpinBox()
        self.crf_spin.setRange(0, 51)
        self.crf_spin.setValue(20)
        self.audio_bitrate = QComboBox()
        self.audio_bitrate.addItems(["96k", "128k", "192k", "256k"])
        self.audio_bitrate.setCurrentText("128k")

        self.run_compare_btn = QPushButton("运行直接截取 + 重编码")
        self.run_compare_btn.setObjectName("primary")
        self.run_compare_btn.clicked.connect(self.run_compare)

        grid.addWidget(QLabel("封装"), 0, 0)
        grid.addWidget(self.container_combo, 0, 1)
        grid.addWidget(QLabel("x264 preset"), 0, 2)
        grid.addWidget(self.preset_combo, 0, 3)
        grid.addWidget(QLabel("CRF"), 0, 4)
        grid.addWidget(self.crf_spin, 0, 5)
        grid.addWidget(QLabel("音频码率"), 0, 6)
        grid.addWidget(self.audio_bitrate, 0, 7)
        grid.addWidget(self.run_compare_btn, 0, 8)
        self.cmd_toggle = QCheckBox("显示完整命令")
        self.cmd_toggle.toggled.connect(self._toggle_commands)
        grid.addWidget(self.cmd_toggle, 0, 9)
        self.export_btn = QPushButton("导出对比 JSON")
        self.export_btn.setEnabled(False)
        self.export_btn.clicked.connect(self.export_compare)
        grid.addWidget(self.export_btn, 0, 10)
        layout.addWidget(controls)

        self.prediction_label = QLabel("先在 ① 里选好范围")
        self.prediction_label.setWordWrap(True)
        self.prediction_label.setObjectName("predictionLabel")
        self.prediction_label.setStyleSheet(
            "background:#1b2130; border:1px solid #2c3442; border-radius:6px;"
            "padding:10px; color:#c9d6ee;")
        layout.addWidget(self.prediction_label)

        cards = QHBoxLayout()
        self.copy_tile = FrameTile("直接截取 · 输出首帧")
        self.reenc_tile = FrameTile("重编码 · 输出首帧")
        for tile in (self.copy_tile, self.reenc_tile):
            tile.setMinimumSize(320, 180)
            tile.image.setMinimumSize(200, 96)
            cards.addWidget(tile, 1)
        layout.addLayout(cards, 2)

        self.track_table = QTableWidget(0, 3)
        self.track_table.setHorizontalHeaderLabels(
            ["输出体检", "直接截取", "重编码"])
        self.track_table.verticalHeader().setVisible(False)
        self.track_table.setAlternatingRowColors(True)
        self.track_table.setEditTriggers(
            QAbstractItemView.EditTrigger.NoEditTriggers)
        self.track_table.setSelectionMode(
            QAbstractItemView.SelectionMode.NoSelection)
        self.track_table.horizontalHeader().setSectionResizeMode(
            QHeaderView.ResizeMode.Stretch)
        self.track_table.verticalHeader().setDefaultSectionSize(24)
        self.track_table.setSelectionMode(
            QAbstractItemView.SelectionMode.NoSelection)
        self.track_table.setMinimumHeight(210)
        layout.addWidget(self.track_table, 3)

        self.deviation_table = QTableWidget(0, 5)
        self.deviation_table.setHorizontalHeaderLabels(
            ["测量项", "请求", "实际", "偏差", "判定"])
        self.deviation_table.setAlternatingRowColors(True)
        self.deviation_table.verticalHeader().setVisible(False)
        self.deviation_table.setEditTriggers(
            QAbstractItemView.EditTrigger.NoEditTriggers)
        self.deviation_table.horizontalHeader().setSectionResizeMode(
            0, QHeaderView.ResizeMode.Stretch)
        for col in range(1, 5):
            self.deviation_table.horizontalHeader().setSectionResizeMode(
                col, QHeaderView.ResizeMode.ResizeToContents)
        self.deviation_table.verticalHeader().setDefaultSectionSize(24)
        self.deviation_table.setMinimumHeight(200)
        layout.addWidget(self.deviation_table, 5)

        self.compare_log = QTextBrowser()
        self.compare_log.setMinimumHeight(70)
        self.compare_log.setVisible(False)
        layout.addWidget(self.compare_log, 2)
        return page

    # ------------------------------------------------------------------
    # ③ 非零起点
    # ------------------------------------------------------------------
    def _build_timemap_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setContentsMargins(12, 12, 12, 12)
        layout.setSpacing(10)

        info = QLabel(
            "对 start_time 非零的输入（手机录屏、MOV/TS 片段），"
            "ffmpeg 的 -ss 默认按文件起点解释。这里分别用两种写法截一小段，"
            "再读输出首帧的烧录条码，验证实际落到了哪一帧。")
        info.setWordWrap(True)
        info.setStyleSheet("color:#9fb0cc;")
        layout.addWidget(info)

        controls = QHBoxLayout()
        self.tm_time_spin = self._time_spin()
        self.tm_time_spin.setValue(2.0)
        self.tm_run_btn = QPushButton("演示定位")
        self.tm_run_btn.setObjectName("primary")
        self.tm_run_btn.clicked.connect(self.run_timemap)
        self.tm_offset_btn = QPushButton("加载非零起点样例")
        self.tm_offset_btn.clicked.connect(lambda: self.load_builtin_sample(True))
        controls.addWidget(QLabel("内容时间"))
        controls.addWidget(self.tm_time_spin)
        controls.addWidget(self.tm_run_btn)
        controls.addWidget(self.tm_offset_btn)
        controls.addStretch(1)
        layout.addLayout(controls)

        self.tm_summary = QLabel("尚未运行")
        self.tm_summary.setWordWrap(True)
        self.tm_summary.setStyleSheet(
            "background:#1b2130; border:1px solid #2c3442; border-radius:6px;"
            "padding:10px;")
        layout.addWidget(self.tm_summary)

        self.tm_table = QTableWidget(0, 5)
        self.tm_table.setHorizontalHeaderLabels(
            ["命令写法", "输出首帧", "期望帧", "输出首帧 PTS", "说明"])
        self.tm_table.setAlternatingRowColors(True)
        self.tm_table.verticalHeader().setVisible(False)
        self.tm_table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.tm_table.horizontalHeader().setSectionResizeMode(
            4, QHeaderView.ResizeMode.Stretch)
        layout.addWidget(self.tm_table, 1)

        self.tm_cmd = QTextBrowser()
        self.tm_cmd.setMinimumHeight(120)
        layout.addWidget(self.tm_cmd)
        return page

    # ------------------------------------------------------------------
    # ④ 验证
    # ------------------------------------------------------------------
    def _build_verify_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setContentsMargins(12, 12, 12, 12)
        layout.setSpacing(10)

        group = QGroupBox("内置样例")
        form = QFormLayout(group)
        form.setContentsMargins(12, 16, 12, 10)
        self.sample_info = QLabel(
            "样例包含：每秒一个关键帧、逐帧烧录编号（画面文字 + 机器可读条码）、"
            "可定位的音频包络。条码可直接核对输出帧是否与源文件同一帧。")
        self.sample_info.setWordWrap(True)
        form.addRow(self.sample_info)

        row = QHBoxLayout()
        self.gen_sample_btn = QPushButton("生成普通样例 (0 起点)")
        self.gen_sample_btn.clicked.connect(lambda: self.generate_sample(False))
        self.gen_offset_btn = QPushButton("生成非零起点样例 (+12.5s, 音轨提前 0.5s)")
        self.gen_offset_btn.clicked.connect(lambda: self.generate_sample(True))
        row.addWidget(self.gen_sample_btn)
        row.addWidget(self.gen_offset_btn)
        row.addStretch(1)
        form.addRow(row)
        layout.addWidget(group)

        run_row = QHBoxLayout()
        self.verify_btn = QPushButton("运行自动验证")
        self.verify_btn.setObjectName("primary")
        self.verify_btn.clicked.connect(self.run_verify)
        self.verify_json = QCheckBox("同时输出 JSON 摘要")
        run_row.addWidget(self.verify_btn)
        run_row.addWidget(self.verify_json)
        run_row.addStretch(1)
        layout.addLayout(run_row)

        self.verify_output = QTextBrowser()
        layout.addWidget(self.verify_output, 1)
        return page

    # ------------------------------------------------------------------
    # 文件加载
    # ------------------------------------------------------------------
    def open_file(self) -> None:
        start_dir = str(Path.home())
        path, _ = QFileDialog.getOpenFileName(
            self, "选择短视频", start_dir,
            "视频文件 (*.mp4 *.mov *.mkv *.m4v *.ts *.mts *.webm *.avi *.flv);;所有文件 (*)")
        if not path:
            return
        self.load_path(path)

    def load_builtin_sample(self, offset: bool) -> None:
        self.progress.setValue(1)
        self.statusBar().showMessage("正在生成内置样例…")
        kwargs = dict(offset=12.5, audio_lead=0.5) if offset else {}

        def job(emit_progress=None):
            manifest = sample.ensure_sample(self.workdir, progress=(
                (lambda p: emit_progress(p, "绘制样例帧")) if emit_progress else None),
                **kwargs)
            return manifest["path"]

        gui_tasks.submit(
            job, on_done=self._on_sample_ready, on_error=self._on_task_error,
            on_progress=lambda pct, msg: (self.progress.setValue(pct),
                                          self.statusBar().showMessage(msg)))

    def _on_sample_ready(self, path: object) -> None:
        self.load_path(str(path))

    def load_path(self, path: str) -> None:
        self.path_edit.setText(path)
        self.progress.setValue(0)
        self.statusBar().showMessage("正在解析媒体…")
        self.media_summary.setText("正在解析媒体…")

        def job(emit_progress=None):
            if emit_progress:
                emit_progress(10, "读取流信息")
            return media.probe(path)

        gui_tasks.submit(
            job, on_done=self._on_media_ready, on_error=self._on_task_error,
            on_progress=lambda pct, msg: (self.progress.setValue(pct),
                                          self.statusBar().showMessage(msg)))

    def _on_media_ready(self, info: object) -> None:
        assert isinstance(info, media.MediaInfo)
        self.info = info
        self._thumb_cache.clear()
        self._copy_out = self._reenc_out = None
        self._copy_align = self._reenc_align = None
        self._last_deviations = []
        self.progress.setValue(100)
        self.statusBar().showMessage(
            f"已加载 {info.path.name} · {info.probed_frames} 帧 · {len(info.keyframes)} 个关键帧")

        self.media_summary.setText(self._summary_text(info))
        self.timeline.set_media(info)

        self.start_spin.blockSignals(True)
        self.end_spin.blockSignals(True)
        self.start_spin.setRange(0.0, max(0.0, info.content_duration()))
        self.end_spin.setRange(0.0, max(0.0, info.content_duration()))
        first_kf = info.keyframes[1] if len(info.keyframes) > 1 else None
        self.start_spin.setValue(first_kf.content_time if first_kf else 0.0)
        end_candidate = first_kf.content_time + 1.5 if first_kf else info.content_duration()
        self.end_spin.setValue(min(end_candidate, info.content_duration()))
        self.start_spin.blockSignals(False)
        self.end_spin.blockSignals(False)

        self._fill_keyframe_table()
        self._on_range_changed()
        self._reset_results()
        self.tabs.setCurrentIndex(0)

    def _summary_text(self, info: media.MediaInfo) -> str:
        v = info.video
        parts = [
            f"<b>{html.escape(info.path.name)}</b>",
            f"封装 {info.format_name}",
            f"{v.width}×{v.height}" if v and v.width else "",
            f"{info.fps:.4f} fps" + ("" if info.fps_exact else "（与标称不一致）"),
            f"{info.probed_frames} 帧",
            f"{len(info.keyframes)} 个关键帧",
            f"时长 {info.content_duration():.3f}s",
        ]
        if info.has_nonzero_origin:
            parts.append(
                f"<span style='color:#ffd05c'>非零起点：首帧 PTS {info.content_origin:.3f}s，"
                f"format start {info.format_start:.3f}s</span>")
        if info.audio_start is not None and info.video_start - info.audio_start > 0.002:
            parts.append(
                f"<span style='color:#ffd05c'>音轨比画面早 "
                f"{(info.video_start - info.audio_start) * 1000:.0f} ms</span>")
        return " · ".join(p for p in parts if p)

    def _fill_keyframe_table(self) -> None:
        assert self.info
        self.kf_table.setRowCount(len(self.info.keyframes))
        for row, kf in enumerate(self.info.keyframes):
            values = [f"#{kf.index}", f"{kf.content_time:.3f}s",
                      f"{kf.pts:.3f}s", f"{kf.frame_index}"]
            for col, text in enumerate(values):
                item = QTableWidgetItem(text)
                item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
                item.setData(Qt.ItemDataRole.UserRole, kf.index)
                self.kf_table.setItem(row, col, item)
        if self.info.keyframes:
            self.kf_table.selectRow(0)

    # ------------------------------------------------------------------
    # 范围与预览
    # ------------------------------------------------------------------
    def _on_keyframe_selected(self) -> None:
        if not self.info:
            return
        rows = self.kf_table.selectionModel().selectedRows()
        if not rows:
            return
        index = rows[0].row()
        if not 0 <= index < len(self.info.keyframes):
            return
        kf = self.info.keyframes[index]
        self.kf_meta.setText(
            f"关键帧 #{kf.index} · 内容时间 <b>{kf.content_time:.3f}s</b> · "
            f"绝对 PTS <b>{kf.pts:.3f}s</b> · 帧号 <b>{kf.frame_index}</b>"
            + (f" · 距上一关键帧 {kf.gop_frames} 帧 ({kf.gop_seconds:.2f}s)"
               if kf.gop_frames else ""))
        self.timeline.set_cursor(kf.content_time)
        self._load_keyframe_thumbnail(kf)

    def _on_keyframe_double_clicked(self, item: QTableWidgetItem) -> None:
        if not self.info:
            return
        row = item.row()
        if 0 <= row < len(self.info.keyframes):
            kf = self.info.keyframes[row]
            self.start_spin.setValue(kf.content_time)
            nxt = (self.info.keyframes[row + 1] if row + 1 < len(self.info.keyframes)
                   else None)
            self.end_spin.setValue(nxt.content_time if nxt else
                                   min(kf.content_time + 1.0, self.info.content_duration()))
            self.tabs.setCurrentIndex(0)

    def _load_keyframe_thumbnail(self, kf: media.Keyframe) -> None:
        assert self.info
        key = f"{kf.index}_{kf.pts:.6f}"
        cached = self._thumb_cache.get(key)
        if cached and cached.is_file():
            self.kf_preview.set_image(cached)
            self._check_thumbnail_identity(cached, kf)
            return
        target = self.workdir / f"kf_{kf.index:04d}.png"
        self.kf_preview.set_placeholder("抽取中…")

        def job():
            ffmpeg.extract_frame_png(self.info.path, target, absolute_time=kf.pts)
            return target

        gui_tasks.submit(job, on_done=lambda p: self._on_thumb_ready(Path(p), key, kf),
                         on_error=lambda msg, tb: self.kf_preview.set_placeholder("抽取失败"))

    def _on_thumb_ready(self, path: Path, key: str, kf: media.Keyframe) -> None:
        self._thumb_cache[key] = path
        self.kf_preview.set_image(path)
        self._check_thumbnail_identity(path, kf)

    def _check_thumbnail_identity(self, path: Path, kf: media.Keyframe) -> None:
        """如果画面带条码，就顺带核对一下抽出来的确实是这个关键帧。"""
        assert self.info and self.info.video
        try:
            raw = ffmpeg.run_capture([
                ffmpeg.ffmpeg_path(), "-v", "error", "-i", str(path),
                "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
            result = barcode.decode_identity(
                raw[: self.info.video.width * self.info.video.height * 3],
                self.info.video.width, self.info.video.height)
        except ffmpeg.FFmpegError:
            return
        if not result.ok:
            self.kf_preview.set_caption(
                f"内容时间 {kf.content_time:.3f}s · 绝对 PTS {kf.pts:.3f}s\n"
                "（画面无条码，无法自动核对帧号）")
            return
        if result.frame_index == kf.frame_index:
            self.kf_preview.set_caption(
                f"内容时间 {kf.content_time:.3f}s · 绝对 PTS {kf.pts:.3f}s\n"
                f"画面条码读出 #{result.frame_index}，与关键帧帧号一致 ✓")
        else:
            self.kf_preview.set_caption(
                f"内容时间 {kf.content_time:.3f}s · 绝对 PTS {kf.pts:.3f}s\n"
                f"画面条码读出 #{result.frame_index}，与关键帧帧号 {kf.frame_index} 不一致")

    def _on_timeline_seek(self, t: float) -> None:
        self.timeline.set_cursor(t)
        if t < self.start_spin.value() or t > self.end_spin.value():
            self.start_spin.setValue(t)

    def _on_range_changed(self) -> None:
        if not self.info:
            return
        start = self.start_spin.value()
        end = self.end_spin.value()
        if end < start:
            self.end_spin.blockSignals(True)
            self.end_spin.setValue(start)
            self.end_spin.blockSignals(False)
            end = start
        self.timeline.set_range(start, end)
        self.timeline.set_cursor(start)
        self._update_prediction()

    def _snap(self, is_start: bool) -> None:
        if not self.info:
            return
        t = self.start_spin.value() if is_start else self.end_spin.value()
        if is_start:
            kf = self.info.keyframe_at_or_before(t)
            if kf:
                self.start_spin.setValue(kf.content_time)
        else:
            kf = self.info.keyframe_at_or_after(t)
            if kf:
                self.end_spin.setValue(kf.content_time)

    def _use_keyframe_range(self) -> None:
        if not self.info:
            return
        rows = self.kf_table.selectionModel().selectedRows()
        row = rows[0].row() if rows else 0
        if row + 1 >= len(self.info.keyframes):
            QMessageBox.information(self, "提示", "这是最后一个关键帧，请换一个。")
            return
        self.start_spin.setValue(self.info.keyframes[row].content_time)
        self.end_spin.setValue(self.info.keyframes[row + 1].content_time)

    def _request(self, reencode: bool) -> cut.CutRequest:
        assert self.info
        return cut.CutRequest(
            source=self.info,
            start=self.start_spin.value(),
            end=self.end_spin.value(),
            container=self.container_combo.currentText(),
            reencode=reencode,
            crf=self.crf_spin.value(),
            preset=self.preset_combo.currentText(),
            audio_bitrate=self.audio_bitrate.currentText(),
        )

    def _update_prediction(self) -> None:
        if not self.info:
            return
        req = self._request(False)
        pred = cut.predict(req)
        if pred.start_keyframe is None:
            self.prediction_label.setText("无法定位起点关键帧")
            return
        start_kf = pred.start_keyframe
        text = (
            f"<b>请求范围</b> {req.start:.3f}s → {req.end:.3f}s "
            f"（{req.duration:.3f}s ≈ {pred.expected_frames} 帧）· "
            f"起点帧 #{start_kf.frame_index}<br>"
            f"起点前的关键帧：<b>{start_kf.content_time:.3f}s</b> "
            f"（距请求起点 "
            f"<b>{pred.preroll_seconds * 1000:.0f} ms / {pred.preroll_frames:.1f} 帧</b>）"
        )
        if pred.start_on_key:
            text += " · <span style='color:#7ee7a0'>起点正好在关键帧上</span>"
        else:
            text += ("<br><span style='color:#ffd05c'>直接截取会把画面提前到该关键帧；"
                     "MP4 会用 edit list 裁掉前面，但帧数与音轨仍按预滚计算。</span>")
        if pred.notes:
            text += "<br><span style='color:#8f9db6'>" + "<br>".join(pred.notes) + "</span>"
        self.prediction_label.setText(text)
        self._pred = pred
        self.range_hint.setText(
            f"请求 {req.duration:.3f}s ≈ {pred.expected_frames} 帧 · 起点距前一关键帧 "
            f"{pred.preroll_seconds * 1000:.0f} ms · 见「② 截取对比」")

    # ------------------------------------------------------------------
    # 运行对比
    # ------------------------------------------------------------------
    def _reset_results(self) -> None:
        self.copy_tile.set_placeholder("待运行")
        self.reenc_tile.set_placeholder("待运行")
        self.copy_tile.set_caption("")
        self.reenc_tile.set_caption("")
        self.track_table.setRowCount(0)
        self.deviation_table.setRowCount(0)
        self.compare_log.clear()
        self.export_btn.setEnabled(False)
        self._last_deviations = []

    def run_compare(self) -> None:
        if not self.info:
            QMessageBox.information(self, "提示", "请先导入视频或生成样例。")
            return
        if self.end_spin.value() <= self.start_spin.value():
            QMessageBox.warning(self, "范围无效", "结束时间必须大于开始时间。")
            return
        req_copy = self._request(False)
        req_reenc = self._request(True)
        self.run_compare_btn.setEnabled(False)
        self.progress.setValue(2)
        self.statusBar().showMessage("正在执行直接截取与重编码…")
        self.compare_log.clear()

        def job(emit_progress=None):
            out_copy = cut.run_cut(
                req_copy, self.workdir / f"compare_copy.{req_copy.container}")
            if emit_progress:
                emit_progress(45, "直接截取完成，开始重编码")
            out_reenc = cut.run_cut(
                req_reenc, self.workdir / f"compare_reencode.{req_reenc.container}")
            if emit_progress:
                emit_progress(75, "测量音轨对齐")
            copy_align = audio.measure(req_copy.source.path, out_copy.path,
                                       source_absolute_start=req_copy.start_abs,
                                       duration=req_copy.duration)
            reenc_align = audio.measure(req_reenc.source.path, out_reenc.path,
                                        source_absolute_start=req_reenc.start_abs,
                                        duration=req_reenc.duration)
            return out_copy, out_reenc, copy_align, reenc_align

        gui_tasks.submit(
            job, on_done=self._on_compare_done, on_error=self._on_compare_error,
            on_progress=lambda pct, msg: (self.progress.setValue(pct),
                                          self.statusBar().showMessage(msg)))

    def _on_compare_error(self, msg: str, detail: str) -> None:
        self.run_compare_btn.setEnabled(True)
        self.progress.setValue(0)
        self.statusBar().showMessage("对比失败")
        self.compare_log.setHtml(
            f"<span style='color:#ff7668'><b>执行失败</b></span><br>"
            f"<pre style='white-space:pre-wrap'>{html.escape(msg)}</pre>")

    def _on_compare_done(self, result: object) -> None:
        out_copy, out_reenc, copy_align, reenc_align = result  # type: ignore[misc]
        self._copy_out, self._reenc_out = out_copy, out_reenc
        self._copy_align, self._reenc_align = copy_align, reenc_align
        self.run_compare_btn.setEnabled(True)
        self.progress.setValue(100)
        self.statusBar().showMessage("对比完成")

        assert self.info
        pred = self._pred
        self._render_tile(self.copy_tile, out_copy, "直接截取")
        self._render_tile(self.reenc_tile, out_reenc, "重编码")
        self._render_track_table(out_copy, out_reenc)

        rows = cut.compare(pred, out_copy, out_reenc, copy_align, reenc_align)
        self.deviation_table.setRowCount(len(rows))
        for row, dev in enumerate(rows):
            if dev.unit == "seconds":
                requested = f"{dev.requested:.3f}s"
                actual = f"{dev.actual:.3f}s"
            else:
                requested = f"{dev.requested:.0f} 帧"
                actual = f"{dev.actual:.0f} 帧"
            cells = [dev.label, requested, actual, dev.describe(),
                     SEVERITY_TEXT.get(dev.severity, dev.severity)]
            for col, text in enumerate(cells):
                item = QTableWidgetItem(text)
                if col == 0:
                    item.setTextAlignment(Qt.AlignmentFlag.AlignLeft
                                          | Qt.AlignmentFlag.AlignVCenter)
                else:
                    item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
                if col == 4:
                    item.setForeground(QColor(_severity_color(dev.severity)))
                if dev.detail:
                    item.setToolTip(dev.detail)
                self.deviation_table.setItem(row, col, item)
        self.compare_log.setHtml(self._compare_html(pred, out_copy, out_reenc,
                                                    copy_align, reenc_align))
        self._last_deviations = rows
        self.export_btn.setEnabled(True)

    def _toggle_commands(self, visible: bool) -> None:
        self.compare_log.setVisible(visible)

    def export_compare(self) -> None:
        """把本次对比写成 JSON，便于贴进工单或脚本复跑。"""
        import json
        if not self.info or not self._copy_out or not self._reenc_out:
            return
        path, _ = QFileDialog.getSaveFileName(
            self, "导出对比 JSON", str(Path.home() / "cutlab-compare.json"),
            "JSON (*.json)")
        if not path:
            return
        pred = self._pred

        def track(t: cut.TrackMeasure | None) -> dict | None:
            if not t:
                return None
            return {
                "start": t.start, "duration": t.duration, "frames": t.frames,
                "declared_frames": t.declared_frames,
                "first_pts": t.first_pts, "last_pts": t.last_pts,
                "first_key": t.first_key,
            }

        def measure(m: cut.OutputMeasure) -> dict:
            return {
                "path": str(m.path),
                "size": m.size,
                "format_start": m.format_start,
                "format_duration": m.format_duration,
                "video": track(m.video),
                "audio": track(m.audio),
                "first_frame": m.first_frame_index,
                "last_frame": m.last_frame_index,
                "command": m.command,
            }

        payload = {
            "source": str(self.info.path),
            "request": {
                "start": pred.request.start,
                "end": pred.request.end,
                "duration": pred.request.duration,
                "container": pred.request.container,
                "start_absolute": pred.request.start_abs,
                "content_origin": self.info.content_origin,
                "format_start": self.info.format_start,
            },
            "prediction": {
                "start_frame": pred.start_frame_index,
                "end_frame": pred.end_frame_index,
                "expected_frames": pred.expected_frames,
                "start_keyframe": pred.start_keyframe.content_time
                if pred.start_keyframe else None,
                "preroll_seconds": pred.preroll_seconds,
                "preroll_frames": pred.preroll_frames,
            },
            "direct_copy": measure(self._copy_out),
            "reencode": measure(self._reenc_out),
            "audio_alignment": {
                "copy": self._copy_align.lag if self._copy_align else None,
                "reencode": self._reenc_align.lag if self._reenc_align else None,
            },
            "deviations": [
                {"label": d.label, "unit": d.unit, "requested": d.requested,
                 "actual": d.actual, "delta": d.delta, "severity": d.severity,
                 "detail": d.detail}
                for d in getattr(self, "_last_deviations", [])
            ],
        }
        Path(path).write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        self.statusBar().showMessage(f"已导出 {path}")

    def _render_track_table(self, copy_out: cut.OutputMeasure,
                            reenc_out: cut.OutputMeasure) -> None:
        def vf(m: cut.OutputMeasure, getter) -> str:
            try:
                return getter(m)
            except Exception:  # noqa: BLE001
                return "—"

        def track_value(m: cut.OutputMeasure, which: str) -> str:
            t = m.video if which == "video" else m.audio
            if not t:
                return "无"
            return (_fmt(t.start, 3, "s") + " / " + _fmt(t.duration, 3, "s"))

        rows = [
            ("输出首帧 · 烧录条码",
             vf(copy_out, lambda m: f"#{m.first_frame_index}"
                if m.first_frame_index is not None else "不可读"),
             vf(reenc_out, lambda m: f"#{m.first_frame_index}"
                if m.first_frame_index is not None else "不可读")),
            ("输出末帧 · 烧录条码",
             vf(copy_out, lambda m: f"#{m.last_frame_index}"
                if m.last_frame_index is not None else "不可读"),
             vf(reenc_out, lambda m: f"#{m.last_frame_index}"
                if m.last_frame_index is not None else "不可读")),
            ("首帧 PTS（相对输出起点）",
             vf(copy_out, lambda m: _fmt(m.video.first_pts if m.video else None, 3, "s")),
             vf(reenc_out, lambda m: _fmt(m.video.first_pts if m.video else None, 3, "s"))),
            ("视频轨 起点 / 时长",
             vf(copy_out, lambda m: track_value(m, "video")),
             vf(reenc_out, lambda m: track_value(m, "video"))),
            ("视频轨 首末采样跨度",
             vf(copy_out, lambda m: _fmt(m.video.span if m.video else None, 3, "s")),
             vf(reenc_out, lambda m: _fmt(m.video.span if m.video else None, 3, "s"))),
            ("音轨 起点 / 时长",
             vf(copy_out, lambda m: track_value(m, "audio")),
             vf(reenc_out, lambda m: track_value(m, "audio"))),
            ("音轨 首末采样跨度（含预滚）",
             vf(copy_out, lambda m: _fmt(m.audio.span if m.audio else None, 3, "s")),
             vf(reenc_out, lambda m: _fmt(m.audio.span if m.audio else None, 3, "s"))),
            ("解码帧数 / 首帧是否关键帧",
             vf(copy_out, lambda m: f"{m.video.frames if m.video else '—'} / "
                f"{'是' if m.video and m.video.first_key else '否'}"),
             vf(reenc_out, lambda m: f"{m.video.frames if m.video else '—'} / "
                f"{'是' if m.video and m.video.first_key else '否'}")),
            ("文件大小",
             vf(copy_out, lambda m: f"{m.size / 1024:.0f} KiB"),
             vf(reenc_out, lambda m: f"{m.size / 1024:.0f} KiB")),
        ]
        self.track_table.setRowCount(len(rows))
        for row, (label, left, right) in enumerate(rows):
            for col, text in enumerate((label, left, right)):
                item = QTableWidgetItem(text)
                item.setTextAlignment(
                    Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter
                    if col == 0 else Qt.AlignmentFlag.AlignCenter)
                self.track_table.setItem(row, col, item)

    def _render_tile(self, tile: FrameTile, measure: cut.OutputMeasure,
                     tag: str) -> None:
        png = self.workdir / f"{tag}_first.png"
        try:
            ffmpeg.extract_frame_png(measure.path, png)
            tile.set_image(png)
        except ffmpeg.FFmpegError:
            tile.set_placeholder("无法抽取首帧")
        v = measure.video
        ident = measure.first_frame_identity
        if ident and ident.ok:
            head = f"<span style='color:#7ee7a0'>条码 #{ident.frame_index}</span>"
        elif ident:
            head = (f"<span style='color:#ffd05c'>条码不可读 "
                    f"(对比度 {ident.contrast:.0f})</span>")
        else:
            head = "—"
        tile.set_caption(
            f"{head} · 首帧关键帧 {'是' if v and v.first_key else '否'} · "
            f"{v.frames if v else '—'} 帧")

    def _compare_html(self, pred: cut.Prediction, out_copy: cut.OutputMeasure,
                      out_reenc: cut.OutputMeasure,
                      copy_align: audio.Alignment,
                      reenc_align: audio.Alignment) -> str:
        def cmd_block(m: cut.OutputMeasure) -> str:
            return html.escape(" ".join(m.command)) if m.command else "—"
        return f"""
        <div style='font-family:Menlo,monospace;font-size:11px;color:#b6c3da'>
        <b style='color:#9cc9ff'>直接截取命令</b><br>{cmd_block(out_copy)}<br><br>
        <b style='color:#9cc9ff'>重编码命令</b><br>{cmd_block(out_reenc)}<br><br>
        <b style='color:#9cc9ff'>音轨对齐</b><br>
        直接截取 lag={_fmt(copy_align.lag, 3, 's')} 置信度 {copy_align.confidence:.0%}
        {html.escape(copy_align.note)}<br>
        重编码 lag={_fmt(reenc_align.lag, 3, 's')} 置信度 {reenc_align.confidence:.0%}
        {html.escape(reenc_align.note)}<br><br>
        <span style='color:#8f9db6'>请求起点前关键帧：
        {pred.start_keyframe.content_time if pred.start_keyframe else '—'}s ·
        预滚 {pred.preroll_frames:.1f} 帧</span>
        </div>"""

    # ------------------------------------------------------------------
    # 时间定位
    # ------------------------------------------------------------------
    def run_timemap(self) -> None:
        if not self.info:
            QMessageBox.information(self, "提示", "请先导入视频或生成样例。")
            return
        info = self.info
        t = self.tm_time_spin.value()
        self.tm_run_btn.setEnabled(False)
        self.statusBar().showMessage("正在演示时间定位…")

        def job(emit_progress=None):
            return timemap.demonstrate(info, t, self.workdir / "timemap")

        gui_tasks.submit(job, on_done=self._on_timemap_done,
                         on_error=self._on_timemap_error)

    def _on_timemap_error(self, msg: str, detail: str) -> None:
        self.tm_run_btn.setEnabled(True)
        self.tm_summary.setText(f"<span style='color:#ff7668'>{html.escape(msg)}</span>")

    def _on_timemap_done(self, report: object) -> None:
        assert isinstance(report, timemap.TimeMapReport)
        self.tm_run_btn.setEnabled(True)
        self.statusBar().showMessage("定位演示完成")
        rows = report.trials
        self.tm_table.setRowCount(len(rows))
        for row, trial in enumerate(rows):
            offset = trial.offset_frames
            note = trial.note
            if offset is not None and offset != 0:
                note += f"（偏移 {offset:+d} 帧）"
            cells = [
                trial.label,
                f"#{trial.first_frame}" if trial.first_frame is not None else "—",
                f"#{trial.expected_frame}" if trial.expected_frame is not None else "—",
                _fmt(trial.video_first_pts, 3, "s"),
                note,
            ]
            for col, text in enumerate(cells):
                item = QTableWidgetItem(text)
                if col in (1, 2, 3):
                    item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
                if col in (1, 2) and offset is not None:
                    item.setForeground(QColor("#7ee7a0" if offset == 0 else "#ff7668"))
                self.tm_table.setItem(row, col, item)
        self.tm_table.resizeRowsToContents()

        naive = report.naive
        absolute = report.absolute
        verdict = ("两种写法结果一致（该文件起点为 0）"
                   if not report.naive_is_wrong
                   else "相对写法已经切错位置，必须用绝对定位")
        color = "#7ee7a0" if not report.naive_is_wrong else "#ffd05c"
        detail = (f"相对写法落帧 "
                  f"{('#' + str(naive.first_frame)) if naive and naive.first_frame is not None else '失败'}"
                  f" / 期望 #{report.expected_frame}；绝对写法落帧 "
                  f"{('#' + str(absolute.first_frame)) if absolute and absolute.first_frame is not None else '失败'}")
        self.tm_summary.setText(
            f"<span style='color:{color}'><b>{verdict}</b></span><br>"
            + html.escape(detail) + "<br>"
            + html.escape(report.explanation()).replace("\n", "<br>"))

        blocks = ["<div style='font-family:Menlo,monospace;font-size:11px;'>"]
        for trial in rows:
            blocks.append(f"<b style='color:#9cc9ff'>{html.escape(trial.label)}</b><br>"
                          f"{html.escape(' '.join(trial.command))}<br><br>")
        blocks.append("</div>")
        self.tm_cmd.setHtml("".join(blocks))

    # ------------------------------------------------------------------
    # 样例与验证
    # ------------------------------------------------------------------
    def generate_sample(self, offset: bool) -> None:
        self.gen_sample_btn.setEnabled(False)
        self.gen_offset_btn.setEnabled(False)
        kwargs = dict(offset=12.5, audio_lead=0.5) if offset else {}

        def job(emit_progress=None):
            return sample.ensure_sample(
                self.workdir,
                progress=(lambda p: emit_progress(p, "绘制样例帧")) if emit_progress else None,
                **kwargs)

        def done(manifest: object) -> None:
            self.gen_sample_btn.setEnabled(True)
            self.gen_offset_btn.setEnabled(True)
            path = manifest["path"]
            self.verify_output.setHtml(
                f"<b>样例已生成</b><br>{html.escape(path)}<br><br>"
                f"帧数 {manifest['frames']} · 关键帧间隔 {manifest['gop_frames']} 帧 · "
                f"{manifest['fps']} fps<br>"
                f"条码：{manifest['barcode']['sync']} 位同步 + "
                f"{manifest['barcode']['data']} 位帧号 + "
                f"{manifest['barcode']['check']} 位校验")
            self.load_path(path)

        def fail(msg: str, detail: str) -> None:
            self.gen_sample_btn.setEnabled(True)
            self.gen_offset_btn.setEnabled(True)
            self.verify_output.setHtml(
                f"<span style='color:#ff7668'>生成失败</span><br>"
                f"<pre style='white-space:pre-wrap'>{html.escape(msg)}</pre>")

        gui_tasks.submit(job, on_done=done, on_error=fail,
                         on_progress=lambda pct, msg: (self.progress.setValue(pct),
                                                       self.statusBar().showMessage(msg)))

    def run_verify(self) -> None:
        self.verify_btn.setEnabled(False)
        self.verify_output.setPlainText("运行中…")
        want_json = self.verify_json.isChecked()

        def job(emit_progress=None):
            def progress(msg: str, pct: int) -> None:
                if emit_progress:
                    emit_progress(pct, msg)
            return verify.run(progress=progress)

        def done(report: object) -> None:
            self.verify_btn.setEnabled(True)
            assert isinstance(report, verify.VerifyReport)
            rows = []
            for check in report.checks:
                color = "#7ee7a0" if check.ok else "#ff7668"
                mark = "PASS" if check.ok else "FAIL"
                rows.append(
                    f"<tr><td style='color:{color};font-weight:600'>{mark}</td>"
                    f"<td>{html.escape(check.name)}</td>"
                    f"<td style='color:#8f9db6'>{html.escape(check.detail)}</td></tr>")
            body = "".join(rows)
            summary = ("全部通过" if report.ok else "存在失败项")
            color = "#7ee7a0" if report.ok else "#ff7668"
            extra = ""
            if want_json:
                import json
                extra = ("<br><br><b>JSON 摘要</b><pre style='white-space:pre-wrap'>"
                         + html.escape(json.dumps(report.to_dict(), ensure_ascii=False,
                                                  indent=2)) + "</pre>")
            self.verify_output.setHtml(
                f"<h3 style='color:{color}'>{summary}</h3>"
                f"<table cellspacing='6'>{body}</table>{extra}<br>"
                f"<span style='color:#8f9db6'>样例：{'、'.join(report.sample_paths)}</span>")

        def fail(msg: str, detail: str) -> None:
            self.verify_btn.setEnabled(True)
            self.verify_output.setHtml(
                f"<span style='color:#ff7668'>验证失败</span><br>"
                f"<pre style='white-space:pre-wrap'>{html.escape(msg)}</pre>")

        gui_tasks.submit(job, on_done=done, on_error=fail,
                         on_progress=lambda pct, msg: (self.progress.setValue(pct),
                                                       self.statusBar().showMessage(msg)))

    # ------------------------------------------------------------------
    def _on_task_error(self, msg: str, detail: str) -> None:
        self.progress.setValue(0)
        self.statusBar().showMessage("操作失败")
        box = QMessageBox(self)
        box.setIcon(QMessageBox.Icon.Warning)
        box.setWindowTitle("操作失败")
        box.setText(msg[:800])
        if detail:
            box.setDetailedText(detail[-4000:])
        box.exec()

    def show_about(self) -> None:
        QMessageBox.information(
            self, "关于 CutLab",
            "CutLab 用来回答一个问题：一次短视频截取，能不能直接用 "
            "-c copy 搬运原编码包？\n\n"
            "它会把请求起点、源文件最近的关键帧、实际输出首帧（用烧录条码读出）、"
            "音轨起点与两轨时长放在一起对照，并给出重编码的同一组指标。\n\n"
            "时间约定：界面上的时间为“内容时间”，0 = 视频首帧；"
            "实际执行时一律换算成绝对 PTS 并加 -seek_timestamp 1，"
            "避免非零起点文件被静默切错。\n\n"
            f"ffmpeg: {ffmpeg.version_line()}")


def main() -> int:
    app = QApplication.instance() or QApplication([])
    app.setApplicationName("CutLab")
    window = MainWindow()
    window.show()
    if len(os.sys.argv) > 1 and Path(os.sys.argv[1]).is_file():
        QTimer.singleShot(60, lambda: window.load_path(os.sys.argv[1]))
    return app.exec()
