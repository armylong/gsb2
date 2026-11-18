"""PySide6 图形界面: 短片选段画面+声音倒放工具."""

from __future__ import annotations

import sys
import tempfile
import wave
from pathlib import Path

import numpy as np
from PySide6.QtCore import Qt, QTimer, QUrl
from PySide6.QtGui import QImage, QPixmap
from PySide6.QtMultimedia import QSoundEffect
from PySide6.QtWidgets import (
    QApplication,
    QComboBox,
    QFileDialog,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QSlider,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)

from .core import FrameRange, audio_sample_bounds, reverse_audio_segment, video_frame_mapping
from .media import Media, export_media, load_media
from .sample import generate_sample


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("选段倒放工具")
        self.media: Media | None = None
        self.mapping: list[int] = []
        self.cur = 0
        self.playing = False
        self._result_audio: np.ndarray | None = None
        self._result_audio_key: tuple[int, int] | None = None

        self.timer = QTimer(self)
        self.timer.timeout.connect(self._on_tick)
        self.player = QSoundEffect(self)

        root = QWidget()
        self.setCentralWidget(root)
        layout = QVBoxLayout(root)

        # --- 顶部: 打开 / 样例 / 文件信息 ---
        top = QHBoxLayout()
        btn_open = QPushButton("导入 mp4…")
        btn_open.clicked.connect(self.open_file)
        btn_sample = QPushButton("生成并打开样例")
        btn_sample.clicked.connect(self.open_sample)
        top.addWidget(btn_open)
        top.addWidget(btn_sample)
        top.addStretch(1)
        layout.addLayout(top)

        self.info = QLabel("未导入文件")
        self.info.setStyleSheet("font-family: Menlo, monospace;")
        layout.addWidget(self.info)

        # --- 画面 ---
        self.video_label = QLabel("画面")
        self.video_label.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.video_label.setMinimumSize(640, 360)
        self.video_label.setStyleSheet("background: #111; color: #888;")
        layout.addWidget(self.video_label, stretch=1)

        self.frame_info = QLabel("")
        self.frame_info.setStyleSheet("font-family: Menlo, monospace;")
        layout.addWidget(self.frame_info)

        # --- 播放控制 ---
        ctrl = QHBoxLayout()
        self.version = QComboBox()
        self.version.addItems(["原片", "结果(倒放后)"])
        self.version.currentIndexChanged.connect(self.refresh_frame)
        ctrl.addWidget(QLabel("版本:"))
        ctrl.addWidget(self.version)
        self.btn_play = QPushButton("播放")
        self.btn_play.clicked.connect(self.toggle_play)
        ctrl.addWidget(self.btn_play)
        btn_prev = QPushButton("◀ 上一帧")
        btn_prev.clicked.connect(lambda: self.step(-1))
        ctrl.addWidget(btn_prev)
        btn_next = QPushButton("下一帧 ▶")
        btn_next.clicked.connect(lambda: self.step(1))
        ctrl.addWidget(btn_next)
        self.btn_audition = QPushButton("试听当前位置 ±1s")
        self.btn_audition.clicked.connect(self.audition)
        ctrl.addWidget(self.btn_audition)
        ctrl.addStretch(1)
        layout.addLayout(ctrl)

        self.slider = QSlider(Qt.Orientation.Horizontal)
        self.slider.valueChanged.connect(self.seek)
        layout.addWidget(self.slider)

        # --- 区间设置 ---
        rng = QHBoxLayout()
        rng.addWidget(QLabel("倒放区间 [起点, 终点):"))
        self.spin_start = QSpinBox()
        self.spin_end = QSpinBox()
        self.spin_start.valueChanged.connect(self.on_range_changed)
        self.spin_end.valueChanged.connect(self.on_range_changed)
        rng.addWidget(self.spin_start)
        rng.addWidget(self.spin_end)
        btn_set_start = QPushButton("当前帧→起点")
        btn_set_start.clicked.connect(lambda: self.spin_start.setValue(self.cur))
        btn_set_end = QPushButton("当前帧→终点")
        btn_set_end.clicked.connect(lambda: self.spin_end.setValue(self.cur))
        rng.addWidget(btn_set_start)
        rng.addWidget(btn_set_end)
        rng.addStretch(1)
        layout.addLayout(rng)

        self.range_info = QLabel("")
        self.range_info.setStyleSheet("font-family: Menlo, monospace;")
        self.range_info.setWordWrap(True)
        layout.addWidget(self.range_info)

        # --- 导出 ---
        bottom = QHBoxLayout()
        btn_export = QPushButton("导出 mp4…")
        btn_export.clicked.connect(self.export)
        bottom.addWidget(btn_export)
        self.status = QLabel("")
        bottom.addWidget(self.status, stretch=1)
        layout.addLayout(bottom)

        self._update_enabled()

    # ---------- 文件 ----------

    def open_file(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "导入 mp4", "", "MP4 (*.mp4)")
        if path:
            self.load(path)

    def open_sample(self) -> None:
        path = Path(tempfile.gettempdir()) / "reverse_tool_sample.mp4"
        try:
            generate_sample(path)
        except Exception as e:  # noqa: BLE001
            QMessageBox.critical(self, "样例生成失败", str(e))
            return
        self.load(str(path))

    def load(self, path: str) -> None:
        try:
            media = load_media(path)
        except Exception as e:  # noqa: BLE001
            QMessageBox.warning(self, "无法导入", str(e))
            return
        self.stop_play()
        self.media = media
        self.cur = 0
        self._result_audio = None
        self._result_audio_key = None

        n = media.n_frames
        self.slider.setRange(0, n - 1)
        for spin in (self.spin_start, self.spin_end):
            spin.blockSignals(True)
            spin.setRange(0, n)
        self.spin_start.setValue(0)
        self.spin_end.setValue(n)
        for spin in (self.spin_start, self.spin_end):
            spin.blockSignals(False)

        fps = float(media.fps)
        audio_desc = (
            f"音频: {media.sample_rate} Hz × {media.n_channels} 声道, "
            f"{media.audio.shape[1]} 采样点"
            if media.has_audio
            else "音频: 无音轨(不添加声音)"
        )
        self.info.setText(
            f"{media.path.name} | {media.frames[0].shape[1]}x{media.frames[0].shape[0]} | "
            f"{media.fps} fps | {n} 帧 | 总时长 {media.duration:.3f}s | {audio_desc}"
        )
        self.on_range_changed()
        self._update_enabled()
        self.status.setText("已导入")

    # ---------- 区间 ----------

    def current_range(self) -> FrameRange | None:
        if self.media is None:
            return None
        rng = FrameRange(self.spin_start.value(), self.spin_end.value())
        try:
            rng.validate(self.media.n_frames)
        except ValueError:
            return None
        return rng

    def on_range_changed(self) -> None:
        if self.media is None:
            return
        m = self.media
        n = m.n_frames
        f0, f1 = self.spin_start.value(), self.spin_end.value()
        lines = []
        try:
            rng = FrameRange(f0, f1)
            rng.validate(n)
        except ValueError as e:
            self.range_info.setText(f"区间无效: {e}")
            self.mapping = list(range(n))
            self.refresh_frame()
            return

        t0 = m.frame_times[f0]
        t1 = m.frame_times[f1 - 1] + float(1 / m.fps)  # 终点=最后一帧之后的片尾位置
        lines.append(
            f"吸附后区间: 帧 [{f0}, {f1}) 共 {f1 - f0} 帧 | "
            f"时间 [{t0:.3f}s, {t1:.3f}s) (起点含, 终点不含)"
        )
        if m.has_audio:
            ab = audio_sample_bounds(rng, m.fps, m.sample_rate, m.audio.shape[1])
            lines.append(
                f"音频采样边界: [{ab.s0}, {ab.s1}) / {ab.total_samples} @ {ab.sample_rate} Hz | "
                f"舍入差 起点 {ab.err0:+.3f} / 终点 {ab.err1:+.3f} 采样点"
            )
        else:
            lines.append("无音轨, 仅反转画面")
        self.range_info.setText("\n".join(lines))
        self.mapping = video_frame_mapping(n, rng)
        self._result_audio = None
        self._result_audio_key = None
        self.refresh_frame()

    # ---------- 预览 ----------

    def _frame_for_display(self) -> np.ndarray:
        idx = self.cur
        if self.version.currentIndex() == 1 and self.mapping:
            idx = self.mapping[self.cur]
        return self.media.frames[idx]

    def refresh_frame(self) -> None:
        if self.media is None:
            return
        m = self.media
        self.cur = max(0, min(self.cur, m.n_frames - 1))
        arr = np.ascontiguousarray(self._frame_for_display())
        h, w, _ = arr.shape
        img = QImage(arr.data, w, h, 3 * w, QImage.Format.Format_RGB888).copy()
        pix = QPixmap.fromImage(img).scaled(
            self.video_label.size(),
            Qt.AspectRatioMode.KeepAspectRatio,
            Qt.TransformationMode.SmoothTransformation,
        )
        self.video_label.setPixmap(pix)

        src_idx = self.mapping[self.cur] if self.mapping else self.cur
        t_out = m.frame_times[self.cur]
        t_src = m.frame_times[src_idx]
        ver = "结果" if self.version.currentIndex() == 1 else "原片"
        self.frame_info.setText(
            f"[{ver}] 输出帧 {self.cur}/{m.n_frames - 1}  t={t_out:.3f}s  ←  原帧 {src_idx} (t={t_src:.3f}s)"
        )
        self.slider.blockSignals(True)
        self.slider.setValue(self.cur)
        self.slider.blockSignals(False)

    def resizeEvent(self, event) -> None:  # noqa: N802
        super().resizeEvent(event)
        self.refresh_frame()

    # ---------- 播放 ----------

    def toggle_play(self) -> None:
        if self.playing:
            self.stop_play()
        else:
            if self.media is None:
                return
            self.playing = True
            self.btn_play.setText("暂停")
            self.timer.start(int(round(1000 / float(self.media.fps))))

    def stop_play(self) -> None:
        self.playing = False
        self.timer.stop()
        self.btn_play.setText("播放")

    def _on_tick(self) -> None:
        if self.media is None:
            return
        if self.cur >= self.media.n_frames - 1:
            self.stop_play()
            return
        self.cur += 1
        self.refresh_frame()

    def step(self, delta: int) -> None:
        if self.media is None:
            return
        self.stop_play()
        self.cur = max(0, min(self.cur + delta, self.media.n_frames - 1))
        self.refresh_frame()

    def seek(self, value: int) -> None:
        if self.media is None:
            return
        self.cur = value
        self.refresh_frame()

    # ---------- 试听 ----------

    def _audio_for_version(self) -> np.ndarray | None:
        m = self.media
        if m is None or not m.has_audio:
            return None
        if self.version.currentIndex() == 0:
            return m.audio
        rng = self.current_range()
        if rng is None:
            return m.audio
        key = (rng.f0, rng.f1)
        if self._result_audio is None or self._result_audio_key != key:
            ab = audio_sample_bounds(rng, m.fps, m.sample_rate, m.audio.shape[1])
            self._result_audio = reverse_audio_segment(m.audio, ab.s0, ab.s1)
            self._result_audio_key = key
        return self._result_audio

    def audition(self) -> None:
        m = self.media
        if m is None or not m.has_audio:
            self.status.setText("无音轨, 无法试听")
            return
        audio = self._audio_for_version()
        sr = m.sample_rate
        center = int(round(m.frame_times[self.cur] * sr))
        half = int(1.0 * sr)
        s0 = max(0, center - half)
        s1 = min(audio.shape[1], center + half)
        seg = audio[:, s0:s1]
        pcm = np.clip(seg.T * 32767, -32768, 32768).astype(np.int16)
        tmp = Path(tempfile.gettempdir()) / "reverse_tool_audition.wav"
        with wave.open(str(tmp), "wb") as wf:
            wf.setnchannels(m.n_channels)
            wf.setsampwidth(2)
            wf.setframerate(sr)
            wf.writeframes(pcm.tobytes())
        self.player.setSource(QUrl.fromLocalFile(str(tmp)))
        self.player.play()
        ver = "结果" if self.version.currentIndex() == 1 else "原片"
        self.status.setText(
            f"试听[{ver}] 采样 [{s0}, {s1}) ≈ {s0 / sr:.3f}s–{s1 / sr:.3f}s"
        )

    # ---------- 导出 ----------

    def export(self) -> None:
        m = self.media
        if m is None:
            return
        rng = self.current_range()
        if rng is None:
            QMessageBox.warning(self, "区间无效", "请先设置合法的倒放区间(至少两帧)")
            return
        out, _ = QFileDialog.getSaveFileName(self, "导出 mp4", "reversed.mp4", "MP4 (*.mp4)")
        if not out:
            return
        mapping = video_frame_mapping(m.n_frames, rng)
        frames = [m.frames[i] for i in mapping]
        audio = None
        if m.has_audio:
            ab = audio_sample_bounds(rng, m.fps, m.sample_rate, m.audio.shape[1])
            audio = reverse_audio_segment(m.audio, ab.s0, ab.s1)
        try:
            self.status.setText("导出中…")
            QApplication.processEvents()
            export_media(out, frames, m.fps, audio, m.sample_rate)
        except Exception as e:  # noqa: BLE001
            QMessageBox.critical(self, "导出失败", str(e))
            self.status.setText("导出失败")
            return
        self.status.setText(f"已导出: {out}")

    # ---------- 杂项 ----------

    def _update_enabled(self) -> None:
        enabled = self.media is not None
        for w in (
            self.btn_play,
            self.btn_audition,
            self.slider,
            self.spin_start,
            self.spin_end,
            self.version,
        ):
            w.setEnabled(enabled)


def main() -> int:
    app = QApplication(sys.argv)
    win = MainWindow()
    win.resize(960, 720)
    win.show()
    if len(sys.argv) > 1:
        win.load(sys.argv[1])
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
