"""基于 QAudioSink 的轻量播放引擎。

- 统一时间指针: 波形视图与频谱视图共用同一个 positionChanged 信号。
- 支持播放任意 [start, end) 段 (预听选区上下文), 到点自动停止。
- 分段写入 + 轮询时长, 避免一次性占用大块内存。
- stop 后不残留任何回调; 重复点击播放不会叠加声音。
"""

from __future__ import annotations

import numpy as np
from PySide6.QtCore import QObject, QTimer, Signal
from PySide6.QtMultimedia import QAudioFormat, QAudioSink


class AudioPlayer(QObject):
    positionChanged = Signal(float)   # 当前播放头, 单位秒 (统一时间参数)
    stateChanged = Signal(bool)       # True=正在播放
    segmentFinished = Signal()
    error = Signal(str)

    CHUNK_FRAMES = 8192

    def __init__(self, parent: QObject | None = None):
        super().__init__(parent)
        self._sink: QAudioSink | None = None
        self._dev = None  # QIODevice, 由 QAudioSink.start() 返回
        self._format: QAudioFormat | None = None
        self._data: np.ndarray | None = None
        self._sr = 0
        self._n_channels = 1
        self._start = 0
        self._end = 0
        self._cursor = 0
        self._poll = QTimer(self)
        self._poll.setInterval(30)
        self._poll.timeout.connect(self._pump)
        self._playing = False

    # ------------------------------------------------------------------
    def _build_format(self, sr: int, n_channels: int) -> QAudioFormat:
        fmt = QAudioFormat()
        fmt.setSampleRate(sr)
        fmt.setChannelCount(n_channels)
        fmt.setSampleFormat(QAudioFormat.Float)
        return fmt

    def is_playing(self) -> bool:
        return self._playing

    @property
    def end_time(self) -> float:
        """当前片段结束时间 (秒), 未播放时为 0。"""
        return self._end / self._sr if self._sr else 0.0

    def play_segment(self, audio: np.ndarray, sr: int,
                     start_sample: int, end_sample: int) -> None:
        """播放 audio[start:end] (多声道按行)。重复调用先停旧的, 不叠加。"""
        self.stop()
        if audio is None or end_sample <= start_sample:
            return
        data2d = audio if audio.ndim == 2 else audio[:, None]
        n, nch = data2d.shape
        start_sample = max(0, min(start_sample, n))
        end_sample = max(start_sample, min(end_sample, n))
        self._data = np.ascontiguousarray(data2d, dtype=np.float32)
        self._sr = sr
        self._n_channels = nch
        self._start = start_sample
        self._end = end_sample
        self._cursor = start_sample

        self._format = self._build_format(sr, nch)
        self._sink = QAudioSink(self._format, self)
        self._dev = self._sink.start()
        if self._dev is None:
            self._sink.deleteLater()
            self._sink = None
            self._playing = False
            self.error.emit(
                "无法启动音频输出设备 (当前采样率/格式可能不被支持)。")
            return
        self._playing = True
        self.stateChanged.emit(True)
        self.positionChanged.emit(start_sample / sr)
        self._poll.start()
        self._pump()

    def stop(self) -> None:
        self._poll.stop()
        was_playing = self._playing
        if self._sink is not None:
            self._sink.stop()
            self._sink.deleteLater()
            self._sink = None
            self._dev = None
        self._playing = False
        if was_playing:
            self.stateChanged.emit(False)

    # ------------------------------------------------------------------
    def _pump(self) -> None:
        if self._sink is None or self._dev is None:
            return
        bytes_per_frame = 4 * self._n_channels
        free = self._sink.bytesFree()
        frames_can_write = min(
            self.CHUNK_FRAMES, free // bytes_per_frame, self._end - self._cursor
        )
        if frames_can_write > 0:
            block = self._data[self._cursor:self._cursor + frames_can_write]
            self._dev.write(block.tobytes())
            self._cursor += frames_can_write
            self.positionChanged.emit(self._cursor / self._sr)
        # 数据已全部写入, 且设备已播放完整个片段 -> 结束
        total_us = int((self._end - self._start) / self._sr * 1_000_000)
        if self._cursor >= self._end and self._sink.processedUSecs() >= total_us:
            self._finish()

    def _finish(self) -> None:
        end_time = self._end / self._sr
        self.stop()
        self.positionChanged.emit(end_time)
        self.segmentFinished.emit()
