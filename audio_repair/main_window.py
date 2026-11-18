"""主窗口: 载入/选区/参数/预览试听/确认/撤销重做/导出。"""

from __future__ import annotations

import os

import numpy as np
from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QAction, QKeySequence
from PySide6.QtWidgets import (
    QFileDialog, QLabel, QMainWindow, QMessageBox, QPushButton,
    QDoubleSpinBox, QSlider, QStatusBar, QToolBar, QVBoxLayout, QHBoxLayout,
    QWidget, QGroupBox, QRadioButton, QButtonGroup, QFrame,
)

from .document import AudioDocument, MAX_DURATION_S
from .player import AudioPlayer
from .processing import (InpaintError, ProcessOptions, Selection,
                         SelectionError)
from .widgets.spectrogram import SpectrogramView, ViewRect, WaveformView

PREVIEW_DEBOUNCE_MS = 350
CONTEXT_MS = 300.0


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("时频选区音频修复工具 (本地)")
        self.resize(1180, 820)

        self.doc = AudioDocument()
        self.player = AudioPlayer(self)

        self.spec = SpectrogramView()
        self.wave = WaveformView()
        self._rect: ViewRect | None = None
        self._channels: tuple[int, ...] = (0, 1)

        self._build_ui()
        self._connect()
        self._preview_timer = QTimer(self)
        self._preview_timer.setSingleShot(True)
        self._preview_timer.timeout.connect(self._rebuild_preview)
        self._update_actions()

    # ------------------------------------------------------------------ UI
    def _build_ui(self) -> None:
        toolbar = QToolBar()
        toolbar.setMovable(False)
        self.addToolBar(toolbar)
        self.act_open = QAction("打开 WAV", self)
        self.act_export = QAction("导出 WAV", self)
        self.act_undo = QAction("撤销", self)
        self.act_redo = QAction("重做", self)
        self.act_restore = QAction("恢复原文件", self)
        for a in (self.act_open, self.act_export, self.act_undo,
                  self.act_redo, self.act_restore):
            toolbar.addAction(a)
        toolbar.addSeparator()
        self.act_zoom_in_t = QAction("时间放大", self)
        self.act_zoom_out_t = QAction("时间缩小", self)
        self.act_zoom_in_f = QAction("频率放大", self)
        self.act_zoom_out_f = QAction("频率缩小", self)
        self.act_reset_view = QAction("重置视图", self)
        for a in (self.act_zoom_in_t, self.act_zoom_out_t,
                  self.act_zoom_in_f, self.act_zoom_out_f,
                  self.act_reset_view):
            toolbar.addAction(a)

        central = QWidget()
        root = QVBoxLayout(central)

        root.addWidget(self.wave, 0)
        root.addWidget(self.spec, 1)

        # 控制条
        ctrl = QHBoxLayout()

        gb_mode = QGroupBox("处理方式")
        mode_lay = QVBoxLayout(gb_mode)
        self.rb_att = QRadioButton("局部衰减 (窄带干扰)")
        self.rb_inp = QRadioButton("邻域修补 (短暂局部异常)")
        self.rb_att.setChecked(True)
        self.mode_group = QButtonGroup(self)
        self.mode_group.addButton(self.rb_att)
        self.mode_group.addButton(self.rb_inp)
        mode_lay.addWidget(self.rb_att)
        mode_lay.addWidget(self.rb_inp)
        ctrl.addWidget(gb_mode)

        gb_strength = QGroupBox("强度")
        s_lay = QVBoxLayout(gb_strength)
        row = QHBoxLayout()
        self.slider = QSlider(Qt.Horizontal)
        self.slider.setRange(0, 100)
        self.slider.setValue(80)
        self.spin = QDoubleSpinBox()
        self.spin.setRange(0.0, 1.0)
        self.spin.setSingleStep(0.05)
        self.spin.setValue(0.8)
        row.addWidget(self.slider)
        row.addWidget(self.spin)
        s_lay.addLayout(row)
        hint = QLabel("衰减: 0=不处理, 1=最大抑制; 修补: 混入邻域估计的比例")
        hint.setWordWrap(True)
        hint.setStyleSheet("color:#999;")
        s_lay.addWidget(hint)
        ctrl.addWidget(gb_strength, 1)

        gb_ch = QGroupBox("处理通道")
        ch_lay = QHBoxLayout(gb_ch)
        self.rb_both = QRadioButton("两侧联动 (L+R)")
        self.rb_left = QRadioButton("仅左声道 L")
        self.rb_right = QRadioButton("仅右声道 R")
        self.rb_mono = QRadioButton("单声道")
        self.rb_both.setChecked(True)
        ch_lay.addWidget(self.rb_both)
        ch_lay.addWidget(self.rb_left)
        ch_lay.addWidget(self.rb_right)
        ch_lay.addWidget(self.rb_mono)
        self.rb_mono.setVisible(False)
        ctrl.addWidget(gb_ch)

        gb_prev = QGroupBox("预听 (选区+前后 %.0f ms 上下文)" % CONTEXT_MS)
        pv = QVBoxLayout(gb_prev)
        btn_row = QHBoxLayout()
        self.btn_play_orig = QPushButton("预听原声")
        self.btn_play_fix = QPushButton("预听修复")
        self.btn_stop = QPushButton("停止")
        btn_row.addWidget(self.btn_play_orig)
        btn_row.addWidget(self.btn_play_fix)
        btn_row.addWidget(self.btn_stop)
        pv.addLayout(btn_row)
        self.lbl_preview = QLabel("未建立预览")
        self.lbl_preview.setStyleSheet("color:#e0a030; font-weight:bold;")
        pv.addWidget(self.lbl_preview)
        btn_row2 = QHBoxLayout()
        self.btn_commit = QPushButton("确认处理")
        self.btn_cancel = QPushButton("取消预览")
        btn_row2.addWidget(self.btn_commit)
        btn_row2.addWidget(self.btn_cancel)
        pv.addLayout(btn_row2)
        ctrl.addWidget(gb_prev)

        root.addLayout(ctrl)

        self.sel_label = QLabel(
            "选区: 无。在频谱上按住左键拖出矩形, 右键平移, 滚轮缩放时间"
            " (Shift+滚轮缩放频率), 双击跳转播放头。"
        )
        self.sel_label.setWordWrap(True)
        self.sel_label.setFrameStyle(QFrame.StyledPanel)
        root.addWidget(self.sel_label)

        self.setCentralWidget(central)
        self.setStatusBar(QStatusBar())

        # 快捷键
        self.act_undo.setShortcut(QKeySequence.Undo)
        self.act_redo.setShortcut(QKeySequence.Redo)
        self.act_open.setShortcut(QKeySequence.Open)
        self.act_export.setShortcut(QKeySequence.Save)

    def _connect(self) -> None:
        self.act_open.triggered.connect(self.open_file)
        self.act_export.triggered.connect(self.export_file)
        self.act_undo.triggered.connect(self.doc.undo)
        self.act_redo.triggered.connect(self.doc.redo)
        self.act_restore.triggered.connect(self.restore_original)
        self.act_zoom_in_t.triggered.connect(
            lambda: self.spec.zoom_time(1 / 1.4))
        self.act_zoom_out_t.triggered.connect(
            lambda: self.spec.zoom_time(1.4))
        self.act_zoom_in_f.triggered.connect(
            lambda: self.spec.zoom_freq(1 / 1.4))
        self.act_zoom_out_f.triggered.connect(
            lambda: self.spec.zoom_freq(1.4))
        self.act_reset_view.triggered.connect(self.spec.reset_view)

        self.spec.selectionDragged.connect(self.on_selection_dragged)
        self.spec.seekRequested.connect(self.seek)
        self.spec.message.connect(self._on_message)
        self.wave.seekRequested.connect(self.seek)

        self.slider.valueChanged.connect(self._on_strength_slider)
        self.spin.valueChanged.connect(self._on_strength_spin)
        self.rb_att.toggled.connect(self._schedule_preview)
        self.rb_both.toggled.connect(self._on_channel_mode)
        self.rb_left.toggled.connect(self._on_channel_mode)
        self.rb_right.toggled.connect(self._on_channel_mode)
        self.rb_mono.toggled.connect(self._on_channel_mode)

        self.btn_play_orig.clicked.connect(self.play_original_segment)
        self.btn_play_fix.clicked.connect(self.play_fixed_segment)
        self.btn_stop.clicked.connect(self.player.stop)
        self.btn_commit.clicked.connect(self.commit)
        self.btn_cancel.clicked.connect(self.cancel_preview)

        self.doc.changed.connect(self.on_doc_changed)
        self.doc.preview_changed.connect(self.on_preview_changed)
        self.doc.message.connect(self._on_message)
        self.player.positionChanged.connect(self._on_position)
        self.player.segmentFinished.connect(self._on_segment_finished)
        self.player.error.connect(
            lambda msg: self._on_message("error", msg))

    # ------------------------------------------------------------------ 文件
    def open_file(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "打开 WAV (≤%.0f 秒, 单声道/立体声)" % MAX_DURATION_S,
            "", "WAV 音频 (*.wav *.WAV)")
        if not path:
            return
        try:
            self.player.stop()
            self.doc.load(path)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.warning(self, "无法载入", str(exc))
            return
        audio = self.doc.confirmed
        self.spec.set_audio(audio, self.doc.sample_rate, 0)
        self.wave.set_audio(audio, self.doc.sample_rate)
        self._rect = None
        self._init_channel_controls()
        self._on_message("info",
                         f"已载入 {os.path.basename(path)}: "
                         f"{self.doc.sample_rate} Hz, "
                         f"{self.doc.n_channels} 声道, "
                         f"{self.doc.duration:.2f}s")

    def export_file(self) -> None:
        if self.doc.confirmed is None:
            QMessageBox.information(self, "导出", "请先载入音频。")
            return
        if self.doc.has_preview:
            ret = QMessageBox.question(
                self, "存在未确认预览",
                "当前预览尚未确认。导出将写入上一次已确认状态, "
                "不包含临时预览。是否继续?",
                QMessageBox.Yes | QMessageBox.No, QMessageBox.No)
            if ret != QMessageBox.Yes:
                return
        base = os.path.splitext(os.path.basename(self.doc.path))[0]
        path, _ = QFileDialog.getSaveFileName(
            self, "导出已确认音频", f"{base}_repaired.wav",
            "WAV 音频 (*.wav)")
        if not path:
            return
        try:
            self.doc.export(path)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "导出失败", str(exc))

    def restore_original(self) -> None:
        if self.doc.original is None:
            return
        ret = QMessageBox.question(
            self, "恢复原文件",
            "放弃当前所有已确认修改, 恢复到刚载入时的内容? "
            "(该操作本身可撤销)",
            QMessageBox.Yes | QMessageBox.No, QMessageBox.No)
        if ret == QMessageBox.Yes:
            self.doc.restore_original()

    # ------------------------------------------------------------------ 通道
    def _init_channel_controls(self) -> None:
        stereo = self.doc.n_channels == 2
        self.rb_both.setVisible(stereo)
        self.rb_left.setVisible(stereo)
        self.rb_right.setVisible(stereo)
        self.rb_mono.setVisible(not stereo)
        if stereo:
            self.rb_both.setChecked(True)
            self._channels = (0, 1)
            self.spec.set_channel(0)
        else:
            self.rb_mono.setChecked(True)
            self._channels = (0,)
            self.spec.set_channel(0)

    def _on_channel_mode(self) -> None:
        if self.doc.n_channels == 2:
            if self.rb_both.isChecked():
                self._channels = (0, 1)
                self.spec.set_channel(0)
            elif self.rb_left.isChecked():
                self._channels = (0,)
                self.spec.set_channel(0)
            else:
                self._channels = (1,)
                self.spec.set_channel(1)
        else:
            self._channels = (0,)
        self._update_sel_label()
        self._schedule_preview()

    # ------------------------------------------------------------------ 选区
    def on_selection_dragged(self, rect: ViewRect | None) -> None:
        self._rect = rect
        if rect is not None:
            self.wave.set_selection_range(rect.start_sample, rect.end_sample)
        else:
            self.wave.set_selection_range(None, None)
        self._update_sel_label()
        self._schedule_preview()

    def _current_selection(self) -> Selection | None:
        if self._rect is None:
            return None
        return self._rect.to_selection(self._channels)

    def _update_sel_label(self) -> None:
        if self._rect is None:
            self.sel_label.setText(
                "选区: 空 —— 在频谱上按住左键拖出一个时间×频率矩形; "
                "空选区不会触发任何处理。")
            return
        rc = self._rect
        sr = self.doc.sample_rate
        ch_txt = ("L+R 联动" if self._channels == (0, 1)
                  else ("仅 L" if self._channels == (0,) else "仅 R"))
        self.sel_label.setText(
            f"选区: {rc.start_sample/sr:.3f}s – {rc.end_sample/sr:.3f}s "
            f"({rc.end_sample - rc.start_sample} 样本), "
            f"{rc.f0:.1f} – {rc.f1:.1f} Hz | 通道: {ch_txt} | "
            f"边界带柔和过渡, 选区外内容保持不变"
        )

    # ------------------------------------------------------------------ 参数
    def _on_strength_slider(self, v: int) -> None:
        val = v / 100.0
        if abs(self.spin.value() - val) > 1e-9:
            self.spin.blockSignals(True)
            self.spin.setValue(val)
            self.spin.blockSignals(False)
        self._schedule_preview()

    def _on_strength_spin(self, v: float) -> None:
        iv = int(round(v * 100))
        if self.slider.value() != iv:
            self.slider.blockSignals(True)
            self.slider.setValue(iv)
            self.slider.blockSignals(False)
        self._schedule_preview()

    def _current_options(self) -> ProcessOptions:
        return ProcessOptions(
            mode="attenuate" if self.rb_att.isChecked() else "inpaint",
            strength=float(self.spin.value()),
        )

    # ------------------------------------------------------------------ 预览
    def _schedule_preview(self) -> None:
        # 参数仍在调整: 防抖重建, 界面明确标识 "未确认预览"
        if self.doc.confirmed is None or self._rect is None:
            return
        self._preview_timer.start(PREVIEW_DEBOUNCE_MS)

    def _rebuild_preview(self) -> None:
        sel = self._current_selection()
        if sel is None:
            return
        try:
            self.doc.make_preview(sel, self._current_options(), CONTEXT_MS)
        except InpaintError as exc:
            self.doc.cancel_preview()
            ret = QMessageBox.question(
                self, "邻域修补受限",
                f"{exc}\n\n是否改用 \"局部衰减\" 处理当前选区?",
                QMessageBox.Yes | QMessageBox.No, QMessageBox.Yes)
            if ret == QMessageBox.Yes:
                self.rb_att.setChecked(True)
                try:
                    self.doc.make_preview(
                        sel,
                        ProcessOptions(mode="attenuate",
                                       strength=float(self.spin.value())),
                        CONTEXT_MS)
                except SelectionError as exc2:
                    self._on_message("error", str(exc2))
        except SelectionError as exc:
            self.doc.cancel_preview()
            self._on_message("error", str(exc))

    def cancel_preview(self) -> None:
        self.player.stop()
        self.doc.cancel_preview()

    def commit(self) -> None:
        if not self.doc.has_preview:
            QMessageBox.information(
                self, "确认处理",
                "当前没有可确认的预览: 请先框选选区并选择处理方式。")
            return
        rect = self._rect
        self.player.stop()
        self.doc.commit_preview()
        # commit 触发 preview_changed (视图已刷新为确认数据, 视口/选区保留)
        if rect is not None:
            self.spec.set_rect(rect)
            self.wave.set_selection_range(rect.start_sample,
                                          rect.end_sample)

    def on_preview_changed(self) -> None:
        if not self.spec._sr:
            # 视图尚未载入 (doc.load 内部信号), 等 open_file 显式初始化
            self._update_actions()
            return
        if self.doc.has_preview:
            self.lbl_preview.setText(f"● {self.doc.preview.label}")
            self.lbl_preview.setStyleSheet(
                "color:#e0a030; font-weight:bold;")
            # 频谱/波形实时展示修复结果, 但保留视口与选区
            self.spec.update_audio_keep_view(
                self.doc.preview.audio, sr=self.doc.sample_rate)
            self.wave.update_audio_keep_marks(
                self.doc.preview.audio, sr=self.doc.sample_rate)
        else:
            self.lbl_preview.setText("未建立预览 (参数调整结果不会修改音频)")
            self.lbl_preview.setStyleSheet("color:#999;")
            if self.doc.confirmed is not None:
                # 取消预览: 视图还原到已确认数据
                self.spec.update_audio_keep_view(
                    self.doc.confirmed, sr=self.doc.sample_rate)
                self.wave.update_audio_keep_marks(
                    self.doc.confirmed, sr=self.doc.sample_rate)
        self._update_actions()

    def on_doc_changed(self) -> None:
        self._update_actions()
        # 视图尚未载入 (例如 doc.load 内部发射信号) 时直接跳过,
        # open_file 随后会显式 set_audio 完成首帧绘制
        if (not self.doc.has_preview and self.doc.confirmed is not None
                and self.spec._sr):
            self.spec.update_audio_keep_view(
                self.doc.confirmed, sr=self.doc.sample_rate)
            self.wave.update_audio_keep_marks(
                self.doc.confirmed, sr=self.doc.sample_rate)

    # ------------------------------------------------------------------ 试听
    def _segment_bounds(self) -> tuple[int, int] | None:
        if self._rect is None or self.doc.confirmed is None:
            return None
        sr = self.doc.sample_rate
        ctx = int(CONTEXT_MS / 1000.0 * sr)
        return (max(0, self._rect.start_sample - ctx),
                min(self.doc.n_samples, self._rect.end_sample + ctx))

    def play_original_segment(self) -> None:
        bounds = self._segment_bounds()
        if bounds is None:
            self._on_message("warn", "请先框选选区再预听。")
            return
        # 原声永远取自已确认数据, 与预览状态无关
        self.player.play_segment(self.doc.confirmed, self.doc.sample_rate,
                                 bounds[0], bounds[1])

    def play_fixed_segment(self) -> None:
        bounds = self._segment_bounds()
        if bounds is None:
            self._on_message("warn", "请先框选选区再预听。")
            return
        if not self.doc.has_preview:
            self._rebuild_preview()
        if not self.doc.has_preview:
            return
        self.player.play_segment(self.doc.preview.audio,
                                 self.doc.sample_rate,
                                 bounds[0], bounds[1])

    def seek(self, t: float) -> None:
        if self.doc.confirmed is None:
            return
        t = float(np.clip(t, 0, self.doc.duration))
        n = int(t * self.doc.sample_rate)
        self.player.play_segment(self.doc.working, self.doc.sample_rate,
                                 n, self.doc.n_samples)

    def _on_position(self, t: float) -> None:
        # 统一时间参数: 同一播放头同时驱动两个视图
        self.spec.set_playhead(t)
        self.wave.set_playhead(t)
        self.statusBar().showMessage(f"播放头: {t:8.3f} s")

    def _on_segment_finished(self) -> None:
        self._on_position(self.player.end_time)

    # ------------------------------------------------------------------ 杂项
    def _on_message(self, level: str, text: str) -> None:
        prefix = {"info": "ℹ", "warn": "⚠", "error": "✖"}.get(level, "ℹ")
        self.statusBar().showMessage(f"{prefix} {text}", 6000)

    def _update_actions(self) -> None:
        loaded = self.doc.confirmed is not None
        for a in (self.act_export, self.act_undo, self.act_redo,
                  self.act_restore):
            a.setEnabled(loaded)
        self.act_undo.setEnabled(self.doc.can_undo)
        self.act_redo.setEnabled(self.doc.can_redo)
        self.btn_commit.setEnabled(self.doc.has_preview)
        self.btn_cancel.setEnabled(self.doc.has_preview)

    def closeEvent(self, event):
        self.player.stop()
        super().closeEvent(event)
