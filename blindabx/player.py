"""无缝 A/B/X 播放引擎。

实现要点:
- 一个常驻 QAudioSink + 自定义 QIODevice 拉流, 切换音源只换缓冲引用,
  不 stop/start 音频设备, 因此没有额外跳停可供猜测
- 三路缓冲等长、同采样率同格式, 共用同一条样点时间轴与同一对循环边界
- seek 只移动读样点, 循环在 readData 内自动回到循环起点
- 非循环播放到缓冲尾部时自然静默, 由位置定时器停止引擎
"""
from __future__ import annotations

import numpy as np
from PySide6.QtCore import QIODevice, QObject, QTimer, Signal
from PySide6.QtMultimedia import QAudioFormat, QAudioSink


class _StreamDevice(QIODevice):
    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._buffers: dict[str, bytes] = {}
        self._active = "A"
        self._pos = 0
        self._total = 0
        self._loop_start = 0
        self._loop_end = 0          # 不含
        self._loop_mode = False
        self._bytes_per_frame = 4  # 16bit stereo 默认

    def configure(self, buffers: dict[str, bytes], bytes_per_frame: int) -> None:
        self._buffers = buffers
        self._bytes_per_frame = bytes_per_frame
        length = min(len(b) for b in buffers.values())
        self._total = length
        self._pos = 0
        self._loop_start = 0
        self._loop_end = length
        self._loop_mode = False

    def set_active(self, key: str) -> None:
        """换源: 读位置、循环边界全部不动。"""
        if key not in self._buffers:
            raise KeyError(key)
        self._active = key

    @property
    def active(self) -> str:
        return self._active

    def seek_frames(self, frame: int) -> None:
        # 允许定位到末帧之后: 此时读取自然返回静音并结束播放
        self._pos = int(np.clip(frame, 0, self.frame_count())) * self._bytes_per_frame

    def position_frames(self) -> int:
        return self._pos // self._bytes_per_frame

    def frame_count(self) -> int:
        return self._total // self._bytes_per_frame

    def set_loop(self, start_frame: int, end_frame: int) -> None:
        bpf = self._bytes_per_frame
        self._loop_start = int(np.clip(start_frame, 0, self.frame_count() - 1)) * bpf
        self._loop_end = int(np.clip(end_frame, 1, self.frame_count())) * bpf
        if self._loop_end <= self._loop_start:
            self._loop_end = min(self._total, self._loop_start + bpf)
        if not self._loop_mode and self._pos < self._loop_start:
            self._pos = self._loop_start

    def loop_bounds_frames(self) -> tuple[int, int]:
        return self._loop_start // self._bytes_per_frame, self._loop_end // self._bytes_per_frame

    def set_loop_mode(self, on: bool) -> None:
        self._loop_mode = on

    @property
    def loop_mode(self) -> bool:
        return self._loop_mode

    def reset_position(self) -> None:
        self._pos = self._loop_start if self._loop_mode else 0

    # -- QIODevice 拉流接口 ------------------------------------------------ #
    def readData(self, maxlen: int) -> bytes:  # noqa: N802 (Qt 命名)
        data = self._buffers[self._active]
        if self._pos >= self._total:
            if self._loop_mode:
                self._pos = self._loop_start
            else:
                return b"\x00" * maxlen
        out = bytearray()
        remaining = maxlen
        while remaining > 0:
            boundary = self._loop_end if self._loop_mode else self._total
            chunk = data[self._pos: min(boundary, self._pos + remaining)]
            if not chunk:
                if self._loop_mode:
                    self._pos = self._loop_start
                    continue
                out.extend(b"\x00" * remaining)
                break
            out.extend(chunk)
            self._pos += len(chunk)
            remaining -= len(chunk)
            if self._loop_mode and self._pos >= self._loop_end:
                self._pos = self._loop_start
            if not self._loop_mode and self._pos >= self._total:
                if remaining:
                    out.extend(b"\x00" * remaining)
                break
        return bytes(out)

    def writeData(self, _data: bytes) -> int:  # noqa: N802
        return 0


class GaplessPlayer(QObject):
    positionChanged = Signal(float)          # 秒
    playbackEnded = Signal()
    activeChanged = Signal(str)
    stateChanged = Signal(bool)              # True = 播放中

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._device = _StreamDevice(self)
        self._sink: QAudioSink | None = None
        self._sr = 0
        self._ch = 0
        self._playing = False
        self._timer = QTimer(self)
        self._timer.setInterval(40)
        self._timer.timeout.connect(self._tick)

    # -- 装载 -------------------------------------------------------------- #
    def load(self, buffers_f32: dict[str, np.ndarray], sr: int, ch: int) -> None:
        was_playing = self._playing
        self.stop()
        fmt = QAudioFormat()
        fmt.setSampleRate(sr)
        fmt.setChannelCount(ch)
        fmt.setSampleFormat(QAudioFormat.SampleFormat.Int16)
        self._sink = QAudioSink(fmt, self)
        self._sink.setBufferSize(max(8192, sr * ch * 2 // 20))  # 约 50ms
        self._sr, self._ch = sr, ch
        pcm: dict[str, bytes] = {}
        for key, buf in buffers_f32.items():
            clipped = np.clip(buf, -1.0, 1.0)
            pcm[key] = (clipped * 32767.0).astype("<i2").tobytes()
        self._device.configure(pcm, bytes_per_frame=ch * 2)
        self._device.open(QIODevice.OpenModeFlag.ReadOnly)
        if was_playing:
            self.play()

    # -- 传输控制 ---------------------------------------------------------- #
    def play(self) -> None:
        if self._sink is None:
            return
        if self._device.position_frames() >= self._device.frame_count():
            self._device.reset_position()
        self._sink.start(self._device)
        self._playing = True
        self._timer.start()
        self.stateChanged.emit(True)

    def pause(self) -> None:
        if self._sink is not None:
            self._sink.stop()
        self._playing = False
        self._timer.stop()
        self.stateChanged.emit(False)

    def stop(self) -> None:
        self.pause()
        if self._sink is not None:
            self._sink.deleteLater()
            self._sink = None
        if self._device.isOpen():
            self._device.close()

    def toggle(self) -> None:
        self.pause() if self._playing else self.play()

    def _tick(self) -> None:
        pos = self._device.position_frames() / max(1, self._sr)
        self.positionChanged.emit(pos)
        if (not self._device.loop_mode
                and self._device.position_frames() >= self._device.frame_count()):
            self.pause()
            self.playbackEnded.emit()

    # -- 音源切换 (核心: 无跳停) ------------------------------------------- #
    def switch_source(self, key: str) -> None:
        if key == self._device.active:
            return
        self._device.set_active(key)
        self.activeChanged.emit(key)

    @property
    def active_source(self) -> str:
        return self._device.active

    # -- 位置 / 循环 ------------------------------------------------------- #
    def seek(self, seconds: float) -> None:
        self._device.seek_frames(int(seconds * self._sr))
        self.positionChanged.emit(seconds)

    def position(self) -> float:
        return self._device.position_frames() / max(1, self._sr)

    def duration(self) -> float:
        return self._device.frame_count() / max(1, self._sr)

    def set_loop_mode(self, on: bool) -> None:
        self._device.set_loop_mode(on)
        if on and self._device.position_frames() < self._device.loop_bounds_frames()[0]:
            self._device.seek_frames(self._device.loop_bounds_frames()[0])

    def loop_mode(self) -> bool:
        return self._device.loop_mode

    def set_loop_bounds(self, start_s: float, end_s: float) -> None:
        self._device.set_loop(int(start_s * self._sr), int(end_s * self._sr))

    def loop_bounds(self) -> tuple[float, float]:
        s, e = self._device.loop_bounds_frames()
        return s / self._sr, e / self._sr
