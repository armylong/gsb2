"""PySide6 桌面界面: 选段、调参、渲染、试听、导出。

启动:  python -m audiostretch.app
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import numpy as np
from PySide6.QtCore import Qt, QUrl, Signal
from PySide6.QtGui import QColor, QPainter, QPainterPath, QPen
from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer
from PySide6.QtWidgets import (QApplication, QDoubleSpinBox, QFileDialog, QFormLayout,
                               QGroupBox, QHBoxLayout, QLabel, QMainWindow, QMessageBox,
                               QPushButton, QSpinBox, QVBoxLayout, QWidget)

from .core import StretchError, stretch
from .synth import make_demo
from .wavio import read_wav, write_wav


class WaveformWidget(QWidget):
    """时间图: 波形 + 选段高亮 + 播放头 + (可选)输出粒子分布条。点击=定位, 拖动=选段。"""

    seekRequested = Signal(float)
    selectionChanged = Signal(float, float)

    def __init__(self, title: str, parent: QWidget | None = None):
        super().__init__(parent)
        self._title = title
        self._sr = 0
        self._mins: np.ndarray | None = None
        self._maxs: np.ndarray | None = None
        self._duration = 0.0
        self._sel: tuple[float, float] | None = None
        self._playhead = -1.0
        self._density: np.ndarray | None = None  # 输出粒子中心时间(秒)
        self._press_x: float | None = None
        self._dragged = False
        self.setMinimumHeight(150)
        self.setMouseTracking(False)

    # ---- 数据 ----
    def set_audio(self, audio: np.ndarray, sr: int):
        self._sr = sr
        self._duration = len(audio) / sr
        mono = audio.mean(axis=1) if audio.ndim == 2 else audio
        cols = 2000
        idx = np.linspace(0, len(mono), cols + 1).astype(int)
        self._mins = np.array([mono[a:b].min() if b > a else 0 for a, b in zip(idx[:-1], idx[1:])])
        self._maxs = np.array([mono[a:b].max() if b > a else 0 for a, b in zip(idx[:-1], idx[1:])])
        self._playhead = -1.0
        self.update()

    def set_density(self, centers: np.ndarray | None, duration: float):
        self._density = centers
        if centers is not None:
            self._duration = duration
        self.update()

    def set_selection(self, a: float, b: float):
        self._sel = (a, b)
        self.update()

    def set_playhead(self, sec: float):
        self._playhead = sec
        self.update()

    # ---- 绘制 ----
    def paintEvent(self, _):
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        w, h = self.width(), self.height()
        p.fillRect(0, 0, w, h, QColor("#1e1e24"))
        p.setPen(QColor("#888"))
        p.drawText(6, 14, self._title)
        if self._mins is None and self._density is None:
            p.end()
            return
        wave_h = h - 34 if self._density is not None else h - 20
        mid_y = 18 + wave_h / 2

        if self._sel and self._duration > 0:
            x0 = self._sel[0] / self._duration * w
            x1 = self._sel[1] / self._duration * w
            p.fillRect(int(x0), 16, max(1, int(x1 - x0)), int(wave_h), QColor(80, 140, 255, 60))

        if self._mins is not None:
            n = len(self._mins)
            p.setPen(QPen(QColor("#7fd4a8"), 1))
            for i in range(n):
                x = i / (n - 1) * w
                p.drawLine(int(x), int(mid_y - self._maxs[i] * wave_h / 2),
                           int(x), int(mid_y - self._mins[i] * wave_h / 2))

        if self._density is not None and self._duration > 0:
            base = h - 14
            p.setPen(QPen(QColor("#e0a040"), 1))
            for c in self._density:
                x = int(c / self._duration * w)
                p.drawLine(x, base, x, base - 10)

        if 0 <= self._playhead <= self._duration and self._duration > 0:
            x = int(self._playhead / self._duration * w)
            p.setPen(QPen(QColor("#ff5f5f"), 2))
            p.drawLine(x, 14, x, h - 4)
        p.end()

    # ---- 交互 ----
    def _sec(self, x: float) -> float:
        return min(max(x / max(self.width(), 1), 0.0), 1.0) * self._duration

    def mousePressEvent(self, e):
        if self._duration > 0:
            self._press_x = e.position().x()
            self._dragged = False

    def mouseMoveEvent(self, e):
        if self._press_x is not None:
            if abs(e.position().x() - self._press_x) > 4:
                self._dragged = True
            if self._dragged:
                a, b = sorted((self._sec(self._press_x), self._sec(e.position().x())))
                self._sel = (a, b)
                self.selectionChanged.emit(a, b)
                self.update()

    def mouseReleaseEvent(self, e):
        if self._press_x is not None and not self._dragged:
            self.seekRequested.emit(self._sec(e.position().x()))
        self._press_x = None


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("环境音粒子拉伸试验台")
        self.resize(980, 720)
        self.audio: np.ndarray | None = None
        self.sr = 44100
        self.src_path: str | None = None
        self.result = None
        self._tmp_result: str | None = None

        # 播放器(原音 / 结果各一个, 点击时间图定位)
        self.player_src = QMediaPlayer(self)
        self.player_out = QMediaPlayer(self)
        for pl in (self.player_src, self.player_out):
            pl.setAudioOutput(QAudioOutput(self))
        self.player_src.positionChanged.connect(
            lambda ms: self.wave_src.set_playhead(ms / 1000.0))
        self.player_out.positionChanged.connect(
            lambda ms: self.wave_out.set_playhead(ms / 1000.0))

        # ---- 控件 ----
        self.btn_open = QPushButton("打开 WAV…")
        self.btn_demo = QPushButton("生成示例音 (220Hz)")
        self.btn_render = QPushButton("渲染")
        self.btn_play_src = QPushButton("▶ 试听原音")
        self.btn_play_out = QPushButton("▶ 试听结果")
        self.btn_export = QPushButton("导出 WAV…")
        self.btn_play_out.setEnabled(False)
        self.btn_export.setEnabled(False)

        self.sp_start = QDoubleSpinBox(maximum=1e6, decimals=3, suffix=" s")
        self.sp_end = QDoubleSpinBox(maximum=1e6, decimals=3, value=2.0, suffix=" s")
        self.sp_grain = QDoubleSpinBox(minimum=1, maximum=2000, value=80.0, suffix=" ms")
        self.sp_overlap = QDoubleSpinBox(minimum=0, maximum=95, value=75.0, suffix=" %")
        self.sp_ratio = QDoubleSpinBox(minimum=0.1, maximum=100, value=8.0)
        self.sp_jitter = QDoubleSpinBox(minimum=0, maximum=500, value=5.0, suffix=" ms")
        self.sp_seed = QSpinBox(minimum=0, maximum=999999, value=0)
        self.sp_export = QDoubleSpinBox(minimum=0.1, maximum=3600, value=12.0, suffix=" s")

        form = QFormLayout()
        form.addRow("选段起 / 止", self._row(self.sp_start, self.sp_end))
        form.addRow("窗口 / 重叠", self._row(self.sp_grain, self.sp_overlap))
        form.addRow("倍率 / 抖动", self._row(self.sp_ratio, self.sp_jitter))
        form.addRow("种子 / 导出时长", self._row(self.sp_seed, self.sp_export))
        box = QGroupBox("参数")
        box.setLayout(form)

        self.status = QLabel("请打开 WAV 或生成示例音")
        self.status.setWordWrap(True)
        self.status.setStyleSheet("color:#c8a040")

        self.wave_src = WaveformWidget("原音 (点击定位试听, 拖动选择选段)")
        self.wave_out = WaveformWidget("输出 (橙线 = 粒子分布)")

        btns = QHBoxLayout()
        for b in (self.btn_open, self.btn_demo, self.btn_render,
                  self.btn_play_src, self.btn_play_out, self.btn_export):
            btns.addWidget(b)

        lay = QVBoxLayout()
        lay.addLayout(btns)
        lay.addWidget(box)
        lay.addWidget(self.wave_src, 1)
        lay.addWidget(self.wave_out, 1)
        lay.addWidget(self.status)
        root = QWidget()
        root.setLayout(lay)
        self.setCentralWidget(root)

        # ---- 信号 ----
        self.btn_open.clicked.connect(self.open_wav)
        self.btn_demo.clicked.connect(self.make_demo)
        self.btn_render.clicked.connect(self.render)
        self.btn_export.clicked.connect(self.export)
        self.btn_play_src.clicked.connect(lambda: self._toggle(self.player_src, self.btn_play_src))
        self.btn_play_out.clicked.connect(lambda: self._toggle(self.player_out, self.btn_play_out))
        self.wave_src.seekRequested.connect(
            lambda s: self.player_src.setPosition(int(s * 1000)))
        self.wave_out.seekRequested.connect(
            lambda s: self.player_out.setPosition(int(s * 1000)))
        self.wave_src.selectionChanged.connect(self._on_sel)

    @staticmethod
    def _row(a, b):
        w = QWidget()
        h = QHBoxLayout(w)
        h.setContentsMargins(0, 0, 0, 0)
        h.addWidget(a)
        h.addWidget(b)
        return w

    # ---- 行为 ----
    def _load(self, audio: np.ndarray, sr: int, path: str | None):
        self.audio, self.sr = audio, sr
        self.result = None
        self.btn_play_out.setEnabled(False)
        self.btn_export.setEnabled(False)
        dur = len(audio) / sr
        self.sp_start.setMaximum(dur)
        self.sp_end.setMaximum(dur)
        self.sp_start.setValue(0.0)
        self.sp_end.setValue(min(2.0, dur))
        self.wave_src.set_audio(audio, sr)
        self.wave_src.set_selection(0.0, min(2.0, dur))
        self.wave_out.set_density(None, 0)
        if path:  # 真实文件直接播; 合成样例先写临时文件
            self.src_path = path
        else:
            self.src_path = str(Path(tempfile.gettempdir()) / "audiostretch_demo.wav")
            write_wav(self.src_path, audio, sr)
        self.player_src.setSource(QUrl.fromLocalFile(self.src_path))
        self.status.setText(
            f"已载入: {dur:.2f}s, {sr}Hz, {audio.shape[1] if audio.ndim == 2 else 1} 声道")

    def open_wav(self):
        path, _ = QFileDialog.getOpenFileName(self, "打开 WAV", "", "WAV (*.wav)")
        if not path:
            return
        try:
            audio, sr = read_wav(path)
        except Exception as e:
            QMessageBox.warning(self, "读取失败", str(e))
            return
        self._load(audio, sr, path)

    def make_demo(self):
        audio, sr = make_demo()
        self._load(audio, sr, None)

    def _on_sel(self, a: float, b: float):
        self.sp_start.blockSignals(True)
        self.sp_end.blockSignals(True)
        self.sp_start.setValue(a)
        self.sp_end.setValue(b)
        self.sp_start.blockSignals(False)
        self.sp_end.blockSignals(False)

    def _params(self):
        return dict(grain_ms=self.sp_grain.value(), overlap=self.sp_overlap.value() / 100.0,
                    ratio=self.sp_ratio.value(), jitter_ms=self.sp_jitter.value(),
                    seed=self.sp_seed.value())

    def render(self) -> bool:
        if self.audio is None:
            self.status.setText("请先载入音频")
            return False
        a, b = self.sp_start.value(), self.sp_end.value()
        try:
            self.result = stretch(self.audio, self.sr, a, b, **self._params())
        except StretchError as e:
            self.status.setText(f"参数限制: {e}")
            return False
        self.wave_src.set_selection(a, b)
        self.wave_out.set_audio(self.result.audio, self.sr)
        self.wave_out.set_density(self.result.out_centers, len(self.result.audio) / self.sr)
        self._tmp_result = str(Path(tempfile.gettempdir()) / "audiostretch_result.wav")
        write_wav(self._tmp_result, self.result.audio, self.sr)
        self.player_out.setSource(QUrl.fromLocalFile(self._tmp_result))
        self.btn_play_out.setEnabled(True)
        self.btn_export.setEnabled(True)
        dur = len(self.result.audio) / self.sr
        self.status.setText(f"渲染完成: {dur:.2f}s, {len(self.result.out_centers)} 个粒子")
        return True

    def export(self):
        if self.audio is None:
            return
        path, _ = QFileDialog.getSaveFileName(self, "导出 WAV", "stretched.wav", "WAV (*.wav)")
        if not path:
            return
        a, b = self.sp_start.value(), self.sp_end.value()
        try:
            res = stretch(self.audio, self.sr, a, b, **self._params(),
                          target_sec=self.sp_export.value())
        except StretchError as e:
            QMessageBox.warning(self, "参数限制", str(e))
            return
        write_wav(path, res.audio, self.sr)
        self.status.setText(f"已导出 {path} ({self.sp_export.value():.2f}s)")

    def _toggle(self, player: QMediaPlayer, btn: QPushButton):
        other = self.player_out if player is self.player_src else self.player_src
        other.stop()
        if player.playbackState() == QMediaPlayer.PlayingState:
            player.stop()
        else:
            player.play()


def main():
    app = QApplication(sys.argv)
    win = MainWindow()
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
