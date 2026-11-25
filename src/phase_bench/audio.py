"""Local audio preview through QtMultimedia.

Preview deliberately renders the exact aligned NumPy samples used by analysis;
only a fixed monitor headroom trim and the hardware/software volume are applied.
Export uses the same :func:`phase_bench.dsp.apply_alignment` result at unity gain.
"""

from __future__ import annotations

import io
import wave

import numpy as np
from PySide6.QtCore import QBuffer, QObject, Signal
from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer


def render_preview_wav(samples: np.ndarray, sample_rate: int, headroom_trim: float = 0.5) -> bytes:
    """Render mono samples to 16-bit WAV for QtMultimedia.

    The fixed 0.5 trim gives two full-scale correlated channels enough headroom
    after summing.  It does not change delay, polarity or relative comparisons.
    """

    x = np.asarray(samples, dtype=np.float64).reshape(-1)
    x = np.clip(x * float(headroom_trim), -1.0, 1.0)
    pcm = (x * 32767.0).astype("<i2")

    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(int(sample_rate))
        wav.writeframes(pcm.tobytes())
    return buffer.getvalue()


class AudioPlayer(QObject):
    positionChanged = Signal(int)  # frame relative to the buffer start
    playbackStopped = Signal()

    def __init__(self) -> None:
        super().__init__()
        self._player = QMediaPlayer()
        self._output = QAudioOutput()
        self._player.setAudioOutput(self._output)
        self._buffer: QBuffer | None = None
        self._sample_rate = 48_000
        self._frames = 0
        self._last_state = QMediaPlayer.PlaybackState.StoppedState

        self._player.positionChanged.connect(self._on_position_ms)
        self._player.playbackStateChanged.connect(self._on_state_changed)

    def set_volume(self, value: float) -> None:
        self._output.setVolume(float(np.clip(value, 0.0, 1.0)))

    def play_samples(self, samples: np.ndarray, sample_rate: int, loop: bool = False, volume: float = 0.9) -> None:
        self.stop()
        data = render_preview_wav(samples, sample_rate)
        self._sample_rate = int(sample_rate)
        self._frames = int(len(samples))

        self._buffer = QBuffer()
        self._buffer.setData(data)
        self._buffer.open(QBuffer.OpenModeFlag.ReadOnly)

        self._player.setSourceDevice(self._buffer)
        try:
            self._player.setLoops(QMediaPlayer.Loops.Infinite if loop else QMediaPlayer.Loops.Once)
        except AttributeError:  # pragma: no cover - compatibility fallback
            pass
        self.set_volume(volume)
        self._player.play()

    def stop(self) -> None:
        self._player.stop()
        self._player.setSourceDevice(None)
        if self._buffer is not None:
            self._buffer.close()
            self._buffer.deleteLater()
            self._buffer = None
        # -1 tells the view to clear the playhead rather than draw at offset 0.
        self.positionChanged.emit(-1)

    def _on_position_ms(self, ms: int) -> None:
        if self._player.playbackState() != QMediaPlayer.PlaybackState.PlayingState:
            return
        frame = int(round(ms * self._sample_rate / 1000.0))
        self.positionChanged.emit(min(max(0, frame), max(0, self._frames - 1)))

    def _on_state_changed(self, state: QMediaPlayer.PlaybackState) -> None:
        if self._last_state != QMediaPlayer.PlaybackState.StoppedState and state == QMediaPlayer.PlaybackState.StoppedState:
            self.playbackStopped.emit()
        self._last_state = state
