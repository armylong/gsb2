"""指针附近试听: QAudioSink 拉模式, 只播放给定窗口的样本。

不依赖 QMediaPlayer, 内存里直接喂 PCM, 因此可以精确控制
"从哪个采样开始、播多少采样", 原声和成品共用同一套播放逻辑。
"""

from __future__ import annotations

from typing import Optional

import numpy as np
from PySide6.QtCore import QIODevice, QObject
from PySide6.QtMultimedia import QAudioFormat, QAudioSink


class _WindowDevice(QIODevice):
    """把一段 float64 样本按小端 int16 PCM 字节流喂给 QAudioSink。"""

    def __init__(self, samples: np.ndarray, parent: Optional[QObject] = None):
        super().__init__(parent)
        x = np.asarray(samples, dtype=np.float64)
        if x.ndim == 1:
            x = x[:, None]
        self._channels = x.shape[1]
        q = np.clip(np.round(x * 32767.0), -32768, 32767).astype("<i2")
        self._raw = q.tobytes()
        self._pos = 0
        self.open(QIODevice.OpenModeFlag.ReadOnly)

    def readData(self, maxlen: int) -> bytes:
        data = self._raw[self._pos:self._pos + maxlen]
        self._pos += len(data)
        return data

    def bytesAvailable(self) -> int:
        return len(self._raw) - self._pos

    def atEnd(self) -> bool:
        return self._pos >= len(self._raw)

    def isSequential(self) -> bool:
        return True


class ArrayPlayer(QObject):
    """播放内存里的 numpy 音频片段。"""

    def __init__(self, parent: Optional[QObject] = None):
        super().__init__(parent)
        self._sink: Optional[QAudioSink] = None
        self._device: Optional[_WindowDevice] = None
        self._sample_rate = 0
        self._channels = 1

    def _make_format(self, sample_rate: int, channels: int) -> QAudioFormat:
        fmt = QAudioFormat()
        fmt.setSampleRate(sample_rate)
        fmt.setChannelCount(channels)
        fmt.setSampleFormat(QAudioFormat.SampleFormat.Int16)
        return fmt

    def is_playing(self) -> bool:
        return self._sink is not None

    def play_window(self, samples: np.ndarray, sample_rate: int,
                    channels: int) -> str:
        """播放 samples (形状 (n, channels))。返回空串表示成功, 否则是错误说明。"""
        self.stop()
        fmt = self._make_format(sample_rate, channels)
        sink = QAudioSink(fmt, self)
        dev = _WindowDevice(samples, self)
        self._sink, self._device = sink, dev
        self._sample_rate, self._channels = sample_rate, channels
        sink.start(dev)
        # 没有真实音频设备 (CI/offscreen) 时 QAudioSink 会进入挂起/错误态
        from PySide6.QtMultimedia import QAudio
        if sink.state() == QAudio.State.SuspendedState or sink.error() != QAudio.Error.NoError:
            err = sink.errorString() or "无可用音频输出设备"
            self.stop()
            return err
        return ""

    def stop(self) -> None:
        if self._sink is not None:
            self._sink.stop()
            self._sink.deleteLater()
            self._sink = None
        if self._device is not None:
            self._device.close()
            self._device.deleteLater()
            self._device = None

    def toggle(self, samples: np.ndarray, sample_rate: int, channels: int) -> str:
        if self.is_playing():
            self.stop()
            return ""
        return self.play_window(samples, sample_rate, channels)
