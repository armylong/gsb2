"""基于 QAudioSink 的本地试听播放，支持圈选区间回放。"""

from __future__ import annotations

import numpy as np
from PySide6.QtCore import QBuffer, QByteArray, QIODevice, QObject, QTimer, Signal
from PySide6.QtMultimedia import QAudioFormat, QAudioSink


class Player(QObject):
    positionChanged = Signal(float)   # 当前播放位置（秒）
    stateChanged = Signal(bool)       # True=播放中

    def __init__(self, parent=None):
        super().__init__(parent)
        self._fs = 0
        self._buf = QBuffer(self)
        self._sink = None
        self._timer = QTimer(self)
        self._timer.setInterval(30)
        self._timer.timeout.connect(self._tick)
        self._range = (0.0, 0.0)
        self._duration = 0.0

    def set_source(self, x: np.ndarray, fs: int) -> None:
        self.stop()
        self._fs = int(fs)
        pcm = np.clip(x, -1.0, 1.0)
        raw = (pcm * 32767.0).astype("<i2").tobytes()
        self._data = QByteArray(raw)
        if self._buf.isOpen():
            self._buf.close()
        self._buf.setData(self._data)
        self._buf.open(QIODevice.ReadOnly)
        fmt = QAudioFormat()
        fmt.setSampleRate(fs)
        fmt.setChannelCount(1)
        fmt.setSampleFormat(QAudioFormat.SampleFormat.Int16)
        self._sink = QAudioSink(fmt, self)
        self._duration = len(x) / fs
        self._range = (0.0, self._duration)

    def _byte_for_time(self, t: float) -> int:
        return int(round(t * self._fs)) * 2

    def play_range(self, t0: float | None = None, t1: float | None = None) -> None:
        if self._sink is None:
            return
        self.stop()
        if t0 is None or t1 is None:
            t0, t1 = 0.0, self._duration
        t0 = max(0.0, min(t0, self._duration))
        t1 = max(t0, min(t1, self._duration))
        self._range = (t0, t1)
        self._buf.close()
        self._buf.open(QIODevice.ReadOnly)
        self._buf.seek(self._byte_for_time(t0))
        self._sink.start(self._buf)
        self._timer.start()
        self.stateChanged.emit(True)

    def stop(self) -> None:
        if self._sink is not None:
            self._sink.stop()
        self._timer.stop()
        self.stateChanged.emit(False)

    def _tick(self) -> None:
        if self._sink is None:
            return
        pos_bytes = self._buf.pos()
        t = pos_bytes / 2.0 / self._fs if self._fs else 0.0
        self.positionChanged.emit(t)
        if t >= self._range[1] or self._sink.state() == QAudioSink.State.StoppedState:
            self.stop()
