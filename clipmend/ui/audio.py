"""Playback of short ranges through QtMultimedia, with a pure buffer builder.

The buffer builder is Qt-free so tests can verify exactly what would be heard
(which channel, which range, which version) without an audio device.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from PySide6.QtCore import QBuffer, QByteArray, QObject, QTimer, Signal
from PySide6.QtMultimedia import QAudio, QAudioFormat, QAudioSink, QMediaDevices


@dataclass
class PlaybackBuffer:
    data: bytes
    sample_rate: int
    channels: int
    frames: int
    first_frame: int
    last_frame: int


def resample_linear(x: np.ndarray, src_sr: int, dst_sr: int, dst_frames: int) -> np.ndarray:
    """Linear resampling, only used when the device rejects the source rate."""
    if src_sr == dst_sr or x.shape[0] == 0:
        return x.astype(np.float32)
    src_t = np.arange(x.shape[0], dtype=np.float64)
    dst_t = np.linspace(0.0, x.shape[0] - 1.0, dst_frames)
    out = np.empty((dst_frames, x.shape[1]), dtype=np.float32)
    for ch in range(x.shape[1]):
        out[:, ch] = np.interp(dst_t, src_t, x[:, ch])
    return out


def build_playback_buffer(
    samples: np.ndarray,
    sample_rate: int,
    start_frame: int,
    end_frame: int,
    channel_gain: tuple[float, ...] | None = None,
    loop: bool = False,
    target_rate: int | None = None,
) -> PlaybackBuffer:
    """Slice [start, end), apply per-channel gain, and render float32 stereo.

    ``channel_gain`` of (1.0, 0.0) is a left-only solo; this is how the user
    checks that repairing the left channel really left the right untouched.
    """
    samples = np.asarray(samples, dtype=np.float64)
    if samples.ndim == 1:
        samples = samples[:, None]
    frames = samples.shape[0]
    start = max(0, min(int(start_frame), frames))
    end = max(start, min(int(end_frame), frames))
    block = samples[start:end].copy()
    if block.size:
        block = np.nan_to_num(block, nan=0.0, posinf=1.0, neginf=-1.0)
    gains = np.ones(block.shape[1])
    if channel_gain is not None:
        for ch, g in enumerate(channel_gain[: block.shape[1]]):
            gains[ch] = float(g)
    block = block * gains

    channels_out = 2
    if block.size == 0:
        stereo = np.zeros((0, channels_out), dtype=np.float32)
    elif block.shape[1] == 1:
        stereo = np.repeat(block, channels_out, axis=1).astype(np.float32)
    elif block.shape[1] == 2:
        stereo = block.astype(np.float32)
    else:
        stereo = np.repeat(block[:, :1], channels_out, axis=1).astype(np.float32)

    out_rate = target_rate or sample_rate
    if out_rate != sample_rate and stereo.shape[0]:
        n_out = max(1, int(round(stereo.shape[0] * out_rate / sample_rate)))
        stereo = resample_linear(stereo, sample_rate, out_rate, n_out)

    if loop and stereo.shape[0] > 0:
        fade = min(stereo.shape[0] // 8, int(0.003 * out_rate))
        if fade > 1:
            ramp = np.linspace(0.0, 1.0, fade, dtype=np.float32)[:, None]
            stereo[:fade] *= ramp
            stereo[-fade:] *= ramp[::-1]

    stereo = np.clip(stereo, -1.0, 1.0)
    return PlaybackBuffer(
        data=stereo.astype("<f4").tobytes(),
        sample_rate=out_rate,
        channels=channels_out,
        frames=int(stereo.shape[0]),
        first_frame=start,
        last_frame=end,
    )


def device_format(sample_rate: int, device=None) -> QAudioFormat:
    """Return a float32 stereo format at the device's preferred rate when the
    requested rate is not accepted, so the sink never runs at a mismatched
    rate (which would play at the wrong speed)."""
    audio_device = device or QMediaDevices.defaultAudioOutput()
    fmt = QAudioFormat()
    fmt.setChannelCount(2)
    fmt.setSampleFormat(QAudioFormat.SampleFormat.Float)
    fmt.setSampleRate(int(sample_rate))
    if audio_device is None or audio_device.isNull():
        return fmt
    if audio_device.isFormatSupported(fmt):
        return fmt
    preferred = audio_device.preferredFormat()
    preferred.setChannelCount(2)
    preferred.setSampleFormat(QAudioFormat.SampleFormat.Float)
    if preferred.sampleRate() <= 0:
        preferred.setSampleRate(48000)
    return preferred


def resample_buffer(buffer: PlaybackBuffer, dst_rate: int) -> PlaybackBuffer:
    """Resample a prepared buffer (multichannel float32) to another rate."""
    if dst_rate == buffer.sample_rate or buffer.frames == 0:
        return buffer
    data = np.frombuffer(buffer.data, dtype="<f4").reshape(-1, buffer.channels)
    n_out = max(1, int(round(buffer.frames * dst_rate / buffer.sample_rate)))
    out = resample_linear(data, buffer.sample_rate, dst_rate, n_out)
    return PlaybackBuffer(
        data=out.astype("<f4").tobytes(),
        sample_rate=dst_rate,
        channels=buffer.channels,
        frames=n_out,
        first_frame=buffer.first_frame,
        last_frame=buffer.last_frame,
    )


class AudioPlayer(QObject):
    """Small single-clip player.  Starting a new clip stops the previous one."""

    finished = Signal(str)  # reason: "end" | "stopped" | "error"

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._sink: QAudioSink | None = None
        self._buffer: QBuffer | None = None
        self._byte_array: QByteArray | None = None
        self._loop_buffer: PlaybackBuffer | None = None
        self._loop = False
        self._stopping = False
        self._label = ""
        self._volume = 1.0
        self._device = QMediaDevices.defaultAudioOutput()

    @property
    def active_label(self) -> str:
        return self._label if self.is_playing() else ""

    @staticmethod
    def _state_value(state) -> int:
        """Sink states come back as QtAudio.State while signals carry
        QAudio.State; comparing those enums directly is always False."""
        return int(getattr(state, "value", state))

    def is_playing(self) -> bool:
        return (
            self._sink is not None
            and self._state_value(self._sink.state())
            == self._state_value(QAudio.State.ActiveState)
        )

    def set_volume(self, value: float) -> None:
        self._volume = max(0.0, min(1.0, float(value)))
        if self._sink is not None:
            self._sink.setVolume(self._volume)

    def _teardown(self) -> None:
        self._stopping = True
        try:
            if self._sink is not None:
                self._sink.stop()
                self._sink.stateChanged.disconnect(self._on_state)
        except (RuntimeError, TypeError):
            pass
        self._sink = None
        if self._buffer is not None:
            self._buffer.close()
        self._buffer = None
        self._byte_array = None
        self._stopping = False

    def stop(self, reason: str = "stopped") -> None:
        was_active = self._sink is not None
        self._teardown()
        self._loop_buffer = None
        self._loop = False
        self._label = ""
        if was_active:
            self.finished.emit(reason)

    def play_buffer(
        self,
        buffer: PlaybackBuffer,
        label: str,
        loop: bool = False,
    ) -> bool:
        self.stop("stopped")
        if buffer.frames == 0:
            self.finished.emit("error")
            return False
        self._label = label
        self._loop_buffer = buffer
        self._loop = loop
        return self._start(buffer)

    def _start(self, buffer: PlaybackBuffer) -> bool:
        self._device = QMediaDevices.defaultAudioOutput()
        if self._device is None or self._device.isNull():
            self._label = ""
            self.finished.emit("error")
            return False
        fmt = device_format(buffer.sample_rate, self._device)
        if fmt.sampleRate() != buffer.sample_rate:
            buffer = resample_buffer(buffer, fmt.sampleRate())
        if buffer.frames == 0:
            self._label = ""
            self.finished.emit("error")
            return False
        try:
            sink = QAudioSink(self._device, fmt, self)
        except Exception:
            self._label = ""
            self.finished.emit("error")
            return False
        sink.setVolume(self._volume)
        byte_array = QByteArray(buffer.data)
        qbuffer = QBuffer()
        qbuffer.setData(byte_array)
        qbuffer.open(QBuffer.OpenModeFlag.ReadOnly)
        # Keep Python references alive while the sink reads from them.
        self._byte_array = byte_array
        self._buffer = qbuffer
        self._sink = sink
        sink.stateChanged.connect(self._on_state)
        sink.start(qbuffer)
        return True

    def _on_state(self, state) -> None:
        if self._stopping or self._sink is None:
            return
        value = self._state_value(state)
        if value == self._state_value(QAudio.State.IdleState):
            if self._loop and self._loop_buffer is not None:
                buffer = self._loop_buffer
                self._teardown()
                QTimer.singleShot(0, lambda b=buffer: self._restart(b))
            else:
                label = self._label
                self._teardown()
                self._loop_buffer = None
                self._label = ""
                self.finished.emit("end")
        elif value == self._state_value(QAudio.State.StoppedState) and self._sink is not None:
            # Device removed or sink stopped by the system.
            if self._sink.error() != QAudio.Error.NoError:
                self._teardown()
                self._label = ""
                self.finished.emit("error")

    def _restart(self, buffer: PlaybackBuffer) -> None:
        if self._loop:
            self._start(buffer)
