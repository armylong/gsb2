"""主窗口：参数与图形同屏的中侧声场调整工具。"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import soundfile as sf
from PySide6.QtCore import Qt, QTimer
from PySide6.QtWidgets import (
    QButtonGroup,
    QCheckBox,
    QDoubleSpinBox,
    QFileDialog,
    QGridLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QMessageBox,
    QPushButton,
    QRadioButton,
    QSlider,
    QVBoxLayout,
    QWidget,
)

from .audio_engine import (
    GAIN_MAX,
    GAIN_MIN,
    MODE_MID,
    MODE_SIDE,
    MODE_STEREO,
    AudioData,
    AudioLoadError,
    Params,
    compute_stats,
    format_dbfs,
    load_wav,
    quantization_step,
    render_product,
    write_wav,
)
from .player import AudioPlayer, PlayerError
from .waveform_widget import WaveformView

CLIP_EPS = 1e-9


class MainWindow(QWidget):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("中侧声场调整工具（M/S Width）")
        self.resize(1280, 820)

        self._audio: AudioData | None = None
        self._player: AudioPlayer | None = None
        self._params = Params()
        self._product: np.ndarray | None = None     # 当前正式成品（立体声）
        self._attenuation = 1.0

        self._ui_timer = QTimer(self)
        self._ui_timer.setInterval(33)
        self._ui_timer.timeout.connect(self._refresh_position)
        self._ui_timer.start()

        self._build_ui()
        self._set_controls_enabled(False)

    # ============================================================ UI 构建

    def _build_ui(self) -> None:
        root = QVBoxLayout(self)

        # 顶部：文件操作与信息
        top = QHBoxLayout()
        self._btn_open = QPushButton("打开 WAV…")
        self._btn_open.clicked.connect(self._on_open)
        self._btn_export = QPushButton("导出 WAV…")
        self._btn_export.clicked.connect(self._on_export)
        self._lbl_file = QLabel("尚未打开文件")
        self._lbl_file.setStyleSheet("color:#374151;")
        top.addWidget(self._btn_open)
        top.addWidget(self._lbl_file, stretch=1)
        top.addWidget(self._btn_export)
        root.addLayout(top)

        self._lbl_mono_warn = QLabel(
            "⚠ 单声道文件不适用中侧处理：不存在左右差（侧边恒为 0），"
            "增益调整与导出已禁用。"
        )
        self._lbl_mono_warn.setStyleSheet(
            "background:#fef2f2;color:#b91c1c;padding:6px;border-radius:4px;"
            "font-weight:bold;"
        )
        self._lbl_mono_warn.hide()
        root.addWidget(self._lbl_mono_warn)

        formula = QLabel(
            "口径：中间 M =（左 L + 右 R）/ 2 ；侧边 S =（左 L − 右 R）/ 2 。"
            "可逆关系：L = M + S，R = M − S。"
        )
        formula.setStyleSheet("color:#6b7280;padding:2px;")
        root.addWidget(formula)

        body = QHBoxLayout()
        self._wave = WaveformView()
        self._wave.seekRequested.connect(self._on_seek)
        self._wave.regionChanged.connect(self._on_region_changed)
        body.addWidget(self._wave, stretch=3)
        body.addWidget(self._build_param_panel(), stretch=1)
        root.addLayout(body, stretch=1)

        root.addWidget(self._build_transport())
        root.addWidget(self._build_stats_panel())

    def _build_param_panel(self) -> QWidget:
        box = QGroupBox("参数（单听模式不会改变这里的成品增益）")
        layout = QVBoxLayout(box)

        self._sld_mid, self._spin_mid, self._lbl_mid_db = self._gain_row(
            layout, "中间增益 M")
        self._sld_side, self._spin_side, self._lbl_side_db = self._gain_row(
            layout, "侧边增益 S")
        self._sld_mid.valueChanged.connect(self._on_gain_changed)
        self._sld_side.valueChanged.connect(self._on_gain_changed)
        self._spin_mid.valueChanged.connect(self._on_gain_changed)
        self._spin_side.valueChanged.connect(self._on_gain_changed)

        mode_box = QGroupBox("监听")
        mode_lay = QVBoxLayout(mode_box)
        self._mode_group = QButtonGroup(self)
        self._rb_stereo = QRadioButton("处理后立体声（成品）")
        self._rb_mid = QRadioButton("单听中间 M")
        self._rb_side = QRadioButton("单听侧边 S")
        self._rb_stereo.setChecked(True)
        for rb in (self._rb_stereo, self._rb_mid, self._rb_side):
            self._mode_group.addButton(rb)
            mode_lay.addWidget(rb)
        self._rb_stereo.toggled.connect(self._on_mode_changed)
        self._rb_mid.toggled.connect(self._on_mode_changed)
        self._rb_side.toggled.connect(self._on_mode_changed)
        layout.addWidget(mode_box)

        self._chk_protect = QCheckBox("统一衰减保护（两声道同一系数）")
        self._chk_protect.toggled.connect(self._on_protect_changed)
        layout.addWidget(self._chk_protect)

        self._lbl_atten = QLabel("实际衰减：0.00 dB（系数 1.0000）")
        self._lbl_atten.setStyleSheet("color:#059669;")
        layout.addWidget(self._lbl_atten)

        self._lbl_clip = QLabel("")
        self._lbl_clip.setWordWrap(True)
        self._lbl_clip.setStyleSheet(
            "background:#fef2f2;color:#b91c1c;padding:6px;border-radius:4px;"
            "font-weight:bold;"
        )
        self._lbl_clip.hide()
        layout.addWidget(self._lbl_clip)
        layout.addStretch(1)
        return box

    def _gain_row(self, parent_layout: QVBoxLayout, title: str):
        wrap = QWidget()
        lay = QGridLayout(wrap)
        lay.setContentsMargins(0, 0, 0, 0)
        lbl = QLabel(title)
        sld = QSlider(Qt.Horizontal)
        sld.setRange(int(GAIN_MIN * 1000), int(GAIN_MAX * 1000))
        sld.setValue(1000)
        spin = QDoubleSpinBox()
        spin.setRange(GAIN_MIN, GAIN_MAX)
        spin.setSingleStep(0.01)
        spin.setDecimals(2)
        spin.setValue(1.0)
        db = QLabel("+0.00 dB")
        db.setMinimumWidth(72)
        lay.addWidget(lbl, 0, 0, 1, 2)
        lay.addWidget(sld, 1, 0)
        lay.addWidget(spin, 1, 1)
        lay.addWidget(db, 1, 2)
        parent_layout.addWidget(wrap)
        return sld, spin, db

    def _build_transport(self) -> QWidget:
        box = QGroupBox("播放与区间")
        outer = QVBoxLayout(box)

        row = QHBoxLayout()
        self._btn_play = QPushButton("▶ 播放")
        self._btn_pause = QPushButton("⏸ 暂停")
        self._btn_stop = QPushButton("⏹ 停止")
        self._btn_play.clicked.connect(self._on_play)
        self._btn_pause.clicked.connect(self._on_pause)
        self._btn_stop.clicked.connect(self._on_stop)
        self._lbl_pos = QLabel("0.000 s（帧 0）")
        for b in (self._btn_play, self._btn_pause, self._btn_stop):
            row.addWidget(b)
        row.addWidget(self._lbl_pos, stretch=1)
        outer.addLayout(row)

        row2 = QHBoxLayout()
        row2.addWidget(QLabel("区间起(s)"))
        self._spin_r0 = QDoubleSpinBox()
        self._spin_r0.setDecimals(3)
        self._spin_r0.setSingleStep(0.05)
        row2.addWidget(self._spin_r0)
        row2.addWidget(QLabel("止(s)"))
        self._spin_r1 = QDoubleSpinBox()
        self._spin_r1.setDecimals(3)
        self._spin_r1.setSingleStep(0.05)
        row2.addWidget(self._spin_r1)
        self._spin_r0.valueChanged.connect(self._on_region_spin)
        self._spin_r1.valueChanged.connect(self._on_region_spin)

        self._btn_region_play = QPushButton("试听区间")
        self._btn_region_play.clicked.connect(self._on_play_region)
        self._btn_clear_region = QPushButton("清除区间")
        self._btn_clear_region.clicked.connect(lambda: self._wave.clear_region())
        self._chk_loop = QCheckBox("循环")
        self._chk_loop.toggled.connect(self._apply_player_region)
        row2.addWidget(self._btn_region_play)
        row2.addWidget(self._btn_clear_region)
        row2.addWidget(self._chk_loop)
        outer.addLayout(row2)

        hint = QLabel("波形区：点击跳转，按住拖选区间，双击/Esc 清除，"
                      "Ctrl/⌘+滚轮缩放，滚轮平移，Shift+拖动平移。")
        hint.setStyleSheet("color:#6b7280;")
        outer.addWidget(hint)
        return box

    def _build_stats_panel(self) -> QWidget:
        box = QGroupBox("统计（基于处理后立体声；有区间时只统计区间）")
        grid = QGridLayout(box)
        self._lbl_corr = QLabel("-")
        self._lbl_peak_l = QLabel("-")
        self._lbl_peak_r = QLabel("-")
        self._lbl_mono = QLabel("-")
        self._lbl_scope = QLabel("范围：整段")
        cells = [
            ("左右相关程度", self._lbl_corr),
            ("左声道峰值", self._lbl_peak_l),
            ("右声道峰值", self._lbl_peak_r),
            ("单声道合听 (L+R)/2", self._lbl_mono),
        ]
        for row, (name, value) in enumerate(cells):
            name_lbl = QLabel(name)
            name_lbl.setStyleSheet("color:#6b7280;")
            grid.addWidget(name_lbl, row, 0)
            grid.addWidget(value, row, 1)
        grid.addWidget(self._lbl_scope, 0, 2, 4, 1)
        grid.setColumnStretch(1, 1)
        return box

    # ============================================================ 文件加载

    def _on_open(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "打开 WAV 文件", "", "WAV 音频 (*.wav)")
        if not path:
            return
        self._on_open_path(path)

    def _on_open_path(self, path: str) -> None:
        try:
            audio = load_wav(path)
        except AudioLoadError as exc:
            QMessageBox.warning(self, "无法打开", str(exc))
            return

        if self._player is not None:
            self._player.close()
            self._player = None
        self._audio = audio
        self._params = Params()
        self._reset_gain_controls()
        self._rb_stereo.setChecked(True)
        self._chk_protect.setChecked(False)
        self._wave.set_data(audio.samples, audio.samplerate)

        dur = audio.duration
        self._spin_r0.blockSignals(True)
        self._spin_r1.blockSignals(True)
        for sp in (self._spin_r0, self._spin_r1):
            sp.setRange(0.0, dur)
        self._spin_r0.setValue(0.0)
        self._spin_r1.setValue(dur)
        self._spin_r0.blockSignals(False)
        self._spin_r1.blockSignals(False)

        mono_note = "（源为单声道，两列相同仅用于展示）" if audio.is_mono else ""
        self._lbl_file.setText(
            f"{Path(path).name}　采样率 {audio.samplerate} Hz　"
            f"采样点 {audio.frames} 帧 × 2　时长 {dur:.3f} s　"
            f"格式 {audio.subtype} {mono_note}"
        )
        self._lbl_mono_warn.setVisible(audio.is_mono)
        self._set_controls_enabled(not audio.is_mono)
        self._recompute()

    def _reset_gain_controls(self) -> None:
        for sld, spin in ((self._sld_mid, self._spin_mid),
                          (self._sld_side, self._spin_side)):
            sld.blockSignals(True)
            spin.blockSignals(True)
            sld.setValue(1000)
            spin.setValue(1.0)
            sld.blockSignals(False)
            spin.blockSignals(False)
        self._update_gain_db_labels()

    def _set_controls_enabled(self, enabled: bool) -> None:
        for w in (self._sld_mid, self._sld_side, self._spin_mid,
                  self._spin_side, self._rb_mid, self._rb_side,
                  self._rb_stereo, self._chk_protect, self._btn_export,
                  self._btn_play, self._btn_pause, self._btn_stop,
                  self._btn_region_play, self._chk_loop):
            w.setEnabled(enabled)

    # ============================================================ 参数变化

    def _on_gain_changed(self, *_args) -> None:
        sender = self.sender()
        mid = self._sld_mid.value() / 1000.0
        side = self._sld_side.value() / 1000.0
        # 滑块与 spinbox 双向同步
        if sender is self._sld_mid:
            self._spin_mid.blockSignals(True)
            self._spin_mid.setValue(mid)
            self._spin_mid.blockSignals(False)
        elif sender is self._spin_mid:
            self._sld_mid.blockSignals(True)
            self._sld_mid.setValue(round(mid * 1000))
            self._sld_mid.blockSignals(False)
        elif sender is self._sld_side:
            self._spin_side.blockSignals(True)
            self._spin_side.setValue(side)
            self._spin_side.blockSignals(False)
        elif sender is self._spin_side:
            self._sld_side.blockSignals(True)
            self._sld_side.setValue(round(side * 1000))
            self._sld_side.blockSignals(False)
        self._params.mid_gain = self._spin_mid.value()
        self._params.side_gain = self._spin_side.value()
        self._update_gain_db_labels()
        self._recompute()

    def _update_gain_db_labels(self) -> None:
        for spin, lbl in ((self._spin_mid, self._lbl_mid_db),
                          (self._spin_side, self._lbl_side_db)):
            v = spin.value()
            lbl.setText("−∞" if v == 0 else f"{20 * np.log10(v):+.2f} dB")

    def _on_mode_changed(self) -> None:
        if self._rb_stereo.isChecked():
            self._params.mode = MODE_STEREO
        elif self._rb_mid.isChecked():
            self._params.mode = MODE_MID
        else:
            self._params.mode = MODE_SIDE
        if self._player is not None:
            self._player.set_mode(self._params.mode)

    def _on_protect_changed(self, checked: bool) -> None:
        self._params.protect = checked
        self._recompute()

    def _recompute(self) -> None:
        """正式成品、保护衰减、统计与播放器参数统一刷新。"""
        if self._audio is None:
            return
        self._product, self._attenuation = render_product(
            self._audio.samples, self._params)
        self._refresh_clip_and_atten()
        self._refresh_stats()
        if self._player is not None:
            self._player.set_gains(self._params.mid_gain,
                                   self._params.side_gain,
                                   self._attenuation)

    def _raw_peak(self) -> float:
        """未加保护衰减的处理结果峰值（判断超幅用）。"""
        if self._audio is None:
            return 0.0
        from .audio_engine import process_stereo
        return float(np.max(np.abs(process_stereo(
            self._audio.samples, self._params.mid_gain,
            self._params.side_gain))))

    def _refresh_clip_and_atten(self) -> None:
        raw_peak = self._raw_peak()
        clipped = raw_peak > 1.0 + CLIP_EPS
        if self._params.protect:
            if self._attenuation < 1.0:
                db = 20 * np.log10(self._attenuation)
                self._lbl_atten.setText(
                    f"实际衰减：{db:.2f} dB（系数 {self._attenuation:.4f}）")
                self._lbl_atten.setStyleSheet("color:#b45309;font-weight:bold;")
            else:
                self._lbl_atten.setText("实际衰减：0.00 dB（系数 1.0000，未触发）")
                self._lbl_atten.setStyleSheet("color:#059669;")
        else:
            self._lbl_atten.setText("实际衰减：0.00 dB（保护关闭，系数 1.0000）")
            self._lbl_atten.setStyleSheet("color:#6b7280;")

        if clipped:
            if self._params.protect:
                self._lbl_clip.setText(
                    f"⚠ 扩宽已超幅（原始峰值 {raw_peak:.4f}），"
                    f"保护已统一压回 1.0000 以内。")
            else:
                self._lbl_clip.setText(
                    f"⚠ 扩宽超幅：峰值 {raw_peak:.4f} > 1.0。"
                    f"请降低增益/侧边，或开启统一衰减保护，否则不能导出。")
            self._lbl_clip.show()
        else:
            self._lbl_clip.hide()

    def _refresh_stats(self) -> None:
        if self._product is None or self._audio is None:
            return
        region = self._wave.region()
        if region is not None:
            self._lbl_scope.setText(
                f"范围：{region[0]}–{region[1]} 帧"
                f"（{region[0] / self._audio.samplerate:.3f}–"
                f"{region[1] / self._audio.samplerate:.3f} s）")
        else:
            self._lbl_scope.setText("范围：整段")
        stats = compute_stats(self._product, region)

        if stats.correlation is None:
            self._lbl_corr.setText("无有效值（信号能量不足）")
            self._lbl_corr.setStyleSheet("color:#6b7280;")
        else:
            c = stats.correlation
            if c <= -0.9:
                hint, color = "反相", "#b91c1c"
            elif c >= 0.9:
                hint, color = "高度同相", "#059669"
            elif c >= 0.2:
                hint, color = "偏同相", "#374151"
            elif c <= -0.2:
                hint, color = "偏反相", "#b45309"
            else:
                hint, color = "近似不相关", "#374151"
            self._lbl_corr.setText(f"{c:+.4f}（{hint}）")
            self._lbl_corr.setStyleSheet(f"color:{color};font-weight:bold;")

        self._lbl_peak_l.setText(
            f"{stats.peak_left:.4f}（{format_dbfs(stats.peak_left)}）")
        self._lbl_peak_r.setText(
            f"{stats.peak_right:.4f}（{format_dbfs(stats.peak_right)}）")
        self._lbl_mono.setText(
            f"峰值 {stats.mono_peak:.4f}（{format_dbfs(stats.mono_peak)}）"
            f"　RMS {stats.mono_rms:.4f}")

    # ============================================================ 区间

    def _on_region_changed(self, region) -> None:
        if self._audio is None:
            return
        sr = self._audio.samplerate
        self._spin_r0.blockSignals(True)
        self._spin_r1.blockSignals(True)
        if region is None:
            self._spin_r0.setValue(0.0)
            self._spin_r1.setValue(self._audio.duration)
        else:
            self._spin_r0.setValue(region[0] / sr)
            self._spin_r1.setValue(region[1] / sr)
        self._spin_r0.blockSignals(False)
        self._spin_r1.blockSignals(False)
        self._apply_player_region()
        self._refresh_stats()

    def _on_region_spin(self) -> None:
        if self._audio is None:
            return
        t0, t1 = self._spin_r0.value(), self._spin_r1.value()
        if t1 <= t0:
            return
        sr = self._audio.samplerate
        f0 = int(round(t0 * sr))
        f1 = int(round(t1 * sr))
        self._wave.set_region(f0, f1)  # 会触发 regionChanged → 统计刷新

    def _apply_player_region(self) -> None:
        if self._player is None or self._audio is None:
            return
        region = self._wave.region()
        self._player.set_region(region[0] if region else None,
                                region[1] if region else None,
                                loop=self._chk_loop.isChecked())

    # ============================================================ 播放

    def _ensure_player(self) -> AudioPlayer:
        if self._player is None:
            assert self._audio is not None
            player = AudioPlayer(self._audio.samples, self._audio.samplerate)
            player.sync_params(self._params, self._attenuation)
            self._apply_player_region_to(player)
            self._player = player
        return self._player

    def _apply_player_region_to(self, player: AudioPlayer) -> None:
        region = self._wave.region()
        player.set_region(region[0] if region else None,
                          region[1] if region else None,
                          loop=self._chk_loop.isChecked())

    def _on_play(self) -> None:
        try:
            player = self._ensure_player()
            player.play()
        except PlayerError as exc:
            QMessageBox.warning(self, "播放失败", str(exc))

    def _on_play_region(self) -> None:
        if self._audio is None:
            return
        region = self._wave.region()
        if region is None:
            QMessageBox.information(self, "提示", "请先在波形上拖选一个区间。")
            return
        try:
            player = self._ensure_player()
            self._apply_player_region_to(player)
            player.seek(region[0])
            player.play()
        except PlayerError as exc:
            QMessageBox.warning(self, "播放失败", str(exc))

    def _on_pause(self) -> None:
        if self._player is not None:
            self._player.pause()

    def _on_stop(self) -> None:
        if self._player is not None:
            self._player.stop()
        else:
            self._wave.set_position(0)
        self._refresh_position()

    def _on_seek(self, frame: int) -> None:
        if self._audio is None:
            return
        if self._player is not None:
            self._player.seek(frame)
        else:
            self._wave.set_position(frame)
        self._refresh_position()

    def _refresh_position(self) -> None:
        if self._audio is None:
            return
        # 没有播放器时以波形控件自身位置为准（点击跳转由它直接保存）
        if self._player is None:
            pos = self._wave._pos
        else:
            pos = self._player.position()
            self._wave.set_position(pos)
        self._lbl_pos.setText(
            f"{pos / self._audio.samplerate:.3f} s（帧 {pos}）")

    # ============================================================ 导出与回读核对

    def _on_export(self) -> None:
        if self._audio is None or self._product is None:
            return
        raw_peak = self._raw_peak()
        if not self._params.protect and raw_peak > 1.0 + CLIP_EPS:
            QMessageBox.warning(
                self, "禁止导出：超幅",
                f"当前处理结果峰值 {raw_peak:.4f} 超过满量程，"
                f"且统一衰减保护处于关闭状态。\n"
                f"请先降低中间/侧边增益，或开启保护后再导出。")
            return

        default_name = self._audio.source_path.stem + "_ms.wav"
        path, _ = QFileDialog.getSaveFileName(
            self, "导出立体声 WAV", default_name, "WAV 音频 (*.wav)")
        if not path:
            return

        subtype = self._audio.subtype
        write_wav(path, self._product, self._audio.samplerate, subtype)
        report = self._verify_export(Path(path), subtype)
        self._show_export_report(report)

    def _verify_export(self, path: Path, subtype: str) -> dict:
        """回读核对：中侧还原、长度/采样率、左右差异与峰值（1 个量化单位）。"""
        data, sr = sf.read(str(path), dtype="float64", always_2d=True)
        expected = self._product
        step = quantization_step(subtype)
        tol = step + 1e-12

        results: dict = {"path": str(path), "checks": [], "ok": True}

        def check(name: str, ok: bool, detail: str) -> None:
            results["checks"].append((name, ok, detail))
            results["ok"] = results["ok"] and ok

        check("采样率一致", sr == self._audio.samplerate,
              f"{sr} Hz vs {self._audio.samplerate} Hz")
        check("长度一致（立体声 2 声道）",
              data.shape == expected.shape, str(data.shape))

        diff = float(np.max(np.abs(data - expected))) if data.size else 0.0
        check("回读与试听参数一致（≤1 个量化单位）",
              diff <= tol, f"最大差 {diff:.3e}，容差 {tol:.3e}")

        # 中侧还原：对回读信号做 M/S 分解再合回，应精确复原
        mid = (data[:, 0] + data[:, 1]) * 0.5
        side = (data[:, 0] - data[:, 1]) * 0.5
        recon = np.column_stack((mid + side, mid - side))
        rt_err = float(np.max(np.abs(recon - data)))
        check("中侧分解/合成可逆", rt_err < 1e-12, f"复原误差 {rt_err:.2e}")

        # 左右差异与峰值
        peak_l = float(np.max(np.abs(data[:, 0])))
        peak_r = float(np.max(np.abs(data[:, 1])))
        exp_l = float(np.max(np.abs(expected[:, 0])))
        exp_r = float(np.max(np.abs(expected[:, 1])))
        check("左右峰值与处理结果一致",
              abs(peak_l - exp_l) <= tol and abs(peak_r - exp_r) <= tol,
              f"L {peak_l:.4f}/{exp_l:.4f}，R {peak_r:.4f}/{exp_r:.4f}")
        side_peak = float(np.max(np.abs(side)))
        check("侧边分量可读", np.isfinite(side_peak),
              f"S 峰值 {side_peak:.4f}")
        return results

    def _show_export_report(self, report: dict) -> None:
        lines = [f"已导出：{report['path']}", ""]
        for name, ok, detail in report["checks"]:
            lines.append(f"{'✅' if ok else '❌'} {name} —— {detail}")
        lines.append("")
        lines.append(f"使用参数：M ×{self._params.mid_gain:.2f}，"
                     f"S ×{self._params.side_gain:.2f}，"
                     f"保护{'开' if self._params.protect else '关'}，"
                     f"衰减系数 {self._attenuation:.4f}")
        box = QMessageBox(self)
        box.setWindowTitle("导出完成，回读核对")
        box.setText("\n".join(lines))
        box.setIcon(QMessageBox.Information if report["ok"]
                    else QMessageBox.Warning)
        box.exec()

    # ============================================================ 关闭

    def closeEvent(self, event) -> None:  # noqa: N802
        self._ui_timer.stop()
        if self._player is not None:
            self._player.close()
        event.accept()
