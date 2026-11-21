"""主窗口: 检测参数、双声道候选列表、逐段接受/拒绝/调整、A/B 试听、导出与校验."""

from __future__ import annotations

import os
import time
from pathlib import Path

import numpy as np
from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QAction, QColor, QKeySequence
from PySide6.QtWidgets import (QAbstractItemView, QApplication, QCheckBox,
                               QComboBox, QDoubleSpinBox, QFileDialog,
                               QFormLayout, QGroupBox, QHBoxLayout, QHeaderView,
                               QLabel, QMainWindow, QMessageBox, QPushButton,
                               QScrollArea, QSpinBox, QSplitter, QTableWidget,
                               QTableWidgetItem, QTextEdit, QVBoxLayout, QWidget)

from .. import benchmark
from ..audio_engine import AudioEngine
from ..dsp import DetectParams
from ..model import Project
from ..wavio import WavData, load_wav
from .waveform import CH_COLORS, ChannelStrip

_SAMPLE_CACHE: dict[str, WavData] = {}


def sample_wavs(seed: int = 7) -> dict[str, WavData]:
    """程序内生成的对照样例 (干净/退化/修复后)."""
    key = f"bench_{seed}"
    if key not in _SAMPLE_CACHE:
        _, wavs = benchmark.run_benchmark(seed=seed)
        _SAMPLE_CACHE.update({f"{key}_{k}": v for k, v in wavs.items()})
    return {k.rsplit("_", 1)[-1]: v for k, v in _SAMPLE_CACHE.items() if k.startswith(key)}


def synthetic_noisy_wav(seed: int = 3, duration_s: float = 3.0) -> WavData:
    """程序内生成的简单测试信号: 真实敲击 + 随机脉冲 + 底噪."""
    clean, hits = benchmark.make_clean_percussion(seed=seed, duration_s=duration_s)
    rng = np.random.default_rng(seed + 101)
    data = clean.samples.copy()
    n = clean.frames
    inactive = np.ones(n, dtype=bool)
    for a, b in benchmark.hit_active_windows(hits):
        inactive[max(0, a - 24):min(n, b + 24)] = False
    free = np.flatnonzero(inactive)
    if free.size == 0:
        return clean
    for _ in range(10):
        p = int(free[rng.integers(0, len(free))])
        ch = int(rng.integers(0, 2))
        data[p, ch] += float(rng.choice([-1, 1]) * rng.uniform(0.2, 0.6))
    return WavData(data, clean.sample_rate, 16, 1)


class CandidateTable(QTableWidget):
    """一个声道的候选列表."""

    COLUMNS = ["#", "开始", "结束", "宽", "峰值dB", "z", "背景dB", "类型", "状态", "说明"]

    def __init__(self, channel: int, parent=None) -> None:
        super().__init__(0, len(self.COLUMNS), parent)
        self.channel = channel
        self._show_protected = True
        self._project: Project | None = None
        self.setHorizontalHeaderLabels(self.COLUMNS)
        self.verticalHeader().setVisible(False)
        self.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.setSelectionMode(QAbstractItemView.SingleSelection)
        self.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.setAlternatingRowColors(True)
        header = self.horizontalHeader()
        header.setSectionResizeMode(QHeaderView.ResizeToContents)
        header.setStretchLastSection(True)
        self.setStyleSheet(
            "QTableWidget{background:#1b1d22; alternate-background-color:#20232a;"
            "color:#d8dde5; gridline-color:#2c3038;}"
            "QHeaderView::section{background:#262a32;color:#cfd5de;padding:3px;border:0;}"
            "QTableWidget::item:selected{background:#2f4f7a;color:#fff;}"
        )

    def rebuild(self, project: Project | None, selected_id: int | None = None) -> None:
        self._project = project
        self.blockSignals(True)
        self.setRowCount(0)
        if project is None:
            self.blockSignals(False)
            return
        cands = [c for c in project.sorted_candidates(self.channel)
                 if self._show_protected or c.kind != "protected"]
        self.setRowCount(len(cands))
        for row, c in enumerate(cands):
            state = {"pending": "待定", "accepted": "已接受", "rejected": "已拒绝"}[c.state]
            kind = "可修复" if c.kind == "spike" else "待确认"
            values = [f"#{c.id}", str(c.start), str(c.end), str(c.width),
                      f"{c.deviation_db:.1f}", f"{c.z_score:.0f}",
                      f"{c.background_db:.1f}", kind, state, c.reason]
            for col, val in enumerate(values):
                item = QTableWidgetItem(val)
                item.setData(Qt.UserRole, c.id)
                if c.kind == "protected":
                    item.setForeground(QColor(240, 190, 70))
                if c.state == "accepted":
                    item.setForeground(QColor(110, 230, 150))
                elif c.state == "rejected":
                    item.setForeground(QColor(140, 140, 140))
                if c.id == selected_id:
                    item.setBackground(QColor(47, 79, 122))
                self.setItem(row, col, item)
        self.blockSignals(False)

    def selected_candidate_id(self) -> int | None:
        rows = self.selectionModel().selectedRows() if self.selectionModel() else []
        if not rows:
            return None
        item = self.item(rows[0].row(), 0)
        return int(item.data(Qt.UserRole)) if item else None

    def id_at_row(self, row: int) -> int | None:
        item = self.item(row, 0)
        return int(item.data(Qt.UserRole)) if item else None

    def row_of(self, cid: int) -> int | None:
        for row in range(self.rowCount()):
            if self.id_at_row(row) == cid:
                return row
        return None

    def set_protected_visible(self, visible: bool) -> None:
        self._show_protected = visible
        if self._project is not None:
            cid = self.selected_candidate_id()
            self.rebuild(self._project, selected_id=cid)


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("spikefix · 数字录音孤立跳点修复")
        self.resize(1560, 1000)
        self.setMinimumSize(1180, 820)
        self.project = Project()
        self.engine = AudioEngine()
        self.selected_id: int | None = None
        self.loop_mode = False
        self.loop_use_repaired = True
        self._play_timer = QTimer(self)
        self._play_timer.setInterval(40)
        self._play_timer.timeout.connect(self._poll_playhead)
        self._strips: list[ChannelStrip] = []
        self._tables: list[CandidateTable] = []
        self._backup: WavData | None = None
        self._build_ui()
        self._apply_style()
        self._update_enabled()
        self.statusBar().showMessage(
            f"音频后端: {self.engine.backend}  |  可用样例: 菜单「文件 → 生成样例」"
        )

    # -------------------------------------------------------------- 界面构建
    def _build_ui(self) -> None:
        central = QWidget()
        root = QVBoxLayout(central)
        root.setContentsMargins(8, 8, 8, 8)
        root.setSpacing(6)

        # 顶部操作条
        top = QHBoxLayout()
        self.btn_open = QPushButton("打开 WAV…")
        self.btn_open.clicked.connect(self.open_wav_dialog)
        self.btn_sample = QPushButton("生成样例")
        self.btn_sample.setToolTip("在程序内合成 干净原声 / 注入脉冲 / 修复后 三段对照音频")
        self.btn_sample.clicked.connect(self.load_builtin_sample)
        self.btn_export = QPushButton("导出修复 WAV…")
        self.btn_export.clicked.connect(self.export_wav)
        self.btn_export.setEnabled(False)
        self.lbl_file = QLabel("未载入")
        self.lbl_file.setStyleSheet("color:#9aa3b0;")
        top.addWidget(self.btn_open)
        top.addWidget(self.btn_sample)
        top.addWidget(self.btn_export)
        top.addSpacing(12)
        top.addWidget(self.lbl_file, 1)
        self.lbl_backend = QLabel(f"音频后端: {self.engine.backend}")
        top.addWidget(self.lbl_backend)
        root.addLayout(top)

        # 检测参数
        params_box = QGroupBox("检测参数 (修改后点「重新检测」)")
        form = QFormLayout(params_box)
        form.setContentsMargins(10, 8, 10, 8)
        self.sp_thresh = QDoubleSpinBox()
        self.sp_thresh.setRange(-120.0, 0.0)
        self.sp_thresh.setSingleStep(1.0)
        self.sp_thresh.setSuffix(" dBFS")
        self.sp_thresh.setValue(self.project.params.abs_threshold_db)
        self.sp_z = QDoubleSpinBox()
        self.sp_z.setRange(1.0, 120.0)
        self.sp_z.setSingleStep(1.0)
        self.sp_z.setValue(self.project.params.z_threshold)
        self.sp_maxrun = QSpinBox()
        self.sp_maxrun.setRange(1, 64)
        self.sp_maxrun.setValue(self.project.params.max_run)
        self.sp_merge = QSpinBox()
        self.sp_merge.setRange(0, 64)
        self.sp_merge.setValue(self.project.params.merge_gap)
        self.sp_bg = QDoubleSpinBox()
        self.sp_bg.setRange(-200.0, 0.0)
        self.sp_bg.setSingleStep(2.0)
        self.sp_bg.setSuffix(" dBFS")
        self.sp_bg.setValue(self.project.params.background_db)
        self.sp_onset = QDoubleSpinBox()
        self.sp_onset.setRange(-200.0, 0.0)
        self.sp_onset.setSingleStep(2.0)
        self.sp_onset.setSuffix(" dBFS")
        self.sp_onset.setValue(self.project.params.onset_guard_db)
        self.cb_method = QComboBox()
        self.cb_method.addItems(["线性插值", "三次插值"])
        self.cb_method.currentIndexChanged.connect(self._on_method_changed)
        self.cb_preview = QCheckBox("叠加高亮候选的修复")
        self.cb_preview.setChecked(True)
        self.cb_preview.toggled.connect(self._on_preview_toggle)
        self.cb_show_protected = QCheckBox("显示待确认项")
        self.cb_show_protected.setChecked(True)
        self.cb_show_protected.setToolTip("待确认项可能是真实起振, 默认不自动修复")
        self.cb_show_protected.toggled.connect(self._on_show_protected)
        self.btn_detect = QPushButton("重新检测")
        self.btn_detect.clicked.connect(self.run_detection)
        self.btn_undo = QPushButton("撤销")
        self.btn_undo.setShortcut(QKeySequence.Undo)
        self.btn_undo.clicked.connect(self.undo)

        row1 = QHBoxLayout()
        for label, widget in [
            ("幅度门限", self.sp_thresh),
            ("稳健 z", self.sp_z),
            ("最大连点", self.sp_maxrun),
            ("合并间隔", self.sp_merge),
        ]:
            row1.addWidget(QLabel(label))
            row1.addWidget(widget)
        row2 = QHBoxLayout()
        for label, widget in [
            ("背景保护", self.sp_bg),
            ("起振保护", self.sp_onset),
            ("修复方式", self.cb_method),
        ]:
            row2.addWidget(QLabel(label))
            row2.addWidget(widget)
        row2.addWidget(self.cb_preview)
        row2.addWidget(self.cb_show_protected)
        row2.addStretch(1)
        row2.addWidget(self.btn_undo)
        row2.addWidget(self.btn_detect)
        form.addRow(row1)
        form.addRow(row2)
        root.addWidget(params_box)

        # 中部: 双声道视图
        splitter = QSplitter(Qt.Vertical)
        for ch in range(2):
            strip = ChannelStrip(ch)
            strip.header.setText(f"CH{ch + 1}")
            strip.detail.seeked.connect(lambda f, c=ch: self._on_seek(f, c))
            strip.detail.range_selected.connect(lambda a, b, c=ch: self._on_region(a, b, c))
            strip.detail.candidate_clicked.connect(self.select_candidate)
            strip.detail.candidate_committed.connect(self._on_candidate_committed)
            strip.detail.view_changed.connect(self._sync_views)
            strip.detail._overview.view_changed.connect(self._sync_views)
            splitter.addWidget(strip)
            self._strips.append(strip)
        splitter.setSizes([340, 340])
        splitter.setCollapsible(0, False)
        splitter.setCollapsible(1, False)
        root.addWidget(splitter, 3)

        # 下部: 候选表 + 操作 + 校验
        bottom = QSplitter(Qt.Horizontal)
        tables_wrap = QWidget()
        tv = QVBoxLayout(tables_wrap)
        tv.setContentsMargins(0, 0, 0, 0)
        for ch in range(2):
            head = QHBoxLayout()
            lbl = QLabel(f"CH{ch + 1} 候选")
            lbl.setStyleSheet(f"color:{CH_COLORS[ch % 4][1].name()}; font-weight:600;")
            head.addWidget(lbl)
            head.addStretch(1)
            b_acc = QPushButton("全部接受")
            b_rej = QPushButton("全部拒绝")
            b_acc.clicked.connect(lambda _=False, c=ch: self._accept_all(c))
            b_rej.clicked.connect(lambda _=False, c=ch: self._reject_all(c))
            head.addWidget(b_acc)
            head.addWidget(b_rej)
            tv.addLayout(head)
            table = CandidateTable(ch)
            table.itemSelectionChanged.connect(lambda c=ch: self._on_table_select(c))
            tv.addWidget(table, 1)
            self._tables.append(table)
        bottom.addWidget(tables_wrap)

        side = QWidget()
        sv = QVBoxLayout(side)
        sv.setContentsMargins(6, 0, 0, 0)
        sv.setSpacing(6)
        side.setMinimumWidth(420)
        sel_box = QGroupBox("选中候选")
        sel_form = QFormLayout(sel_box)
        sel_form.setContentsMargins(10, 8, 10, 8)
        self.lbl_sel = QLabel("（未选中）")
        self.lbl_sel.setWordWrap(True)
        self.lbl_sel.setMinimumHeight(46)
        self.sp_sel_start = QSpinBox()
        self.sp_sel_start.setRange(0, 10_000_000)
        self.sp_sel_end = QSpinBox()
        self.sp_sel_end.setRange(0, 10_000_000)
        for sp in (self.sp_sel_start, self.sp_sel_end):
            sp.setMinimumWidth(84)
        self.btn_apply_range = QPushButton("应用范围")
        self.btn_apply_range.clicked.connect(self.apply_range)
        range_row = QHBoxLayout()
        range_row.setSpacing(4)
        range_row.addWidget(QLabel("起"))
        range_row.addWidget(self.sp_sel_start)
        range_row.addWidget(QLabel("止"))
        range_row.addWidget(self.sp_sel_end)
        range_row.addWidget(self.btn_apply_range)
        range_row.addStretch(1)
        btn_row = QHBoxLayout()
        self.btn_accept = QPushButton("接受")
        self.btn_reject = QPushButton("拒绝")
        self.btn_reset = QPushButton("重置")
        self.btn_accept.clicked.connect(lambda: self._set_state(self.selected_id, "accepted"))
        self.btn_reject.clicked.connect(lambda: self._set_state(self.selected_id, "rejected"))
        self.btn_reset.clicked.connect(lambda: self._set_state(self.selected_id, "pending"))
        for b in (self.btn_accept, self.btn_reject, self.btn_reset):
            btn_row.addWidget(b)
        sel_form.addRow(self.lbl_sel)
        sel_form.addRow(range_row)
        sel_form.addRow(btn_row)
        self.btn_merge = QPushButton("合并所有重叠候选")
        self.btn_merge.clicked.connect(self.merge_overlaps)
        sel_form.addRow(self.btn_merge)
        sv.addWidget(sel_box)

        # 试听
        play_box = QGroupBox("局部循环试听 (两段区间完全对齐)")
        pv = QVBoxLayout(play_box)
        pv.setContentsMargins(10, 8, 10, 8)
        self.lbl_loop = QLabel("循环区间: 未设置 (在波形上拖动选择)")
        self.lbl_loop.setWordWrap(True)
        pv.addWidget(self.lbl_loop)
        row = QHBoxLayout()
        self.btn_loop_set = QPushButton("用选中候选作循环")
        self.btn_loop_set.clicked.connect(self.set_loop_from_candidate)
        self.btn_loop_sel = QPushButton("用波形选区作循环")
        self.btn_loop_sel.clicked.connect(self.set_loop_from_selection)
        row.addWidget(self.btn_loop_set)
        row.addWidget(self.btn_loop_sel)
        pv.addLayout(row)
        row2 = QHBoxLayout()
        self.btn_play_orig = QPushButton("循环 ▶ 原声")
        self.btn_play_rep = QPushButton("循环 ▶ 修复")
        self.btn_stop = QPushButton("■ 停止")
        self.btn_play_orig.clicked.connect(lambda: self.play_loop(False))
        self.btn_play_rep.clicked.connect(lambda: self.play_loop(True))
        self.btn_stop.clicked.connect(self.stop_audio)
        row2.addWidget(self.btn_play_orig)
        row2.addWidget(self.btn_play_rep)
        row2.addWidget(self.btn_stop)
        pv.addLayout(row2)
        sv.addWidget(play_box)

        # 校验与导出
        verify_box = QGroupBox("导出与校验")
        vv = QVBoxLayout(verify_box)
        vv.setContentsMargins(10, 8, 10, 8)
        self.lbl_verify = QLabel("尚无修复区间")
        self.lbl_verify.setWordWrap(True)
        self.lbl_verify.setMinimumHeight(58)
        vv.addWidget(self.lbl_verify)
        self.btn_verify = QPushButton("刷新校验")
        self.btn_verify.clicked.connect(self.refresh_verification)
        vv.addWidget(self.btn_verify)
        self.btn_benchmark = QPushButton("运行合成对照测试")
        self.btn_benchmark.clicked.connect(self.run_benchmark_dialog)
        vv.addWidget(self.btn_benchmark)
        sv.addWidget(verify_box)

        # 日志
        self.log = QTextEdit()
        self.log.setReadOnly(True)
        self.log.setMinimumHeight(64)
        self.log.setStyleSheet("background:#16181d;color:#a9b3c0;border:1px solid #2b2f37;")
        sv.addWidget(self.log, 1)
        side_scroll = QScrollArea()
        side_scroll.setWidgetResizable(True)
        side_scroll.setFrameShape(QScrollArea.NoFrame)
        side_scroll.setWidget(side)
        side_scroll.setMinimumWidth(430)
        side_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        bottom.addWidget(side_scroll)
        bottom.setStretchFactor(0, 1)
        bottom.setStretchFactor(1, 0)
        bottom.setSizes([940, 480])
        root.addWidget(bottom, 1)
        root.setStretchFactor(splitter, 1)
        root.setStretchFactor(bottom, 1)
        self.setCentralWidget(central)

        # 菜单
        menu = self.menuBar().addMenu("文件")
        act_open = QAction("打开 WAV…", self)
        act_open.setShortcut(QKeySequence.Open)
        act_open.triggered.connect(self.open_wav_dialog)
        menu.addAction(act_open)
        act_sample = QAction("生成样例 (干净/注入/修复)", self)
        act_sample.triggered.connect(self.load_builtin_sample)
        menu.addAction(act_sample)
        act_noisy = QAction("生成简单测试信号", self)
        act_noisy.triggered.connect(self.load_simple_sample)
        menu.addAction(act_noisy)
        menu.addSeparator()
        act_export = QAction("导出修复 WAV…", self)
        act_export.triggered.connect(self.export_wav)
        menu.addAction(act_export)
        act_quit = QAction("退出", self)
        act_quit.setShortcut(QKeySequence.Quit)
        act_quit.triggered.connect(self.close)
        menu.addAction(act_quit)

    def _apply_style(self) -> None:
        self.setStyleSheet(
            "QWidget{background:#14161a;color:#d4d9e1;font-size:12px;}"
            "QGroupBox{background:#1a1d22;border:1px solid #2b3038;border-radius:6px;"
            "margin-top:9px;padding-top:8px;}"
            "QGroupBox::title{subcontrol-origin:margin;left:10px;color:#aeb7c4;}"
            "QPushButton{background:#272c34;border:1px solid #3a4049;border-radius:4px;"
            "padding:4px 10px;}"
            "QPushButton:hover{background:#313741;}"
            "QPushButton:disabled{color:#666c76;background:#1d2025;}"
            "QDoubleSpinBox,QSpinBox,QComboBox{background:#1e2128;border:1px solid #363c45;"
            "border-radius:4px;padding:2px 4px;min-width:70px;}"
            "QSplitter::handle{background:#22262d;}"
            "QScrollBar:vertical{background:#1a1d22;width:10px;}"
            "QScrollBar::handle:vertical{background:#39404a;border-radius:5px;}"
        )

    # -------------------------------------------------------------- 数据载入
    def _set_project_data(self, wav: WavData, name: str, path: str | None = None,
                          backup: WavData | None = None) -> None:
        self.stop_audio()
        # backup 在样例场景里就是干净参考音, 用于给出修复误差
        self.project.load(wav, path, reference=backup)
        self._backup = backup.copy() if backup is not None else wav.copy()
        self.lbl_file.setText(
            f"{name}  ·  {wav.frames} 帧 / {wav.channels} 声道 / {wav.sample_rate} Hz / "
            f"{wav.bits_per_sample} bit  ·  {wav.duration:.2f}s"
        )
        self.selected_id = None
        self._strips_visible_channels(wav.channels)
        self.project.preview_candidate = None
        self.project.include_preview = self.cb_preview.isChecked()
        for strip in self._strips:
            strip.set_project(self.project)
            strip.set_view(0, min(wav.frames, wav.sample_rate))
        for table in self._tables:
            table.rebuild(self.project)
        self.sp_sel_start.setRange(0, max(0, wav.frames - 1))
        self.sp_sel_end.setRange(0, max(0, wav.frames - 1))
        self.btn_export.setEnabled(True)
        self._log(f"载入 {name}: {wav.frames} 帧, {wav.channels} 声道")
        self._update_enabled()
        self.refresh_verification()

    def _strips_visible_channels(self, channels: int) -> None:
        for i, strip in enumerate(self._strips):
            strip.setVisible(i < channels)
        for i, table in enumerate(self._tables):
            table.setEnabled(i < channels)

    def load_builtin_sample(self) -> None:
        try:
            wavs = sample_wavs()
        except Exception as exc:  # pragma: no cover
            QMessageBox.critical(self, "生成样例失败", str(exc))
            return
        dlg = QMessageBox(self)
        dlg.setWindowTitle("选择样例")
        dlg.setText("程序内生成三种对照音频, 请选择要载入的版本:")
        b_clean = dlg.addButton("干净原声 (真实敲击)", QMessageBox.AcceptRole)
        b_deg = dlg.addButton("注入脉冲 (待修复)", QMessageBox.AcceptRole)
        b_rep = dlg.addButton("自动修复后", QMessageBox.AcceptRole)
        dlg.addButton("取消", QMessageBox.RejectRole)
        dlg.exec()
        clicked = dlg.clickedButton()
        if clicked is b_clean:
            wav = wavs["clean"]
            self._set_project_data(wav, "样例: 干净原声", backup=wav)
        elif clicked is b_deg:
            wav = wavs["degraded"]
            self._set_project_data(wav, "样例: 注入脉冲", backup=wavs["clean"])
        elif clicked is b_rep:
            wav = wavs["repaired"]
            self._set_project_data(wav, "样例: 自动修复后", backup=wavs["clean"])
        else:
            return
        self.run_detection(verbose=False)

    def load_simple_sample(self) -> None:
        wav = synthetic_noisy_wav()
        self._set_project_data(wav, "样例: 简单测试信号", backup=wav)
        self.run_detection(verbose=False)

    def open_wav_dialog(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "打开 WAV", "", "WAV 文件 (*.wav)")
        if not path:
            return
        try:
            wav = load_wav(path)
        except Exception as exc:
            QMessageBox.critical(self, "无法读取", f"{path}\n\n{exc}")
            return
        self._set_project_data(wav, os.path.basename(path), path=path, backup=wav)
        self.run_detection(verbose=False)

    # -------------------------------------------------------------- 检测
    def _collect_params(self) -> DetectParams:
        return DetectParams(
            abs_threshold_db=self.sp_thresh.value(),
            z_threshold=self.sp_z.value(),
            max_run=self.sp_maxrun.value(),
            merge_gap=self.sp_merge.value(),
            background_db=self.sp_bg.value(),
            onset_guard_db=self.sp_onset.value(),
        )

    def run_detection(self, verbose: bool = True) -> None:
        if not self.project.loaded:
            return
        self.project.params = self._collect_params()
        t0 = time.perf_counter()
        stats = self.project.run_detection()
        dt = (time.perf_counter() - t0) * 1000
        self.selected_id = None
        self._refresh_all()
        msg = (self.project.detect_note + f"  [{dt:.0f} ms]")
        self._log(msg)
        if verbose and stats.get("merged"):
            self._log("重叠候选已自动合并, 见合并记录")
        for line in self.project.merge_log:
            self._log(line)
        self._update_enabled()
        self.refresh_verification()

    # -------------------------------------------------------------- 选中与状态
    def select_candidate(self, cid: int | None) -> None:
        self.selected_id = cid
        cand = self.project.candidate(cid) if cid is not None else None
        if cand is None:
            self.lbl_sel.setText("（未选中）")
            self.project.preview_candidate = None
        else:
            self.lbl_sel.setText(
                f"#{cand.id} · CH{cand.channel + 1} · 帧 {cand.start}–{cand.end} "
                f"({cand.width} 点)\n{cand.reason}\n偏差 {cand.deviation_db:.1f} dBFS, "
                f"z={cand.z_score:.0f}, 背景 {cand.background_db:.1f} dBFS"
            )
            self.sp_sel_start.setValue(cand.start)
            self.sp_sel_end.setValue(cand.end)
            self.project.preview_candidate = cid
            if not self.cb_preview.isChecked():
                self.project.include_preview = False
            # 把视图移到该候选
            span = max(64, cand.width * 32)
            center = (cand.start + cand.end) // 2
            start = max(0, center - span // 2)
            self._set_view(start, start + span)
        for strip in self._strips:
            strip.detail.set_selected(cid)
        for table in self._tables:
            table.blockSignals(True)
            for row in range(table.rowCount()):
                is_sel = table.id_at_row(row) == cid
                for col in range(table.columnCount()):
                    item = table.item(row, col)
                    if item is not None:
                        item.setBackground(QColor(47, 79, 122) if is_sel else QColor(0, 0, 0, 0))
            table.blockSignals(False)
        self._update_enabled()
        self.refresh_verification()

    def _on_table_select(self, channel: int) -> None:
        cid = self._tables[channel].selected_candidate_id()
        if cid is not None and cid != self.selected_id:
            self.select_candidate(cid)

    def _set_state(self, cid: int | None, state: str) -> None:
        if cid is None:
            return
        if state == "accepted":
            self.project.accept(cid)
        elif state == "rejected":
            self.project.reject(cid)
        else:
            self.project.reset(cid)
        self._refresh_all()

    def _accept_all(self, channel: int) -> None:
        n = self.project.accept_all(channel)
        self._log(f"CH{channel + 1}: 接受 {n} 个可修复候选 (待确认项保持未修复)")
        self._refresh_all()

    def _reject_all(self, channel: int) -> None:
        n = self.project.reject_all(channel)
        self._log(f"CH{channel + 1}: 拒绝 {n} 个候选")
        self._refresh_all()

    def apply_range(self) -> None:
        cid = self.selected_id
        if cid is None:
            QMessageBox.information(self, "提示", "请先选中一个候选")
            return
        start, end = self.sp_sel_start.value(), self.sp_sel_end.value()
        cand = self.project.candidate(cid)
        if cand is None:
            return
        overlaps = self.project.overlapping_pairs(cid, start, end)
        if overlaps:
            names = ", ".join(f"#{c.id}[{c.start},{c.end}]" for c in overlaps)
            ans = QMessageBox.question(
                self, "区间重叠",
                f"新范围 [{start}, {end}] 与候选 {names} 重叠。\n"
                "继续将把它们合并为同一个修复区间 (不会重复应用)。是否继续?",
                QMessageBox.Yes | QMessageBox.No, QMessageBox.Yes)
            if ans != QMessageBox.Yes:
                return
        removed = self.project.set_range(cid, start, end)
        for line in self.project.merge_log:
            self._log(line)
        self.project.merge_log.clear()
        if removed:
            self._log(f"合并了候选: {', '.join(f'#{r}' for r in removed)}")
        self._refresh_all()

    def merge_overlaps(self) -> None:
        n = self.project.merge_all_overlaps()
        for line in self.project.merge_log:
            self._log(line)
        self.project.merge_log.clear()
        self._log(f"合并完成: {n} 个重叠候选被并入其它候选")
        self._refresh_all()

    def undo(self) -> None:
        if self.project.undo():
            self.selected_id = None
            self.project.preview_candidate = None
            self._log("已撤销上一步候选编辑")
            self._refresh_all()

    def _on_preview_toggle(self, checked: bool) -> None:
        self.project.include_preview = checked
        self.project._invalidate()
        self.refresh_verification()

    def _on_method_changed(self, index: int) -> None:
        self.project.method = "cubic" if index == 1 else "linear"
        self.project._invalidate()
        self._refresh_all()

    def _on_show_protected(self, checked: bool) -> None:
        for strip in self._strips:
            strip.detail.show_protected = checked
        for table in self._tables:
            table.set_protected_visible(checked)

    # -------------------------------------------------------------- 视图交互
    def _set_view(self, start: int, end: int) -> None:
        self._view = (start, end)
        for strip in self._strips:
            strip.set_view(start, end)

    def _sync_views(self, start: int, end: int) -> None:
        self._view = (start, end)
        for strip in self._strips:
            strip.overview.set_view(start, end)
            strip.detail.view = type(strip.detail.view)(start, end)
            strip.detail.update()

    def _on_seek(self, frame: int, channel: int) -> None:
        for strip in self._strips:
            strip.detail.set_playhead(frame)

    def _on_region(self, start: int, end: int, channel: int) -> None:
        self._selection = (start, end)
        self._log(f"选区 [{start}, {end}] ({end - start} 帧)")

    def _on_candidate_committed(self, cid: int, start: int, end: int) -> None:
        cand = self.project.candidate(cid)
        if cand is None:
            return
        overlaps = self.project.overlapping_pairs(cid, start, end)
        if overlaps:
            names = ", ".join(f"#{o.id}[{o.start},{o.end}]" for o in overlaps)
            ans = QMessageBox.question(
                self, "区间重叠",
                f"调整后的范围 [{start}, {end}] 与候选 {names} 重叠。\n"
                "继续将把它们合并为同一个修复区间 (不会重复应用)。是否继续?",
                QMessageBox.Yes | QMessageBox.No, QMessageBox.Yes)
            if ans != QMessageBox.Yes:
                return
        removed = self.project.set_range(cid, start, end)
        for line in self.project.merge_log:
            self._log(line)
        self.project.merge_log.clear()
        if removed:
            self._log(f"合并了候选: {', '.join(f'#{r}' for r in removed)}")
        self.sp_sel_start.setValue(self.project.candidate(cid).start
                                   if self.project.candidate(cid) else start)
        self.sp_sel_end.setValue(self.project.candidate(cid).end
                                 if self.project.candidate(cid) else end)
        self._refresh_all(keep_selection=cid)

    def set_loop_from_candidate(self) -> None:
        cand = self.project.candidate(self.selected_id) if self.selected_id else None
        if cand is None:
            QMessageBox.information(self, "提示", "请先选中一个候选")
            return
        pad = max(48, cand.width * 8)
        self._set_loop(max(0, cand.start - pad), min(self.project.frames, cand.end + pad))
        for strip in self._strips:
            strip.detail.set_loop_range(*self._loop_range)
        self._set_view(max(0, cand.start - pad * 4), cand.end + pad * 4)

    def set_loop_from_selection(self) -> None:
        if not getattr(self, "_selection", None):
            QMessageBox.information(self, "提示", "请先在波形上拖动选择一段区间")
            return
        a, b = self._selection
        self._set_loop(a, b)
        for strip in self._strips:
            strip.detail.set_loop_range(a, b)

    def _set_loop(self, start: int, end: int) -> None:
        start = max(0, min(start, self.project.frames - 1))
        end = max(start + 1, min(end, self.project.frames))
        self._loop_range = (start, end)
        self.lbl_loop.setText(
            f"循环区间: {start}–{end} 帧 ({(end - start) / self.project.sample_rate * 1000:.1f} ms)"
        )

    # -------------------------------------------------------------- 试听
    def play_loop(self, use_repaired: bool) -> None:
        if not self.project.loaded:
            return
        if not self.engine.available:
            QMessageBox.warning(self, "无音频后端", "未找到可用的音频播放后端")
            return
        if not getattr(self, "_loop_range", None):
            cand = self.project.candidate(self.selected_id) if self.selected_id else None
            if cand is None:
                QMessageBox.information(self, "提示", "请先设置循环区间或选中候选")
                return
            pad = max(48, cand.width * 8)
            self._set_loop(max(0, cand.start - pad), min(self.project.frames, cand.end + pad))
            for strip in self._strips:
                strip.detail.set_loop_range(*self._loop_range)
        a, b = self._loop_range
        wav = self.project.region_playback(a, b, use_repaired)
        self.engine.play(wav, 0, wav.frames, loop=True)
        self.loop_use_repaired = use_repaired
        self._play_base = a
        self._play_len = b - a
        self._play_timer.start()
        self.btn_play_orig.setEnabled(False)
        self.btn_play_rep.setEnabled(False)
        self._log(f"循环播放 {'修复后' if use_repaired else '原声'} 区间 [{a}, {b}]  "
                  f"({b - a} 帧, 长度一致)")

    def stop_audio(self) -> None:
        self._play_timer.stop()
        if self.engine.available:
            self.engine.stop()
        self.btn_play_orig.setEnabled(True)
        self.btn_play_rep.setEnabled(True)
        for strip in self._strips:
            strip.detail.set_playhead(None)

    def _poll_playhead(self) -> None:
        pos = self.engine.position_frames()
        if pos is None or not self.engine.playing:
            if not self.engine.playing:
                self._play_timer.stop()
                self.btn_play_orig.setEnabled(True)
                self.btn_play_rep.setEnabled(True)
            return
        frame = getattr(self, "_play_base", 0) + (pos % max(1, getattr(self, "_play_len", 1)))
        for strip in self._strips:
            strip.detail.set_playhead(min(frame, self.project.frames - 1))

    # -------------------------------------------------------------- 刷新
    def _refresh_all(self, keep_selection: int | None = None) -> None:
        cid = keep_selection if keep_selection is not None else self.selected_id
        if cid is not None and self.project.candidate(cid) is None:
            cid = None
        self.selected_id = cid
        self.project.preview_candidate = cid
        for strip in self._strips:
            strip.detail.set_project(self.project)
        for table in self._tables:
            table.rebuild(self.project, selected_id=cid)
            if cid is not None:
                row = table.row_of(cid)
                if row is not None:
                    table.selectRow(row)
        self._update_enabled()
        self.refresh_verification()

    def _update_enabled(self) -> None:
        has_sel = self.selected_id is not None
        for b in (self.btn_accept, self.btn_reject, self.btn_reset,
                  self.btn_apply_range, self.btn_loop_set):
            b.setEnabled(has_sel)
        self.btn_export.setEnabled(self.project.loaded)
        self.btn_undo.setEnabled(bool(self.project._undo))

    def refresh_verification(self) -> None:
        if not self.project.loaded:
            self.lbl_verify.setText("尚无修复区间")
            return
        v = self.project.verification()
        spans = v["spans"]
        applied = sum(len(s) for s in spans.values())
        n_accepted = len([c for c in self.project.candidates.values()
                          if c.state == "accepted"])
        lines = [f"已接受候选 {n_accepted} 个, 实际修复区间 {applied} 段"]
        for ch, ch_spans in spans.items():
            if ch_spans:
                info = v["per_channel"].get(ch)
                extra = (f", 改动量 RMS {info['rms_db']:.1f} dB / 峰值 {info['peak_db']:.1f} dB"
                         if info else "")
                lines.append(f"CH{ch + 1}: {len(ch_spans)} 段{extra}")
                if info and "ref_after_rms_db" in info:
                    lines.append(
                        f"    对干净参考误差: 修复后 {info['ref_after_rms_db']:.1f} dB, "
                        f"修复前 {info['ref_before_rms_db']:.1f} dB (越低越好)")
        lines.append(
            f"修复区间之外改动: {v['outside_changed']} 个采样 "
            + ("✓" if v["outside_changed"] == 0 else "⚠ 不应出现")
        )
        if self.project.reference is None:
            lines.append("（载入带干净参考的样例时可显示修复误差）")
        self.lbl_verify.setText("\n".join(lines))

    # -------------------------------------------------------------- 导出与校验
    def export_wav(self) -> None:
        if not self.project.loaded:
            return
        default = "repaired.wav"
        if self.project.path:
            p = Path(self.project.path)
            default = str(p.with_name(p.stem + "_repaired.wav"))
        path, _ = QFileDialog.getSaveFileName(self, "导出修复 WAV", default, "WAV 文件 (*.wav)")
        if not path:
            return
        try:
            info = self.project.export(path)
        except Exception as exc:
            QMessageBox.critical(self, "导出失败", str(exc))
            return
        msg = (f"已导出 {path}\n"
               f"帧数 {info['frames']}, 声道 {info['channels']}, {info['bits']} bit\n"
               f"修复区间之外改动采样数: {info['outside_changed']}")
        self._log(msg.replace("\n", "  "))
        if info["outside_changed"] != 0:
            QMessageBox.warning(self, "校验未通过", msg + "\n\n区间外采样发生变化, 请检查")
        else:
            QMessageBox.information(self, "导出完成", msg)

    def run_benchmark_dialog(self) -> None:
        report, _ = benchmark.run_benchmark(params=self._collect_params())
        box = QMessageBox(self)
        box.setWindowTitle("合成对照测试")
        box.setText("合成原声 + 注入脉冲对照结果 (等宽字体显示)")
        box.setDetailedText(report.summary_text())
        box.setInformativeText(
            "干净原声: 自动修复标记 "
            f"{report.scenarios[0].detected_spike} 个; "
            "注入场景: 误标 "
            f"{report.scenarios[1].false_marks} 个, 区间外改动 "
            f"{report.scenarios[1].outside_changed_samples} 个."
        )
        box.exec()
        self._log("运行合成对照测试:")
        for line in report.summary_text().splitlines():
            self._log(line)

    # -------------------------------------------------------------- 杂项
    def _log(self, text: str) -> None:
        self.log.append(text)

    def closeEvent(self, event) -> None:  # noqa: N802
        self.stop_audio()
        super().closeEvent(event)


def main(argv: list[str] | None = None) -> int:
    app = QApplication.instance() or QApplication(argv or [])
    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
