"""单路音频输出。

只存在一个 QAudioSink, 数据由自定义 pull 设备按主时钟即时计算,
因此切换 A/B/静音、暂停、定位都不会残留另一路或旧位置的声音。
"""
from __future__ import annotations

from PySide6.QtCore import QIODevice, QObject, Signal, Slot
from PySide6.QtMultimedia import QAudioFormat, QAudioSink

from .media import AudioBuffer


class PullDevice(QIODevice):
    """按主时钟从一段 PCM 中拉数据的虚拟设备。

    每次 readData 都以 clock() 返回的主时间重新计算字节位置(主时钟漂移校正),
    循环区间由 [loop_lo, loop_hi) 给出; 超出内容范围则输出静音。
    """

    def __init__(
        self,
        audio: AudioBuffer | None,
        offset: float,
        clock,
        loop_bounds,
        parent: QObject | None = None,
    ):
        super().__init__(parent)
        self.audio = audio
        self.offset = offset
        self._clock = clock
        self._loop_bounds = loop_bounds  # 返回 (lo, hi) 或 None 的回调
        self._last_pos = -1.0
        self.open(QIODevice.OpenModeFlag.ReadOnly)

    def set_source(self, audio: AudioBuffer | None, offset: float) -> None:
        self.audio = audio
        self.offset = offset
        self._last_pos = -1.0

    def _content_time(self) -> float | None:
        t = self._clock()
        lo_hi = self._loop_bounds()
        if lo_hi is not None:
            lo, hi = lo_hi
            if t >= hi:
                t = lo + ((t - lo) % (hi - lo))
        if self.audio is None:
            return None
        ct = t + self.offset
        if ct < 0.0 or ct >= self.audio.duration:
            return None
        return ct

    def readData(self, maxlen: int) -> bytes:
        frame_size = 4 * (self.audio.channels if self.audio else 2)
        if self.audio is None:
            return bytes(maxlen)

        ct = self._content_time()
        if ct is None:
            self._last_pos = -1.0
            return bytes(maxlen)

        # 以主时钟计算本块应处的内容采样位置; 循环折回已在 _content_time 完成
        target = max(0.0, ct) * self.audio.sample_rate
        # 定位/跳变后不追旧位置, 直接从新位置供数(避免追播一段旧声音)
        if self._last_pos < 0 or abs(target - self._last_pos) > 0.5:
            pos = target
        else:
            pos = self._last_pos  # 正常连续播放, 保证字节流不回跳

        n_frames = max(1, maxlen // frame_size)
        start = int(pos)
        end = min(self.audio.pcm.shape[0], start + n_frames)
        if end <= start:
            self._last_pos = -1.0
            return bytes(maxlen)
        data = self.audio.pcm[start:end].tobytes()
        self._last_pos = end
        if len(data) < maxlen:  # 内容末端: 不足部分补静音, 不喂半截块
            data += bytes(maxlen - len(data))
        return data

    def writeData(self, data: bytes) -> int:  # pragma: no cover - 只读设备
        return 0


class AudioController(QObject):
    """A / B / 静音三态的唯一音频出口。"""

    stateChanged = Signal(str)

    def __init__(self, audio_a: AudioBuffer | None, audio_b: AudioBuffer | None,
                 clock, loop_bounds, parent: QObject | None = None):
        super().__init__(parent)
        fmt = QAudioFormat()
        fmt.setSampleRate(AudioBuffer.TARGET_RATE)
        fmt.setChannelCount(2)
        fmt.setSampleFormat(QAudioFormat.SampleFormat.Float)
        self._fmt = fmt

        self.sink = QAudioSink(fmt, parent)
        self.sink.setBufferSize(48000 * 2 * 4 // 5)  # ~0.2s
        self.device = PullDevice(audio_a, 0.0, clock, loop_bounds, parent)
        self._sources = {"A": audio_a, "B": audio_b}
        self._mode = "mute"
        self._offset = 0.0
        self._running = False

    @property
    def mode(self) -> str:
        return self._mode

    def set_offset(self, offset: float) -> None:
        self._offset = offset
        self._apply_source()

    def set_mode(self, mode: str) -> None:
        assert mode in ("A", "B", "mute")
        self._mode = mode
        self._apply_source()

    def _apply_source(self) -> None:
        if self._mode == "mute":
            self.device.set_source(None, 0.0)
        else:
            self.device.set_source(
                self._sources[self._mode],
                self._offset if self._mode == "B" else 0.0,
            )
        self.stateChanged.emit(self._mode)

    def start(self) -> None:
        if not self._running:
            self.sink.start(self.device)
            self._running = True

    @Slot()
    def stop(self) -> None:
        if self._running:
            # stop 会丢弃 sink 内部全部缓冲, 确保旧声音不残留
            self.sink.stop()
            self._running = False
            self.device._last_pos = -1.0

    def reset_position(self) -> None:
        """主时钟跳变后调用: 让 pull 设备从新位置重新供数。"""
        self.device._last_pos = -1.0
        if self._running:
            # flush 已缓冲的旧位置数据
            self.sink.stop()
            self.sink.start(self.device)

    def shutdown(self) -> None:
        self.stop()
