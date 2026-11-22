"""sounddevice 播放封装: 支持左/右/混合三种监听与位置查询。"""

from __future__ import annotations

import numpy as np
import sounddevice as sd
from PySide6.QtCore import QObject, QTimer, Signal

from .audio import AudioData


def _to_stereo(samples: np.ndarray, view: str) -> np.ndarray:
    """生成实际送声卡的双声道数据。

    L/R 单听: 该声道内容复制到两耳 (双单声道), 方便耳机核对;
    混合: 原始立体声直接播放。单声道输入任意 view 都得到双单声道。
    """
    if samples.ndim == 1:
        return np.repeat(samples[:, None], 2, axis=1).astype(np.float32)
    if view == "L":
        x = samples[:, 0]
        return np.repeat(x[:, None], 2, axis=1).astype(np.float32)
    if view == "R":
        x = samples[:, 1]
        return np.repeat(x[:, None], 2, axis=1).astype(np.float32)
    return np.ascontiguousarray(samples, dtype=np.float32)


class AudioPlayer(QObject):
    positionChanged = Signal(float)
    started = Signal()
    stopped = Signal()
    finished = Signal()

    def __init__(self) -> None:
        super().__init__()
        self._stream: sd.OutputStream | None = None
        self._buffer: np.ndarray | None = None
        self._sr = 0
        self._pos = 0
        self._timer = QTimer(self)
        self._timer.setInterval(50)
        self._timer.timeout.connect(self._tick)

    @property
    def is_playing(self) -> bool:
        return self._stream is not None and self._stream.active

    def position(self) -> float:
        if self._sr == 0:
            return 0.0
        return self._pos / self._sr

    def play(self, audio: AudioData, view: str, start_s: float = 0.0) -> None:
        self.stop()
        data = _to_stereo(audio.samples, view)
        self._buffer = data
        self._sr = audio.sr
        self._pos = int(np.clip(start_s, 0.0, audio.duration - 1e-4) * self._sr)

        def callback(outdata, frames, _time_info, _status):
            available = len(self._buffer) - self._pos
            n = min(frames, max(available, 0))
            if n > 0:
                outdata[:n] = self._buffer[self._pos : self._pos + n]
                self._pos += n
            if n < frames:
                outdata[n:] = 0.0

        self._stream = sd.OutputStream(
            samplerate=self._sr, channels=2, dtype="float32", callback=callback
        )
        self._stream.start()
        self._timer.start()
        self.started.emit()

    def stop(self) -> None:
        if self._stream is not None:
            try:
                self._stream.stop()
                self._stream.close()
            except Exception:
                pass
            self._stream = None
        self._timer.stop()
        self.stopped.emit()

    def _tick(self) -> None:
        if self._buffer is None or self._sr == 0:
            return
        self.positionChanged.emit(self.position())
        if self._pos >= len(self._buffer):
            self.stop()
            self.finished.emit()
