"""本地播放: 用 QtMultimedia 的 QAudioSink 直接播 PCM, 不依赖任何外部播放器.

只播内存里的单声道 float 数据, 支持整段和选区两种播法. 没有可用输出设备时
只把状态标出来, 不影响识别和导出.
"""

from __future__ import annotations

import numpy as np
from PySide6.QtCore import QBuffer, QByteArray, QIODevice, QObject, QTimer, Signal
from PySide6.QtMultimedia import QAudio, QAudioFormat, QAudioSink, QMediaDevices


def _to_pcm16(samples: np.ndarray) -> QByteArray:
    arr = np.asarray(samples, dtype=np.float64)
    if arr.ndim > 1:
        arr = arr.mean(axis=1)
    peak = float(np.max(np.abs(arr))) if arr.size else 0.0
    if peak > 1.0:
        arr = arr / peak
    pcm = np.clip(np.round(arr * 32767.0), -32768, 32767).astype("<i2")
    return QByteArray(pcm.tobytes())


def output_available() -> bool:
    try:
        return not QMediaDevices.defaultAudioOutput().isNull()
    except Exception:  # pragma: no cover - 取决于运行环境
        return False


class AudioPlayer(QObject):
    """把一段内存里的音频播到系统默认输出, 并把播放状态回报给界面."""

    finished = Signal()
    stateChanged = Signal(str)

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._sink: QAudioSink | None = None
        self._buffer: QBuffer | None = None
        self._data: QByteArray | None = None
        self._sample_rate = 44100
        self._total_bytes = 0
        self._available = output_available()
        self._poll = QTimer(self)
        self._poll.setInterval(80)
        self._poll.timeout.connect(self._check_progress)
        if not self._available:
            self.stateChanged.emit("没有可用的音频输出设备, 实听功能不可用")

    @property
    def available(self) -> bool:
        return self._available

    @property
    def is_playing(self) -> bool:
        return self._sink is not None and self._sink.state() == QAudio.State.ActiveState

    def play(self, samples: np.ndarray, sample_rate: int) -> bool:
        if not self._available:
            return False
        self.stop()
        if len(samples) == 0:
            return False
        fmt = QAudioFormat()
        fmt.setSampleRate(int(sample_rate))
        fmt.setChannelCount(1)
        fmt.setSampleFormat(QAudioFormat.SampleFormat.Int16)
        device = QMediaDevices.defaultAudioOutput()
        if not device.isFormatSupported(fmt):
            # 退到 44100 再试, 大多数设备都支持
            fmt.setSampleRate(44100)
            if not device.isFormatSupported(fmt):
                self.stateChanged.emit("当前输出设备不支持该采样率")
                return False
        self._data = _to_pcm16(samples)
        self._total_bytes = self._data.size()
        self._buffer = QBuffer(self)
        self._buffer.setData(self._data)
        self._buffer.open(QIODevice.OpenModeFlag.ReadOnly)
        self._sink = QAudioSink(device, fmt, self)
        self._sample_rate = fmt.sampleRate()
        self._sink.start(self._buffer)
        self._poll.start()
        self.stateChanged.emit("播放中")
        return True

    def stop(self) -> None:
        self._poll.stop()
        if self._sink is not None:
            try:
                self._sink.stop()
            except RuntimeError:
                pass
            self._sink.deleteLater()
            self._sink = None
        if self._buffer is not None:
            self._buffer.close()
            self._buffer.deleteLater()
            self._buffer = None
        self._data = None
        self._total_bytes = 0

    def position_s(self) -> float:
        if self._sink is None:
            return 0.0
        processed = self._sink.processedUSecs()
        if processed <= 0:
            return 0.0
        return min(processed / 1e6, self._total_seconds())

    def _total_seconds(self) -> float:
        if self._sample_rate <= 0:
            return 0.0
        return (self._total_bytes / 2.0) / self._sample_rate

    def _check_progress(self) -> None:
        if self._sink is None:
            self._poll.stop()
            return
        state = self._sink.state()
        processed = self._sink.processedUSecs()
        total_s = self._total_seconds()
        if state == QAudio.State.StoppedState or (
            total_s > 0 and processed >= total_s * 1e6 * 0.98
        ) or (state == QAudio.State.IdleState and processed >= total_s * 1e6 * 0.9):
            self.stop()
            self.stateChanged.emit("播放结束")
            self.finished.emit()
