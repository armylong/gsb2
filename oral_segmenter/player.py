"""基于 QAudioSink 的逐段试听。

播放时只把选中段的 PCM 送入声卡, 但界面显示的播放头位置会换算回原始
时间轴 (原始样本号), 因此“听到的”和“标记的”始终是同一条时间线。
"""

from __future__ import annotations

import sys
from array import array

from PySide6.QtCore import QBuffer, QByteArray, QIODevice, QObject, QTimer, Signal
from PySide6.QtMultimedia import QAudio, QAudioFormat, QAudioSink, QMediaDevices

from .audio import AudioData


class PlaybackError(Exception):
    pass


def _device_format(sample_rate: int, channels: int) -> QAudioFormat:
    fmt = QAudioFormat()
    fmt.setSampleRate(sample_rate)
    fmt.setChannelCount(channels)
    fmt.setSampleFormat(QAudioFormat.Int16)
    return fmt


def convert_segment(
    audio: AudioData,
    start: int,
    end: int,
    out_format: QAudioFormat,
) -> bytes:
    """把 [start, end) 帧转换成目标格式的字节流。

    转换包含: 声道数映射与线性插值重采样; 输出样本格式支持 Int16 与
    Float32。源数据可以直接送入声卡时调用方应走零拷贝路径。
    """
    if not 0 <= start < end <= audio.frame_count:
        raise PlaybackError("试听区间越界")
    values, full_scale = audio.decoded
    in_channels = audio.channels
    in_rate = audio.sample_rate
    out_rate = out_format.sampleRate()
    out_channels = out_format.channelCount()
    sample_format = out_format.sampleFormat()

    frames = end - start
    ratio = out_rate / in_rate
    out_frames = max(1, int(round(frames * ratio)))
    scale = 1.0 / float(full_scale)
    base = start * in_channels

    def source_frame(index: int) -> tuple[float, ...]:
        if index >= frames:
            index = frames - 1
        offset = base + index * in_channels
        return tuple(values[offset + c] * scale for c in range(in_channels))

    def mix(frame: tuple[float, ...]) -> list[float]:
        if out_channels == in_channels:
            return list(frame)
        if out_channels == 1:
            return [sum(frame) / len(frame)]
        if in_channels == 1:
            return [frame[0]] * out_channels
        return [frame[c] if c < in_channels else 0.0 for c in range(out_channels)]

    frames_out: list[list[float]] = []
    last_index = -1
    current = next_frame = source_frame(0)
    for j in range(out_frames):
        position = j / ratio
        index = int(position)
        if index != last_index:
            current = source_frame(index)
            next_frame = source_frame(index + 1)
            last_index = index
        frac = position - index
        interpolated = tuple(
            current[c] * (1.0 - frac) + next_frame[c] * frac
            for c in range(in_channels)
        )
        frames_out.append(mix(interpolated))

    if sample_format == QAudioFormat.Float:
        out = array("f", (value for frame in frames_out for value in frame))
    else:
        out = array(
            "h",
            (
                max(-32768, min(32767, int(round(value * 32767.0))))
                for frame in frames_out
                for value in frame
            ),
        )
    if sys.byteorder == "big":
        out.byteswap()
    return out.tobytes()


class SegmentPlayer(QObject):
    """一次播放一个样本区间。"""

    positionChanged = Signal(int)  # 从段首起算的已播样本数
    playingChanged = Signal(bool)
    failed = Signal(str)

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._sink: QAudioSink | None = None
        self._buffer: QBuffer | None = None
        self._playing = False
        self._format: QAudioFormat | None = None
        self._timer = QTimer(self)
        self._timer.setInterval(25)
        self._timer.timeout.connect(self._poll)
        self._requested_loop = False
        self._segment: tuple[int, int] | None = None
        self._audio: AudioData | None = None
        self._frame_ratio = 1.0  # 输出帧 / 源帧

    @property
    def is_playing(self) -> bool:
        return self._playing

    @property
    def is_looping(self) -> bool:
        return self._requested_loop

    def set_loop(self, enabled: bool) -> None:
        # 试听过程中切换循环也能立即生效, 无需等这一遍放完
        self._requested_loop = enabled

    def play_segment(self, audio: AudioData, start: int, end: int,
                     loop: bool = False) -> None:
        self.stop()
        if not 0 <= start < end <= audio.frame_count:
            self.failed.emit("试听区间越界")
            return
        device = QMediaDevices.defaultAudioOutput()
        if device is None or device.isNull():
            self.failed.emit("没有可用的音频输出设备")
            return

        direct = _device_format(audio.sample_rate, audio.channels)
        if audio.sample_width == 2 and device.isFormatSupported(direct):
            payload = audio.slice_bytes(start, end)
            out_format = direct
        else:
            preferred = device.preferredFormat()
            candidates = [preferred]
            fallback = QAudioFormat()
            fallback.setSampleRate(44100)
            fallback.setChannelCount(2)
            fallback.setSampleFormat(QAudioFormat.Int16)
            candidates.append(fallback)
            out_format = next(
                (fmt for fmt in candidates if device.isFormatSupported(fmt)),
                candidates[-1],
            )
            if out_format.sampleFormat() not in (
                QAudioFormat.Int16,
                QAudioFormat.Float,
            ):
                out_format = candidates[-1]
            try:
                payload = convert_segment(audio, start, end, out_format)
            except Exception as exc:  # noqa: BLE001 - 报给界面而不是崩溃
                self.failed.emit(f"音频转换失败: {exc}")
                return

        try:
            self._buffer = QBuffer(self)
            self._buffer.setData(QByteArray(payload))
            self._buffer.open(QIODevice.ReadOnly)
            self._sink = QAudioSink(device, out_format, self)
            self._sink.stateChanged.connect(self._on_state)
            self._format = out_format
            self._audio = audio
            self._segment = (start, end)
            self._frame_ratio = audio.sample_rate / out_format.sampleRate()
            self._requested_loop = loop
            self._playing = True
            self._timer.start()
            self.playingChanged.emit(True)
            self._sink.start(self._buffer)
        except Exception as exc:  # noqa: BLE001
            self.failed.emit(f"播放失败: {exc}")
            self._cleanup()

    def release(self) -> None:
        """窗口关闭时彻底释放声卡。"""
        self._requested_loop = False
        self.stop()

    def stop(self) -> None:
        if self._sink is not None:
            try:
                self._sink.stop()
            except RuntimeError:
                pass
        self._cleanup()

    def _cleanup(self) -> None:
        was_playing = self._playing
        self._playing = False
        self._timer.stop()
        self._requested_loop = False
        if self._sink is not None:
            self._sink.deleteLater()
            self._sink = None
        if self._buffer is not None:
            self._buffer.close()
            self._buffer.deleteLater()
            self._buffer = None
        self._format = None
        if was_playing:
            self.playingChanged.emit(False)

    def _on_state(self, state: QAudio.State) -> None:
        if state != QAudio.State.IdleState or not self._playing:
            return
        if (
            self._requested_loop
            and self._segment
            and self._audio
            and self._sink is not None
            and self._buffer is not None
        ):
            # 复用同一个 sink 循环重播: stop() 会把 processedUSecs 归零,
            # 因此播放头每一轮都从段首重新走, 不会累积。
            self._sink.stop()
            self._buffer.seek(0)
            self._sink.start(self._buffer)
        else:
            self.stop()

    def _poll(self) -> None:
        sink = self._sink
        if sink is None or not self._playing or self._format is None:
            return
        # processedUSecs() 是自 start() 起已消费的时长, 换算成输出样本数,
        # 再按输出采样率折回“段内已播帧数”。
        micros = max(0, sink.processedUSecs())
        played = int(micros * self._format.sampleRate() / 1_000_000)
        played = int(played * self._frame_ratio)
        if self._segment is not None:
            played = min(played, self._segment[1] - self._segment[0])
        self.positionChanged.emit(max(0, played))
