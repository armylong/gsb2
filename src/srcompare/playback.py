# -*- coding: utf-8 -*-
"""按各路自身采样率播放的回放引擎。

设计要点:
- 每路 Track 用与其数据完全一致的 QAudioFormat(自身采样率/声道数/PCM16)
  创建独立 QAudioSink, 不做任何预先重采样; 播放什么就测量什么。
- 统一定位: 所有播放/切换都经过 set_position(秒), 三路共用同一时间坐标,
  切换版本时从同一时刻继续, 不会播错版本。
- 循环区间在引擎内按字节位置实现。
- 注意: 音频设备/操作系统若不支持该采样率, 会在设备内部再转换, 那属于
  回放链路, 不能当作导出质量的测量依据; 质量结论以文件/内存频谱测量为准。
"""
from __future__ import annotations

import numpy as np
from PySide6.QtCore import QIODevice, QObject, Qt, QTimer, Signal
from PySide6.QtMultimedia import QAudioFormat, QAudioSink, QMediaDevices

PUSH_INTERVAL_MS = 20


class AudioPlayer(QObject):
    positionChanged = Signal(float)   # 当前位置(秒)
    stateChanged = Signal(str)        # playing | stopped

    def __init__(self, parent=None):
        super().__init__(parent)
        self._sink: QAudioSink | None = None
        self._dev: QIODevice | None = None
        self._pcm: bytes = b""
        self._pos = 0                  # 字节位置
        self._sr = 0
        self._channels = 1
        self._loop_a: float | None = None
        self._loop_b: float | None = None
        self._current_name = ""
        self.timer = QTimer(self)
        self.timer.setTimerType(Qt.TimerType.PreciseTimer)
        self.timer.setInterval(PUSH_INTERVAL_MS)
        self.timer.timeout.connect(self._push)

    # ------------------------------------------------------------------ #
    @staticmethod
    def _to_pcm16(samples: np.ndarray) -> bytes:
        x = np.clip(samples.astype(np.float32), -1.0, 1.0)
        return np.round(x * 32768.0).astype("<i2").tobytes()

    def _bytes_per_frame(self) -> int:
        return 2 * self._channels

    def _seconds_to_bytes(self, sec: float) -> int:
        b = int(round(sec * self._sr)) * self._bytes_per_frame()
        return max(0, min(b, len(self._pcm)))

    def _bytes_to_seconds(self, b: int) -> float:
        return b / float(self._sr * self._bytes_per_frame())

    # ------------------------------------------------------------------ #
    def stop(self) -> None:
        self.timer.stop()
        if self._sink is not None:
            self._sink.stop()
            self._sink.deleteLater()
            self._sink = None
        self._dev = None
        self.stateChanged.emit("stopped")

    def set_track(self, track) -> None:
        """切换到另一路(同一时间位置会在 play 时按时间重新映射)。"""
        sec = self.position() if self._sr else 0.0
        was_playing = self.is_playing()
        self.stop()
        self._current_name = track.name
        self._sr = int(track.sr)
        self._channels = int(track.channels)
        self._pcm = self._to_pcm16(track.samples)
        self.set_position(min(sec, track.duration))
        if was_playing:
            self.play()

    def play(self) -> None:
        if not self._pcm or self._sink is not None:
            if self._sink is not None:
                self._sink.resume()
                self.timer.start()
                self.stateChanged.emit("playing")
            return
        fmt = self._make_format_obj()
        device = QMediaDevices.defaultAudioOutput()
        self._sink = QAudioSink(device, fmt, self)
        self._sink.setBufferSize(
            max(2048, int(self._sr * self._channels * 2 * 0.1))
        )
        self._dev = self._sink.start()
        self.timer.start()
        self.stateChanged.emit("playing")

    def _make_format_obj(self) -> QAudioFormat:
        fmt = QAudioFormat()
        fmt.setSampleRate(self._sr)
        fmt.setChannelCount(self._channels)
        fmt.setSampleFormat(QAudioFormat.SampleFormat.Int16)
        return fmt

    def pause(self) -> None:
        if self._sink is not None:
            self._sink.suspend()
            self.timer.stop()
            self.stateChanged.emit("stopped")

    def is_playing(self) -> bool:
        return self._sink is not None and self.timer.isActive()

    def _push(self) -> None:
        if self._dev is None or self._sink is None:
            return
        free = self._sink.bytesFree()
        if free <= 0:
            return
        end = len(self._pcm)
        # 循环区间终点
        if self._loop_b is not None:
            end = min(end, self._seconds_to_bytes(self._loop_b))
        n = min(free, end - self._pos)
        if n > 0:
            self._dev.write(self._pcm[self._pos : self._pos + n])
            self._pos += n
        # 到循环终点或文件尾
        at_loop_end = self._loop_b is not None and self._pos >= self._seconds_to_bytes(self._loop_b)
        if at_loop_end and self._loop_a is not None:
            self._pos = self._seconds_to_bytes(self._loop_a)
        elif self._pos >= len(self._pcm):
            self.stop()
            return
        self.positionChanged.emit(self.position())

    # ------------------------------------------------------------------ #
    def position(self) -> float:
        if not self._sr:
            return 0.0
        return self._bytes_to_seconds(self._pos)

    def duration(self) -> float:
        if not self._sr:
            return 0.0
        return self._bytes_to_seconds(len(self._pcm))

    def set_position(self, sec: float) -> None:
        """统一时间定位(秒), 对当前载入的任意采样率都映射到对应字节。"""
        if not self._sr:
            return
        self._pos = self._seconds_to_bytes(float(sec))
        self.positionChanged.emit(self.position())

    def set_loop(self, a: float | None, b: float | None) -> None:
        self._loop_a, self._loop_b = a, b

    @property
    def current_name(self) -> str:
        return self._current_name
