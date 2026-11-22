"""音频播放: QAudioSink 拉模式, 支持原始/校正两轨在同一输入时间轴上对比。

所有 seek、游标都以"输入(文件)时间"为基准, 切换 A/B 时停在同一事件上,
便于听同一个打点/同一段话校正前后的差别。
"""
from __future__ import annotations

import numpy as np
from PySide6.QtCore import QBuffer, QByteArray, QIODevice, QTimer, Signal
from PySide6.QtMultimedia import QAudioFormat, QAudioSink
from PySide6.QtWidgets import QWidget


def _to_pcm16(mono: np.ndarray) -> bytes:
    x = np.clip(np.asarray(mono, dtype=np.float64), -1.0, 1.0)
    return np.round(x * 32767.0).astype("<i2").tobytes()


class AudioPlayer(QWidget):
    """单声道播放器, 内部维护两条可切换音轨(原始/校正)。"""

    positionChanged = Signal(float)   # 当前输入时间位置 (s)
    stateChanged = Signal(str)        # "playing" / "stopped"

    def __init__(self, parent=None):
        super().__init__(parent)
        self._sr = 48000
        self._tracks: dict[str, bytes] = {}
        self._current = ""
        self._buffer = QBuffer(self)
        self._sink: QAudioSink | None = None
        self._io: QIODevice | None = None
        self._pull_timer = QTimer(self)
        self._pull_timer.setInterval(30)
        self._pull_timer.timeout.connect(self._pump)
        self._pos_timer = QTimer(self)
        self._pos_timer.setInterval(50)
        self._pos_timer.timeout.connect(self._emit_position)
        self._notify_end = True

    # --- 音轨管理 ---
    def set_tracks(self, sr: int, original: np.ndarray,
                   corrected: np.ndarray):
        was_playing = self.is_playing()
        self.stop()
        self._sr = int(sr)
        self._tracks = {
            "original": _to_pcm16(original),
            "corrected": _to_pcm16(corrected),
        }
        self._current = "original"
        self._rebuild_sink()
        self._buffer.close()
        self._buffer.setData(QByteArray(self._tracks[self._current]))
        self._buffer.open(QIODevice.ReadOnly)
        if was_playing:
            self.play()

    def _rebuild_sink(self):
        if self._sink is not None:
            self._sink.stop()
            self._sink.deleteLater()
        fmt = QAudioFormat()
        fmt.setSampleRate(self._sr)
        fmt.setChannelCount(1)
        fmt.setSampleFormat(QAudioFormat.Int16)
        self._sink = QAudioSink(fmt, self)
        self._sink.setBufferSize(32768)

    def switch_track(self, key: str):
        """original / corrected; 保持当前输入时间位置不变。"""
        if key not in self._tracks or key == self._current:
            return
        pos = self.position()
        playing = self.is_playing()
        self._stop_devices()
        self._current = key
        self._buffer.close()
        self._buffer.setData(QByteArray(self._tracks[key]))
        self._buffer.open(QIODevice.ReadOnly)
        self._buffer.seek(int(pos * self._sr) * 2)
        if playing:
            self.play()
        else:
            self.positionChanged.emit(pos)

    # --- 传输控制 ---
    def play(self):
        if not self._tracks:
            return
        if self._io is None:
            self._io = self._sink.start()
        self._pull_timer.start()
        self._pos_timer.start()
        self.stateChanged.emit("playing")

    def stop(self):
        if self._sink is None:
            return
        self._stop_devices()
        self.stateChanged.emit("stopped")
        self._emit_position()

    def _stop_devices(self):
        self._pull_timer.stop()
        self._pos_timer.stop()
        if self._sink is not None:
            self._sink.stop()
        self._io = None

    def is_playing(self) -> bool:
        return self._pull_timer.isActive()

    def seek(self, t: float):
        if not self._tracks:
            return
        byte_pos = int(max(0.0, t) * self._sr) * 2
        byte_pos = min(byte_pos, len(self._tracks[self._current]) - 2)
        self._buffer.seek(byte_pos)
        if self.is_playing() and self._sink is not None:
            # 重置 sink 设备队列, 丢掉 seek 前已缓冲的音频
            self._sink.stop()
            self._io = self._sink.start()
        self.positionChanged.emit(byte_pos / 2.0 / self._sr)

    def position(self) -> float:
        if not self._tracks:
            return 0.0
        # 用缓冲已读字节定位: 单缓冲拉模式下与实际听到的样本严格对应,
        # seek 后也不会被 sink 内部累积计数带偏
        return self._buffer.pos() / 2.0 / self._sr

    def duration(self) -> float:
        if not self._tracks:
            return 0.0
        return len(self._tracks.get(self._current, b"")) / 2.0 / self._sr

    # --- 拉模式喂数据 ---
    def _pump(self):
        if self._sink is None or self._io is None:
            return
        bytes_free = self._sink.bytesFree()
        if bytes_free <= 0:
            return
        data = self._buffer.read(bytes_free)
        if not data:
            self.stop()
            self.positionChanged.emit(self.duration())
            return
        self._io.write(data)

    def _emit_position(self):
        self.positionChanged.emit(self.position())
