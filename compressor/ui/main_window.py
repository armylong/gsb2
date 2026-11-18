"""主窗口：参数控制、四视图时间轴、试听与导出。"""

from __future__ import annotations

import os

import numpy as np
from PySide6.QtCore import Qt, QTimer
from PySide6.QtWidgets import (
    QCheckBox, QDoubleSpinBox, QFileDialog, QGroupBox, QHBoxLayout, QLabel,
    QMainWindow, QMessageBox, QPushButton, QRadioButton, QSpinBox,
    QVBoxLayout, QWidget)

from ..audio_io import (
    AudioLoadError, ClippingError, export_wav, load_wav, readback_verify)
from ..dsp import CompressorParams
from ..player import AudioPlayer
from ..synth import make_sample
from .axis_model import TimeAxisModel
from .dsp_thread import DspRunner
from .trace_view import MODE_ENVELOPE, MODE_GR, MODE_WAVE, TraceView

CALIB_TEXT = (
    "口径：逐采样 link 峰值（立体声取左右较大值，共同增益）→ dB 域一阶 RC 平滑"
    "（起音=包络上升/恢复=下降，tau 为与目标差缩到 1/e 的时间）→ 硬拐点，"
    "ratio=1 不压缩；无前视、无自动补偿。静音处包络 -inf、衰减 0。")


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("动态压缩实验工具 — 峰值检测 / 硬拐点 / 无前视")
        self.resize(1320, 900)

        self._x: np.ndarray | None = None
        self._fs = 48000
        self._source_path: str | None = None
        self._result = None
        self._gen = 0
        self._shown_gen = -1
        self._dsp = DspRunner(
            on_done=self._on_done,
            on_error=lambda msg: self._status(f"处理失败：{msg}", error=True))
        self._player = AudioPlayer(self)
        self._player.positionChanged.connect(self._on_play_pos)
        self._player.playbackStateChanged.connect(self._on_play_state)
        self._debounce = QTimer(self)
        self._debounce.setSingleShot(True)
        self._debounce.setInterval(50)
        self._debounce.timeout.connect(self._schedule_process)

        self._build_ui()
        self._load_sample()

    # ---------------- UI 搭建 ----------------
    def _build_ui(self) -> None:
        central = QWidget()
        root = QVBoxLayout(central)

        # 顶部文件操作
        top = QHBoxLayout()
        self.btn_open = QPushButton("打开 WAV…")
        self.btn_sample = QPushButton("载入自带样例")
        self.btn_export = QPushButton("导出结果 WAV…")
        self.btn_export.setEnabled(False)
        self.btn_open.clicked.connect(self._open_file)
        self.btn_sample.clicked.connect(self._load_sample)
        self.btn_export.clicked.connect(self._export)
        top.addWidget(self.btn_open)
        top.addWidget(self.btn_sample)
        top.addStretch(1)
        top.addWidget(self.btn_export)
        root.addLayout(top)

        # 参数区
        root.addWidget(self._build_param_box())
        self.lbl_calib = QLabel(CALIB_TEXT)
        self.lbl_calib.setWordWrap(True)
        self.lbl_calib.setStyleSheet("color:#9aa3ad; font-size:11px;")
        root.addWidget(self.lbl_calib)

        # 四个视图
        self.axis = TimeAxisModel(12.0)
        self.views: list[TraceView] = []
        titles = [
            (MODE_WAVE, "① 原波形（输入，线性振幅）"),
            (MODE_ENVELOPE, "② 检测包络（细灰=逐采样峰值，绿=平滑包络，dBFS）"),
            (MODE_GR, "③ 增益衰减（dB，越大压得越深）"),
            (MODE_WAVE, "④ 输出波形（当前参数处理结果）"),
        ]
        for mode, title in titles:
            v = TraceView(self.axis, mode, title)
            v.cursorClicked.connect(self.axis.set_cursor)
            v.selectionMade.connect(self._on_selection)
            self.views.append(v)
            root.addWidget(v, stretch=1)
        self.axis.cursorChanged.connect(lambda *_: self._update_readout())

        # 光标读数
        readout = QHBoxLayout()
        self.lbl_cursor = QLabel("光标：—")
        self.lbl_in = QLabel("输入峰值：—")
        self.lbl_env = QLabel("包络：—")
        self.lbl_gr = QLabel("衰减：—")
        for w in (self.lbl_cursor, self.lbl_in, self.lbl_env, self.lbl_gr):
            w.setStyleSheet(
                "font-family:Menlo,monospace; padding:0 14px; color:#1d2127;")
            readout.addWidget(w)
        readout.addStretch(1)
        root.addLayout(readout)

        # 试听 + 缩放
        playbar = QHBoxLayout()
        self.rb_input = QRadioButton("试听原声")
        self.rb_output = QRadioButton("试听结果")
        self.rb_output.setChecked(True)
        self.chk_loop = QCheckBox("循环")
        self.chk_sel = QCheckBox("仅试听所选区间")
        self.btn_play = QPushButton("播放/停止（空格）")
        self.btn_zoom = QPushButton("放大所选区间")
        self.btn_reset = QPushButton("复位缩放")
        self.btn_play.clicked.connect(self._toggle_play)
        self.btn_zoom.clicked.connect(self._zoom_selection)
        self.btn_reset.clicked.connect(self.axis.reset_zoom)
        for w in (self.rb_input, self.rb_output, self.chk_loop, self.chk_sel,
                  self.btn_play):
            playbar.addWidget(w)
        playbar.addStretch(1)
        playbar.addWidget(self.btn_zoom)
        playbar.addWidget(self.btn_reset)
        root.addLayout(playbar)

        self.setCentralWidget(central)
        self.statusBar().showMessage("就绪")

        # 超幅警告（默认隐藏）
        self.lbl_clip = QLabel("")
        self.lbl_clip.setStyleSheet(
            "color:#ff6b6b; font-weight:bold; padding:0 12px;")
        self.statusBar().addPermanentWidget(self.lbl_clip)

    def _build_param_box(self) -> QGroupBox:
        box = QGroupBox("压缩参数（硬拐点 / 峰值检测 / 无前视）")
        h = QHBoxLayout(box)

        self.sp_threshold = QDoubleSpinBox()
        self.sp_threshold.setRange(-60.0, 0.0)
        self.sp_threshold.setValue(-18.0)
        self.sp_threshold.setSuffix(" dBFS")
        self.sp_threshold.setSingleStep(0.5)

        self.sp_ratio = QDoubleSpinBox()
        self.sp_ratio.setRange(1.0, 20.0)
        self.sp_ratio.setValue(4.0)
        self.sp_ratio.setSuffix(" : 1")
        self.sp_ratio.setSingleStep(0.5)
        self.sp_ratio.setDecimals(2)

        self.sp_attack = QSpinBox()
        self.sp_attack.setRange(1, 1000)
        self.sp_attack.setValue(10)
        self.sp_attack.setSuffix(" ms")

        self.sp_release = QSpinBox()
        self.sp_release.setRange(5, 3000)
        self.sp_release.setValue(150)
        self.sp_release.setSuffix(" ms")

        self.sp_makeup = QDoubleSpinBox()
        self.sp_makeup.setRange(-12.0, 24.0)
        self.sp_makeup.setValue(0.0)
        self.sp_makeup.setSuffix(" dB")
        self.sp_makeup.setSingleStep(0.5)

        for label, sp in (
                ("阈值", self.sp_threshold), ("压缩比", self.sp_ratio),
                ("启动时间", self.sp_attack), ("恢复时间", self.sp_release),
                ("补偿增益", self.sp_makeup)):
            h.addWidget(QLabel(label))
            h.addWidget(sp)
            sp.valueChanged.connect(self._on_param_changed)
        h.addStretch(1)
        return box

    # ---------------- 数据装载 ----------------
    def _load_sample(self) -> None:
        self._player.stop()
        self._x = make_sample(48000)
        self._fs = 48000
        self._source_path = None
        self.axis.reset(self._x.shape[0] / self._fs)
        self._status("已载入自带 12 秒立体声样例（稳态/突增/突减/静音/不平衡）")
        self._schedule_process()

    def _open_file(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "选择 WAV（≤12 秒，44.1/48 kHz，单/立体声）",
            "", "WAV (*.wav)")
        if not path:
            return
        try:
            x, fs = load_wav(path)
        except AudioLoadError as e:
            QMessageBox.warning(self, "无法打开", str(e))
            return
        self._player.stop()
        self._x, self._fs, self._source_path = x, fs, path
        # 复用同一时间轴模型（视图信号在构建时已连接，无需重建）
        self.axis.reset(x.shape[0] / fs)
        self._status(f"已打开 {os.path.basename(path)}（"
                     f"{fs} Hz, {x.shape[0]/fs:.2f} s, "
                     f"{1 if x.ndim == 1 else x.shape[1]} 声道）")
        self._schedule_process()

    # ---------------- 处理调度 ----------------
    def _current_params(self) -> CompressorParams:
        return CompressorParams(
            threshold_db=self.sp_threshold.value(),
            ratio=self.sp_ratio.value(),
            attack_ms=float(self.sp_attack.value()),
            release_ms=float(self.sp_release.value()),
            makeup_db=self.sp_makeup.value())

    def _on_param_changed(self, *_args) -> None:
        # 防抖：拖动 spinbox 时合并为一次后台重算
        self._debounce.start()

    def _schedule_process(self) -> None:
        if self._x is None:
            return
        self._gen += 1
        gen = self._gen
        self.lbl_clip.setText("处理中…")
        self.lbl_clip.setStyleSheet("color:#f1c40f; padding:0 12px;")
        self.btn_export.setEnabled(False)
        self._dsp.submit(gen, self._x, self._fs, self._current_params())

    def _on_done(self, gen: int, result) -> None:
        if gen != self._gen:
            return  # 已有更新的一版，丢弃过期结果
        self._result = result
        self._shown_gen = gen
        for v in self.views:
            v.set_data(result, gen)
        self._update_clip_indicator(result)
        self._update_readout()
        self.btn_export.setEnabled(not result.clipped)
        self.lbl_clip.setText(
            "" if not result.clipped else self.lbl_clip.text())
        self._status(
            f"处理完成（第 {gen} 版，当前显示即最新结果）· "
            f"输出峰值 {result.output_peak_db:+.2f} dBFS")

    def _update_clip_indicator(self, result) -> None:
        if result.clipped:
            over = result.output_peak_db
            self.lbl_clip.setText(
                f"⚠ 补偿后超幅 {over:+.2f} dBFS：已阻止导出，请降低补偿增益")
            self.lbl_clip.setStyleSheet(
                "color:#ff6b6b; font-weight:bold; padding:0 12px;")
        else:
            self.lbl_clip.setText(
                f"输出峰值 {result.output_peak_db:+.2f} dBFS（未超幅）")
            self.lbl_clip.setStyleSheet("color:#2ecc71; padding:0 12px;")

    def _refresh_views(self) -> None:
        for v in self.views:
            v.update()

    # ---------------- 光标读数 ----------------
    def _update_readout(self) -> None:
        t = self.axis.cursor()
        if t is None or self._result is None or self._x is None:
            self.lbl_cursor.setText("光标：—")
            self.lbl_in.setText("输入峰值：—")
            self.lbl_env.setText("包络：—")
            self.lbl_gr.setText("衰减：—")
            return
        i = int(np.clip(round(t * self._fs), 0, self._x.shape[0] - 1))
        det = self._result.detected_db[i]
        env = self._result.envelope_db[i]
        gr = self._result.gain_reduction_db[i]
        self.lbl_cursor.setText(f"光标：{t:.4f} s（样本 {i}）")
        # 严格数字静音（样本振幅为 0）与正弦过零点区分显示
        raw = self._x[i]
        is_digital_zero = np.all(raw == 0.0) if np.ndim(raw) else raw == 0.0
        if is_digital_zero:
            self.lbl_in.setText("输入峰值：数字静音（-inf dBFS）")
        else:
            self.lbl_in.setText(f"输入峰值：{det:6.2f} dBFS（瞬时，过零点会很低）")
        self.lbl_env.setText(
            "包络：静音" if np.isneginf(env) else f"包络：{env:6.2f} dBFS")
        self.lbl_gr.setText(f"衰减：{gr:5.2f} dB")

    # ---------------- 选择与缩放 ----------------
    def _on_selection(self, sel) -> None:
        self._status("已选择区间，可放大查看起音/恢复，或勾选仅试听区间"
                     if sel else "已清除区间选择")

    def _zoom_selection(self) -> None:
        sel = self.axis.selection()
        if not sel:
            self._status("请先在图上拖选时间区间", error=True)
            return
        self.axis.set_range(sel[0], sel[1])

    def keyPressEvent(self, event) -> None:  # noqa: N802
        if event.key() == Qt.Key_Space:
            self._toggle_play()
        else:
            super().keyPressEvent(event)

    # ---------------- 试听 ----------------
    def _play_bounds(self) -> tuple[float, float | None]:
        if self.chk_sel.isChecked() and self.axis.selection():
            a, b = self.axis.selection()
            return a, b
        return 0.0, None

    def _toggle_play(self) -> None:
        if self._player.is_playing():
            self._player.stop()
            return
        if self._result is None:
            self._status("尚无处理结果", error=True)
            return
        # 试听原声/结果只影响听到的内容，导出始终用处理结果
        data = self._x if self.rb_input.isChecked() else self._result.output
        start, end = self._play_bounds()
        self._player.play(data, self._fs, start, end,
                          loop=self.chk_loop.isChecked())

    def _on_play_pos(self, t: float) -> None:
        self.axis.set_cursor(t)
        self._status(f"试听{'原声' if self.rb_input.isChecked() else '结果'}"
                     f"：{t:.3f} s")

    def _on_play_state(self, playing: bool) -> None:
        self.btn_play.setText("停止（空格）" if playing
                              else "播放/停止（空格）")

    # ---------------- 导出与回读核对 ----------------
    def _export(self) -> None:
        if self._result is None:
            return
        if self._shown_gen != self._gen:
            QMessageBox.warning(self, "结果不是最新",
                                "参数已修改，请等待重新处理完成后再导出。")
            return
        if self._result.clipped:
            QMessageBox.critical(
                self, "阻止导出",
                f"补偿后峰值 {self._result.output_peak_db:+.2f} dBFS 超幅，"
                "为避免静默削波已阻止导出，请降低补偿增益。")
            return
        default = "compressor_output.wav"
        if self._source_path:
            base = os.path.splitext(os.path.basename(self._source_path))[0]
            default = f"{base}_compressed.wav"
        path, _ = QFileDialog.getSaveFileName(
            self, "导出处理结果", default, "WAV (*.wav)")
        if not path:
            return
        try:
            export_wav(path, self._result)
            checks = readback_verify(path, self._result)
        except ClippingError as e:
            QMessageBox.critical(self, "阻止导出", str(e))
            return
        if checks["ok"]:
            QMessageBox.information(
                self, "导出并回读核对通过",
                f"文件：{path}\n"
                f"长度一致：{checks['length_match']}（{self._result.n} 样本）\n"
                f"采样率一致：{checks['fs_match']}（{self._fs} Hz）\n"
                f"声道一致：{checks['channels_match']}\n"
                f"回读峰值 {checks['readback_peak_db']:+.2f} dBFS，"
                f"与处理结果差 ≤ {0.5} dB\n"
                f"左右同比例衰减（声像保持）："
                f"{checks['stereo_balance_preserved']}")
            self._status(f"已导出 {os.path.basename(path)}，回读核对通过")
        else:
            QMessageBox.warning(self, "回读核对未通过", str(checks))

    # ---------------- 其它 ----------------
    def _status(self, text: str, error: bool = False) -> None:
        self.statusBar().showMessage(text)
        if error:
            self.statusBar().setStyleSheet("color:#ff6b6b;")
        else:
            self.statusBar().setStyleSheet("")

    def closeEvent(self, event) -> None:  # noqa: N802
        self._player.stop()
        self._dsp.shutdown()
        super().closeEvent(event)
