"""QAudioSink 播放封装：直接播放与导出同源的 int16 PCM。

试听与导出共用 dsp.to_pcm16 的量化结果，因此"听到的幅值"和"写进 wav 的幅值"
是同一份数据，不存在两条渲染路径。
"""
from __future__ import annotations

import numpy as np
from PySide6.QtCore import QBuffer, QByteArray, QIODevice, QObject, Signal
from PySide6.QtMultimedia import QAudioFormat, QAudioSink

from .dsp import to_pcm16


class AudioPlayer(QObject):
    positionChanged = Signal(int)   # 当前播放采样（输出数组坐标）
    stateChanged = Signal(str)      # "stopped" / "playing" / "paused"

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._sink: QAudioSink | None = None
        self._buffer = QBuffer(self)
        self._sr = 48000
        self._channels = 1
        self._data = QByteArray()
        self._poll = None

    # ------------------------------------------------------------------
    def set_audio(self, audio: np.ndarray, sr: int) -> None:
        """载入 float 波形 (N, C)；内部立即转成 int16 PCM（与导出一致）。"""
        was_playing = self.stop()
        pcm = to_pcm16(np.asarray(audio, dtype=np.float64))
        if pcm.ndim == 1:
            pcm = pcm[:, None]
        self._channels = pcm.shape[1]
        self._sr = sr
        self._data = QByteArray(pcm.tobytes())
        if was_playing:
            self.play()

    def _build_sink(self) -> QAudioSink:
        fmt = QAudioFormat()
        fmt.setSampleRate(self._sr)
        fmt.setChannelCount(self._channels)
        fmt.setSampleFormat(QAudioFormat.SampleFormat.Int16)
        sink = QAudioSink(fmt, self)
        sink.setBufferSize(32768)
        return sink

    # ------------------------------------------------------------------
    def play(self, from_sample: int | None = None) -> None:
        if self._data.isEmpty():
            return
        if self._sink is None:
            self._sink = self._build_sink()
        self._buffer.setData(self._data)
        self._buffer.open(QIODevice.OpenModeFlag.ReadOnly)
        byte_pos = 0 if from_sample is None else from_sample * self._channels * 2
        self._buffer.seek(max(0, min(byte_pos, self._buffer.size())))
        self._sink.start(self._buffer)
        self.stateChanged.emit("playing")
        from PySide6.QtCore import QTimer

        if self._poll is None:
            self._poll = QTimer(self)
            self._poll.setInterval(30)
            self._poll.timeout.connect(self._tick)
        self._poll.start()

    def pause(self) -> None:
        if self._sink is not None:
            self._sink.pause()
            self.stateChanged.emit("paused")

    def stop(self) -> bool:
        was_playing = False
        if self._sink is not None:
            was_playing = self._sink.state() != QAudioSink.State.StoppedState
            self._sink.stop()
            self._sink = None
        if self._buffer.isOpen():
            self._buffer.close()
        if self._poll is not None:
            self._poll.stop()
        if was_playing:
            self.stateChanged.emit("stopped")
            self.positionChanged.emit(0)
        return was_playing

    # ------------------------------------------------------------------
    def _tick(self) -> None:
        if self._sink is None:
            return
        if self._sink.state() == QAudioSink.State.StoppedState:
            self.stop()
            return
        pos_bytes = self._buffer.pos()
        sample = pos_bytes // (self._channels * 2)
        self.positionChanged.emit(int(sample))

    @property
    def sample_rate(self) -> int:
        return self._sr
