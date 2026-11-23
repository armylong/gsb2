"""Main window: load, detect, audition, audit and export."""

from __future__ import annotations

import os
from pathlib import Path

import numpy as np
from PySide6.QtCore import QSettings, Qt
from PySide6.QtGui import QAction, QColor, QKeySequence, QPalette
from PySide6.QtWidgets import (
    QAbstractItemView,
    QApplication,
    QCheckBox,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QDoubleSpinBox,
    QFileDialog,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QPlainTextEdit,
    QProgressBar,
    QPushButton,
    QSpinBox,
    QSplitter,
    QStatusBar,
    QTableWidget,
    QTableWidgetItem,
    QTabWidget,
    QToolButton,
    QVBoxLayout,
    QWidget,
)

from .. import analysis as an
from ..analysis import (
    CONFIDENCE_LABELS,
    CONFIDENCE_LOW,
    CONFIDENCE_MEDIUM,
    METHOD_LABELS,
    STATUS_CONFIRMED,
    STATUS_EXCLUDED,
    STATUS_LABELS,
    STATUS_SUSPECTED,
)
from ..document import Document
from ..samples import SAMPLES
from ..wavio import WavError
from .audio import AudioPlayer, build_playback_buffer, device_format
from .waveform import WaveformView

AUDITION_MODES = {
    "原始": "original",
    "修复后": "repaired",
    "修复/原始叠加": "overlay",
    "差值": "diff",
}

CHANNEL_MODES = {
    "立体声": "both",
    "只听左": "left",
    "只听右": "right",
}

POLARITY_FILTERS = {"正负都看": "both", "只看正削顶": "pos", "只看负削顶": "neg"}

STATUS_COLORS = {
    STATUS_SUSPECTED: QColor("#e0b34f"),
    STATUS_CONFIRMED: QColor("#d9793a"),
    STATUS_EXCLUDED: QColor("#6a7280"),
}

CONFIDENCE_COLORS = {
    an.CONFIDENCE_HIGH: QColor("#7ee0a3"),
    CONFIDENCE_MEDIUM: QColor("#e0b34f"),
    CONFIDENCE_LOW: QColor("#c060c0"),
}


class MainWindow(QMainWindow):
    def __init__(self, settings: QSettings | None = None) -> None:
        super().__init__()
        self.setWindowTitle("削顶修复试听工具")
        self.resize(1280, 860)
        self.doc = Document()
        self.player = AudioPlayer(self)
        self.player.finished.connect(self._on_playback_finished)
        self.settings = settings or QSettings("clipmend", "clipmend")
        self.samples_dir = Path(
            self.settings.value("samples_dir", str(Path.cwd() / "samples"))
        )
        self._audition_loops = False
        self._last_region_channel = 0
        self._last_verification: an.VerificationReport | None = None
        self._suppress_table_signals = False

        self._build_ui()
        self._build_actions()
        self._restore_settings()
        self._refresh_all()

    # -- construction ------------------------------------------------------

    def _build_ui(self) -> None:
        splitter = QSplitter(Qt.Orientation.Vertical)
        splitter.addWidget(self._build_wave_panel())
        splitter.addWidget(self._build_lower_panel())
        splitter.setStretchFactor(0, 3)
        splitter.setStretchFactor(1, 2)
        self.setCentralWidget(splitter)
        self.setStatusBar(QStatusBar())
        self._status_label = QLabel("打开 WAV，或从「样例」菜单载入内置样例")
        self.statusBar().addWidget(self._status_label, 1)
        self._view_label = QLabel("")
        self.statusBar().addPermanentWidget(self._view_label)
        self._player_label = QLabel("")
        self.statusBar().addPermanentWidget(self._player_label)

    def _build_wave_panel(self) -> QWidget:
        panel = QWidget()
        layout = QVBoxLayout(panel)
        layout.setContentsMargins(8, 6, 8, 4)

        self.waveform = WaveformView()
        self.waveform.playheadMoved.connect(self._on_playhead)
        self.waveform.regionSelected.connect(self._on_region_selected)
        self.waveform.viewChanged.connect(self._on_view_changed)
        self.waveform.segmentClicked.connect(self._on_segment_clicked)
        layout.addWidget(self.waveform, 1)

        bar = QHBoxLayout()
        self.mode_combo = QComboBox()
        self.mode_combo.addItems(list(AUDITION_MODES.keys()))
        self.mode_combo.setToolTip("试听与显示哪一版本（F1/F2/F3/F4 快速切换）")
        self.mode_combo.currentTextChanged.connect(self._on_mode_changed)
        bar.addWidget(QLabel("试听:"))
        bar.addWidget(self.mode_combo)

        self.channel_combo = QComboBox()
        self.channel_combo.addItems(list(CHANNEL_MODES.keys()))
        self.channel_combo.setToolTip("单声道独听，便于确认未被修声道没有变化")
        self.channel_combo.currentTextChanged.connect(lambda _: self._refresh_player_label())
        bar.addWidget(QLabel("声道:"))
        bar.addWidget(self.channel_combo)

        self.polarity_combo = QComboBox()
        self.polarity_combo.addItems(list(POLARITY_FILTERS.keys()))
        self.polarity_combo.currentTextChanged.connect(self._on_polarity_filter)
        bar.addWidget(QLabel("削顶极性:"))
        bar.addWidget(self.polarity_combo)

        self.overlay_check = QCheckBox("显示修复/差值标记")
        self.overlay_check.setChecked(True)
        self.overlay_check.toggled.connect(self.waveform.set_show_changed)
        bar.addWidget(self.overlay_check)

        bar.addStretch(1)
        zoom_in = QToolButton()
        zoom_in.setText("放大")
        zoom_in.clicked.connect(lambda: self.waveform.zoom(1.6))
        zoom_out = QToolButton()
        zoom_out.setText("缩小")
        zoom_out.clicked.connect(lambda: self.waveform.zoom(1 / 1.6))
        fit = QToolButton()
        fit.setText("全览")
        fit.clicked.connect(self.waveform.fit)
        for btn in (zoom_in, zoom_out, fit):
            bar.addWidget(btn)
        layout.addLayout(bar)
        return panel

    def _build_lower_panel(self) -> QWidget:
        tabs = QTabWidget()
        tabs.addTab(self._build_segments_tab(), "削顶片段")
        tabs.addTab(self._build_audition_tab(), "试听")
        tabs.addTab(self._build_audit_tab(), "修改明细")
        tabs.addTab(self._build_export_tab(), "导出 / 核对")
        self.tabs = tabs
        return tabs

    def _build_segments_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)

        det = QGroupBox("判定门槛（改动会重新扫描；已确认/已排除的片段不会被丢掉）")
        grid = QHBoxLayout(det)
        # Integer PCM never reaches exactly 1.0 (16-bit tops out at
        # 32767/32768), so a 0 dBFS threshold would detect nothing.  Cap just
        # below it.
        self.pos_spin = QDoubleSpinBox()
        self.pos_spin.setRange(-80.0, -0.01)
        self.pos_spin.setSingleStep(0.25)
        self.pos_spin.setDecimals(2)
        self.pos_spin.setSuffix(" dBFS")
        self.pos_spin.setToolTip("正削顶判定：采样值 ≥ 该电平（最高 -0.01 dBFS）")
        self.neg_spin = QDoubleSpinBox()
        self.neg_spin.setRange(-80.0, -0.01)
        self.neg_spin.setSingleStep(0.25)
        self.neg_spin.setDecimals(2)
        self.neg_spin.setSuffix(" dBFS")
        self.neg_spin.setToolTip("负削顶判定：采样值 ≤ -该电平（最高 -0.01 dBFS）")
        self.minrun_spin = QSpinBox()
        self.minrun_spin.setRange(1, 4000)
        self.minrun_spin.setSuffix(" 样本")
        self.minrun_spin.setToolTip("连续多少个样本达到门槛才算一段")
        self.joined_spin = QSpinBox()
        self.joined_spin.setRange(0, 400)
        self.joined_spin.setSuffix(" 样本")
        self.joined_spin.setToolTip("合并中间只断开这么几个样本的平台")

        for label, widget in (
            ("正门槛", self.pos_spin),
            ("负门槛", self.neg_spin),
            ("最短", self.minrun_spin),
            ("合并间隔", self.joined_spin),
        ):
            grid.addWidget(QLabel(label))
            grid.addWidget(widget)
        self.apply_det_btn = QPushButton("重新扫描")
        self.apply_det_btn.clicked.connect(self._apply_detection)
        grid.addWidget(self.apply_det_btn)
        grid.addStretch(1)
        layout.addWidget(det)

        actions = QHBoxLayout()
        self.confirm_btn = QPushButton("确认选中")
        self.confirm_btn.setToolTip("确认后该片段会保留，即使门槛变化也不再丢失")
        self.confirm_btn.clicked.connect(lambda: self._set_selected_status(STATUS_CONFIRMED))
        self.exclude_btn = QPushButton("排除选中")
        self.exclude_btn.setToolTip("排除方波样/本来就平的内容；不会删除记录")
        self.exclude_btn.clicked.connect(lambda: self._set_selected_status(STATUS_EXCLUDED))
        self.auto_exclude_btn = QPushButton("排除所有『方波样』提示")
        self.auto_exclude_btn.clicked.connect(self._exclude_square_hints)
        self.clear_sel_btn = QPushButton("清除选择")
        self.clear_sel_btn.clicked.connect(self._clear_selection)
        self.method_combo = QComboBox()
        for key in ("auto", "hermite", "lpc"):
            self.method_combo.addItem(METHOD_LABELS[key], key)
        self.method_combo.setToolTip("自动 = 短缺口用埃尔米特、长缺口用预测并降级")
        self.method_combo.currentIndexChanged.connect(self._on_method_changed)
        for w in (
            self.confirm_btn,
            self.exclude_btn,
            self.auto_exclude_btn,
            self.clear_sel_btn,
        ):
            actions.addWidget(w)
        actions.addWidget(QLabel("修复方式:"))
        actions.addWidget(self.method_combo)
        actions.addStretch(1)
        self.add_region_btn = QPushButton("把波形选区加为修复区")
        self.add_region_btn.setToolTip("在波形上拖选后点击；也可用于手动补上漏检的削顶")
        self.add_region_btn.clicked.connect(self._add_selected_region)
        actions.addWidget(self.add_region_btn)
        layout.addLayout(actions)

        self.table = QTableWidget(0, 9)
        self.table.setHorizontalHeaderLabels(
            ["修复", "#", "声道", "极性", "开始 (样本)", "长度", "状态", "置信", "提示"]
        )
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.table.verticalHeader().setVisible(False)
        header = self.table.horizontalHeader()
        header.setSectionResizeMode(QHeaderView.ResizeMode.ResizeToContents)
        header.setSectionResizeMode(8, QHeaderView.ResizeMode.Stretch)
        self.table.itemSelectionChanged.connect(self._on_table_selection)
        self.table.itemDoubleClicked.connect(self._on_table_double_clicked)
        self.table.itemChanged.connect(self._on_table_item_changed)
        layout.addWidget(self.table, 1)

        self.seg_summary = QLabel("")
        self.seg_summary.setWordWrap(True)
        layout.addWidget(self.seg_summary)
        return page

    def _build_audition_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        info = QLabel(
            "双击波形定位，或拖选一段区间。试听会把同一时间段依次按「原始 / 修复 / 差值」"
            "切好，长度保持一致，便于 A/B。"
        )
        info.setWordWrap(True)
        layout.addWidget(info)

        row = QHBoxLayout()
        self.audition_from = QLineEdit()
        self.audition_from.setPlaceholderText("起点样本")
        self.audition_to = QLineEdit()
        self.audition_to.setPlaceholderText("终点样本")
        pick_btn = QPushButton("用当前选区")
        pick_btn.clicked.connect(self._fill_audition_from_selection)
        seg_btn = QPushButton("用选中片段")
        seg_btn.clicked.connect(self._fill_audition_from_segment)
        loop_check = QCheckBox("循环")
        loop_check.toggled.connect(lambda v: setattr(self, "_audition_loops", v))
        self.loop_check = loop_check
        solo_check = QCheckBox("独听选区所在声道")
        solo_check.setChecked(False)
        solo_check.setToolTip("勾选后只放出该声道，核对另一声道确实没变")
        self.solo_check = solo_check
        for label, w in (
            ("起点", self.audition_from),
            ("终点", self.audition_to),
            ("", pick_btn),
            ("", seg_btn),
        ):
            if label:
                row.addWidget(QLabel(label))
            row.addWidget(w)
        row.addWidget(loop_check)
        row.addWidget(solo_check)
        row.addStretch(1)
        layout.addLayout(row)

        self.audition_selection_label = QLabel("")
        self.audition_selection_label.setWordWrap(True)
        self.audition_selection_label.setStyleSheet("color: #8b95a3;")
        layout.addWidget(self.audition_selection_label)

        btns = QHBoxLayout()
        # The F1–F4 shortcuts belong to the menu actions (single owner avoids
        # "ambiguous shortcut" warnings); the buttons just advertise them.
        for text, mode in (
            ("F1 原始", "original"),
            ("F2 修复后", "repaired"),
            ("F3 差值", "diff"),
            ("F4 左右切换", "toggle"),
        ):
            b = QPushButton(text)
            if mode == "toggle":
                b.clicked.connect(self._audition_toggle_channel)
            else:
                b.clicked.connect(lambda _=False, m=mode: self._audition(m))
            btns.addWidget(b)
        stop_btn = QPushButton("停止 (Esc)")
        stop_btn.clicked.connect(self._stop_playback)
        btns.addWidget(stop_btn)
        btns.addStretch(1)
        btn_text = QPushButton("把当前区间改在波形上一屏显示")
        btn_text.clicked.connect(self._frame_audition_range)
        btns.addWidget(btn_text)
        layout.addLayout(btns)

        self.audition_info = QLabel("")
        self.audition_info.setWordWrap(True)
        layout.addWidget(self.audition_info)
        layout.addStretch(1)
        return page

    def _frame_audition_range(self) -> None:
        selection = self.waveform.selection
        if selection is not None:
            start, end = selection
        else:
            rng = self._audition_range()
            if rng is None:
                return
            start, end = rng
        pad = max(20, (end - start) // 2)
        self.waveform.set_view(start - pad, end + pad)

    def _build_audit_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        self.audit_table = QTableWidget(0, 7)
        self.audit_table.setHorizontalHeaderLabels(
            ["片段", "声道", "区间 (样本)", "方式", "置信", "改动样本", "改动区间"]
        )
        self.audit_table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.audit_table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.audit_table.verticalHeader().setVisible(False)
        header = self.audit_table.horizontalHeader()
        header.setSectionResizeMode(QHeaderView.ResizeMode.ResizeToContents)
        header.setSectionResizeMode(6, QHeaderView.ResizeMode.Stretch)
        self.audit_table.itemSelectionChanged.connect(self._on_audit_selection)
        layout.addWidget(self.audit_table, 1)

        row = QHBoxLayout()
        save_json = QPushButton("保存修改明细 JSON…")
        save_json.clicked.connect(self._save_audit_json)
        save_csv = QPushButton("保存修改明细 CSV…")
        save_csv.clicked.connect(self._save_audit_csv)
        inspect = QPushButton("查看精确改动采样点…")
        inspect.setToolTip("逐样本列出改动前后的值，用于核对具体改到了哪些点")
        inspect.clicked.connect(self._show_changed_samples)
        row.addWidget(inspect)
        row.addWidget(save_json)
        row.addWidget(save_csv)
        row.addStretch(1)
        layout.addLayout(row)

        self.audit_summary = QLabel("")
        self.audit_summary.setWordWrap(True)
        layout.addWidget(self.audit_summary)
        return page

    def _build_export_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        self.headroom_box = QGroupBox("导出前峰值检查")
        hb = QVBoxLayout(self.headroom_box)
        self.headroom_label = QLabel("")
        self.headroom_label.setWordWrap(True)
        hb.addWidget(self.headroom_label)
        self.headroom_bar = QProgressBar()
        self.headroom_bar.setRange(0, 100)
        self.headroom_bar.setTextVisible(False)
        self.headroom_bar.setFixedHeight(14)
        hb.addWidget(self.headroom_bar)
        row = QHBoxLayout()
        row.addWidget(QLabel("位深"))
        self.bits_combo = QComboBox()
        for bits in (16, 24, 32):
            self.bits_combo.addItem(f"{bits} 位", bits)
        self.bits_combo.currentIndexChanged.connect(self._refresh_headroom)
        row.addWidget(self.bits_combo)
        self.export_btn = QPushButton("导出 WAV 并回读核对…")
        self.export_btn.clicked.connect(self._export)
        row.addWidget(self.export_btn)
        row.addStretch(1)
        hb.addLayout(row)
        layout.addWidget(self.headroom_box)

        self.verify_box = QGroupBox("导出后回读核对")
        vb = QVBoxLayout(self.verify_box)
        self.verify_label = QLabel("尚未导出")
        self.verify_label.setWordWrap(True)
        vb.addWidget(self.verify_label)
        self.verify_table = QTableWidget(0, 4)
        self.verify_table.setHorizontalHeaderLabels(
            ["声道", "文件实际改动区间", "意图外改动", "是否允许"]
        )
        self.verify_table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.verify_table.verticalHeader().setVisible(False)
        self.verify_table.horizontalHeader().setSectionResizeMode(
            1, QHeaderView.ResizeMode.Stretch
        )
        self.verify_table.horizontalHeader().setSectionResizeMode(
            2, QHeaderView.ResizeMode.Stretch
        )
        vb.addWidget(self.verify_table, 1)
        layout.addWidget(self.verify_box, 1)
        return page

    def _build_actions(self) -> None:
        file_menu = self.menuBar().addMenu("文件(&F)")
        open_action = QAction("打开 WAV…", self)
        open_action.setShortcut(QKeySequence.StandardKey.Open)
        open_action.triggered.connect(self._open_file)
        file_menu.addAction(open_action)
        file_menu.addSeparator()
        quit_action = QAction("退出", self)
        quit_action.setShortcut(QKeySequence.StandardKey.Quit)
        quit_action.triggered.connect(self.close)
        file_menu.addAction(quit_action)

        samples_menu = self.menuBar().addMenu("样例(&S)")
        for spec in SAMPLES:
            action = QAction(f"{spec.title}（{spec.seconds:.0f} 秒）", self)
            action.setToolTip(spec.description)
            action.triggered.connect(lambda _=False, k=spec.key: self._load_sample(k))
            samples_menu.addAction(action)

        audition_menu = self.menuBar().addMenu("试听(&A)")
        for label, mode, key in (
            ("原始", "original", "F1"),
            ("修复后", "repaired", "F2"),
            ("差值", "diff", "F3"),
        ):
            a = QAction(label, self)
            a.setShortcut(QKeySequence(key))
            a.triggered.connect(lambda _=False, m=mode: self._audition(m))
            audition_menu.addAction(a)
        overlay_action = QAction("修复/原始叠加显示（不播放）", self)
        overlay_action.setShortcut(QKeySequence("F5"))
        overlay_action.triggered.connect(
            lambda: self._set_audition_mode("overlay")
        )
        audition_menu.addAction(overlay_action)
        toggle_channel = QAction("左右声道交替试听", self)
        toggle_channel.setShortcut(QKeySequence("F4"))
        toggle_channel.triggered.connect(self._audition_toggle_channel)
        audition_menu.addAction(toggle_channel)
        audition_menu.addSeparator()
        audition_menu.addAction(
            self._make_action("停止播放 (Esc)", self._stop_playback, "Esc")
        )
        audition_menu.addAction(
            self._make_action("播放 / 停止 (空格)", self._toggle_playback, "Space")
        )

        view_menu = self.menuBar().addMenu("视图(&V)")
        fit_action = QAction("全览", self)
        fit_action.setShortcut(QKeySequence("Ctrl+0"))
        fit_action.triggered.connect(self.waveform.fit)
        view_menu.addAction(fit_action)

        full_screen = QAction("全屏", self)
        full_screen.setShortcut(QKeySequence("Ctrl+Shift+F"))
        full_screen.triggered.connect(self._toggle_fullscreen)
        view_menu.addAction(full_screen)

        help_menu = self.menuBar().addMenu("帮助(&H)")
        about_action = QAction("关于 / 使用说明", self)
        about_action.triggered.connect(self._show_about)
        help_menu.addAction(about_action)

    def _make_action(self, text: str, slot, shortcut: str | None = None) -> QAction:
        action = QAction(text, self)
        if shortcut:
            action.setShortcut(QKeySequence(shortcut))
        action.triggered.connect(slot)
        return action

    def _toggle_fullscreen(self) -> None:
        if self.isFullScreen():
            self.showNormal()
        else:
            self.showFullScreen()

    def _restore_settings(self) -> None:
        pos = float(self.settings.value("pos_dbfs", self.doc.config.pos_dbfs))
        neg = float(self.settings.value("neg_dbfs", self.doc.config.neg_dbfs))
        min_run = int(self.settings.value("min_run", self.doc.config.min_run))
        join_gap = int(self.settings.value("join_gap", self.doc.config.join_gap))
        method = str(self.settings.value("method", "auto"))
        bits = int(self.settings.value("bits", 16))
        self.pos_spin.setValue(pos)
        self.neg_spin.setValue(neg)
        self.minrun_spin.setValue(min_run)
        self.joined_spin.setValue(join_gap)
        idx = self.method_combo.findData(method)
        self.method_combo.setCurrentIndex(idx if idx >= 0 else 0)
        bidx = self.bits_combo.findData(bits)
        self.bits_combo.setCurrentIndex(bidx if bidx >= 0 else 0)
        self.doc.config = an.DetectionConfig(
            pos_dbfs=pos, neg_dbfs=neg, min_run=max(1, min_run), join_gap=join_gap
        )
        self.doc.method = method

    def _save_settings(self) -> None:
        self.settings.setValue("pos_dbfs", self.pos_spin.value())
        self.settings.setValue("neg_dbfs", self.neg_spin.value())
        self.settings.setValue("min_run", self.minrun_spin.value())
        self.settings.setValue("join_gap", self.joined_spin.value())
        self.settings.setValue("method", self.method_combo.currentData())
        self.settings.setValue("bits", self.bits_combo.currentData())
        self.settings.setValue("samples_dir", str(self.samples_dir))
        geo = self.saveGeometry()
        self.settings.setValue("geometry", geo)

    def closeEvent(self, event) -> None:  # noqa: N802
        self.player.stop()
        self._save_settings()
        super().closeEvent(event)

    # -- loading -----------------------------------------------------------

    def _open_file(self) -> None:
        start = str(Path.home())
        path, _ = QFileDialog.getOpenFileName(
            self, "打开 WAV（一分钟以内）", start, "WAV 文件 (*.wav *.WAV)"
        )
        if not path:
            return
        try:
            self.doc.load(path)
        except WavError as exc:
            QMessageBox.warning(self, "无法打开", str(exc))
            return
        except Exception as exc:  # pragma: no cover - defensive
            QMessageBox.critical(self, "无法打开", f"读取失败：{exc}")
            return
        self._refresh_all()
        self._status(f"已打开 {Path(path).name}")

    def _load_sample(self, key: str) -> None:
        try:
            self.doc.load_sample(key, self.samples_dir)
        except Exception as exc:  # pragma: no cover - defensive
            QMessageBox.critical(self, "样例载入失败", str(exc))
            return
        self._refresh_all()
        spec = next((s for s in SAMPLES if s.key == key), None)
        self._status(spec.description if spec else "已载入样例")

    # -- refresh -----------------------------------------------------------

    def _refresh_all(self) -> None:
        doc = self.doc
        wav = doc.wav
        if wav is None:
            self.waveform.set_data(None, None, None, 44100)
            self.seg_summary.setText("")
            self.audit_summary.setText("")
            self.headroom_label.setText("")
            return
        self.waveform.set_data(wav.samples, doc.repaired, doc.diff, wav.sample_rate)
        self._refresh_segment_table()
        self._refresh_audit()
        self._refresh_headroom()
        self._refresh_player_label()
        self._refresh_audition_label()
        self._update_window_title()

    def _update_window_title(self) -> None:
        wav = self.doc.wav
        if wav is None:
            self.setWindowTitle("削顶修复试听工具")
            return
        name = Path(self.doc.name).name
        mode = "立体声" if wav.channels == 2 else "单声道"
        self.setWindowTitle(
            f"削顶修复试听工具 — {name} · {wav.sample_rate} Hz · {mode} · "
            f"{wav.duration:.2f} 秒"
        )

    def _visible_views(self) -> list:
        """Segment views after the polarity filter, shared by table+waveform."""
        views = self.doc.segment_views()
        polarity = POLARITY_FILTERS[self.polarity_combo.currentText()]
        if polarity == "pos":
            return [v for v in views if v.segment.polarity > 0]
        if polarity == "neg":
            return [v for v in views if v.segment.polarity < 0]
        return views

    # A very low threshold can legitimately find tens of thousands of tiny
    # plateaus; painting them all would freeze the window.  The model keeps
    # everything (audit/export use all of it), the table shows a bounded page.
    MAX_TABLE_ROWS = 2000

    def _refresh_segment_table(self) -> None:
        doc = self.doc
        views = self._visible_views()
        shown = views[: self.MAX_TABLE_ROWS]
        self._suppress_table_signals = True
        self.table.setUpdatesEnabled(False)
        self.table.setRowCount(len(shown))
        sr = doc.wav.sample_rate if doc.wav else 44100
        changed_by_uid = {r.segment_uid: r for r in doc.records}
        for row, view in enumerate(shown):
            seg = view.segment
            rec = changed_by_uid.get(seg.uid)
            cells = [
                "",  # checkbox column, filled below
                str(seg.uid),
                "左" if seg.channel == 0 else ("右" if seg.channel == 1 else str(seg.channel)),
                "正" if seg.polarity > 0 else "负",
                f"{seg.start}  ({an.format_sample_time(seg.start, sr)})",
                f"{seg.length} 样本 / {1000.0 * seg.length / sr:.2f} ms",
                STATUS_LABELS.get(seg.status, seg.status),
                view.confidence_label,
                view.hint,
            ]
            for col, text in enumerate(cells):
                item = QTableWidgetItem(text)
                if col == 0:
                    item.setFlags(
                        Qt.ItemFlag.ItemIsUserCheckable
                        | Qt.ItemFlag.ItemIsEnabled
                        | Qt.ItemFlag.ItemIsSelectable
                    )
                    item.setCheckState(
                        Qt.CheckState.Unchecked
                        if seg.status == STATUS_EXCLUDED
                        else Qt.CheckState.Checked
                    )
                if col == 1:
                    item.setData(Qt.ItemDataRole.UserRole, seg.uid)
                if col == 6:
                    item.setForeground(STATUS_COLORS.get(seg.status, QColor("#ffffff")))
                    if seg.status == STATUS_EXCLUDED:
                        f = item.font()
                        f.setStrikeOut(True)
                        item.setFont(f)
                if col == 7:
                    if rec is not None:
                        item.setForeground(CONFIDENCE_COLORS.get(rec.confidence, QColor("#ffffff")))
                    if rec is not None and rec.confidence == CONFIDENCE_LOW:
                        f = item.font()
                        f.setBold(True)
                        item.setFont(f)
                self.table.setItem(row, col, item)
        self.table.setUpdatesEnabled(True)
        self._suppress_table_signals = False

        all_views = doc.segment_views()
        active = [v for v in views if v.segment.status != STATUS_EXCLUDED]
        low = [v for v in active if v.record and v.record.confidence == CONFIDENCE_LOW]
        excluded = [v for v in views if v.segment.status == STATUS_EXCLUDED]
        confirmed = [v for v in views if v.segment.status == STATUS_CONFIRMED]
        neg = [v for v in views if v.segment.polarity < 0]
        pos = [v for v in views if v.segment.polarity > 0]
        if len(views) > self.MAX_TABLE_ROWS:
            shown = f"共 {len(views)} 段，表格只列出前 {self.MAX_TABLE_ROWS} 段"
        elif len(views) != len(all_views):
            shown = f"显示 {len(views)}/{len(all_views)} 段"
        else:
            shown = f"共 {len(views)} 段"
        self.seg_summary.setText(
            f"{shown}：正削顶 {len(pos)}，负削顶 {len(neg)}；"
            f"可疑 {len(views) - len(excluded) - len(confirmed)}，"
            f"已确认 {len(confirmed)}，已排除 {len(excluded)}；"
            f"其中 {len(low)} 段的修复置信度为「低」（长段缺失，只作连接推测）"
        )
        self.waveform.set_segments(
            doc.segments,
            an.records_to_change_runs(doc.records, doc.wav.channels, doc.wav.frames)
            if doc.wav is not None else {},
            low_confidence_uids={r.segment_uid for r in doc.low_confidence_records()},
        )

    def _on_table_item_changed(self, item: QTableWidgetItem) -> None:
        if self._suppress_table_signals or item.column() != 0:
            return
        uid_item = self.table.item(item.row(), 1)
        if uid_item is None:
            return
        uid = int(uid_item.data(Qt.ItemDataRole.UserRole))
        enabled = item.checkState() == Qt.CheckState.Checked
        self.doc.set_enabled(uid, enabled)
        seg = self.doc.segment(uid)
        self._refresh_all()
        if seg is not None:
            self._status(
                f"片段 #{uid} " + ("参与修复" if enabled else "已排除（保留记录）")
            )

    def _refresh_audit(self) -> None:
        doc = self.doc
        if doc.wav is None:
            return
        sr = doc.wav.sample_rate
        records = doc.records[: self.MAX_TABLE_ROWS]
        self.audit_table.setUpdatesEnabled(False)
        self.audit_table.setRowCount(len(records))
        for row, rec in enumerate(records):
            runs = an.format_runs(rec.changed_runs, sr)
            cells = [
                str(rec.segment_uid),
                "左" if rec.channel == 0 else ("右" if rec.channel == 1 else str(rec.channel)),
                f"{rec.start}–{rec.end}",
                METHOD_LABELS.get(rec.method, rec.method),
                CONFIDENCE_LABELS.get(rec.confidence, rec.confidence),
                str(rec.changed_count),
                runs,
            ]
            for col, text in enumerate(cells):
                item = QTableWidgetItem(text)
                item.setData(Qt.ItemDataRole.UserRole, rec.segment_uid)
                if col == 4:
                    item.setForeground(CONFIDENCE_COLORS.get(rec.confidence, QColor("#ffffff")))
                self.audit_table.setItem(row, col, item)
        self.audit_table.setUpdatesEnabled(True)
        total = doc.total_changed_samples()
        extra = ""
        if len(doc.records) > len(records):
            extra = f"（表格只列出前 {len(records)} 段，完整内容请导出 JSON/CSV）"
        self.audit_summary.setText(
            f"修复片段 {len(doc.records)} 段，真实改动样本 {total} 个{extra}。"
            "勾选/取消片段会立即重建修复结果；每次改动都能在这里核对区间。"
        )

    def _refresh_headroom(self) -> None:
        doc = self.doc
        if doc.wav is None or doc.repaired is None:
            self.headroom_label.setText("")
            self.headroom_bar.setValue(0)
            return
        bits = int(self.bits_combo.currentData() or 16)
        rep = doc.headroom(bits)
        peak_db = rep.peak_dbfs
        orig_db = an.amp_to_db(rep.original_peak)
        fits_text = "放得下" if rep.fits else f"放不下（{rep.overflow_count} 个样本超满幅）"
        self.headroom_bar.setValue(int(max(0.0, min(1.0, rep.repaired_peak)) * 100))
        if rep.fits:
            self.headroom_bar.setStyleSheet("QProgressBar::chunk { background: #4f9bd9; }")
        else:
            self.headroom_bar.setStyleSheet("QProgressBar::chunk { background: #e05c5c; }")
        text = (
            f"原始峰值 {orig_db:+.2f} dBFS → 修复后 {peak_db:+.2f} dBFS；"
            f"新增峰值 {rep.new_peak * 100:.2f}% 满幅，余量 {max(0.0, rep.headroom_db):.2f} dB。"
            f"导出为 {bits} 位：{fits_text}。"
        )
        if rep.overflow_count:
            text += (
                " 超出部分写入时会被压平；可以取消勾选该片段、缩短修段，"
                "或换一种修复方式后再导出。"
            )
        self.headroom_label.setText(text)
        low = doc.low_confidence_records()
        if low:
            self.headroom_label.setText(
                text
                + f" 另有 {len(low)} 段置信度为「低」，导出的是连接推测，不是还原。"
            )

    def _refresh_audition_label(self) -> None:
        if self.doc.wav is None:
            self.audition_selection_label.setText("")
            return
        sr = self.doc.wav.sample_rate
        seg = None
        uids = self._selected_uids()
        if uids:
            seg = self.doc.segment(uids[0])
        if seg is None:
            selection = self.waveform.selection
            if selection is not None:
                self.audition_selection_label.setText(
                    f"将对选区 {selection[0]}–{selection[1]} "
                    f"（{an.format_sample_time(selection[0], sr)} – "
                    f"{an.format_sample_time(selection[1], sr)}）做等长 A/B"
                )
            else:
                self.audition_selection_label.setText(
                    "在片段表或波形上选中一段；F1/F2/F3 会试听同一区间"
                )
            return
        self.audition_selection_label.setText(
            f"选中片段 #{seg.uid}：{an.format_sample_time(seg.start, sr)} – "
            f"{an.format_sample_time(seg.end, sr)}，{seg.length} 样本，"
            f"{'左' if seg.channel == 0 else '右'}声道"
        )

    def _refresh_player_label(self) -> None:
        if self.player.is_playing():
            self._player_label.setText(f"▶ {self.player.active_label}")
        else:
            self._player_label.setText("")

    # -- detection interactions -------------------------------------------

    def _apply_detection(self) -> None:
        if self.doc.wav is None:
            return
        self.doc.set_thresholds(
            self.pos_spin.value(),
            self.neg_spin.value(),
            self.minrun_spin.value(),
            self.joined_spin.value(),
        )
        self._refresh_all()
        self._status(
            f"重新扫描：{len(self.doc.segments)} 段（已确认/已排除的片段已保留）"
        )

    def _on_method_changed(self) -> None:
        method = self.method_combo.currentData()
        if method == self.doc.method:
            return
        self.doc.set_method(method)
        self._refresh_all()

    def _selected_uids(self) -> list[int]:
        uids: list[int] = []
        for index in self.table.selectionModel().selectedRows():
            item = self.table.item(index.row(), 1)
            if item is not None:
                uids.append(int(item.data(Qt.ItemDataRole.UserRole)))
        return uids

    def _set_selected_status(self, status: str) -> None:
        uids = self._selected_uids()
        if not uids:
            self._status("先在片段表里选择要处理的片段")
            return
        for uid in uids:
            self.doc.set_status(uid, status)
        self._refresh_all()
        self._status(f"{len(uids)} 段标记为「{STATUS_LABELS[status]}」")

    def _exclude_square_hints(self) -> None:
        targets = [
            seg.uid
            for seg in self.doc.segments
            if "方波" in seg.hint and seg.status != STATUS_EXCLUDED
        ]
        for uid in targets:
            self.doc.set_status(uid, STATUS_EXCLUDED)
        self._refresh_all()
        self._status(f"已排除 {len(targets)} 段方波样片段" if targets else "没有方波样提示的片段")

    def _on_table_selection(self) -> None:
        if self._suppress_table_signals:
            return
        uids = self._selected_uids()
        if not uids:
            self.waveform.set_selection(None, None)
            return
        seg = self.doc.segment(uids[0])
        if seg is None:
            return
        self.waveform.set_selection(seg.start, seg.end)
        self.waveform.set_playhead((seg.start + seg.end) // 2)
        self.waveform.show_frame((seg.start + seg.end) // 2)
        # Keep the audition range on the selection so F1/F2/F3 compare it.
        self.audition_from.setText(str(seg.start))
        self.audition_to.setText(str(seg.end))
        self._refresh_audition_label()

    def _on_table_double_clicked(self, index) -> None:
        uids = self._selected_uids()
        if uids:
            self._audition_range_from_segment(uids[0])

    def _on_segment_clicked(self, uid: int) -> None:
        seg = self.doc.segment(uid)
        if seg is None:
            return
        self.waveform.set_selection(seg.start, seg.end)
        for row in range(self.table.rowCount()):
            item = self.table.item(row, 1)
            if item is not None and int(item.data(Qt.ItemDataRole.UserRole)) == uid:
                self.table.selectRow(row)
                self.audition_from.setText(str(seg.start))
                self.audition_to.setText(str(seg.end))
                break

    def _clear_selection(self) -> None:
        self.table.clearSelection()
        self.waveform.set_selection(None, None)

    def _add_selected_region(self) -> None:
        selection = self.waveform.selection
        if selection is None:
            self._status("先在波形上拖选一段")
            return
        start, end = selection
        # An explicit table selection identifies a channel; otherwise use the
        # lane the last drag happened in, not the left channel by default.
        uids = self._selected_uids()
        ch = self.doc.segment(uids[0]).channel if uids and self.doc.segment(uids[0]) else self._last_region_channel
        seg = self.doc.add_user_region(ch, start, end)
        if seg is not None:
            self._refresh_all()
            self._status(
                f"已添加手动修复区：声道 {ch + 1}，样本 {start}–{end}"
            )

    def _selection_channel(self) -> int:
        uids = self._selected_uids()
        if uids:
            seg = self.doc.segment(uids[0])
            if seg is not None:
                return seg.channel
        return self._last_region_channel

    def _on_region_selected(self, channel: int, start: int, end: int) -> None:
        self._last_region_channel = channel
        self.waveform.set_selection(start, end)
        self.audition_from.setText(str(start))
        self.audition_to.setText(str(end))
        self._status(
            f"选区：声道 {channel + 1}，样本 {start}–{end}"
            f"（{an.format_sample_time(start, self.doc.wav.sample_rate if self.doc.wav else 44100)}"
            f" – {an.format_sample_time(end, self.doc.wav.sample_rate if self.doc.wav else 44100)}）"
        )

    def _on_view_changed(self, start: int, end: int) -> None:
        if self.doc.wav is None:
            return
        sr = self.doc.wav.sample_rate
        self._view_label.setText(
            f"视图 {an.format_sample_time(start, sr)} – "
            f"{an.format_sample_time(end, sr)}（{end - start} 样本）"
        )

    def _on_polarity_filter(self) -> None:
        self.waveform.set_polarity_filter(POLARITY_FILTERS[self.polarity_combo.currentText()])
        self._refresh_segment_table()

    def _on_mode_changed(self) -> None:
        mode = AUDITION_MODES[self.mode_combo.currentText()]
        self._set_audition_mode(mode)

    def _set_audition_mode(self, mode: str) -> None:
        self.waveform.set_mode(mode)
        for text, key in AUDITION_MODES.items():
            if key == mode and self.mode_combo.currentText() != text:
                self.mode_combo.blockSignals(True)
                self.mode_combo.setCurrentText(text)
                self.mode_combo.blockSignals(False)

    # -- playhead / audition ----------------------------------------------

    def _on_playhead(self, frame: int) -> None:
        self.waveform.set_playhead(frame)

    def _audition_range(self) -> tuple[int, int] | None:
        if self.doc.wav is None:
            return None
        frames = self.doc.wav.frames
        try:
            start = int(self.audition_from.text() or 0)
            end = int(self.audition_to.text() or 0)
        except ValueError:
            start = end = 0
        if end <= start:
            selection = self.waveform.selection
            if selection is not None:
                start, end = selection
            else:
                segs = [s for s in self.doc.segments if s.status != STATUS_EXCLUDED]
                if segs:
                    seg = min(segs, key=lambda s: abs(s.start - self.waveform.playhead))
                    start, end = seg.start, seg.end
                else:
                    return None
        start = max(0, min(start, frames - 1))
        end = max(start + 1, min(end, frames))
        pad = max(8, int(0.05 * self.doc.wav.sample_rate))
        return max(0, start - pad), min(frames, end + pad)

    def _fill_audition_from_selection(self) -> None:
        selection = self.waveform.selection
        if selection is None:
            self._status("先拖选一段")
            return
        self.audition_from.setText(str(selection[0]))
        self.audition_to.setText(str(selection[1]))

    def _fill_audition_from_segment(self) -> None:
        uids = self._selected_uids()
        if not uids:
            self._status("先在片段表里选择片段")
            return
        seg = self.doc.segment(uids[0])
        if seg is None:
            return
        self.audition_from.setText(str(seg.start))
        self.audition_to.setText(str(seg.end))

    def _audition(self, mode: str) -> None:
        rng = self._audition_range()
        if rng is None or self.doc.wav is None:
            self._status("没有可试听的区间")
            return
        start, end = rng
        wav = self.doc.wav
        source = self.doc.repaired if mode == "repaired" else (
            self.doc.diff if mode == "diff" else wav.samples
        )
        if source is None:
            return
        channel_mode = CHANNEL_MODES[self.channel_combo.currentText()]
        solo = self.solo_check.isChecked()
        gain: tuple[float, float] | None = None
        if solo:
            # Solo the channel under the current decision: a selected segment's
            # channel, else the lane the last drag/click happened in.
            ch = self._selection_channel()
            gain = (1.0, 0.0) if ch == 0 else (0.0, 1.0)
        elif channel_mode == "left":
            gain = (1.0, 0.0)
        elif channel_mode == "right":
            gain = (0.0, 1.0)

        buffer = build_playback_buffer(
            source,
            wav.sample_rate,
            start,
            end,
            channel_gain=gain,
            loop=self._audition_loops,
            target_rate=self._target_rate(),
        )
        label = f"{AUDITION_MODES_BY_KEY[mode]} {an.format_sample_time(start, wav.sample_rate)}–{an.format_sample_time(end, wav.sample_rate)}"
        if self.player.play_buffer(buffer, label, loop=self._audition_loops):
            self._set_audition_mode("original" if mode == "original" else mode)
            self.audition_info.setText(
                f"正在试听：{label}（{buffer.frames} 帧，{buffer.sample_rate} Hz）"
                + ("，循环中" if self._audition_loops else "")
            )
            self._refresh_player_label()
        else:
            self.audition_info.setText("无法播放：没有可用的音频输出设备")

    def _audition_toggle_channel(self) -> None:
        if self.doc.wav is None:
            return
        if self.channel_combo.currentText() == "只听左":
            self.channel_combo.setCurrentText("只听右")
        else:
            self.channel_combo.setCurrentText("只听左")
        mode = AUDITION_MODES[self.mode_combo.currentText()]
        self._audition("original" if mode == "original" else mode)

    def _target_rate(self) -> int | None:
        """Return a rate the output device accepts, or None to keep the source."""
        from PySide6.QtMultimedia import QMediaDevices

        device = QMediaDevices.defaultAudioOutput()
        if device is None or device.isNull() or self.doc.wav is None:
            return None
        fmt = device_format(self.doc.wav.sample_rate, device)
        return fmt.sampleRate()

    def _stop_playback(self) -> None:
        self.player.stop()
        self._refresh_player_label()

    def _toggle_playback(self) -> None:
        if self.player.is_playing():
            self._stop_playback()
            return
        mode = AUDITION_MODES[self.mode_combo.currentText()]
        self._audition("original" if mode == "overlay" else mode)

    def _on_playback_finished(self, reason: str) -> None:
        if reason == "error":
            self.audition_info.setText("播放失败：输出设备不可用")
        self._refresh_player_label()

    # -- audit actions -----------------------------------------------------

    def _selected_record(self):
        rows = self.audit_table.selectionModel().selectedRows()
        if not rows:
            return None
        item = self.audit_table.item(rows[0].row(), 0)
        if item is None:
            return None
        uid = int(item.data(Qt.ItemDataRole.UserRole))
        return next((r for r in self.doc.records if r.segment_uid == uid), None)

    def _on_audit_selection(self) -> None:
        rec = self._selected_record()
        if rec is None:
            return
        self.waveform.set_selection(rec.start, rec.end)
        self.waveform.show_frame((rec.start + rec.end) // 2)

    def _show_changed_samples(self) -> None:
        """List every changed sample (index, before, after) for the selection."""
        doc = self.doc
        if doc.wav is None or doc.repaired is None:
            return
        rec = self._selected_record()
        records = [rec] if rec is not None else doc.records
        if not records:
            self._status("当前没有修改过的采样点")
            return
        sr = doc.wav.sample_rate
        lines: list[str] = []
        shown = 0
        for record in records:
            before = doc.wav.samples[record.start : record.end, record.channel]
            after = record.values
            changed_idx = np.flatnonzero(before != after)
            lines.append(
                f"片段 #{record.segment_uid} · {'左' if record.channel == 0 else '右'}声道 · "
                f"[{record.start}, {record.end}) · {METHOD_LABELS.get(record.method, record.method)} · "
                f"置信 {CONFIDENCE_LABELS.get(record.confidence, record.confidence)} · "
                f"改动 {changed_idx.size} 个样本"
            )
            if record.flags:
                lines.append("  说明：" + "；".join(record.flags))
            for offset in changed_idx:
                index = record.start + int(offset)
                lines.append(
                    f"  样本 {index}  ({an.format_sample_time(index, sr)})  "
                    f"{before[offset]: .6f} → {after[offset]: .6f}  "
                    f"(Δ {(after[offset] - before[offset]): .6f})"
                )
                shown += 1
                if shown >= 4000:
                    lines.append("  … 其余改动请导出 JSON/CSV 查看")
                    break
            if shown >= 4000:
                break
        dialog = QDialog(self)
        dialog.setWindowTitle("精确改动采样点")
        dialog.resize(760, 560)
        vbox = QVBoxLayout(dialog)
        text = QPlainTextEdit()
        text.setReadOnly(True)
        text.setLineWrapMode(QPlainTextEdit.LineWrapMode.NoWrap)
        text.setPlainText("\n".join(lines))
        vbox.addWidget(text, 1)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Close)
        buttons.rejected.connect(dialog.reject)
        buttons.accepted.connect(dialog.accept)
        copy_btn = QPushButton("复制全部")
        copy_btn.clicked.connect(lambda: QApplication.clipboard().setText("\n".join(lines)))
        buttons.addButton(copy_btn, QDialogButtonBox.ButtonRole.ActionRole)
        vbox.addWidget(buttons)
        dialog.exec()

    def _save_audit_json(self) -> None:
        if self.doc.wav is None:
            return
        path, _ = QFileDialog.getSaveFileName(
            self, "保存修改明细", str(Path.home() / "clipmend_audit.json"), "JSON (*.json)"
        )
        if not path:
            return
        self.doc.write_audit(path, getattr(self, "_last_verification", None))
        self._status(f"修改明细已保存：{path}")

    def _save_audit_csv(self) -> None:
        if self.doc.wav is None:
            return
        path, _ = QFileDialog.getSaveFileName(
            self, "保存修改明细", str(Path.home() / "clipmend_audit.csv"), "CSV (*.csv)"
        )
        if not path:
            return
        Path(path).write_text(self.doc.audit_csv(), encoding="utf-8")
        self._status(f"修改明细已保存：{path}")

    # -- export ------------------------------------------------------------

    def _export(self) -> None:
        doc = self.doc
        if doc.wav is None or doc.repaired is None:
            return
        bits = int(self.bits_combo.currentData() or 16)
        rep = doc.headroom(bits)
        if not rep.fits:
            answer = QMessageBox.warning(
                self,
                "峰值放不下",
                f"修复后峰值 {rep.peak_dbfs:+.2f} dBFS，有 {rep.overflow_count} 个样本超过满幅。\n"
                "直接导出会在这些位置被压平。\n\n仍要继续吗？",
                QMessageBox.StandardButton.Cancel | QMessageBox.StandardButton.Ok,
                QMessageBox.StandardButton.Cancel,
            )
            if answer != QMessageBox.StandardButton.Ok:
                return
        low = doc.low_confidence_records()
        if low and rep.fits:
            answer = QMessageBox.question(
                self,
                "有低置信度修复",
                f"{len(low)} 段的修复是长段缺失后的连接推测，不是有把握的还原。\n"
                "导出会包含这些推测。继续吗？",
                QMessageBox.StandardButton.Cancel | QMessageBox.StandardButton.Ok,
                QMessageBox.StandardButton.Ok,
            )
            if answer != QMessageBox.StandardButton.Ok:
                return
        if self.doc.sample_key is None:
            source_path = Path(self.doc.name)
            # For an opened file, save next to it unless that is not writable.
            default = source_path.with_name(source_path.stem + "_repaired.wav")
            if not os.access(source_path.parent, os.W_OK):
                default = Path.home() / default.name
        else:
            default = Path.home() / "clipmend_demo_repaired.wav"
        path, _ = QFileDialog.getSaveFileName(
            self, "导出修复后的 WAV", str(default), "WAV 文件 (*.wav)"
        )
        if not path:
            return
        try:
            verification = doc.export(path, bits)
        except Exception as exc:
            QMessageBox.critical(self, "导出失败", str(exc))
            return
        self._last_verification = verification
        self._show_verification(verification)
        self.tabs.setCurrentIndex(3)
        if verification.ok and not verification.has_clipping:
            self._status(f"已导出并通过回读核对：{path}")
        elif verification.ok:
            self._status(
                f"已导出，改动范围正确，但有 {verification.clipped_frames} 帧被满幅压平：{path}"
            )
        else:
            self._status(f"已导出，但回读核对发现问题：{path}")

    def _show_verification(self, report: an.VerificationReport) -> None:
        sr = report.sample_rate
        lines = [
            f"回读 {report.frames} 帧 · {report.bits} 位 · "
            f"实际改动 {report.changed_frames} 帧 · 量化误差 ≤ {report.max_quant_error_lsb:.2f} LSB"
        ]
        self.verify_table.setRowCount(len(report.changed_runs))
        for row, ch in enumerate(sorted(report.changed_runs.keys())):
            changed = an.format_runs(report.changed_runs[ch], sr)
            outside = an.format_runs(report.outside_runs.get(ch, []), sr)
            allowed = "是" if not report.outside_runs.get(ch) else "否（越界）"
            for col, text in enumerate(
                ["左" if ch == 0 else ("右" if ch == 1 else str(ch)), changed, outside, allowed]
            ):
                item = QTableWidgetItem(text)
                if col == 2 and outside != "无":
                    item.setForeground(QColor("#e05c5c"))
                if col == 3 and allowed != "是":
                    item.setForeground(QColor("#e05c5c"))
                self.verify_table.setItem(row, col, item)
        if report.clipped_frames:
            lines.append(
                f"有 {report.clipped_frames} 帧因修复后峰值超过满幅，写入时被压平"
                f"（已知损失，不属于越界改动）"
            )
        if report.mismatch_frames:
            lines.append(
                f"写入内容与预期有 {report.mismatch_frames} 帧不一致（量化或压平造成）"
            )
        if report.total_outside:
            lines.append(
                f"意图外改动 {report.total_outside} 帧，请检查是否有别的处理动了文件"
            )
        if report.ok and report.clipped_frames:
            lines.append(
                "范围核对通过：改动全部落在修复区内；"
                "但上面的满幅压平仍需处理才算干净导出。"
            )
        elif report.ok:
            lines.append("核对通过：文件里的改动全部落在修复区内，且没有满幅压平。")
        self.verify_label.setText("\n".join(lines))
        clean = report.ok and not report.clipped_frames
        self.verify_label.setStyleSheet(
            "" if clean else "color: #e05c5c; font-weight: bold;"
        )

    # -- misc --------------------------------------------------------------

    def _audition_range_from_segment(self, uid: int) -> None:
        seg = self.doc.segment(uid)
        if seg is None:
            return
        self.audition_from.setText(str(seg.start))
        self.audition_to.setText(str(seg.end))
        self.tabs.setCurrentIndex(1)
        self.waveform.set_selection(seg.start, seg.end)
        self.waveform.show_frame((seg.start + seg.end) // 2)

    def _status(self, text: str) -> None:
        self._status_label.setText(text)

    def _show_about(self) -> None:
        QMessageBox.information(
            self,
            "使用说明",
            "1. 文件 → 打开 WAV，或从「样例」选短峰/长平顶。\n"
            "2. 「削顶片段」里按声道、正负极性列出可疑连续削顶；调门槛不会丢掉已确认/已排除的片段。\n"
            "3. 波形上拖选可加为手动修复区；双击片段可进入试听。\n"
            "4. F1/F2/F3/F4 试听原始、修复后、差值，同一区间等长切换；「独听」只放一个声道。\n"
            "5. 导出前检查峰值；导出后自动回读 WAV 并核对改动是否都在修复区内。\n"
            "低置信度（长段缺失）会明确标注，结果不当作有把握的还原。",
        )


AUDITION_MODES_BY_KEY = {v: k for k, v in AUDITION_MODES.items()}


def run(argv: list[str] | None = None) -> int:
    import sys

    app = QApplication(argv if argv is not None else sys.argv)
    app.setApplicationName("clipmend")
    app.setStyle("Fusion")
    palette = QPalette()
    palette.setColor(QPalette.ColorRole.Window, QColor("#1b1f26"))
    palette.setColor(QPalette.ColorRole.WindowText, QColor("#cfd6e0"))
    palette.setColor(QPalette.ColorRole.Base, QColor("#14171c"))
    palette.setColor(QPalette.ColorRole.AlternateBase, QColor("#1b1f26"))
    palette.setColor(QPalette.ColorRole.Text, QColor("#cfd6e0"))
    palette.setColor(QPalette.ColorRole.Button, QColor("#232a34"))
    palette.setColor(QPalette.ColorRole.ButtonText, QColor("#cfd6e0"))
    palette.setColor(QPalette.ColorRole.Highlight, QColor("#2f6ea8"))
    palette.setColor(QPalette.ColorRole.HighlightedText, QColor("#ffffff"))
    app.setPalette(palette)
    window = MainWindow()
    window.show()
    if len(sys.argv) > 1:
        candidate = Path(sys.argv[1])
        if candidate.exists():
            try:
                window.doc.load(candidate)
                window._refresh_all()
            except WavError as exc:
                QMessageBox.warning(window, "无法打开", str(exc))
    return app.exec()
