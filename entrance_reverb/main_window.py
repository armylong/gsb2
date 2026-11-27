"""主窗口：导入、起音标记、前置混响参数、试听与导出。"""
from __future__ import annotations

import csv
import os

import numpy as np
from PySide6.QtCore import QTimer
from PySide6.QtWidgets import (
    QButtonGroup,
    QComboBox,
    QDoubleSpinBox,
    QFileDialog,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QRadioButton,
    QVBoxLayout,
    QWidget,
)

from .audio_player import AudioPlayer
from .dsp import (
    RenderParams,
    builtin_ir,
    generate_test_claps,
    match_ir_to_dry,
    read_wav,
    render_reverse_reverb,
    write_wav,
)
from .waveform import WaveformView

VIEW_LABELS = {"dry": "干声", "wet": "前置湿声", "mix": "合成"}


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("进场音前置混响试听 (reverse reverb)")
        self.resize(1180, 780)

        # 状态
        self.dry: np.ndarray | None = None
        self.sr = 48000
        self.dry_path = ""
        self.ir: np.ndarray | None = None       # 已匹配到干声格式
        self.ir_source = "内置：短反射"
        self.markers: list[tuple[int, str]] = []
        self.render = None
        self.player = AudioPlayer(self)
        self.player.positionChanged.connect(self._on_position)
        self.player.stateChanged.connect(lambda _s: self._update_play_button())

        self._build_ui()
        self._set_controls_enabled(False)

    # ==================================================================
    # UI 构建
    # ==================================================================
    def _build_ui(self) -> None:
        central = QWidget()
        root = QVBoxLayout(central)

        # ---- 顶部：文件导入 ----
        top = QHBoxLayout()
        self.btn_load = QPushButton("导入干声 WAV…")
        self.btn_load.clicked.connect(self._load_dry)
        self.btn_ir = QPushButton("导入混响响应 WAV…")
        self.btn_ir.clicked.connect(self._load_ir)
        self.btn_claps = QPushButton("生成两次击掌验证信号…")
        self.btn_claps.clicked.connect(self._gen_claps)
        self.ir_combo = QComboBox()
        self.ir_combo.addItems(["内置：短反射", "内置：一段衰减", "外部文件…"])
        self.ir_combo.currentTextChanged.connect(self._on_ir_source_changed)
        top.addWidget(self.btn_load)
        top.addWidget(QLabel("混响响应:"))
        top.addWidget(self.ir_combo)
        top.addWidget(self.btn_ir)
        top.addStretch(1)
        self.btn_claps.setToolTip("生成带标记的两次击掌 wav，第一击靠近文件头用于验证前置留出")
        top.addWidget(self.btn_claps)
        root.addLayout(top)

        # ---- 参数区 ----
        param_box = QGroupBox("前置混响参数")
        pl = QHBoxLayout(param_box)

        self.spin_lead = QDoubleSpinBox()
        self.spin_lead.setRange(0.0, 5000.0)
        self.spin_lead.setValue(200.0)
        self.spin_lead.setSuffix(" ms")
        self.spin_lead.setDecimals(1)
        self.spin_lead.valueChanged.connect(self._schedule_render)

        self.spin_fade = QDoubleSpinBox()
        self.spin_fade.setRange(0.0, 500.0)
        self.spin_fade.setValue(30.0)
        self.spin_fade.setSuffix(" ms")
        self.spin_fade.setDecimals(1)
        self.spin_fade.valueChanged.connect(self._schedule_render)

        self.spin_wet = QDoubleSpinBox()
        self.spin_wet.setRange(0.0, 2.0)
        self.spin_wet.setValue(1.0)
        self.spin_wet.setSingleStep(0.1)
        self.spin_wet.setSuffix(" ×")
        self.spin_wet.setDecimals(2)
        self.spin_wet.valueChanged.connect(self._schedule_render)

        pl.addWidget(QLabel("混响提前量"))
        pl.addWidget(self.spin_lead)
        pl.addSpacing(20)
        pl.addWidget(QLabel("交界淡变"))
        pl.addWidget(self.spin_fade)
        pl.addSpacing(20)
        pl.addWidget(QLabel("湿声音量"))
        pl.addWidget(self.spin_wet)
        pl.addStretch(1)

        self.lbl_info = QLabel("尚未导入干声")
        self.lbl_info.setStyleSheet("color:#9be29b;")
        pl.addWidget(self.lbl_info)
        root.addWidget(param_box)

        # ---- 视图切换 + 播放 ----
        mid = QHBoxLayout()
        self.view_group = QButtonGroup(self)
        for key in ("dry", "wet", "mix"):
            rb = QRadioButton(VIEW_LABELS[key])
            rb.setProperty("view", key)
            if key == "mix":
                rb.setChecked(True)
            rb.toggled.connect(self._on_view_changed)
            self.view_group.addButton(rb)
            mid.addWidget(rb)
        mid.addStretch(1)
        self.btn_play = QPushButton("▶ 试听")
        self.btn_play.clicked.connect(self._toggle_play)
        self.btn_stop = QPushButton("■ 停止")
        self.btn_stop.clicked.connect(lambda: self.player.stop())
        self.btn_export = QPushButton("导出分轨 WAV…")
        self.btn_export.clicked.connect(self._export)
        mid.addWidget(self.btn_play)
        mid.addWidget(self.btn_stop)
        mid.addWidget(self.btn_export)
        root.addLayout(mid)

        # ---- 波形 ----
        self.view = WaveformView()
        self.view.onsetChanged.connect(self._on_onset_clicked)
        root.addWidget(self.view, stretch=1)

        # ---- 日志 / 规则说明 ----
        self.log = QPlainTextEdit()
        self.log.setReadOnly(True)
        self.log.setMaximumBlockCount(500)
        self.log.setPlaceholderText("匹配规则、对齐信息与警告会显示在这里")
        self.log.setFixedHeight(150)
        root.addWidget(self.log)

        self.setCentralWidget(central)

        # 渲染防抖：拖 spinbox 时不必每帧重算
        self._render_timer = QTimer(self)
        self._render_timer.setSingleShot(True)
        self._render_timer.setInterval(60)
        self._render_timer.timeout.connect(self._render)

    def _set_controls_enabled(self, ok: bool) -> None:
        for w in (self.btn_ir, self.spin_lead, self.spin_fade, self.spin_wet,
                  self.btn_play, self.btn_stop, self.btn_export):
            w.setEnabled(ok)

    # ==================================================================
    # 文件与响应
    # ==================================================================
    def _load_dry(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "选择干声 WAV", "", "WAV 文件 (*.wav *.WAV)"
        )
        if not path:
            return
        try:
            sr, audio = read_wav(path)
        except Exception as exc:  # 读文件失败要明确提示，不静默
            QMessageBox.critical(self, "读取失败", f"{os.path.basename(path)}:\n{exc}")
            return
        self.player.stop()
        self.sr, self.dry, self.dry_path = sr, audio, path
        ch_txt = "单声道" if audio.shape[1] == 1 else "立体声"
        self.markers = []
        # 默认起音：第一个超过 -40 dB 的采样；找不到就取 0
        peak = np.max(np.abs(audio)) or 1.0
        above = np.flatnonzero(np.max(np.abs(audio), axis=1) > peak * 0.01)
        onset = int(above[0]) if above.size else 0
        self.view.set_dry(audio, onset, sr=sr)
        self.view.fit_scale()
        self._log(f"已导入干声 {os.path.basename(path)}：{sr} Hz，{ch_txt}，"
                  f"{audio.shape[0]} 采样（{audio.shape[0] / sr:.3f} s）；默认起音 {onset}。")
        self._set_controls_enabled(True)
        self._rebuild_ir()

    def _load_ir(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "选择混响响应 WAV", "", "WAV 文件 (*.wav *.WAV)"
        )
        if not path:
            return
        try:
            ir_sr, ir_raw = read_wav(path)
        except Exception as exc:
            QMessageBox.critical(self, "读取失败", f"{os.path.basename(path)}:\n{exc}")
            return
        self._ir_external = (ir_raw, ir_sr, os.path.basename(path))
        self.ir_combo.setCurrentText("外部文件…")

    def _on_ir_source_changed(self, text: str) -> None:
        if text == "外部文件…":
            if not hasattr(self, "_ir_external"):
                # 还没选文件：打开对话框，取消则回到内置
                self.btn_ir.click()
                if not hasattr(self, "_ir_external"):
                    self.ir_combo.blockSignals(True)
                    self.ir_combo.setCurrentText(self.ir_source)
                    self.ir_combo.blockSignals(False)
                    return
        self.ir_source = text
        self._rebuild_ir()

    def _rebuild_ir(self) -> None:
        if self.dry is None:
            return
        if self.ir_combo.currentText().startswith("内置"):
            kind = "reflections" if "短反射" in self.ir_combo.currentText() else "decay"
            ir_raw = builtin_ir(kind, self.sr)
            ir_sr = self.sr
            label = self.ir_combo.currentText()
        else:
            ir_raw, ir_sr, label = self._ir_external
        self.ir, msgs = match_ir_to_dry(ir_raw, ir_sr, self.sr, self.dry.shape[1])
        self._log(f"混响响应来源：{label}，匹配后 {self.ir.shape[0]} 采样 / {self.ir.shape[1]} 声道。")
        for m in msgs:
            self._log("  " + m)
        if not msgs:
            self._log("  声道数与采样率一致，左右有效长度相同，无需额外匹配。")
        self._render()

    def _gen_claps(self) -> None:
        out_dir = QFileDialog.getExistingDirectory(self, "选择击掌验证信号的输出目录")
        if not out_dir:
            return
        try:
            paths = generate_test_claps(out_dir)
        except Exception as exc:
            QMessageBox.critical(self, "生成失败", str(exc))
            return
        # 直接载入生成的 wav，并按 marker 文件把起音标在第一击
        sr, audio = read_wav(paths["wav"])
        self.player.stop()
        self.sr, self.dry, self.dry_path = sr, audio, paths["wav"]
        self.markers = []
        first = 0
        with open(paths["markers"], newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                sample = int(row["sample"])
                self.markers.append((sample, row["name"]))
                if row["name"] == "clap1":
                    first = sample
        self.ir_combo.setCurrentText("内置：短反射")
        self.view.set_dry(audio, first, self.markers, sr=sr)
        self.view.fit_scale()
        self._set_controls_enabled(True)
        self._log(f"已生成并载入验证信号：{paths['wav']}")
        self._log(f"标记文件：{paths['markers']}（起音已对准 clap1 = {first} 采样）")
        self._rebuild_ir()

    # ==================================================================
    # 渲染
    # ==================================================================
    def _on_onset_clicked(self, onset: int) -> None:
        self._log(f"干声起音设在第 {onset} 采样（{onset / self.sr:.3f} s）。")
        self._schedule_render()

    def _on_view_changed(self) -> None:
        btn = self.view_group.checkedButton()
        if btn:
            self.view.set_view(btn.property("view"))
            self._refresh_player_audio()

    def _schedule_render(self, *_args) -> None:
        if self.dry is not None and self.ir is not None:
            self._render_timer.start()

    def _render(self) -> None:
        if self.dry is None or self.ir is None:
            return
        params = RenderParams(
            lead_ms=self.spin_lead.value(),
            fade_ms=self.spin_fade.value(),
            wet_gain=self.spin_wet.value(),
        )
        if params.fade_ms > params.lead_ms:
            # 淡变不能比前置段长；钳制并提示，而不是悄悄出错
            self._log("警告：交界淡变长于提前量，已按提前量钳制。")
        self.render = render_reverse_reverb(
            self.dry, self.sr, self.view.onset_dry, self.ir, params
        )
        self.view.set_render(self.render)
        for m in self.render.messages:
            self._log(m)
        if self.render.clip:
            self._log(f"⚠ 合成有 {self.render.clip_count} 个采样超过 0 dBFS，"
                      "导出/试听时会被削顶，请降低湿声音量。")
        self._update_info()
        self._refresh_player_audio()

    def _update_info(self) -> None:
        r = self.render
        onset_sec = r.onset_index / r.sr
        self.lbl_info.setText(
            f"新增前置时长 {r.added_seconds:.3f} s ｜ 起音位于 {onset_sec:.3f} s "
            f"（干声内 {r.onset_index - r.prepend} 采样，未后移）｜ "
            f"总长 {r.total_samples / r.sr:.3f} s"
            + (" ｜ ⚠削顶" if r.clip else "")
        )

    # ==================================================================
    # 试听
    # ==================================================================
    def _current_view_audio(self) -> np.ndarray:
        if self.render is None:
            return self.dry
        return {"dry": self.render.dry, "wet": self.render.wet,
                "mix": self.render.mix}[self.view_group.checkedButton().property("view")]

    def _refresh_player_audio(self) -> None:
        if self.render is not None:
            self.player.set_audio(self._current_view_audio(), self.sr)

    def _toggle_play(self) -> None:
        from PySide6.QtMultimedia import QAudioSink

        if self._sink_state_playing():
            self.player.pause()
        else:
            self._refresh_player_audio()
            self.player.play()

    def _sink_state_playing(self) -> bool:
        sink = getattr(self.player, "_sink", None)
        return sink is not None and sink.state() == QAudioSink.State.ActiveState

    def _update_play_button(self) -> None:
        self.btn_play.setText("⏸ 暂停" if self._sink_state_playing() else "▶ 试听")

    def _on_position(self, sample: int) -> None:
        self.view.set_cursor(sample)

    # ==================================================================
    # 导出：三个等长分轨，采样对齐
    # ==================================================================
    def _export(self) -> None:
        if self.render is None:
            return
        out_dir = QFileDialog.getExistingDirectory(self, "选择分轨导出目录")
        if not out_dir:
            return
        r = self.render
        names = {
            "dry": os.path.join(out_dir, "entrance_dry.wav"),
            "wet": os.path.join(out_dir, "entrance_wet_pre.wav"),
            "mix": os.path.join(out_dir, "entrance_mix.wav"),
        }
        try:
            write_wav(names["dry"], r.sr, r.dry)
            write_wav(names["wet"], r.sr, r.wet)
            write_wav(names["mix"], r.sr, r.mix)
        except Exception as exc:
            QMessageBox.critical(self, "导出失败", str(exc))
            return

        # 同时写一份对齐说明，便于离线核对
        info_path = os.path.join(out_dir, "entrance_export_info.txt")
        with open(info_path, "w", encoding="utf-8") as f:
            f.write("前置混响导出对齐说明\n")
            f.write(f"采样率 {r.sr} Hz，三个分轨等长 {r.total_samples} 采样\n")
            f.write(f"干声起音（输出坐标）: {r.onset_index} 采样 "
                    f"= {r.onset_index / r.sr:.6f} s\n")
            f.write(f"头部前置（新增时长）: {r.prepend} 采样 "
                    f"= {r.prepend / r.sr:.6f} s\n")
            f.write(f"交界淡变: {r.fade_samples} 采样；IR 长度: {r.ir_length}\n")
            f.write("mix = dry + wet（float 求和后统一 int16 量化，与试听同源）\n")
            f.write(f"削顶: {'是 ' + str(r.clip_count) + ' 采样' if r.clip else '否'}\n")
        self._log("已导出分轨：")
        for k, v in names.items():
            self._log(f"  {VIEW_LABELS[k]}: {v}")
        self._log(f"  对齐说明: {info_path}")

    # ==================================================================
    def _log(self, text: str) -> None:
        self.log.appendPlainText(text)
