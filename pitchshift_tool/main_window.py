"""主窗口: 参数/版本管理、试听对比、分析结果与导出。"""

from __future__ import annotations

import os

import numpy as np
from PySide6.QtCore import Qt, QTimer
from PySide6.QtWidgets import (
    QButtonGroup,
    QComboBox,
    QDoubleSpinBox,
    QFileDialog,
    QFrame,
    QGridLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QProgressBar,
    QPushButton,
    QRadioButton,
    QSpinBox,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from . import MAX_DURATION_SEC, __version__
from .analysis import dominant_frequency, find_clip_regions, onset_times
from .audio import AudioData, load_wav, save_wav
from .player import AudioPlayer
from .synth import build_test_signal
from .waveform_widget import WaveformView
from .worker import ProcessWorker

DEBOUNCE_MS = 350
VIEW_LABELS = {"L": "左声道单听", "R": "右声道单听", "mix": "混合 (立体声)"}


def _spin(start: float, end: float, step: float, suffix: str, value: float):
    s = QDoubleSpinBox()
    s.setRange(start, end)
    s.setDecimals(3)
    s.setSingleStep(step)
    s.setSuffix(suffix)
    s.setValue(value)
    return s


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle(f"伴奏移调工具 v{__version__} — 保时长升降半音")
        self.resize(1280, 820)

        self.audio: AudioData | None = None
        self.result: AudioData | None = None
        self.result_semitones: float | None = None
        # 当前配置的 worker 以及仍在退出过程中的旧 worker (都必须持有引用,
        # 否则 QThread 对象被 GC 会段错误)
        self.worker: ProcessWorker | None = None
        self._old_workers: list[ProcessWorker] = []
        self.config_seq = 0
        self.completed_config_id = -1
        self.completed_semitones: float | None = None
        self._listen_pos = 0.0
        self._pending_sel: tuple[float, float] | None = None

        self.player = AudioPlayer()
        self.player.positionChanged.connect(self._on_position)
        self.player.finished.connect(lambda: self._set_listen_pos(0.0))

        self._debounce = QTimer(self)
        self._debounce.setSingleShot(True)
        self._debounce.timeout.connect(self._start_worker)

        self._build_ui()

    # ================= UI 搭建 =================
    def _build_ui(self) -> None:
        central = QWidget()
        self.setCentralWidget(central)
        root = QHBoxLayout(central)

        # ---- 左: 波形 + 区域 ----
        left = QVBoxLayout()
        bar = QHBoxLayout()
        self.btn_import = QPushButton("导入 WAV…")
        self.btn_test = QPushButton("生成测试信号")
        self.btn_import.clicked.connect(self._import)
        self.btn_test.clicked.connect(self._generate_test)
        self.lbl_file = QLabel("未加载音频")
        self.lbl_file.setStyleSheet("color:#9aa4b2;")
        bar.addWidget(self.btn_import)
        bar.addWidget(self.btn_test)
        bar.addWidget(self.lbl_file, 1)
        left.addLayout(bar)

        self.view = WaveformView()
        self.view.selectionMade.connect(self._on_wave_select)
        left.addWidget(self.view, 1)

        region_box = QGroupBox("试听片段 (可在波形上拖选后点按钮, 也可直接填时间)")
        rg = QGridLayout(region_box)
        self.lbl_pending = QLabel("拖选波形以指定片段")
        self.lbl_pending.setStyleSheet("color:#c8a24a;")
        rg.addWidget(self.lbl_pending, 0, 0, 1, 6)

        self.sus_start = _spin(0, MAX_DURATION_SEC, 0.1, " s", 0)
        self.sus_end = _spin(0, MAX_DURATION_SEC, 0.1, " s", 0)
        self.on_start = _spin(0, MAX_DURATION_SEC, 0.1, " s", 0)
        self.on_end = _spin(0, MAX_DURATION_SEC, 0.1, " s", 0)
        self.btn_use_sus = QPushButton("用拖选段→持续音")
        self.btn_use_on = QPushButton("用拖选段→起音段")
        self.btn_use_sus.clicked.connect(lambda: self._assign_pending("sus"))
        self.btn_use_on.clicked.connect(lambda: self._assign_pending("on"))
        rg.addWidget(QLabel("持续音段"), 1, 0)
        rg.addWidget(self.sus_start, 1, 1)
        rg.addWidget(QLabel("–"), 1, 2)
        rg.addWidget(self.sus_end, 1, 3)
        rg.addWidget(self.btn_use_sus, 1, 4, 1, 2)
        rg.addWidget(QLabel("起音段"), 2, 0)
        rg.addWidget(self.on_start, 1 + 1, 1)
        rg.addWidget(QLabel("–"), 2, 2)
        rg.addWidget(self.on_end, 2, 3)
        rg.addWidget(self.btn_use_on, 2, 4, 1, 2)
        for s in (self.sus_start, self.sus_end, self.on_start, self.on_end):
            s.valueChanged.connect(self._regions_changed)
        left.addWidget(region_box)
        root.addLayout(left, 3)

        # ---- 右: 控制区 ----
        right = QVBoxLayout()
        right.setSpacing(8)

        # 参数
        pbox = QGroupBox("移调参数")
        pg = QGridLayout(pbox)
        pg.addWidget(QLabel("半音 (正负整数)"), 0, 0)
        self.spin_semi = QSpinBox()
        self.spin_semi.setRange(-12, 12)
        self.spin_semi.setValue(0)
        pg.addWidget(self.spin_semi, 0, 1)
        pg.addWidget(QLabel("细调 (音分, 100=1半音)"), 1, 0)
        self.spin_cents = QSpinBox()
        self.spin_cents.setRange(-99, 99)
        self.spin_cents.setValue(0)
        pg.addWidget(self.spin_cents, 1, 1)
        self.lbl_effective = QLabel("当前有效偏移: 0.00 半音 (0 音分)")
        self.lbl_effective.setStyleSheet("font-weight:bold;")
        pg.addWidget(self.lbl_effective, 2, 0, 1, 2)
        self.spin_semi.valueChanged.connect(self._param_changed)
        self.spin_cents.valueChanged.connect(self._param_changed)
        right.addWidget(pbox)

        # 处理状态 / 版本
        sbox = QGroupBox("处理状态")
        sg = QVBoxLayout(sbox)
        self.lbl_generating = QLabel("当前配置: —")
        self.lbl_completed = QLabel("上次完成: —")
        self.progress = QProgressBar()
        self.progress.setRange(0, 100)
        self.btn_cancel = QPushButton("取消处理")
        self.btn_cancel.setEnabled(False)
        self.btn_cancel.clicked.connect(self._cancel_worker)
        sg.addWidget(self.lbl_generating)
        sg.addWidget(self.progress)
        sg.addWidget(self.btn_cancel)
        sg.addWidget(self._hline())
        sg.addWidget(self.lbl_completed)
        self._set_status_color("idle")
        right.addWidget(sbox)

        # 试听
        lbox = QGroupBox("试听 (切换版本/声道保持在同一位置)")
        lg = QGridLayout(lbox)
        self.rb_orig = QRadioButton("处理前 (原始)")
        self.rb_result = QRadioButton("处理后 (移调)")
        self.rb_orig.setChecked(True)
        self.rb_result.setEnabled(False)
        self.version_group = QButtonGroup(self)
        self.version_group.addButton(self.rb_orig)
        self.version_group.addButton(self.rb_result)
        self.version_group.idToggled.connect(self._version_toggled)
        lg.addWidget(self.rb_orig, 0, 0)
        lg.addWidget(self.rb_result, 0, 1)

        lg.addWidget(QLabel("监听方式"), 1, 0)
        self.combo_view = QComboBox()
        for key, label in VIEW_LABELS.items():
            self.combo_view.addItem(label, key)
        self.combo_view.currentIndexChanged.connect(self._view_toggled)
        lg.addWidget(self.combo_view, 1, 1)

        self.btn_play_sus = QPushButton("▶ 持续音段")
        self.btn_play_on = QPushButton("▶ 起音段")
        self.btn_play_all = QPushButton("▶ 整曲")
        self.btn_stop = QPushButton("⏹ 停止")
        for b in (self.btn_play_sus, self.btn_play_on, self.btn_play_all):
            b.clicked.connect(self._play_region)
        self.btn_stop.clicked.connect(self._stop_play)
        lg.addWidget(self.btn_play_sus, 2, 0)
        lg.addWidget(self.btn_play_on, 2, 1)
        lg.addWidget(self.btn_play_all, 3, 0)
        lg.addWidget(self.btn_stop, 3, 1)
        self.lbl_pos = QLabel("播放位置 0.000 s")
        lg.addWidget(self.lbl_pos, 4, 0, 1, 2)
        right.addWidget(lbox)

        # 分析
        abox = QGroupBox("处理前后对比分析")
        ag = QVBoxLayout(abox)
        self.txt_analysis = QTextEdit()
        self.txt_analysis.setReadOnly(True)
        self.txt_analysis.setMinimumHeight(190)
        ag.addWidget(self.txt_analysis)
        right.addWidget(abox, 1)

        self.btn_export = QPushButton("导出处理后 WAV (使用上次确认试听的版本)")
        self.btn_export.setEnabled(False)
        self.btn_export.setStyleSheet("font-weight:bold; padding:8px;")
        self.btn_export.clicked.connect(self._export)
        right.addWidget(self.btn_export)

        w = QWidget()
        w.setLayout(right)
        w.setFixedWidth(420)
        root.addWidget(w)

    def _hline(self) -> QFrame:
        f = QFrame()
        f.setFrameShape(QFrame.HLine)
        return f

    def _set_status_color(self, state: str) -> None:
        colors = {
            "idle": "#9aa4b2",
            "working": "#d9a441",
            "done": "#58b368",
            "cancel": "#8a8f98",
            "error": "#e05b5b",
        }
        c = colors[state]
        self.lbl_generating.setStyleSheet(f"color:{c}; font-weight:bold;")
        self.lbl_completed.setStyleSheet("color:#58b368; font-weight:bold;")

    # ================= 文件与测试信号 =================
    def _import(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "选择 WAV 文件", os.path.expanduser("~"), "WAV (*.wav)"
        )
        if not path:
            return
        try:
            audio = load_wav(path)
        except Exception as exc:
            QMessageBox.critical(self, "导入失败", str(exc))
            return
        self._load_audio(audio, os.path.basename(path))

    def _generate_test(self) -> None:
        from .synth import TEST_SR

        sig = build_test_signal()
        audio = AudioData(samples=sig, sr=TEST_SR, path=None)
        self._load_audio(audio, "程序生成测试信号 (8s 立体声)")
        # 预置推荐片段: 6s 后只有持续音; 第一个音头在 1.0s
        self.sus_start.setValue(6.0)
        self.sus_end.setValue(7.5)
        self.on_start.setValue(0.9)
        self.on_end.setValue(1.4)

    def _load_audio(self, audio: AudioData, title: str) -> None:
        self._stop_play()
        self.audio = audio
        self.result = None
        self.result_semitones = None
        self.completed_config_id = -1
        self.completed_semitones = None
        self._listen_pos = 0.0
        self._pending_sel = None
        self.rb_orig.setChecked(True)
        self.rb_result.setEnabled(False)
        self.btn_export.setEnabled(False)
        self.lbl_file.setText(
            f"{title}  |  {audio.sr} Hz, {audio.channels} 声道, "
            f"{len(audio.samples)} 采样点, {audio.duration:.3f}s"
        )
        for s in (self.sus_start, self.sus_end, self.on_start, self.on_end):
            s.setMaximum(audio.duration)
            s.setValue(0)
        self.view.set_audio(audio.samples, audio.sr)
        self._regions_changed()
        self._refresh_analysis()
        self._schedule()

    # ================= 参数 -> 后台处理 =================
    def effective_semitones(self) -> float:
        return float(self.spin_semi.value()) + self.spin_cents.value() / 100.0

    def _param_changed(self) -> None:
        s = self.effective_semitones()
        self.lbl_effective.setText(
            f"当前有效偏移: {s:+.2f} 半音 ({s * 100:+.0f} 音分)"
        )
        if self.audio is not None:
            self._schedule()

    def _schedule(self) -> None:
        # 频繁改参数: 停掉旧计时, 旧 worker 稍后被新配置取代
        self._debounce.start(DEBOUNCE_MS)

    def _start_worker(self) -> None:
        if self.audio is None:
            return
        if self.worker is not None and self.worker.isRunning():
            # 旧配置作废: 通知取消并移到旧 worker 列表, 等它真正退出后再释放
            self.worker.request_cancel()
            self._old_workers.append(self.worker)
        self.config_seq += 1
        cid = self.config_seq
        semi = self.effective_semitones()
        worker = ProcessWorker(self.audio.samples, self.audio.sr, semi, cid)
        worker.progress.connect(self._on_progress)
        worker.succeeded.connect(self._on_succeeded)
        worker.failed.connect(self._on_failed)
        worker.cancelled.connect(self._on_cancelled)
        # 任意 worker 结束都尝试清理已退出的旧引用
        worker.finished.connect(self._cleanup_old_workers)
        self.worker = worker
        worker.start()

        self.btn_cancel.setEnabled(True)
        self.progress.setValue(0)
        self.lbl_generating.setText(
            f"当前配置: #{cid}  {semi:+.2f} 半音 — 生成中… 0%"
        )
        self._set_status_color("working")

    def _cleanup_old_workers(self) -> None:
        self._old_workers = [w for w in self._old_workers if w.isRunning()]

    def _cancel_worker(self) -> None:
        if self.worker is not None and self.worker.isRunning():
            self.worker.request_cancel()
            self.btn_cancel.setEnabled(False)
            self.lbl_generating.setText("正在取消…")

    def _on_progress(self, cid: int, p: float) -> None:
        if cid != self.config_seq:
            return
        pct = int(round(p * 100))
        self.progress.setValue(pct)
        self.lbl_generating.setText(
            f"当前配置: #{cid}  {self.effective_semitones():+.2f} 半音 — 生成中… {pct}%"
        )

    def _on_succeeded(self, cid: int, samples: np.ndarray, semitones: float) -> None:
        if cid != self.config_seq:
            return  # 已被更新的配置取代, 丢弃
        assert self.audio is not None
        assert samples.shape == self.audio.samples.shape, "采样点数/声道必须与原文件一致"
        self.result = AudioData(samples=samples, sr=self.audio.sr, path=None)
        self.result_semitones = semitones
        self.completed_config_id = cid
        self.completed_semitones = semitones
        self.btn_cancel.setEnabled(False)
        self.progress.setValue(100)
        self.lbl_generating.setText(f"当前配置: #{cid}  {semitones:+.2f} 半音")
        self.lbl_completed.setText(
            f"上次完成: #{cid}  {semitones:+.2f} 半音 — 试听与导出均使用此版本"
        )
        self._set_status_color("done")
        self.rb_result.setEnabled(True)
        self.btn_export.setEnabled(True)
        self._update_waveform()
        self._refresh_analysis()

    def _on_failed(self, cid: int, msg: str) -> None:
        if cid != self.config_seq:
            return
        self.btn_cancel.setEnabled(False)
        self.lbl_generating.setText(f"当前配置: #{cid} 处理失败")
        self._set_status_color("error")
        QMessageBox.warning(self, "处理失败", msg)

    def _on_cancelled(self, cid: int) -> None:
        if cid != self.config_seq:
            return
        self.btn_cancel.setEnabled(False)
        self.lbl_generating.setText(f"当前配置: #{cid} 已取消 (上次完成结果仍可试听)")
        self._set_status_color("cancel")
        if self.completed_config_id >= 0:
            self.lbl_completed.setText(
                f"上次完成: #{self.completed_config_id}  "
                f"{self.completed_semitones:+.2f} 半音 — 试听与导出均使用此版本"
            )

    # ================= 波形区域 =================
    def _on_wave_select(self, t0: float, t1: float) -> None:
        self._pending_sel = (t0, t1)
        self.lbl_pending.setText(f"拖选片段: {t0:.3f}s – {t1:.3f}s (点右侧按钮分配)")

    def _assign_pending(self, which: str) -> None:
        if self._pending_sel is None:
            QMessageBox.information(self, "提示", "请先在波形上拖动选择一段")
            return
        t0, t1 = self._pending_sel
        if which == "sus":
            self.sus_start.setValue(t0)
            self.sus_end.setValue(t1)
        else:
            self.on_start.setValue(t0)
            self.on_end.setValue(t1)

    def _regions_changed(self) -> None:
        sus = self._region(self.sus_start, self.sus_end)
        on = self._region(self.on_start, self.on_end)
        self.view.set_regions(sus, on)

    def _region(self, s: QDoubleSpinBox, e: QDoubleSpinBox):
        if e.value() - s.value() < 0.02:
            return None
        return (s.value(), e.value())

    def _update_waveform(self) -> None:
        if self.audio is None:
            return
        if self.rb_result.isChecked() and self.result is not None:
            self.view.set_audio(self.result.samples, self.result.sr)
            self.view.set_clips(find_clip_regions(self.result.samples, self.result.sr))
        else:
            self.view.set_audio(self.audio.samples, self.audio.sr)
        self._regions_changed()
        self.view.set_playhead(self._listen_pos)

    # ================= 试听 =================
    def _version_toggled(self) -> None:
        if self.audio is None:
            return
        was_playing = self.player.is_playing
        pos = self.player.position() if was_playing else self._listen_pos
        self._update_waveform()
        self._refresh_analysis()
        if was_playing:
            self._play_at(pos)
        else:
            self._listen_pos = pos

    def _view_toggled(self) -> None:
        if self.audio is not None and self.player.is_playing:
            self._play_at(self.player.position())

    def _current_listen_audio(self) -> AudioData | None:
        if self.rb_result.isChecked():
            return self.result
        return self.audio

    def _play_region(self) -> None:
        if self.audio is None:
            return
        sender = self.sender()
        if sender is self.btn_play_sus:
            r = self._region(self.sus_start, self.sus_end)
        elif sender is self.btn_play_on:
            r = self._region(self.on_start, self.on_end)
        else:
            r = None
        start = r[0] if r else 0.0
        self._play_at(start)

    def _play_at(self, start_s: float) -> None:
        audio = self._current_listen_audio()
        if audio is None:
            QMessageBox.information(self, "提示", "处理结果尚未生成, 请稍候")
            return
        view = self.combo_view.currentData()
        self._listen_pos = start_s
        self.player.play(audio, view, start_s)

    def _stop_play(self) -> None:
        if self.player.is_playing:
            self._listen_pos = self.player.position()
        self.player.stop()

    def _on_position(self, t: float) -> None:
        self._listen_pos = t
        self.lbl_pos.setText(f"播放位置 {t:.3f} s")
        self.view.set_playhead(t)

    def _set_listen_pos(self, t: float) -> None:
        self._listen_pos = t
        self.view.set_playhead(t)

    # ================= 分析与导出 =================
    def _refresh_analysis(self) -> None:
        if self.audio is None:
            self.txt_analysis.clear()
            return
        sr = self.audio.sr
        sus = self._region(self.sus_start, self.sus_end)
        onr = self._region(self.on_start, self.on_end)
        lines: list[str] = []

        # 长度/格式
        n0 = len(self.audio.samples)
        lines.append("<b>文件长度 / 格式</b>")
        lines.append(
            f"处理前: {n0} 采样点, {n0 / sr:.3f}s, {sr}Hz, {self.audio.channels}声道"
        )
        if self.result is not None:
            n1 = len(self.result.samples)
            same = "一致 ✓" if n1 == n0 else f"<span style='color:#e05b5b'>不一致! {n1}</span>"
            lines.append(
                f"处理后: {n1} 采样点, {n1 / sr:.3f}s — 采样点数 {same}"
            )
        lines.append("")

        # 主频
        if sus:
            f0 = dominant_frequency(self.audio.mono(), sr, *sus)
            lines.append("<b>持续音主频</b>")
            lines.append(f"处理前: {f0:.2f} Hz")
            if self.result is not None and self.result_semitones is not None:
                f1 = dominant_frequency(self.result.mono(), sr, *sus)
                expect = 2 ** (self.result_semitones / 12.0)
                ratio = f1 / f0 if f0 > 1 else 0.0
                err = abs(ratio - expect) / expect * 100 if expect else 0.0
                lines.append(
                    f"处理后: {f1:.2f} Hz  (实测倍率 {ratio:.4f}, "
                    f"理论 {expect:.4f}, 偏差 {err:.2f}%)"
                )
            lines.append("")

        # 起音
        if onr:
            t0 = onset_times(self.audio.mono(), sr, onr[0], onr[1])
            lines.append("<b>起音时间</b>")
            lines.append("处理前: " + (", ".join(f"{t:.3f}s" for t in t0) or "未检出"))
            if self.result is not None:
                t1 = onset_times(self.result.mono(), sr, onr[0], onr[1])
                lines.append(
                    "处理后: " + (", ".join(f"{t:.3f}s" for t in t1) or "未检出")
                )
                if t0 and t1:
                    drift = np.mean([
                        min(abs(b - a) for a in t0) for b in t1
                    ])
                    lines.append(f"起音平均漂移: {drift * 1000:.1f} ms")
            lines.append("")

        # 削波
        peak0 = float(np.max(np.abs(self.audio.samples)))
        lines.append("<b>峰值与削波检查</b>")
        lines.append(f"处理前峰值: {peak0:.4f}")
        if self.result is not None:
            clips = find_clip_regions(self.result.samples, sr)
            peak1 = float(np.max(np.abs(self.result.samples)))
            lines.append(f"处理后峰值: {peak1:.4f}")
            if not clips:
                lines.append("无接近削波的片段 (阈值 0.97) ✓")
            else:
                hard = [c for c in clips if c.hard]
                tag = "已满幅削波!" if hard else "接近削波"
                lines.append(
                    f"<span style='color:#e05b5b'>{tag}, 共 {len(clips)} 段 "
                    "(波形中红色标记):</span>"
                )
                for c in clips:
                    lines.append(
                        f"  • {c.start:.3f}s–{c.end:.3f}s 峰值 {c.peak:.3f}"
                    )
        self.txt_analysis.setHtml("<br>".join(lines))

    def _export(self) -> None:
        if self.result is None:
            return
        default = "pitch_shifted.wav"
        if self.audio is not None and self.audio.path:
            base = os.path.splitext(os.path.basename(self.audio.path))[0]
            default = f"{base}_shifted.wav"
        path, _ = QFileDialog.getSaveFileName(
            self, "导出处理后 WAV", os.path.join(os.path.expanduser("~"), default),
            "WAV (*.wav)",
        )
        if not path:
            return
        if not path.lower().endswith(".wav"):
            path += ".wav"
        try:
            save_wav(path, self.result.samples, self.result.sr)
        except Exception as exc:
            QMessageBox.critical(self, "导出失败", str(exc))
            return
        QMessageBox.information(
            self, "导出完成",
            f"已写出: {path}\n"
            f"配置 #{self.completed_config_id}, "
            f"偏移 {self.completed_semitones:+.2f} 半音\n"
            f"{self.result.sr}Hz, {self.result.channels}声道, "
            f"{len(self.result.samples)} 采样点 (与原文件一致)",
        )

    def closeEvent(self, event) -> None:
        workers = list(self._old_workers)
        if self.worker is not None:
            workers.append(self.worker)
        for w in workers:
            if w.isRunning():
                w.request_cancel()
        for w in workers:
            if w.isRunning():
                w.wait(2000)
        self.player.stop()
        event.accept()
