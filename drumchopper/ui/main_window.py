"""Main window: load → slice → sequence → audition → export."""

from __future__ import annotations

import json
import time
from pathlib import Path

import numpy as np
from PySide6.QtCore import QTimer, Qt, Signal
from PySide6.QtGui import QAction, QKeySequence
from PySide6.QtWidgets import (
    QDoubleSpinBox,
    QFileDialog,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QSpinBox,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

from .. import audio as A
from ..player import AudioPlayer, preview_slice
from .sequencer import SlicePanel, StepGrid
from .waveform import MiniMeter, WaveformWidget


class Transport(QWidget):
    """Play/stop/loop controls plus BPM and the unified fade length."""

    playRequested = Signal()
    stopRequested = Signal()
    loopToggled = Signal(bool)

    def __init__(self, parent=None):
        super().__init__(parent)
        row = QHBoxLayout(self)
        row.setContentsMargins(0, 0, 0, 0)
        self.play_btn = QPushButton("播放序列")
        self.loop_btn = QPushButton("循环")
        self.loop_btn.setCheckable(True)
        self.stop_btn = QPushButton("停止")
        self.play_btn.setToolTip("播放 / 停止 (Space)")
        self.stop_btn.setToolTip("停止并清空设备队列 (Esc)")
        row.addWidget(self.play_btn)
        row.addWidget(self.loop_btn)
        row.addWidget(self.stop_btn)

        self.bpm = QDoubleSpinBox()
        self.bpm.setRange(30.0, 300.0)
        self.bpm.setDecimals(1)
        self.bpm.setSingleStep(1.0)
        self.bpm.setValue(100.0)
        self.bpm.setSuffix(" BPM")
        row.addWidget(QLabel("速度"))
        row.addWidget(self.bpm)

        self.fade = QDoubleSpinBox()
        self.fade.setRange(0.0, 50.0)
        self.fade.setDecimals(1)
        self.fade.setSingleStep(0.5)
        self.fade.setValue(5.0)
        self.fade.setSuffix(" ms")
        self.fade.setToolTip("每个切片首尾共用的淡入/淡出长度")
        row.addWidget(QLabel("淡入/淡出"))
        row.addWidget(self.fade)
        row.addStretch(1)

        self.play_btn.clicked.connect(self.playRequested)
        self.stop_btn.clicked.connect(self.stopRequested)
        self.loop_btn.toggled.connect(self.loopToggled)


class MainWindow(QMainWindow):
    playbackDone = Signal()

    def __init__(self):
        super().__init__()
        self.setWindowTitle("Drum Loop Chopper")
        self.resize(1180, 840)

        self.source: A.SourceAudio | None = None
        self.model: A.SliceModel | None = None
        self.sequence = A.Sequence()
        self.player = AudioPlayer()
        self._current_render: A.RenderResult | None = None
        self._play_started = 0.0
        self._play_timer = QTimer(self)
        self._play_timer.setInterval(30)
        self._play_timer.timeout.connect(self._tick_transport)

        central = QWidget()
        outer = QVBoxLayout(central)
        outer.setContentsMargins(10, 8, 10, 8)

        top = QHBoxLayout()
        self.open_btn = QPushButton("打开 wav…")
        self.demo_btn = QPushButton("生成样例…")
        self.detect_btn = QPushButton("重新检测起音")
        self.detect_btn.setToolTip("用自动检测结果替换当前切点 (会覆盖手动调整)")
        self.detect_btn.setEnabled(False)
        self.export_btn = QPushButton("导出 wav…")
        self.export_btn.setEnabled(False)
        top.addWidget(self.open_btn)
        top.addWidget(self.demo_btn)
        top.addWidget(self.detect_btn)
        top.addWidget(self.export_btn)
        top.addSpacing(12)
        self.file_label = QLabel("未导入素材")
        self.file_label.setStyleSheet("color:#9fb0c4;")
        top.addWidget(self.file_label, 1)
        outer.addLayout(top)

        splitter = QSplitter(Qt.Vertical)

        wave_box = QGroupBox("波形与切片 · 左右声道共用同一边界")
        wave_layout = QVBoxLayout(wave_box)
        self.waveform = WaveformWidget()
        wave_layout.addWidget(self.waveform, 1)
        self.meter = MiniMeter()
        wave_layout.addWidget(self.meter)
        splitter.addWidget(wave_box)

        bottom = QWidget()
        bottom_layout = QHBoxLayout(bottom)
        bottom_layout.setContentsMargins(0, 0, 0, 0)

        grid_box = QGroupBox("16 格节奏 · 每格一个十六分音符, 显示真实开始时间")
        grid_layout = QVBoxLayout(grid_box)
        self.grid = StepGrid()
        grid_layout.addWidget(self.grid)
        grid_hint = QLabel(
            "单击格子循环切换 空 → S1 → S2 … → 空 · 右键清空 · 滚轮微调 · "
            "开启画笔后可连续涂同一片")
        grid_hint.setStyleSheet("color:#8b9bb0;")
        grid_layout.addWidget(grid_hint)
        bottom_layout.addWidget(grid_box, 3)

        side = QWidget()
        side.setMinimumWidth(340)
        side_layout = QVBoxLayout(side)
        side_layout.setContentsMargins(0, 0, 0, 0)
        self.slice_panel = SlicePanel()
        side_layout.addWidget(self.slice_panel)

        self.transport = Transport()
        side_layout.addWidget(self.transport)

        assign_box = QGroupBox("把切片填入空格")
        assign_layout = QVBoxLayout(assign_box)
        self.assign_info = QLabel("先导入素材")
        self.assign_info.setWordWrap(True)
        assign_layout.addWidget(self.assign_info)
        assign_row = QHBoxLayout()
        self.assign_combo = QSpinBox()
        self.assign_combo.setRange(1, A.MAX_SLICES)
        self.assign_combo.setPrefix("S")
        self.assign_btn = QPushButton("填入第一个空格")
        self.assign_btn.setMinimumWidth(110)
        self.brush_btn = QPushButton("画笔: 关")
        self.brush_btn.setCheckable(True)
        self.brush_btn.setMinimumWidth(72)
        self.brush_btn.setToolTip("开启后用左键把当前切片画进格子, 再点同一格清空")
        assign_row.addWidget(self.assign_combo)
        assign_row.addWidget(self.assign_btn)
        assign_row.addWidget(self.brush_btn)
        assign_layout.addLayout(assign_row)
        side_layout.addWidget(assign_box)
        side_layout.addStretch(1)
        bottom_layout.addWidget(side, 2)

        splitter.addWidget(bottom)
        splitter.setStretchFactor(0, 3)
        splitter.setStretchFactor(1, 2)
        outer.addWidget(splitter, 1)
        self.setCentralWidget(central)

        self.status = self.statusBar()
        self.status.showMessage("就绪")
        self._build_menu()

        self.open_btn.clicked.connect(self.open_wav)
        self.demo_btn.clicked.connect(self.load_demo)
        self.detect_btn.clicked.connect(self.redetect_onsets)
        self.export_btn.clicked.connect(self.export_wav)
        self.waveform.cutsChanged.connect(self.on_cuts_changed)
        self.waveform.sliceSelected.connect(self.on_slice_selected)
        self.waveform.message.connect(self.status.showMessage)
        self.slice_panel.changed.connect(self.on_cuts_changed)
        self.slice_panel.auditionRequested.connect(self.audition_selected)
        self.slice_panel.message.connect(self.status.showMessage)
        self.grid.sequenceChanged.connect(self.on_sequence_changed)
        self.transport.bpm.valueChanged.connect(self.on_bpm_changed)
        self.transport.fade.valueChanged.connect(lambda _: self._invalidate_render())
        self.transport.playRequested.connect(self.play_sequence)
        self.transport.stopRequested.connect(self.stop_all)
        self.transport.loopToggled.connect(self.on_loop_toggled)
        self.assign_btn.clicked.connect(self._assign_first_empty)
        self.assign_combo.valueChanged.connect(self._on_assign_value)
        self.brush_btn.toggled.connect(self._on_brush_toggled)
        self.playbackDone.connect(self._finish_ui, Qt.QueuedConnection)

    # -- menu / shortcuts ---------------------------------------------------
    def _build_menu(self) -> None:
        file_menu = self.menuBar().addMenu("文件")
        open_act = QAction("打开 wav…", self)
        open_act.setShortcut(QKeySequence.Open)
        open_act.triggered.connect(self.open_wav)
        file_menu.addAction(open_act)
        demo_act = QAction("生成样例…", self)
        demo_act.triggered.connect(self.load_demo)
        file_menu.addAction(demo_act)
        export_act = QAction("导出 wav…", self)
        export_act.setShortcut(QKeySequence.Save)
        export_act.triggered.connect(self.export_wav)
        file_menu.addAction(export_act)
        file_menu.addSeparator()
        quit_act = QAction("退出", self)
        quit_act.setShortcut(QKeySequence.Quit)
        quit_act.triggered.connect(self.close)
        file_menu.addAction(quit_act)

        transport_menu = self.menuBar().addMenu("走带")
        play_act = QAction("播放 / 停止", self)
        play_act.setShortcut(QKeySequence("Space"))
        play_act.triggered.connect(self.toggle_play)
        transport_menu.addAction(play_act)
        stop_act = QAction("停止", self)
        stop_act.setShortcut(QKeySequence("Escape"))
        stop_act.triggered.connect(self.stop_all)
        transport_menu.addAction(stop_act)

    # -- loading ------------------------------------------------------------
    def load_demo(self) -> None:
        default_path = Path.cwd() / "samples" / "demo_drums.wav"
        default_path.parent.mkdir(exist_ok=True)
        path, _ = QFileDialog.getSaveFileName(
            self, "生成样例并保存为", str(default_path), "WAV (*.wav)")
        if not path:
            return
        from ..samples import write_demo

        json_path = Path(path).with_name(Path(path).stem + "_onsets.json")
        try:
            meta = write_demo(path, json_path)
        except Exception as exc:  # pragma: no cover - IO failure
            QMessageBox.critical(self, "生成失败", str(exc))
            return
        self.status.showMessage(
            f"已生成 {path} · 已知起音 {len(meta['onsets'])} 个 · 记录在 {json_path.name}")
        self._load_path(Path(path), seed_onsets=meta.get("onsets"))

    def open_wav(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "打开 wav", "", "WAV (*.wav *.WAV)")
        if not path:
            return
        self._load_path(Path(path))

    def _load_path(self, path: Path, seed_onsets: list[int] | None = None) -> None:
        self.stop_all()
        try:
            source = A.read_wav(path)
        except A.AudioLoadError as exc:
            QMessageBox.warning(self, "无法导入", str(exc))
            return

        self.source = source
        self.model = A.SliceModel(source.frames)
        raw = (list(seed_onsets) if seed_onsets is not None else
               A.detect_onsets(source.samples, source.samplerate))
        # dedupe + keep only interior positions before applying the limit
        suggested = sorted({int(p) for p in raw if 0 < int(p) < source.frames})
        self._suggested_onsets = suggested
        cuts = suggested[: A.MAX_SLICES - 1]
        self.model.set_cuts(cuts)

        self.sequence = A.Sequence()
        self._auto_fill_pattern()

        self.waveform.set_source(source, self.model)
        self.waveform.set_hints(self._suggested_onsets)
        self.waveform.set_selected(0)
        self.player.configure(source.samplerate, source.channels)
        self.grid.set_state(self.sequence, self.model.count,
                            A.step_samples(self.transport.bpm.value(), source.samplerate),
                            source.samplerate)
        self.slice_panel.set_state(source, self.model, 0)
        self.assign_combo.setRange(1, self.model.count)
        self.export_btn.setEnabled(True)
        self.detect_btn.setEnabled(True)
        self.meter.set_text("尚未渲染")
        self._current_render = None
        self.file_label.setText(
            f"{path.name} · {source.duration:.2f}s · {source.samplerate} Hz · "
            f"{'立体声' if source.channels == 2 else '单声道'} · {self.model.count} 个切片")
        self.status.showMessage(
            f"已导入 {path.name}: 自动建议 {len(self._suggested_onsets)} 个起音, "
            f"已采用 {self.model.count - 1} 个切点, 可拖动修正或点虚线采用其余建议")
        self._refresh_assign_info()

    def redetect_onsets(self) -> None:
        """Replace the cut set with a fresh automatic suggestion."""
        if self.source is None:
            return
        self.stop_all()
        suggested = A.detect_onsets(self.source.samples, self.source.samplerate)
        self._suggested_onsets = suggested
        if self.model is None:
            self.model = A.SliceModel(self.source.frames)
        self.model.set_cuts(suggested[: A.MAX_SLICES - 1])
        self.waveform.set_hints(suggested)
        self.waveform.set_selected(0)
        self.on_cuts_changed()
        self.status.showMessage(
            f"重新检测: {len(suggested)} 个候选, 采用 {self.model.count - 1} 个切点")

    def _auto_fill_pattern(self) -> None:
        """Seed a simple, valid pattern from the available slices."""
        n = self.model.count if self.model else 0
        pattern: list[int | None] = [None] * A.STEPS
        if n:
            for step in range(0, A.STEPS, 4):
                pattern[step] = min(step // 4 % n, n - 1)
            if n > 1:
                for step in range(2, A.STEPS, 4):
                    pattern[step] = 1
        self.sequence.steps = pattern

    # -- slice edits --------------------------------------------------------
    def on_cuts_changed(self) -> None:
        if self.model is None or self.source is None:
            return
        for i, s in enumerate(self.sequence.steps):
            if s is not None and s >= self.model.count:
                self.sequence.steps[i] = None
        self.grid.set_state(self.sequence, self.model.count,
                            A.step_samples(self.transport.bpm.value(), self.source.samplerate),
                            self.source.samplerate)
        idx = min(self.waveform.selected, self.model.count - 1)
        self.waveform.set_selected(idx)
        self.slice_panel.set_state(self.source, self.model, idx)
        self.assign_combo.setRange(1, self.model.count)
        self.waveform.update()
        self._invalidate_render()
        self._refresh_assign_info()

    def on_slice_selected(self, index: int) -> None:
        self.slice_panel.set_state(self.source, self.model, index)
        self.assign_combo.setValue(index + 1)

    # -- sequencing ---------------------------------------------------------
    def on_sequence_changed(self) -> None:
        was_playing = self.player.playing
        self._invalidate_render()
        self._refresh_assign_info()
        if was_playing:
            self.play_sequence(restart=True)

    def on_bpm_changed(self, bpm: float) -> None:
        if self.source is not None and self.model is not None:
            self.grid.set_state(self.sequence, self.model.count,
                                A.step_samples(bpm, self.source.samplerate),
                                self.source.samplerate)
        was_playing = self.player.playing
        self._invalidate_render()
        if was_playing:
            self.play_sequence(restart=True)

    def _on_assign_value(self, value: int) -> None:
        if self.brush_btn.isChecked():
            self.grid.set_brush(max(0, value - 1))

    def _on_brush_toggled(self, on: bool) -> None:
        self.brush_btn.setText("画笔: 开" if on else "画笔: 关")
        self.grid.set_brush(max(0, self.assign_combo.value() - 1) if on else None)

    def _assign_first_empty(self) -> None:
        if self.model is None:
            return
        value = min(self.assign_combo.value() - 1, self.model.count - 1)
        for i, s in enumerate(self.sequence.steps):
            if s is None:
                self.sequence.set_step(i, value)
                self.grid.update()
                self.on_sequence_changed()
                return
        self.status.showMessage("没有空格了, 先清空一些格子")

    def _refresh_assign_info(self) -> None:
        if self.model is None:
            self.assign_info.setText("先导入素材")
            return
        empty = sum(1 for s in self.sequence.steps if s is None)
        used = sorted(self.sequence.used_slices())
        used_text = ", ".join(f"S{i + 1}" for i in used) if used else "无"
        self.assign_info.setText(
            f"{self.model.count} 个切片 · 使用中: {used_text} · 空格 {empty} 个")

    # -- render / transport -------------------------------------------------
    def _fade_seconds(self) -> tuple[float, float]:
        ms = self.transport.fade.value() / 1000.0
        return ms, ms

    def _build_render(self) -> A.RenderResult | None:
        if self.source is None or self.model is None:
            return None
        fin, fout = self._fade_seconds()
        return A.render_sequence(
            self.source, self.model, self.sequence, self.transport.bpm.value(),
            fade_in_s=fin, fade_out_s=fout)

    def _invalidate_render(self) -> None:
        self._current_render = None
        if self.player.playing:
            # never keep stale audio running after an edit
            self.stop_all()
        self.meter.set_text("已修改 · 播放 / 导出时按新设置重新渲染")

    def play_sequence(self, *, restart: bool = False) -> None:
        if self.source is None or self.model is None:
            return
        if self.player.playing and not restart:
            self.stop_all()
            return
        self.player.stop()
        render = self._build_render()
        if render is None:
            return
        self._current_render = render
        self.meter.set_render(render.peak_before, render.peak_after, render.gain)
        ok = self.player.play(render.audio, loop=self.transport.loop_btn.isChecked(),
                              on_finished=self._on_playback_finished)
        if not ok:
            self.status.showMessage(self.player.error or "无法播放, 但仍可导出")
            return
        self._play_started = time.monotonic()
        self._play_timer.start()
        self.status.showMessage(
            f"播放 {render.length} 采样 ({render.length / self.source.samplerate:.3f}s)"
            + (f" · 保护衰减 {20 * np.log10(max(render.gain, 1e-9)):.2f} dB"
               if render.gain < 0.9999 else ""))

    def toggle_play(self) -> None:
        if self.player.playing:
            self.stop_all()
        else:
            self.play_sequence()

    def stop_all(self) -> None:
        self._play_timer.stop()
        self.player.stop()
        self.grid.set_cursor(-1)
        self.status.showMessage("已停止")

    def on_loop_toggled(self, enabled: bool) -> None:
        if self.player.playing:
            self.play_sequence(restart=True)

    def _on_playback_finished(self) -> None:
        # invoked from the audio callback thread; a queued signal hands the
        # UI update back to the GUI thread safely
        self.playbackDone.emit()

    def _finish_ui(self) -> None:
        self._play_timer.stop()
        self.grid.set_cursor(-1)
        self.status.showMessage("播放完成")

    def _tick_transport(self) -> None:
        if self.source is None or not self.player.playing:
            self._play_timer.stop()
            return
        render = self._current_render
        if render is None or render.length <= 0:
            return
        elapsed = time.monotonic() - self._play_started
        pos = int(elapsed * self.source.samplerate) % render.length
        step = min(A.STEPS - 1, int(pos / render.length * A.STEPS))
        self.grid.set_cursor(step)

    # -- audition -----------------------------------------------------------
    def audition_selected(self) -> None:
        if self.source is None or self.model is None:
            return
        index = min(self.waveform.selected, self.model.count - 1)
        start, end = self.model.slice_bounds()[index]
        fin, fout = self._fade_seconds()
        clip = preview_slice(self.source.samples, start, end, fin, fout,
                             self.source.samplerate)
        self.player.stop()
        self._play_timer.stop()
        ok = self.player.play(clip, loop=False, on_finished=self._on_playback_finished)
        if not ok:
            self.status.showMessage(self.player.error or "无法播放")
        else:
            self.status.showMessage(
                f"试听切片 {index + 1}: 采样 {start}–{end} "
                f"({(end - start) / self.source.samplerate * 1000:.1f} ms)")

    # -- export -------------------------------------------------------------
    def export_wav(self) -> None:
        if self.source is None or self.model is None:
            return
        suggested = f"pattern_{int(round(self.transport.bpm.value()))}bpm.wav"
        path, _ = QFileDialog.getSaveFileName(self, "导出完整 16 格 wav", suggested,
                                              "WAV (*.wav)")
        if not path:
            return
        self.export_to(path)

    def export_to(self, path: str | Path) -> dict | None:
        """Render + write the full 16-step wav and its sidecar metadata."""
        if self.source is None or self.model is None:
            return None
        render = self._build_render()
        if render is None:
            return None
        self._current_render = render
        self.meter.set_render(render.peak_before, render.peak_after, render.gain)
        A.write_wav(path, render.audio, self.source.samplerate)
        info = {
            "samplerate": self.source.samplerate,
            "channels": self.source.channels,
            "frames": render.length,
            "duration": render.length / self.source.samplerate,
            "bpm": self.transport.bpm.value(),
            "fade_in_s": self._fade_seconds()[0],
            "fade_out_s": self._fade_seconds()[1],
            "step_samples": render.step_offsets,
            "gain": render.gain,
            "peak_before": render.peak_before,
            "peak_after": render.peak_after,
            "slices": [
                {"index": i, "start": s, "end": e}
                for i, (s, e) in enumerate(self.model.slice_bounds())
            ],
            "steps": self.sequence.steps,
        }
        Path(path).with_suffix(".json").write_text(
            json.dumps(info, indent=2, ensure_ascii=False), encoding="utf-8")
        self.status.showMessage(
            f"已导出 {path}: {render.length} 采样, 峰值 {render.peak_after:.3f}"
            + (f", 衰减 {20 * np.log10(render.gain):.2f} dB" if render.gain < 0.9999 else ""))
        return info

    def closeEvent(self, event) -> None:  # noqa: ANN001
        self._play_timer.stop()
        self.player.stop()
        self.player.close()
        super().closeEvent(event)
