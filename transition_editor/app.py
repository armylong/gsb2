"""PySide6 图形界面: 两段视频交接转场编辑器.

布局: 上为两段素材的载入与保留区间, 中为转场参数与校验, 下为预览
(三点抽帧 + 播放器 + 试听控制 + 音轨范围) 与导出.
任何参数改动都会把预览标记为"已过期", 必须重新生成后才能导出,
保证画面/声音/时间读数始终对应同一版参数.
"""
from __future__ import annotations

import os
import sys
import tempfile

from PySide6.QtCore import Qt, QThread, QTimer, Signal, QUrl
from PySide6.QtGui import QPixmap
from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer
from PySide6.QtMultimediaWidgets import QVideoWidget
from PySide6.QtWidgets import (QApplication, QComboBox, QDoubleSpinBox,
                               QFileDialog, QGridLayout, QGroupBox,
                               QHBoxLayout, QLabel, QMainWindow, QMessageBox,
                               QPushButton, QVBoxLayout, QWidget)

from .media import (FPS, MAX_SOURCE_SECONDS, MAX_TRANSITION, MIN_TRANSITION,
                    MediaError, probe_duration)
from .render import (SLIDE_DIRECTION_LABELS, TRANSITION_LABELS, ClipSpec, Plan,
                     check_readback, extract_frame_png, render)


class ClipPanel(QGroupBox):
    """一段素材: 载入、源区间选择、裁剪后时长显示."""

    changed = Signal()

    def __init__(self, title: str, parent=None):
        super().__init__(title, parent)
        self.path: str | None = None
        self.source_duration = 0.0

        self.load_btn = QPushButton("载入 mp4…")
        self.load_btn.clicked.connect(self._load)
        self.path_label = QLabel("未载入")
        self.path_label.setStyleSheet("color: gray")

        self.in_spin = QDoubleSpinBox(minimum=0.0, maximum=MAX_SOURCE_SECONDS,
                                      singleStep=0.1, decimals=2)
        self.out_spin = QDoubleSpinBox(minimum=0.0, maximum=MAX_SOURCE_SECONDS,
                                       singleStep=0.1, decimals=2)
        self.in_spin.valueChanged.connect(self._on_spin)
        self.out_spin.valueChanged.connect(self._on_spin)
        self.keep_label = QLabel("保留区间: —")

        grid = QGridLayout(self)
        grid.addWidget(self.load_btn, 0, 0)
        grid.addWidget(self.path_label, 0, 1, 1, 3)
        grid.addWidget(QLabel("入点(s)"), 1, 0)
        grid.addWidget(self.in_spin, 1, 1)
        grid.addWidget(QLabel("出点(s)"), 1, 2)
        grid.addWidget(self.out_spin, 1, 3)
        grid.addWidget(self.keep_label, 2, 0, 1, 4)

    def _load(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "选择 mp4", "", "MP4 视频 (*.mp4)")
        if not path:
            return
        try:
            dur = probe_duration(path)
        except MediaError as exc:
            QMessageBox.critical(self, "载入失败", str(exc))
            return
        if dur > MAX_SOURCE_SECONDS + 1e-6:
            QMessageBox.warning(
                self, "素材过长",
                f"每段素材不超过 {MAX_SOURCE_SECONDS:.0f} 秒, 该文件为 {dur:.2f} 秒")
            return
        self.path = path
        self.source_duration = dur
        self.path_label.setText(os.path.basename(path))
        self.path_label.setStyleSheet("")
        self.in_spin.setMaximum(dur)
        self.out_spin.setMaximum(dur)
        self.in_spin.setValue(0.0)
        self.out_spin.setValue(dur)
        self._update_keep()
        self.changed.emit()

    def _on_spin(self):
        self._update_keep()
        self.changed.emit()

    def _update_keep(self):
        if not self.path:
            return
        keep = self.out_spin.value() - self.in_spin.value()
        self.keep_label.setText(
            f"源区间 {self.in_spin.value():.2f}–{self.out_spin.value():.2f}s "
            f"(源长 {self.source_duration:.2f}s) → 裁剪后 {keep:.2f}s")
        self.keep_label.setStyleSheet("" if keep > 0 else "color: red")

    def spec(self) -> ClipSpec | None:
        if not self.path:
            return None
        return ClipSpec(self.path, self.in_spin.value(), self.out_spin.value())


class RenderThread(QThread):
    """后台渲染, 避免阻塞界面."""

    finished_ok = Signal(str)
    failed = Signal(str)

    def __init__(self, plan: Plan, out_path: str, parent=None):
        super().__init__(parent)
        self.plan = plan
        self.out_path = out_path

    def run(self):
        try:
            render(self.plan, self.out_path)
        except MediaError as exc:
            self.failed.emit(str(exc))
        else:
            self.finished_ok.emit(self.out_path)


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("两段视频交接转场编辑器")
        self.tmpdir = tempfile.mkdtemp(prefix="transition_editor_")
        self.preview_path: str | None = None
        self.preview_version = 0
        self.preview_stale = True
        self.loop_enabled = False
        self._render_thread: RenderThread | None = None
        self._pending_export: str | None = None

        # ---- 素材区 ----
        self.clip_a = ClipPanel("A 段(前)")
        self.clip_b = ClipPanel("B 段(后)")
        self.clip_a.changed.connect(self._on_params_changed)
        self.clip_b.changed.connect(self._on_params_changed)

        # ---- 转场参数 ----
        trans_box = QGroupBox("转场")
        self.kind_combo = QComboBox()
        for kind, label in TRANSITION_LABELS.items():
            self.kind_combo.addItem(label, kind)
        self.dir_combo = QComboBox()
        for d, label in SLIDE_DIRECTION_LABELS.items():
            self.dir_combo.addItem(label, d)
        self.dur_spin = QDoubleSpinBox(minimum=MIN_TRANSITION,
                                       maximum=MAX_TRANSITION,
                                       singleStep=0.1, decimals=2, value=1.0)
        self.dur_spin.setSuffix(" s")
        self.kind_combo.currentIndexChanged.connect(self._on_params_changed)
        self.dir_combo.currentIndexChanged.connect(self._on_params_changed)
        self.dur_spin.valueChanged.connect(self._on_params_changed)
        self.validate_label = QLabel("")
        self.validate_label.setWordWrap(True)
        self.total_label = QLabel("预计成品时长: —")
        tgrid = QGridLayout(trans_box)
        tgrid.addWidget(QLabel("类型"), 0, 0)
        tgrid.addWidget(self.kind_combo, 0, 1)
        tgrid.addWidget(QLabel("方向"), 0, 2)
        tgrid.addWidget(self.dir_combo, 0, 3)
        tgrid.addWidget(QLabel("时长"), 0, 4)
        tgrid.addWidget(self.dur_spin, 0, 5)
        tgrid.addWidget(self.validate_label, 1, 0, 1, 6)
        tgrid.addWidget(self.total_label, 2, 0, 1, 6)

        # ---- 预览 ----
        preview_box = QGroupBox("预览")
        self.preview_btn = QPushButton("生成预览")
        self.preview_btn.clicked.connect(self._make_preview)
        self.preview_state = QLabel("尚未生成预览")
        self.preview_state.setStyleSheet("color: gray")
        self.thumbs: list[QLabel] = []
        thumb_row = QHBoxLayout()
        for name in ("转场起点", "转场中点", "转场终点"):
            cell = QVBoxLayout()
            img = QLabel("—")
            img.setFixedSize(320, 180)
            img.setAlignment(Qt.AlignmentFlag.AlignCenter)
            img.setStyleSheet("background: #222; color: #888")
            img.setScaledContents(True)
            cap = QLabel(name)
            cap.setAlignment(Qt.AlignmentFlag.AlignCenter)
            cell.addWidget(img)
            cell.addWidget(cap)
            self.thumbs.append(img)
            thumb_row.addLayout(cell)

        self.video = QVideoWidget()
        self.video.setMinimumHeight(240)
        self.player = QMediaPlayer(self)
        self.audio_out = QAudioOutput(self)
        self.player.setAudioOutput(self.audio_out)
        self.player.setVideoOutput(self.video)

        self.play_btn = QPushButton("播放")
        self.play_btn.clicked.connect(self._toggle_play)
        self.junction_btn = QPushButton("从交接前试听")
        self.junction_btn.clicked.connect(self._play_from_junction)
        self.loop_btn = QPushButton("循环交接: 关")
        self.loop_btn.setCheckable(True)
        self.loop_btn.clicked.connect(self._toggle_loop)
        self.prev_frame_btn = QPushButton("◀ 帧")
        self.next_frame_btn = QPushButton("帧 ▶")
        self.prev_frame_btn.clicked.connect(lambda: self._step_frame(-1))
        self.next_frame_btn.clicked.connect(lambda: self._step_frame(1))
        self.time_label = QLabel("00:00.000 / 00:00.000")
        controls = QHBoxLayout()
        for w in (self.play_btn, self.junction_btn, self.loop_btn,
                  self.prev_frame_btn, self.next_frame_btn, self.time_label):
            controls.addWidget(w)
        controls.addStretch(1)

        self.audio_range_label = QLabel("声音范围(输出时间轴): —")
        self.audio_range_label.setWordWrap(True)

        pv = QVBoxLayout(preview_box)
        head = QHBoxLayout()
        head.addWidget(self.preview_btn)
        head.addWidget(self.preview_state)
        head.addStretch(1)
        pv.addLayout(head)
        pv.addLayout(thumb_row)
        pv.addWidget(self.video)
        pv.addLayout(controls)
        pv.addWidget(self.audio_range_label)

        # ---- 导出 ----
        export_box = QGroupBox("导出")
        self.export_btn = QPushButton("导出 mp4…")
        self.export_btn.clicked.connect(self._export)
        self.export_result = QLabel("—")
        self.export_result.setWordWrap(True)
        ex = QHBoxLayout(export_box)
        ex.addWidget(self.export_btn)
        ex.addWidget(self.export_result, 1)

        # ---- 总装 ----
        root = QWidget()
        lay = QVBoxLayout(root)
        clips = QHBoxLayout()
        clips.addWidget(self.clip_a)
        clips.addWidget(self.clip_b)
        lay.addLayout(clips)
        lay.addWidget(trans_box)
        lay.addWidget(preview_box, 1)
        lay.addWidget(export_box)
        self.setCentralWidget(root)
        self.resize(1100, 900)

        self.player.positionChanged.connect(self._on_position)
        self.player.durationChanged.connect(lambda _: self._update_time_label())
        self._loop_timer = QTimer(self)
        self._loop_timer.setInterval(30)
        self._loop_timer.timeout.connect(self._enforce_loop)
        self._loop_timer.start()

        self._set_controls_enabled(False)
        self._refresh_validation()

    # ---------- 参数与校验 ----------

    def _current_plan(self) -> Plan | None:
        a, b = self.clip_a.spec(), self.clip_b.spec()
        if a is None or b is None:
            return None
        return Plan(a, b,
                    kind=self.kind_combo.currentData(),
                    direction=self.dir_combo.currentData(),
                    duration=self.dur_spin.value())

    def _refresh_validation(self):
        plan = self._current_plan()
        self.dir_combo.setEnabled(self.kind_combo.currentData() == "slide")
        if plan is None:
            self.validate_label.setText("请先载入两段素材")
            self.validate_label.setStyleSheet("color: gray")
            self.total_label.setText("预计成品时长: —")
            self.audio_range_label.setText("声音范围(输出时间轴): —")
            self.preview_btn.setEnabled(False)
            return
        errs = plan.errors()
        if errs:
            self.validate_label.setText("⚠ " + "; ".join(errs))
            self.validate_label.setStyleSheet("color: red")
        else:
            self.validate_label.setText("参数有效")
            self.validate_label.setStyleSheet("color: green")
        self.total_label.setText(
            f"预计成品时长: {plan.total:.3f}s "
            f"(A {plan.len_a:.2f} + B {plan.len_b:.2f} − 转场 {plan.duration:.2f})")
        self.audio_range_label.setText(
            f"声音范围(输出时间轴): A 路 0.000–{plan.len_a:.3f}s · "
            f"B 路 {plan.offset:.3f}–{plan.total:.3f}s · "
            f"重叠 {plan.offset:.3f}–{plan.len_a:.3f}s")
        self.preview_btn.setEnabled(not errs and self._render_thread is None)

    def _on_params_changed(self):
        # 参数变了, 旧预览/旧导出结论一律作废, 不能冒充新结果
        if not self.preview_stale:
            self.preview_stale = True
        self._set_controls_enabled(False)
        self.preview_state.setText("参数已修改, 预览已过期, 请重新生成")
        self.preview_state.setStyleSheet("color: orange")
        self.export_result.setText("—")
        self._refresh_validation()

    def _set_controls_enabled(self, on: bool):
        for w in (self.play_btn, self.junction_btn, self.loop_btn,
                  self.prev_frame_btn, self.next_frame_btn, self.export_btn):
            w.setEnabled(on)

    # ---------- 预览 ----------

    def _make_preview(self):
        plan = self._current_plan()
        if plan is None or plan.errors():
            return
        self.preview_version += 1
        out = os.path.join(self.tmpdir, f"preview_v{self.preview_version}.mp4")
        self.preview_btn.setEnabled(False)
        self.preview_state.setText(f"正在生成预览 v{self.preview_version} …")
        self.preview_state.setStyleSheet("")
        self._render_thread = RenderThread(plan, out, self)
        self._render_thread.finished_ok.connect(self._on_preview_ready)
        self._render_thread.failed.connect(self._on_render_failed)
        self._render_thread.finished.connect(self._on_thread_done)
        self._render_thread.start()

    def _on_thread_done(self):
        self._render_thread = None
        self._refresh_validation()

    def _on_render_failed(self, msg: str):
        self.preview_state.setText("渲染失败")
        self.preview_state.setStyleSheet("color: red")
        QMessageBox.critical(self, "渲染失败", msg)

    def _on_preview_ready(self, path: str):
        plan = self._current_plan()
        if plan is None:
            return
        self.preview_path = path
        self.preview_stale = False
        self.preview_state.setText(
            f"预览 v{self.preview_version} 已生成(与当前参数一致)")
        self.preview_state.setStyleSheet("color: green")
        # 三点抽帧: 起点/中点/终点
        times = [plan.offset,
                 plan.offset + plan.duration / 2,
                 min(plan.offset + plan.duration, plan.total - 1 / FPS)]
        for i, t in enumerate(times):
            png = os.path.join(self.tmpdir,
                               f"thumb_v{self.preview_version}_{i}.png")
            try:
                extract_frame_png(path, t, png)
                self.thumbs[i].setPixmap(QPixmap(png))
            except MediaError:
                self.thumbs[i].setText("抽帧失败")
        self.player.setSource(QUrl.fromLocalFile(path))
        self.player.pause()
        self.play_btn.setText("播放")
        self._set_controls_enabled(True)
        self._update_time_label()

    # ---------- 播放控制 ----------

    def _toggle_play(self):
        if self.player.playbackState() == QMediaPlayer.PlaybackState.PlayingState:
            self.player.pause()
            self.play_btn.setText("播放")
        else:
            self.player.play()
            self.play_btn.setText("暂停")

    def _loop_range_ms(self) -> tuple[int, int] | None:
        plan = self._current_plan()
        if plan is None or self.preview_stale:
            return None
        start = max(0.0, plan.offset - 1.0)
        end = min(plan.total, plan.offset + plan.duration + 1.0)
        return int(start * 1000), int(end * 1000)

    def _play_from_junction(self):
        rng = self._loop_range_ms()
        if rng is None:
            return
        self.player.setPosition(rng[0])
        self.player.play()
        self.play_btn.setText("暂停")

    def _toggle_loop(self, checked: bool):
        self.loop_enabled = checked
        self.loop_btn.setText("循环交接: 开" if checked else "循环交接: 关")
        if checked:
            self._play_from_junction()

    def _enforce_loop(self):
        if not self.loop_enabled or self.preview_stale:
            return
        rng = self._loop_range_ms()
        if rng is None:
            return
        pos = self.player.position()
        if pos > rng[1] or pos < rng[0] - 500:
            self.player.setPosition(rng[0])

    def _step_frame(self, delta: int):
        if self.preview_stale:
            return
        self.player.pause()
        self.play_btn.setText("播放")
        dur = max(1, self.player.duration())
        step = round(1000 / FPS)
        pos = min(max(0, self.player.position() + delta * step), dur - 1)
        self.player.setPosition(pos)
        self._update_time_label()

    def _on_position(self, _pos: int):
        self._update_time_label()

    def _update_time_label(self):
        pos = self.player.position() / 1000
        dur = self.player.duration() / 1000
        frame = round(pos * FPS)
        self.time_label.setText(
            f"{int(pos//60):02d}:{pos%60:06.3f} / {int(dur//60):02d}:{dur%60:06.3f}"
            f"  (第 {frame} 帧)")

    # ---------- 导出 ----------

    def _export(self):
        if self.preview_stale or self.preview_path is None:
            return
        plan = self._current_plan()
        if plan is None:
            return
        out, _ = QFileDialog.getSaveFileName(
            self, "导出 mp4", "output.mp4", "MP4 视频 (*.mp4)")
        if not out:
            return
        if not out.lower().endswith(".mp4"):
            out += ".mp4"
        # 导出路径不得覆盖原始素材
        sources = {os.path.abspath(plan.clip_a.path),
                   os.path.abspath(plan.clip_b.path)}
        if os.path.abspath(out) in sources:
            QMessageBox.warning(self, "路径冲突", "不能覆盖原始素材, 请另选路径")
            return
        self._pending_export = out
        self.export_btn.setEnabled(False)
        self.export_result.setText("正在导出…")
        self._render_thread = RenderThread(plan, out, self)
        self._render_thread.finished_ok.connect(self._on_export_ready)
        self._render_thread.failed.connect(self._on_export_failed)
        self._render_thread.finished.connect(self._on_thread_done)
        self._render_thread.start()

    def _on_export_failed(self, msg: str):
        self.export_result.setText("导出失败")
        QMessageBox.critical(self, "导出失败", msg)

    def _on_export_ready(self, path: str):
        plan = self._current_plan()
        if plan is None:
            return
        try:
            rb = check_readback(plan, path)
        except MediaError as exc:
            self.export_result.setText(f"回读失败: {exc}")
            return
        status = "一致" if rb["ok"] else "存在偏差!"
        self.export_result.setText(
            f"已导出 {path}\n"
            f"预计 {rb['expected_duration']:.4f}s/{rb['expected_frames']} 帧 · "
            f"实际 {rb['actual_duration']:.4f}s/{rb['actual_frames']} 帧 · "
            f"音频末端 {rb['audio_duration']:.4f}s · "
            f"偏差 {rb['duration_deviation_frames']:.3f} 帧(限 1 帧) → {status}")
        self.export_result.setStyleSheet(
            "color: green" if rb["ok"] else "color: red")


def main() -> int:
    app = QApplication(sys.argv)
    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
