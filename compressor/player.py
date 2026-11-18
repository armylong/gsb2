"""本地试听播放（sounddevice 输出流，支持区间与循环）。"""

from __future__ import annotations

import numpy as np
import sounddevice as sd
from PySide6.QtCore import QObject, QTimer, Signal


class AudioPlayer(QObject):
    positionChanged = Signal(float)  # 当前播放位置（秒）
    playbackStateChanged = Signal(bool)  # True=播放中

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._stream: sd.OutputStream | None = None
        self._data: np.ndarray | None = None
        self._fs: int = 48000
        self._start = 0
        self._end = 0
        self._pos = 0
        self._loop = False
        self._timer = QTimer(self)
        self._timer.setInterval(50)
        self._timer.timeout.connect(self._poll)

    # ---- 状态 ----
    def is_playing(self) -> bool:
        return self._stream is not None and self._stream.active

    def position(self) -> float:
        if self._data is None:
            return 0.0
        return self._pos / self._fs

    def _poll(self) -> None:
        if self._stream is not None and self._stream.active:
            self.positionChanged.emit(self.position())
        else:
            # 非循环播完或流已停
            self.stop()

    # ---- 控制 ----
    def play(self, data: np.ndarray, fs: int, start_s: float = 0.0,
             end_s: float | None = None, loop: bool = False) -> None:
        self.stop()
        data = np.asarray(data, dtype="float32")
        n = data.shape[0]
        self._data = data
        self._fs = fs
        self._start = int(np.clip(round(start_s * fs), 0, max(n - 1, 0)))
        if end_s is None:
            self._end = n
        else:
            self._end = int(np.clip(round(end_s * fs), self._start + 1, n))
        self._pos = self._start
        self._loop = loop

        channels = 1 if data.ndim == 1 else data.shape[1]
        self._stream = sd.OutputStream(
            samplerate=fs, channels=channels, dtype="float32",
            callback=self._callback)
        self._stream.start()
        self._timer.start()
        self.playbackStateChanged.emit(True)

    def stop(self) -> None:
        was = self.is_playing()
        if self._stream is not None:
            try:
                self._stream.stop()
                self._stream.close()
            except Exception:
                pass
            self._stream = None
        self._timer.stop()
        if was:
            self.playbackStateChanged.emit(False)

    def _callback(self, outdata: np.ndarray, frames: int,
                  time_info, status) -> None:  # noqa: ARG002
        del time_info, status
        buf = np.zeros_like(outdata)
        remaining = self._end - self._pos
        if remaining <= 0:
            if self._loop:
                self._pos = self._start
                remaining = self._end - self._pos
            else:
                outdata[:] = buf
                raise sd.CallbackStop
        take = min(frames, remaining)
        chunk = self._data[self._pos:self._pos + take]
        if chunk.ndim == 1:
            buf[:take, 0] = chunk
        else:
            buf[:take, :] = chunk
        self._pos += take
        if take < frames and self._loop:
            # 跨过区间尾部：回到起点继续填满缓冲
            self._pos = self._start
            rest = frames - take
            chunk2 = self._data[self._start:self._start + rest]
            if chunk2.ndim == 1:
                buf[take:take + chunk2.shape[0], 0] = chunk2
            else:
                buf[take:take + chunk2.shape[0], :] = chunk2
            self._pos = self._start + chunk2.shape[0]
        outdata[:] = buf
        if self._pos >= self._end and not self._loop:
            raise sd.CallbackStop
