"""QAudioSink 播放: float64 信号转 int16 PCM, 单实例串行播放。"""
from __future__ import annotations

import numpy as np
from PySide6.QtCore import QIODevice
from PySide6.QtMultimedia import QAudioFormat, QAudioSink
from PySide6.QtMultimedia import QMediaDevices


class Player:
    def __init__(self):
        self._sink: QAudioSink | None = None
        self._io: QIODevice | None = None

    @staticmethod
    def _format(sr: int) -> QAudioFormat:
        fmt = QAudioFormat()
        fmt.setSampleRate(int(sr))
        fmt.setChannelCount(1)
        fmt.setSampleFormat(QAudioFormat.Int16)
        return fmt

    def play(self, x: np.ndarray, sr: int):
        self.stop()
        fmt = self._format(sr)
        if not QMediaDevices.defaultAudioOutput():
            raise RuntimeError("找不到音频输出设备")
        self._sink = QAudioSink(QMediaDevices.defaultAudioOutput(), fmt)
        pcm = np.clip(x, -1.0, 1.0)
        data = (pcm * 32767.0).astype("<i2").tobytes()
        self._io = self._sink.start()
        if self._io is None:
            raise RuntimeError("音频设备启动失败")
        self._io.write(data)
        # 写完后设备继续排空缓冲; stop() 或下次 play() 会收尾。
        self._sink.stateChanged.connect(self._on_state)

    def _on_state(self, state):
        if state == QAudioSink.StoppedState:
            self._cleanup()

    def stop(self):
        if self._sink is not None:
            try:
                self._sink.stop()
            except RuntimeError:
                pass
        self._cleanup()

    def _cleanup(self):
        if self._io is not None:
            try:
                self._io.close()
            except RuntimeError:
                pass
        self._io = None
        self._sink = None

    @property
    def playing(self) -> bool:
        return self._sink is not None
