from __future__ import annotations

import numpy as np
from PySide6.QtCore import QBuffer, QObject, QTimer, Signal
from PySide6.QtMultimedia import QAudio, QAudioFormat, QAudioSink

from .audio_io import AudioData


def bandpass_samples(samples: np.ndarray, sample_rate: int, low_hz: float, high_hz: float) -> np.ndarray:
    """Isolate a frequency band with a soft FFT mask; observation listening only."""
    x = np.asarray(samples, dtype=np.float32)
    if x.ndim == 1:
        x = x[:, None]
    n = x.shape[0]
    if n < 8:
        return x.copy()

    spectrum = np.fft.rfft(x, axis=0)
    freqs = np.fft.rfftfreq(n, 1.0 / sample_rate)
    nyquist = sample_rate / 2.0
    low = max(1.0, float(low_hz))
    high = min(nyquist * 0.999, float(high_hz))
    if high <= low:
        return np.zeros_like(x)

    transition = min((high - low) * 0.18, low * 0.35, max(1.0, (nyquist - high) * 0.2))
    mask = np.zeros_like(freqs)
    mask[(freqs >= low) & (freqs <= high)] = 1.0

    low_edge = (freqs > low - transition) & (freqs < low)
    if np.any(low_edge):
        mask[low_edge] = 0.5 - 0.5 * np.cos(np.pi * (freqs[low_edge] - (low - transition)) / transition)
    high_edge = (freqs > high) & (freqs < high + transition)
    if np.any(high_edge):
        mask[high_edge] = 0.5 + 0.5 * np.cos(np.pi * (freqs[high_edge] - high) / transition)

    y = np.fft.irfft(spectrum * mask[:, None], n=n, axis=0)
    return y.astype(np.float32)


def apply_channel_mode(samples: np.ndarray, mode: str) -> np.ndarray:
    out = np.array(samples, dtype=np.float32, copy=True)
    if out.ndim == 1:
        return out
    if mode == "left" and out.shape[1] == 2:
        out[:, 1] = 0.0
    elif mode == "right" and out.shape[1] == 2:
        out[:, 0] = 0.0
    elif mode == "mono" and out.shape[1] == 2:
        mono = out.mean(axis=1, keepdims=True)
        out = np.repeat(mono, 2, axis=1)
    return out


def to_pcm16_bytes(samples: np.ndarray) -> bytes:
    clipped = np.clip(samples, -1.0, 1.0)
    return np.round(clipped * 32767.0).astype("<i2").tobytes()


class PlaybackController(QObject):
    """Play exact time intervals; full-band and band-limited calls share bounds."""

    positionChanged = Signal(float)
    intervalStarted = Signal(float, float, str)
    playbackFinished = Signal()
    error = Signal(str)

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._sink: QAudioSink | None = None
        self._buffer: QBuffer | None = None
        self._timer = QTimer(self)
        self._timer.setInterval(40)
        self._timer.timeout.connect(self._emit_position)
        self._start_time = 0.0
        self._end_time = 0.0
        self._loop = False
        self._last_payload: bytes | None = None
        self._last_format: QAudioFormat | None = None

    @property
    def is_playing(self) -> bool:
        return self._sink is not None and self._sink.state() in (
            QAudio.State.ActiveState,
            QAudio.State.IdleState,
        )

    def play_interval(
        self,
        audio: AudioData,
        start: float,
        end: float,
        *,
        band: tuple[float, float] | None = None,
        channel_mode: str = "all",
        loop: bool = False,
    ) -> None:
        try:
            self.stop(notify=False)
            i0, i1 = audio.segment_samples(start, end)
            if i1 <= i0:
                self.error.emit("试听区间为空")
                return
            segment = audio.samples[i0:i1].copy()
            if band is not None:
                segment = bandpass_samples(segment, audio.sample_rate, band[0], band[1])
            segment = apply_channel_mode(segment, channel_mode)

            fmt = QAudioFormat()
            fmt.setSampleRate(audio.sample_rate)
            fmt.setChannelCount(audio.n_channels)
            fmt.setSampleFormat(QAudioFormat.SampleFormat.Int16)
            payload = to_pcm16_bytes(segment)

            self._buffer = QBuffer(self)
            self._buffer.setData(payload)
            self._buffer.open(QBuffer.OpenModeFlag.ReadOnly)

            self._sink = QAudioSink(fmt, self)
            self._sink.stateChanged.connect(self._on_state_changed)
            self._start_time = i0 / audio.sample_rate
            self._end_time = i1 / audio.sample_rate
            self._loop = loop
            self._last_payload = payload
            self._last_format = fmt
            self._sink.start(self._buffer)
            self._timer.start()
            self.intervalStarted.emit(self._start_time, self._end_time, "band" if band else "full")
            self.positionChanged.emit(self._start_time)
        except Exception as exc:  # audio backends differ across machines
            self.error.emit(f"试听启动失败：{exc}")

    def stop(self, notify: bool = True) -> None:
        self._timer.stop()
        sink, self._sink = self._sink, None
        buffer, self._buffer = self._buffer, None
        if sink is not None:
            try:
                sink.stateChanged.disconnect(self._on_state_changed)
            except Exception:
                pass
            sink.stop()
            sink.deleteLater()
        if buffer is not None:
            buffer.close()
            buffer.deleteLater()
        if notify:
            self.playbackFinished.emit()

    def _emit_position(self) -> None:
        if self._sink is None:
            return
        try:
            usecs = self._sink.processedUSecs()
            pos = self._start_time + usecs / 1_000_000.0
            if pos >= self._end_time:
                pos = self._end_time
            self.positionChanged.emit(pos)
        except Exception:
            pass

    def _on_state_changed(self, state) -> None:  # noqa: ANN001 - Qt enum
        # IdleState usually means the QBuffer reached its end.
        state_value = getattr(state, "value", state)
        if self._sink is not None and state_value == QAudio.State.IdleState.value:
            at_end = self._buffer is None or self._buffer.bytesAvailable() == 0
            if at_end:
                if self._loop and self._last_payload is not None and self._last_format is not None:
                    # Restart the exact same rendered interval, preserving bounds.
                    payload, fmt = self._last_payload, self._last_format
                    self.stop(notify=False)
                    self._buffer = QBuffer(self)
                    self._buffer.setData(payload)
                    self._buffer.open(QBuffer.OpenModeFlag.ReadOnly)
                    self._sink = QAudioSink(fmt, self)
                    self._sink.stateChanged.connect(self._on_state_changed)
                    self._sink.start(self._buffer)
                    self._timer.start()
                    return
                end = self._end_time
                self.stop(notify=False)
                self.positionChanged.emit(end)
                self.playbackFinished.emit()
