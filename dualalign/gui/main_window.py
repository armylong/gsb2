"""主窗口.

界面只围绕"双录音时间对应"设计:
    * 上方: 参考录音 / 对齐结果 / 待对齐录音信息与波形
    * 中部: 趋势表、缺失与低置信列表、人工锚点
    * 下方: 短区间 A/B 试听与导出

不提供混音、增益、包络等编辑控件。
"""

from __future__ import annotations

from pathlib import Path

from PySide6.QtCore import QSettings, QThread, QTimer, Qt, Signal
from PySide6.QtGui import QAction, QColor
from PySide6.QtWidgets import (
    QApplication,
    QComboBox,
    QDoubleSpinBox,
    QFileDialog,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QSplitter,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
    QProgressBar,
)

from ..align import AlignmentResult, Anchor, AnchorConflictError, AlignmentError
from ..audio import AudioClip, AudioLoadError, load_wav
from ..engine import AudioEngine, MixingNotSupported, PlaybackError, make_default_sink
from ..export import export_result, reopen_exported
from ..playback import MIN_WINDOW_S
from ..samples import generate_all
from .timeline import DetailView, TakeView, TimelineView


class AnalysisWorker(QThread):
    finished_ok = Signal(object)
    failed = Signal(str)

    def __init__(self, ref: AudioClip, take: AudioClip, parent=None) -> None:
        super().__init__(parent)
        self.ref = ref
        self.take = take

    def run(self) -> None:  # noqa: D401
        try:
            from ..align import analyze

            result = analyze(self.ref, self.take)
        except (AlignmentError, Exception) as exc:  # noqa: BLE001
            self.failed.emit(str(exc))
            return
        self.finished_ok.emit(result)


class MainWindow(QMainWindow):
    def __init__(self, engine: AudioEngine | None = None, auto_demo: bool = False) -> None:
        super().__init__()
        self.setWindowTitle("双录音对齐工具 — 时间对应与局部缺失校正")
        self.resize(1280, 900)
        self.settings = QSettings("dualalign", "dualalign")
        self.engine = engine if engine is not None else AudioEngine(make_default_sink())
        self.result: AlignmentResult | None = None
        self.ref_clip: AudioClip | None = None
        self.take_clip: AudioClip | None = None
        self.worker: AnalysisWorker | None = None
        self._pending_anchor_ref: float | None = None
        self._build_ui()
        self._set_status("先载入参考录音和待对齐录音 (wav, ≤ 2 分钟), 或点击「生成样例并载入」。")
        if auto_demo:
            QTimer.singleShot(200, self.generate_samples)

    # ---- UI ---------------------------------------------------------------

    def _build_ui(self) -> None:
        central = QWidget()
        outer = QVBoxLayout(central)
        outer.setContentsMargins(10, 10, 10, 10)
        outer.setSpacing(8)

        # 文件行
        file_box = QGroupBox("1. 载入录音")
        file_layout = QVBoxLayout(file_box)
        ref_row = QHBoxLayout()
        self.ref_label = QLabel("参考录音: 未载入")
        self.ref_label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        ref_btn = QPushButton("选择参考录音…")
        ref_btn.clicked.connect(self.choose_reference)
        clear_btn = QPushButton("清空")
        clear_btn.clicked.connect(self.clear_all)
        ref_row.addWidget(self.ref_label, 1)
        ref_row.addWidget(ref_btn)
        ref_row.addWidget(clear_btn)
        file_layout.addLayout(ref_row)
        take_row = QHBoxLayout()
        self.take_label = QLabel("待对齐录音: 未载入")
        self.take_label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        take_btn = QPushButton("选择待对齐录音…")
        take_btn.clicked.connect(self.choose_take)
        demo_btn = QPushButton("生成样例并载入")
        demo_btn.clicked.connect(self.generate_samples)
        take_row.addWidget(self.take_label, 1)
        take_row.addWidget(take_btn)
        take_row.addWidget(demo_btn)
        file_layout.addLayout(take_row)
        self.analyze_btn = QPushButton("开始自动对齐分析")
        self.analyze_btn.setEnabled(False)
        self.analyze_btn.clicked.connect(self.run_analysis)
        file_layout.addWidget(self.analyze_btn)
        self.progress = QProgressBar()
        self.progress.setRange(0, 0)
        self.progress.setVisible(False)
        file_layout.addWidget(self.progress)
        outer.addWidget(file_box)

        # 视图
        view_box = QGroupBox("2. 时间轴与波形 (参考时间, 秒)")
        view_layout = QVBoxLayout(view_box)
        self.timeline = TimelineView()
        self.timeline.cursorMoved.connect(self.on_cursor_moved)
        self.timeline.anchorRemoveRequested.connect(self.remove_anchor_at)
        self.timeline.anchorAddRequested.connect(self.on_anchor_add_requested)
        view_layout.addWidget(self.timeline, 2)
        self.detail = DetailView()
        self.detail.link(self.timeline)
        view_layout.addWidget(self.detail, 1)
        self.take_view = TakeView()
        view_layout.addWidget(self.take_view, 0)
        zoom_row = QHBoxLayout()
        zoom_row.addWidget(QLabel("视图:"))
        self.zoom_combo = QComboBox()
        self.zoom_combo.addItems(["全部", "前 5 秒", "前 10 秒", "中段", "后 10 秒", "后 5 秒"])
        self.zoom_combo.currentIndexChanged.connect(self.apply_zoom_preset)
        zoom_row.addWidget(self.zoom_combo)
        self.cursor_label = QLabel("指针: —")
        zoom_row.addWidget(self.cursor_label, 1)
        view_layout.addLayout(zoom_row)
        outer.addWidget(view_box, 3)

        # 中部: 信息面板
        splitter = QSplitter(Qt.Orientation.Horizontal)
        splitter.addWidget(self._build_trend_panel())
        splitter.addWidget(self._build_issues_panel())
        splitter.addWidget(self._build_anchor_panel())
        splitter.setSizes([520, 340, 380])
        outer.addWidget(splitter, 2)

        # 试听 + 导出
        bottom = QHBoxLayout()
        bottom.addWidget(self._build_playback_panel(), 3)
        bottom.addWidget(self._build_export_panel(), 2)
        outer.addLayout(bottom)

        self.setCentralWidget(central)
        self.statusBar().showMessage("就绪")

        menu = self.menuBar().addMenu("文件")
        open_ref = QAction("载入参考录音…", self)
        open_ref.triggered.connect(self.choose_reference)
        open_take = QAction("载入待对齐录音…", self)
        open_take.triggered.connect(self.choose_take)
        gen = QAction("生成内置样例…", self)
        gen.triggered.connect(self.generate_samples)
        reopen = QAction("重新打开导出说明…", self)
        reopen.triggered.connect(self.reopen_export)
        export = QAction("导出对齐结果…", self)
        export.triggered.connect(self.export_aligned)
        quit_action = QAction("退出", self)
        quit_action.triggered.connect(self.close)
        menu.addActions([open_ref, open_take, gen, reopen, export, quit_action])

        help_menu = self.menuBar().addMenu("帮助")
        about = QAction("关于/使用说明", self)
        about.triggered.connect(self.show_about)
        help_menu.addAction(about)

    def _build_trend_panel(self) -> QWidget:
        box = QGroupBox("3. 时间对应与漂移趋势")
        layout = QVBoxLayout(box)
        self.trend_summary = QLabel("尚未分析")
        self.trend_summary.setWordWrap(True)
        self.trend_summary.setMinimumHeight(76)
        self.trend_summary.setAlignment(
            Qt.AlignmentFlag.AlignTop | Qt.AlignmentFlag.AlignLeft
        )
        layout.addWidget(self.trend_summary)
        self.trend_table = QTableWidget(0, 5)
        self.trend_table.setHorizontalHeaderLabels(
            ["参考区间 (s)", "伸缩系数", "漂移 (%)", "待对齐起点 (s)", "备注"]
        )
        self.trend_table.verticalHeader().setVisible(False)
        self.trend_table.horizontalHeader().setSectionResizeMode(
            QHeaderView.ResizeMode.Stretch
        )
        self.trend_table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        layout.addWidget(self.trend_table, 2)
        self.sample_table = QTableWidget(0, 4)
        self.sample_table.setHorizontalHeaderLabels(
            ["参考 (s)", "对应待对齐 (s)", "相对恒定偏移 (ms)", "局部伸缩系数"]
        )
        self.sample_table.verticalHeader().setVisible(False)
        self.sample_table.horizontalHeader().setSectionResizeMode(
            QHeaderView.ResizeMode.Stretch
        )
        self.sample_table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        layout.addWidget(QLabel("取样位置的偏差 (相对本段起点的恒定偏移):"))
        layout.addWidget(self.sample_table, 3)
        return box

    def _build_issues_panel(self) -> QWidget:
        box = QGroupBox("4. 缺失区间与低置信区间")
        layout = QVBoxLayout(box)
        layout.addWidget(QLabel("缺失区间 (导出为静音, 不代表原始录音有内容):"))
        self.gap_list = QListWidget()
        self.gap_list.itemDoubleClicked.connect(self.focus_gap)
        layout.addWidget(self.gap_list, 1)
        layout.addWidget(QLabel("置信不足区间 (建议人工核对或加锚点):"))
        self.low_list = QListWidget()
        self.low_list.itemDoubleClicked.connect(self.focus_low)
        layout.addWidget(self.low_list, 2)
        self.warning_label = QLabel("")
        self.warning_label.setWordWrap(True)
        self.warning_label.setStyleSheet("color:#8d3b00;")
        layout.addWidget(self.warning_label)
        return box

    def _build_anchor_panel(self) -> QWidget:
        box = QGroupBox("5. 人工锚点 (少量)")
        layout = QVBoxLayout(box)
        help_label = QLabel(
            "在波形上双击设置参考时间, 再用下方「设为锚点」。\n"
            "右侧待对齐时间可用试听/已知关系确定; 锚点会更新相邻时间对应关系。"
        )
        help_label.setWordWrap(True)
        layout.addWidget(help_label)
        self.anchor_list = QListWidget()
        self.anchor_list.itemDoubleClicked.connect(self.locate_anchor)
        layout.addWidget(self.anchor_list, 2)
        form = QFormLayout()
        self.anchor_ref_spin = QDoubleSpinBox()
        self.anchor_ref_spin.setDecimals(3)
        self.anchor_ref_spin.setSingleStep(0.01)
        self.anchor_ref_spin.setSuffix(" s")
        self.anchor_take_spin = QDoubleSpinBox()
        self.anchor_take_spin.setDecimals(3)
        self.anchor_take_spin.setSingleStep(0.01)
        self.anchor_take_spin.setSuffix(" s")
        self.anchor_note = QLineEdit()
        self.anchor_note.setPlaceholderText("备注 (可选)")
        form.addRow("参考时间", self.anchor_ref_spin)
        form.addRow("待对齐时间", self.anchor_take_spin)
        form.addRow("备注", self.anchor_note)
        layout.addLayout(form)
        btn_row = QHBoxLayout()
        add_btn = QPushButton("增加/更新锚点")
        add_btn.clicked.connect(self.apply_anchor)
        use_best_btn = QPushButton("用附近自动匹配填充")
        use_best_btn.clicked.connect(self.fill_anchor_from_auto)
        del_btn = QPushButton("删除选中")
        del_btn.clicked.connect(self.delete_selected_anchor)
        clear_btn = QPushButton("清空锚点")
        clear_btn.clicked.connect(self.clear_anchors)
        btn_row.addWidget(add_btn, 1)
        btn_row.addWidget(use_best_btn, 1)
        layout.addLayout(btn_row)
        btn_row2 = QHBoxLayout()
        btn_row2.addWidget(del_btn, 1)
        btn_row2.addWidget(clear_btn, 1)
        layout.addLayout(btn_row2)
        return box

    def _build_playback_panel(self) -> QWidget:
        box = QGroupBox("6. A/B 短区间试听 (左声道=参考 · 右声道=对齐结果, 同一参考时间)")
        layout = QVBoxLayout(box)
        row = QHBoxLayout()
        row.addWidget(QLabel("起点"))
        self.play_start = QDoubleSpinBox()
        self.play_start.setDecimals(3)
        self.play_start.setSingleStep(0.1)
        self.play_start.setSuffix(" s")
        self.play_start.valueChanged.connect(self.invalidate_preview)
        row.addWidget(self.play_start)
        row.addWidget(QLabel("终点"))
        self.play_end = QDoubleSpinBox()
        self.play_end.setDecimals(3)
        self.play_end.setSingleStep(0.1)
        self.play_end.setSuffix(" s")
        self.play_end.valueChanged.connect(self.invalidate_preview)
        row.addWidget(self.play_end)
        set_from_cursor = QPushButton("以指针为中心 3 秒")
        set_from_cursor.clicked.connect(self.set_preview_around_cursor)
        row.addWidget(set_from_cursor)
        layout.addLayout(row)
        self.preview_from_selection_btn = QPushButton("用当前视图区间试听")
        self.preview_from_selection_btn.clicked.connect(self.use_view_range)
        layout.addWidget(self.preview_from_selection_btn)
        mode_row = QHBoxLayout()
        mode_row.addWidget(QLabel("试听内容"))
        self.play_mode = QComboBox()
        self.play_mode.addItem("左右对照 (左=参考, 右=对齐结果)", "ab")
        self.play_mode.addItem("仅参考录音", "reference")
        self.play_mode.addItem("仅对齐结果", "aligned")
        self.play_mode.currentIndexChanged.connect(self.invalidate_preview)
        mode_row.addWidget(self.play_mode, 1)
        layout.addLayout(mode_row)
        buttons = QHBoxLayout()
        self.play_btn = QPushButton("▶ 播放 A/B")
        self.play_btn.clicked.connect(self.start_preview)
        self.stop_btn = QPushButton("■ 停止")
        self.stop_btn.clicked.connect(self.stop_preview)
        buttons.addWidget(self.play_btn)
        buttons.addWidget(self.stop_btn)
        layout.addLayout(buttons)
        self.playback_state = QLabel("未播放 (没有混音/音量包络功能)")
        self.playback_state.setWordWrap(True)
        layout.addWidget(self.playback_state)
        self.preview_info = QLabel("")
        self.preview_info.setWordWrap(True)
        self.preview_info.setStyleSheet("color:#5a636c;")
        layout.addWidget(self.preview_info)
        return box

    def _build_export_panel(self) -> QWidget:
        box = QGroupBox("7. 导出")
        layout = QVBoxLayout(box)
        info = QLabel(
            "导出与参考录音等长的对齐 wav, 以及时间对应说明 (JSON + 文本)。\n"
            "导出结果已包含漂移修正、人工锚点与缺失区间静音。"
        )
        info.setWordWrap(True)
        layout.addWidget(info)
        self.export_btn = QPushButton("导出对齐 wav 与说明…")
        self.export_btn.setEnabled(False)
        self.export_btn.clicked.connect(self.export_aligned)
        layout.addWidget(self.export_btn)
        self.export_info = QLabel("")
        self.export_info.setWordWrap(True)
        self.export_info.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        layout.addWidget(self.export_info)
        layout.addStretch(1)
        return box

    # ---- 文件与样例 --------------------------------------------------------

    def choose_reference(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "选择参考录音", self._last_dir(), "WAV (*.wav)")
        if not path:
            return
        try:
            self.ref_clip = load_wav(path, "reference")
        except AudioLoadError as exc:
            QMessageBox.warning(self, "无法载入参考录音", str(exc))
            return
        self._last_dir_set(path)
        self.ref_label.setText(self.ref_clip.summary())
        self._invalidate_result("参考录音已更换")

    def choose_take(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "选择待对齐录音", self._last_dir(), "WAV (*.wav)")
        if not path:
            return
        try:
            self.take_clip = load_wav(path, "take")
        except AudioLoadError as exc:
            QMessageBox.warning(self, "无法载入待对齐录音", str(exc))
            return
        self._last_dir_set(path)
        self.take_label.setText(self.take_clip.summary())
        self._invalidate_result("待对齐录音已更换")

    def clear_all(self) -> None:
        self.ref_clip = None
        self.take_clip = None
        self.ref_label.setText("参考录音: 未载入")
        self.take_label.setText("待对齐录音: 未载入")
        self._invalidate_result("已清空")

    def generate_samples(self) -> None:
        folder = Path(self.settings.value("sample_dir", str(Path.home() / "dualalign_samples")))
        folder.mkdir(parents=True, exist_ok=True)
        try:
            manifests = generate_all(folder)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.warning(self, "生成样例失败", str(exc))
            return
        demo = manifests["demo"]
        ref_path = folder / demo.files["reference"]
        take_path = folder / demo.files["take"]
        try:
            self.ref_clip = load_wav(ref_path, "reference")
            self.take_clip = load_wav(take_path, "take")
        except AudioLoadError as exc:
            QMessageBox.warning(self, "载入样例失败", str(exc))
            return
        self.settings.setValue("sample_dir", str(folder))
        self.ref_label.setText(self.ref_clip.summary() + f"  [样例目录 {folder}]")
        self.take_label.setText(
            self.take_clip.summary()
            + f"  (已知起点 {demo.expected_start_offset_s:.2f}s, 缺失 {demo.missing_ref_regions})"
        )
        self._set_status(f"已生成样例到 {folder}; 正在分析…")
        self._invalidate_result("载入样例")
        QTimer.singleShot(100, self.run_analysis)

    def _last_dir(self) -> str:
        return str(self.settings.value("last_dir", str(Path.home())))

    def _last_dir_set(self, path: str) -> None:
        self.settings.setValue("last_dir", str(Path(path).parent))

    # ---- 分析 -------------------------------------------------------------

    def run_analysis(self) -> None:
        if self.ref_clip is None or self.take_clip is None:
            QMessageBox.information(self, "缺少录音", "请先载入参考录音和待对齐录音。")
            return
        if self.worker is not None and self.worker.isRunning():
            return
        self._invalidate_result("重新分析")
        self.analyze_btn.setEnabled(False)
        self.progress.setVisible(True)
        self._set_status("正在分析… (特征提取 / 候选匹配 / 动态规划 / 波形微调)")
        self.worker = AnalysisWorker(self.ref_clip, self.take_clip)
        self.worker.finished_ok.connect(self.on_analysis_ok)
        self.worker.failed.connect(self.on_analysis_failed)
        self.worker.start()

    def on_analysis_ok(self, result: object) -> None:
        self.progress.setVisible(False)
        self.analyze_btn.setEnabled(True)
        if not isinstance(result, AlignmentResult):
            return
        self.result = result
        self.timeline.set_result(result)
        self.take_view.set_result(result)
        self.timeline.set_view(0.0, min(result.ref_duration, 10.0))
        self._refresh_panels()
        self.engine.set_result(result, self._anchors_signature())
        self.play_start.blockSignals(True)
        self.play_end.blockSignals(True)
        self.play_start.setRange(0.0, max(0.0, result.ref_duration - 0.2))
        self.play_end.setRange(0.2, result.ref_duration)
        self.play_start.setValue(min(5.0, max(0.0, result.ref_duration - 3.0)))
        self.play_end.setValue(min(8.0, result.ref_duration))
        self.play_start.blockSignals(False)
        self.play_end.blockSignals(False)
        self.export_btn.setEnabled(True)
        self._set_status(
            f"分析完成: {len(result.matches)} 个对应点, "
            f"{len(result.missing_gaps)} 个缺失区间, "
            f"{len(result.low_confidence)} 个置信不足区间"
        )

    def on_analysis_failed(self, message: str) -> None:
        self.progress.setVisible(False)
        self.analyze_btn.setEnabled(True)
        self._set_status("分析失败")
        QMessageBox.warning(self, "分析失败", message)

    def _invalidate_result(self, reason: str) -> None:
        self.analyze_btn.setEnabled(self.ref_clip is not None and self.take_clip is not None)
        if self.result is not None or reason:
            self.engine.invalidate(reason)
        self.result = None
        self.timeline.set_result(None)
        self.take_view.set_result(None)
        self.detail.update()
        self.export_btn.setEnabled(False)
        self._clear_panels(reason)
        self.playback_state.setText(f"未播放 (上次试听已失效: {reason})")

    def _clear_panels(self, reason: str) -> None:
        self.trend_summary.setText(f"尚未分析 ({reason})" if reason else "尚未分析")
        self.trend_table.setRowCount(0)
        self.sample_table.setRowCount(0)
        self.gap_list.clear()
        self.low_list.clear()
        self.anchor_list.clear()
        self.warning_label.setText("")
        self.preview_info.setText("")
        self.export_info.setText("")

    # ---- 面板刷新 ----------------------------------------------------------

    def _refresh_panels(self) -> None:
        assert self.result is not None
        r = self.result
        self.take_view.set_result(r)
        trend = r.trend
        lines = [
            f"参考 {r.ref_duration:.2f}s / 待对齐 {r.take_duration:.2f}s",
            f"整体漂移: {'—' if trend.overall_drift_percent is None else f'{trend.overall_drift_percent:+.2f}%'}",
        ]
        for note in trend.notes:
            lines.append("• " + note)
        self.trend_summary.setText("\n".join(lines))
        self.trend_table.setRowCount(len(trend.segments))
        for i, seg in enumerate(trend.segments):
            values = [
                f"{seg['ref_start_s']:.2f} – {seg['ref_end_s']:.2f}",
                f"{seg['slope_take_per_ref']:.4f}",
                f"{seg['drift_percent']:+.2f}",
                f"{seg['take_start_s']:.2f}",
                "缺失前后分段" if i else "主段",
            ]
            for j, v in enumerate(values):
                item = QTableWidgetItem(v)
                if j == 2 and abs(seg["drift_percent"]) >= 0.05:
                    item.setForeground(QColor("#b45309"))
                self.trend_table.setItem(i, j, item)
        self.sample_table.setRowCount(len(trend.samples))
        for i, s in enumerate(trend.samples):
            values = [
                f"{s['ref_s']:.2f}",
                f"{s['take_s']:.2f}",
                f"{s['deviation_from_constant_offset_ms']:+.0f}",
                f"{s['local_slope']:.4f}",
            ]
            for j, v in enumerate(values):
                self.sample_table.setItem(i, j, QTableWidgetItem(v))
        self.gap_list.clear()
        for gap in r.gaps:
            item = QListWidgetItem(
                f"{gap.ref_start:7.3f}–{gap.ref_end:7.3f}s  {gap.label}  ({gap.duration:.2f}s)"
            )
            item.setData(Qt.ItemDataRole.UserRole, (gap.ref_start, gap.ref_end))
            if gap.kind == "missing":
                item.setForeground(QColor("#a11b1b"))
            else:
                item.setForeground(QColor("#7a5a00"))
            self.gap_list.addItem(item)
        self.low_list.clear()
        for region in r.low_confidence:
            item = QListWidgetItem(
                f"{region.ref_start:7.3f}–{region.ref_end:7.3f}s  {region.reason}"
            )
            item.setData(Qt.ItemDataRole.UserRole, (region.ref_start, region.ref_end))
            item.setForeground(QColor("#8a6200"))
            self.low_list.addItem(item)
        self.warning_label.setText("\n".join("⚠ " + w for w in r.warnings))
        self._refresh_anchor_list()

    def _refresh_anchor_list(self) -> None:
        self.anchor_list.clear()
        if self.result is None:
            return
        for a in self.result.anchors:
            item = QListWidgetItem(f"{a.ref_time:8.3f} → {a.take_time:8.3f}s  {a.note}")
            item.setData(Qt.ItemDataRole.UserRole, a)
            self.anchor_list.addItem(item)
        if self.result.anchors:
            self.anchor_list.addItem(
                QListWidgetItem("(双击锚点可定位; 双击波形上半部绿色圆点可删除)")
            )

    # ---- 指针/缩放 ---------------------------------------------------------

    def on_cursor_moved(self, ref_time: float) -> None:
        self.cursor_label.setText(f"指针(参考): {ref_time:.3f}s")
        self.take_view.set_cursor(ref_time)
        if self.result is None:
            return
        t_take = float(self.result.curve.take_time_at(ref_time))
        gap = self.result.gap_at(ref_time)
        extra = f" | 待对齐: {t_take:.3f}s"
        if gap is not None:
            extra += f" | 处于{gap.label} (导出静音)"
        self.cursor_label.setText(self.cursor_label.text() + extra)

    def apply_zoom_preset(self, index: int) -> None:
        if self.result is None:
            return
        d = self.result.ref_duration
        presets = {
            0: (0.0, d),
            1: (0.0, min(5.0, d)),
            2: (0.0, min(10.0, d)),
            3: (max(0.0, d / 2 - 2.5), min(d, d / 2 + 2.5)),
            4: (max(0.0, d - 10.0), d),
            5: (max(0.0, d - 5.0), d),
        }
        a, b = presets.get(index, (0.0, d))
        self.timeline.set_view(a, b)

    def focus_gap(self, item: QListWidgetItem) -> None:
        bounds = item.data(Qt.ItemDataRole.UserRole)
        if bounds:
            self._focus_range(bounds[0], bounds[1])

    def focus_low(self, item: QListWidgetItem) -> None:
        bounds = item.data(Qt.ItemDataRole.UserRole)
        if bounds:
            self._focus_range(bounds[0], bounds[1])

    def _focus_range(self, a: float, b: float) -> None:
        pad = max(0.5, (b - a) * 0.25)
        self.timeline.set_view(max(0.0, a - pad), b + pad)
        self.timeline.cursor_ref = 0.5 * (a + b)
        self.timeline.update()
        self.on_cursor_moved(self.timeline.cursor_ref)

    # ---- 锚点 -------------------------------------------------------------

    def set_pending_anchor(self, ref_time: float) -> None:
        self._pending_anchor_ref = ref_time
        self.anchor_ref_spin.setValue(ref_time)
        if self.result is not None:
            guess = float(self.result.curve.take_time_at(ref_time))
            self.anchor_take_spin.setValue(max(0.0, min(guess, self.result.take_duration)))
        self.timeline.pending_anchor = ref_time
        self.timeline.update()

    def on_anchor_add_requested(self, ref_time: float) -> None:
        """双击波形: 只准备候选锚点, 用户确认后才真正加入。"""

        self.set_pending_anchor(ref_time)
        self._set_status(
            f"候选锚点参考时间 {ref_time:.3f}s: 调整待对齐时间后点击「增加/更新锚点」"
        )

    def fill_anchor_from_auto(self) -> None:
        if self.result is None:
            return
        ref = self.anchor_ref_spin.value()
        t = float(self.result.curve.take_time_at(ref))
        self.anchor_take_spin.setValue(max(0.0, min(t, self.result.take_duration)))

    def apply_anchor(self) -> None:
        if self.result is None:
            return
        ref_t = float(self.anchor_ref_spin.value())
        take_t = float(self.anchor_take_spin.value())
        new = Anchor(ref_t, take_t, self.anchor_note.text().strip())
        existing = [a for a in self.result.anchors if abs(a.ref_time - ref_t) > 1e-3]
        if len(existing) != len(self.result.anchors):
            self._set_status(f"已更新参考 {ref_t:.3f}s 处的锚点")
        self._commit_anchors(existing + [new])

    def delete_selected_anchor(self) -> None:
        if self.result is None:
            return
        item = self.anchor_list.currentItem()
        if item is None:
            return
        anchor = item.data(Qt.ItemDataRole.UserRole)
        if not isinstance(anchor, Anchor):
            return
        self._commit_anchors([a for a in self.result.anchors if a is not anchor])

    def remove_anchor_at(self, anchor: object) -> None:
        if self.result is None or not isinstance(anchor, Anchor):
            return
        self._commit_anchors([a for a in self.result.anchors if a is not anchor])

    def clear_anchors(self) -> None:
        if self.result is None or not self.result.anchors:
            return
        self._commit_anchors([])

    def locate_anchor(self, item: QListWidgetItem) -> None:
        anchor = item.data(Qt.ItemDataRole.UserRole)
        if not isinstance(anchor, Anchor):
            return
        self._focus_range(anchor.ref_time - 0.5, anchor.ref_time + 0.5)
        self.set_pending_anchor(anchor.ref_time)

    def _commit_anchors(self, anchors: list[Anchor]) -> None:
        assert self.result is not None
        try:
            updated = self.result.with_anchors(anchors)
        except AnchorConflictError as exc:
            QMessageBox.warning(self, "锚点冲突", str(exc))
            return
        self.result = updated
        self.timeline.set_result(updated)
        self.timeline.pending_anchor = None
        self._pending_anchor_ref = None
        self._refresh_panels()
        self.engine.set_result(updated, self._anchors_signature())
        self.playback_state.setText("人工锚点已更新, 旧试听结果已失效")
        self._set_status(
            f"已应用 {len(updated.anchors)} 个人工锚点; 相邻时间对应关系已更新"
        )

    def _anchors_signature(self) -> str:
        if self.result is None:
            return ""
        return "|".join(f"{a.ref_time:.4f}:{a.take_time:.4f}" for a in self.result.anchors)

    # ---- 试听 -------------------------------------------------------------

    def invalidate_preview(self) -> None:
        self.engine.invalidate("试听区间已修改")
        self.playback_state.setText("试听区间已修改, 需要重新播放 (旧片段已失效)")

    def set_preview_around_cursor(self) -> None:
        if self.result is None:
            return
        center = self.timeline.cursor_ref or 0.0
        half = 1.5
        self.play_start.setValue(max(0.0, center - half))
        self.play_end.setValue(min(self.result.ref_duration, center + half))

    def use_view_range(self) -> None:
        if self.result is None:
            return
        self.play_start.setValue(self.timeline.view.start)
        self.play_end.setValue(min(self.result.ref_duration, self.timeline.view.end))

    def start_preview(self) -> None:
        if self.result is None:
            QMessageBox.information(self, "尚未分析", "请先完成自动对齐分析。")
            return
        start = float(self.play_start.value())
        end = float(self.play_end.value())
        mode = str(self.play_mode.currentData() or "ab")
        if end - start < MIN_WINDOW_S:
            QMessageBox.information(self, "区间太短", f"试听区间至少 {MIN_WINDOW_S:.2f} 秒。")
            return
        try:
            clip = self.engine.play(start, end, mode=mode)
        except PlaybackError as exc:
            QMessageBox.warning(self, "无法试听", str(exc))
            return
        except MixingNotSupported as exc:  # pragma: no cover - 防御性
            QMessageBox.warning(self, "不支持", str(exc))
            return
        self.playback_state.setText(
            f"正在播放 ({clip.label}) 参考 {start:.2f}–{end:.2f}s | 片段 token={clip.token}"
        )
        self.preview_info.setText(
            "该片段在播放开始时已冻结; 切换区间/模式/停止/改锚点/重新分析都会使其失效。"
        )
        QTimer.singleShot(int(clip.duration * 1000) + 150, self._mark_playback_done)

    def _mark_playback_done(self) -> None:
        if self.engine.current is None:
            return
        self.playback_state.setText("播放结束")

    def stop_preview(self) -> None:
        self.engine.stop()
        self.playback_state.setText("已停止; 旧片段已失效")

    # ---- 导出 -------------------------------------------------------------

    def export_aligned(self) -> None:
        if self.result is None:
            QMessageBox.information(self, "尚未分析", "请先完成自动对齐分析。")
            return
        suggested = str(Path(self._last_dir()) / f"{self.result.take_clip.path.stem}_aligned.wav")
        path, _ = QFileDialog.getSaveFileName(self, "导出对齐 wav", suggested, "WAV (*.wav)")
        if not path:
            return
        try:
            summary, wav, desc = export_result(self.result, path)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.warning(self, "导出失败", str(exc))
            return
        self.export_info.setText(
            f"已导出:\n• {wav}\n• {desc}\n• {desc.with_name(desc.name.replace('.timeline.json', '.timeline.txt'))}\n"
            f"与参考等长 {summary.frames / summary.sample_rate:.3f}s; "
            f"静音区间 {len(summary.silent_regions)} 个; 已应用 {len(self.result.anchors)} 个锚点"
        )
        self._set_status("导出完成")

    def reopen_export(self) -> None:
        """重新打开导出说明, 恢复到与导出时一致的时间位置 (锚点也一并恢复)。"""

        path, _ = QFileDialog.getOpenFileName(
            self, "打开时间对应说明", self._last_dir(), "JSON (*.timeline.json);;JSON (*.json)"
        )
        if not path:
            return
        try:
            ref, take, result, payload = reopen_exported(
                path, search_dirs=[self.settings.value("last_dir", str(Path.home())),
                                   self.settings.value("sample_dir", "")]
            )
        except FileNotFoundError as exc:
            QMessageBox.warning(
                self, "缺少原始录音",
                str(exc) + "\n\n请先把参考/待对齐原始 wav 放到说明文件同目录后再试。",
            )
            return
        except Exception as exc:  # noqa: BLE001
            QMessageBox.warning(self, "无法打开", str(exc))
            return
        self.ref_clip, self.take_clip = ref, take
        self.ref_label.setText(ref.summary())
        self.take_label.setText(take.summary())
        self.result = result
        self.timeline.set_result(result)
        self.take_view.set_result(result)
        self.timeline.set_view(0.0, min(result.ref_duration, 10.0))
        self._refresh_panels()
        self.engine.set_result(result, self._anchors_signature())
        self.export_btn.setEnabled(True)
        self._set_status(
            f"已从说明恢复: 锚点 {len(result.anchors)} 个, "
            f"导出时间 {payload.get('render', {}).get('duration_s', '?')}s"
        )

    # ---- 杂项 -------------------------------------------------------------

    def _set_status(self, text: str) -> None:
        self.statusBar().showMessage(text)
        self.setWindowTitle(f"双录音对齐工具 — {text[:60]}")

    def show_about(self) -> None:
        QMessageBox.information(
            self,
            "关于",
            "双录音对齐工具\n\n"
            "• 同时载入参考录音与待对齐录音 (wav, ≤ 2 分钟, 采样率可不同)\n"
            "• 自动给出分段的时间对应关系并显示漂移趋势\n"
            "• 缺失区间显著标记, 导出为静音并列出有效声音区间\n"
            "• 置信不足区间可加人工锚点校正; 时间顺序冲突会明确提示\n"
            "• A/B 试听: 左声道参考, 右声道对齐结果, 同一参考时间\n"
            "• 导出与参考等长的对齐 wav 与时间对应说明\n\n"
            "本工具只做时间对应, 不提供混音、增益或音量包络功能。",
        )

    def closeEvent(self, event) -> None:  # noqa: N802
        self.engine.stop()
        if self.worker is not None and self.worker.isRunning():
            self.worker.wait(2000)
        super().closeEvent(event)


def run_app(argv: list[str] | None = None, auto_demo: bool = False) -> int:
    app = QApplication.instance() or QApplication(argv or [])
    window = MainWindow(auto_demo=auto_demo)
    window.show()
    return app.exec()
