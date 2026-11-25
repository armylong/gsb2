"""试听播放引擎。

QAudioSink 以拉模式从本 QIODevice 读 Int16 单声道数据;
播放区间固定为 (seg0, seg1) 采样下标, 可循环。
切换只听提示/只听背景/混合时, 只替换缓冲数据, 游标采样位置保持不变,
因此三种模式听到的时间位置严格一致。
"""

from __future__ import annotations

import numpy as np
from PySide6.QtCore import QIODevice, QTimer, Signal
from PySide6.QtMultimedia import QAudioFormat, QAudioSink


class SegmentPlayer(QIODevice):
    positionChanged = Signal(float)
    playingChanged = Signal(bool)
    finished = Signal()

    def __init__(self, sr: int, parent=None):
        super().__init__(parent)
        self._sr = sr
        fmt = QAudioFormat()
        fmt.setSampleRate(sr)
        fmt.setChannelCount(1)
        fmt.setSampleFormat(QAudioFormat.SampleFormat.Int16)
        self._sink = QAudioSink(fmt, parent)
        self._sink.setBufferSize(8192)
        self._array = np.zeros(0, dtype="<i2")
        self._pos = 0
        self._seg = (0, 1)
        self._loop = True
        self._playing = False
        self._tick = QTimer(self)
        self._tick.setInterval(50)
        self._tick.timeout.connect(self._emit_position)
        self.open(QIODevice.OpenModeFlag.ReadOnly | QIODevice.OpenModeFlag.Unbuffered)

    # ---- QIODevice 接口 ----
    def isSequential(self) -> bool:  # noqa: N802 (Qt 命名)
        return True

    def readData(self, maxlen: int) -> bytes:  # noqa: N802
        if not self._playing or self._array.size == 0:
            return b""
        n_frames = maxlen // 2
        if n_frames <= 0:
            return b""
        s0, s1 = self._seg
        if s1 <= s0:
            return b""
        pos = self._pos
        if pos < s0 or pos >= s1:
            pos = s0
        parts: list[bytes] = []
        remain = n_frames
        while remain > 0:
            avail = s1 - pos
            take = min(avail, remain)
            parts.append(self._array[pos : pos + take].tobytes())
            remain -= take
            pos += take
            if pos >= s1:
                if self._loop:
                    pos = s0
                else:
                    self._pos = s1
                    QTimer.singleShot(0, self._handle_finished)
                    break
        self._pos = pos
        return b"".join(parts)

    def writeData(self, data) -> int:  # noqa: N802
        return -1

    # ---- 对外控制 ----
    @staticmethod
    def _to_int16(y: np.ndarray) -> np.ndarray:
        peak = float(np.max(np.abs(y))) if y.size else 0.0
        if peak > 0.999:  # 软限幅, 避免削顶方波
            y = np.tanh(y / peak) * 0.999
        return np.clip(np.round(y * 32768.0), -32768, 32767).astype("<i2")

    def set_mix(self, mono: np.ndarray, seg: tuple[int, int], playing: bool | None = None):
        """替换整条时间轴数据与播放区间; 播放中调用会无缝重启并保留游标。"""
        was = self._playing if playing is None else playing
        if was:
            self._sink.stop()
        self._array = self._to_int16(np.asarray(mono, dtype=np.float64))
        self._seg = seg
        self._pos = int(np.clip(self._pos, seg[0], max(seg[0], seg[1] - 1)))
        if was:
            self._sink.start(self)

    def set_loop(self, loop: bool):
        self._loop = loop

    def play(self):
        if self._array.size == 0:
            return
        if not self._playing:
            # 从头播: 游标回到试听段起点
            self._pos = self._seg[0]
        self._playing = True
        self._sink.start(self)
        self._tick.start()
        self.playingChanged.emit(True)
        self._emit_position()

    def has_audio(self) -> bool:
        return self._array.size > 0 and self._seg[1] > self._seg[0]

    def stop(self):
        if not self._playing:
            return
        self._playing = False
        self._sink.stop()
        self._tick.stop()
        self.playingChanged.emit(False)

    def toggle(self):
        self.stop() if self._playing else self.play()

    def seek_seconds(self, t: float):
        s0, s1 = self._seg
        self._pos = int(np.clip(round(t * self._sr), s0, max(s0, s1 - 1)))
        self._emit_position()

    def position_seconds(self) -> float:
        return self._pos / self._sr

    def is_playing(self) -> bool:
        return self._playing

    def _handle_finished(self):
        self._playing = False
        self._tick.stop()
        self.playingChanged.emit(False)
        self.finished.emit()

    def _emit_position(self):
        self.positionChanged.emit(self._pos / self._sr)
