"""试听：优先用 QtMultimedia 播放内存中的 WAV；没有可用音频设备时降级为静默。

设计上把"可试听"与"可分析"分开：分析永远基于 numpy 波形，
播放失败只影响听觉，不影响检索结果。
"""
from __future__ import annotations

import tempfile
from pathlib import Path

import numpy as np

from .audio import TARGET_SR, write_wav

try:  # pragma: no cover - 仅在无 Qt 环境跳过
    from PySide6.QtCore import QObject, QUrl, Signal
    from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer
except Exception:  # noqa: BLE001
    QObject = None  # type: ignore
    QUrl = None  # type: ignore
    Signal = None  # type: ignore
    QAudioOutput = None  # type: ignore
    QMediaPlayer = None  # type: ignore


class AudioClip(QObject if QObject is not None else object):  # type: ignore[misc]
    """一段可播放的音频；start/stop 以样本下标定位。"""

    if Signal is not None:
        finished = Signal()
        positionChanged = Signal(float)   # 相对片段起点，秒
        failed = Signal(str)
    else:  # pragma: no cover
        finished = None
        positionChanged = None
        failed = None

    def __init__(self, samples: np.ndarray, fs: int = TARGET_SR, parent=None):
        if QObject is not None:
            super().__init__(parent)
        self._fs = fs
        self._samples = np.asarray(samples, dtype=np.float64).copy()
        self._tmpdir = tempfile.TemporaryDirectory(prefix="cuefinder_audio_")
        self._path: Path | None = None
        self._player = None
        self._output = None
        self._origin_sec = 0.0
        self._stop_sec: float | None = None
        self._duration = 0.0
        if QMediaPlayer is not None:
            self._player = QMediaPlayer(self)
            self._output = QAudioOutput(self)
            self._player.setAudioOutput(self._output)
            self._output.setVolume(0.85)
            self._player.positionChanged.connect(self._on_position)
            self._player.errorOccurred.connect(self._on_error)

    @property
    def duration(self) -> float:
        return len(self._samples) / float(self._fs) if self._samples.size else 0.0

    @property
    def samples(self) -> np.ndarray:
        return self._samples

    def _write(self) -> Path | None:
        if self._samples.size == 0:
            return None
        if self._path is None:
            self._path = Path(self._tmpdir.name) / "clip.wav"
            write_wav(self._path, self._samples, self._fs)
        return self._path

    @property
    def available(self) -> bool:
        return self._player is not None and self._output is not None

    def play(self, start_sec: float = 0.0, stop_sec: float | None = None,
             volume: float = 0.85) -> bool:
        if not self.available:
            if self.failed:
                self.failed.emit("当前环境没有可用的音频输出")
            return False
        path = self._write()
        if path is None:
            if self.failed:
                self.failed.emit("片段为空")
            return False
        self._player.stop()
        self._player.setSource(QUrl.fromLocalFile(str(path)))
        self._origin_sec = max(0.0, float(start_sec))
        self._stop_sec = None if stop_sec is None else max(self._origin_sec, float(stop_sec))
        self._duration = (self.duration - self._origin_sec if stop_sec is None
                          else max(0.0, self._stop_sec - self._origin_sec))
        self._output.setVolume(float(volume))
        self._player.setPosition(int(self._origin_sec * 1000))
        self._player.play()
        return True

    def _enforce_stop(self) -> None:
        if self._player is None:
            return
        pos = self._player.position() / 1000.0
        if self._stop_sec is not None and pos >= self._stop_sec:
            self._player.stop()
            if self.finished:
                self.finished.emit()

    def play_window(self, start_sec: float, end_sec: float, pad_sec: float = 0.0,
                    volume: float = 0.85) -> bool:
        a = max(0.0, start_sec - pad_sec)
        b = min(self.duration, end_sec + pad_sec)
        return self.play(a, b, volume)

    def stop(self) -> None:
        if self._player is not None:
            self._player.stop()

    def _on_position(self, pos_ms: int) -> None:
        if self._player is None:
            return
        pos = pos_ms / 1000.0
        if self._stop_sec is not None and pos >= self._stop_sec:
            self._player.stop()
            if self.finished:
                self.finished.emit()
            return
        if self.positionChanged:
            self.positionChanged.emit(max(0.0, pos - self._origin_sec))

    def _on_error(self, error, message: str) -> None:
        if self.failed:
            self.failed.emit(message or str(error))
