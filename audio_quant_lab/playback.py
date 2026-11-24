"""QAudioSink transport with audible-position retention across scheme swaps."""

from __future__ import annotations

import numpy as np
from PySide6.QtCore import QBuffer, QByteArray, QIODevice, QObject, QTimer, Signal
from PySide6.QtMultimedia import QAudioFormat, QAudioSink, QMediaDevices


class PlaybackEngine(QObject):
    positionChanged = Signal(int)
    stateChanged = Signal(str)
    errorMessage = Signal(str)

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self.sample_rate = 48_000
        self.sink: QAudioSink | None = None
        self.buffer: QBuffer | None = None

        self._pcm = b""
        self._frame_count = 0
        self._anchor_frame = 0
        self._start_usecs = 0
        self._state = "stopped"
        self._volume = 1.0

        self.timer = QTimer(self)
        self.timer.setInterval(30)
        self.timer.timeout.connect(self._tick)

    def set_source(self, samples: np.ndarray, sample_rate: int) -> None:
        """Load a new clip and rebuild the sink for its sample rate."""
        self.timer.stop()
        if self.sink is not None:
            old_sink = self.sink
            self.sink = None
            old_sink.stop()
            old_sink.deleteLater()
        if self.buffer is not None:
            old_buffer = self.buffer
            self.buffer = None
            old_buffer.deleteLater()

        self.sample_rate = int(sample_rate)
        self._set_pcm(samples)
        self._anchor_frame = 0

        audio_device = QMediaDevices.defaultAudioOutput()
        fmt = QAudioFormat()
        fmt.setSampleRate(self.sample_rate)
        fmt.setChannelCount(1)
        fmt.setSampleFormat(QAudioFormat.SampleFormat.Int16)
        fmt.setChannelConfig(QAudioFormat.ChannelConfig.ChannelConfigMono)

        if not audio_device.isFormatSupported(fmt):
            preferred = audio_device.preferredFormat()
            self.errorMessage.emit(
                "音频设备不支持 "
                f"{self.sample_rate} Hz/mono/Int16；首选格式为 "
                f"{preferred.sampleRate()} Hz, {preferred.channelCount()} ch, "
                f"format={preferred.sampleFormat()}。"
            )

        self.sink = QAudioSink(audio_device, fmt, self)
        self.sink.setVolume(self._volume)
        self._set_state("stopped")

    def set_samples_preserve_position(self, samples: np.ndarray) -> None:
        """Swap scheme buffer without moving the comparison position."""
        position = self.position()
        was_playing = self._state == "playing"
        was_paused = self._state == "paused"
        self._set_pcm(samples)
        position = min(position, self._frame_count)

        if was_playing:
            # Restart from the last *audibly processed* frame, not the source
            # reader's read-ahead position, so A/B/C comparison stays aligned.
            self._start_sink(position)
        elif was_paused:
            if self.sink is not None:
                self.sink.stop()
            self._anchor_frame = position
            self._set_state("stopped")
        else:
            self._anchor_frame = position

    def play(self) -> None:
        if self.sink is None or self._frame_count == 0:
            return
        if self._state == "paused":
            self.sink.resume()
        else:
            if self._anchor_frame >= self._frame_count:
                self._anchor_frame = 0
            self._start_sink(self._anchor_frame)
        self.timer.start()
        self._set_state("playing")

    def pause(self) -> None:
        if self.sink is not None and self._state == "playing":
            self.sink.suspend()
            self.timer.stop()
            self._set_state("paused")

    def stop(self) -> None:
        self.timer.stop()
        if self.sink is not None:
            self.sink.stop()
        self._anchor_frame = 0
        self.positionChanged.emit(0)
        self._set_state("stopped")

    def seek(self, frame: int) -> None:
        frame = int(max(0, min(frame, self._frame_count)))
        if self._state == "playing":
            self._start_sink(frame)
        elif self._state == "paused":
            if self.sink is not None:
                self.sink.stop()
            self._anchor_frame = frame
            self._set_state("stopped")
        else:
            self._anchor_frame = frame
        self.positionChanged.emit(frame)

    def preview_position(self, frame: int) -> None:
        """Update the scrub anchor without restarting the audio sink."""
        if self._state != "playing":
            self._anchor_frame = int(max(0, min(frame, self._frame_count)))

    def set_volume(self, value: float) -> None:
        self._volume = float(max(0.0, min(1.0, value)))
        if self.sink is not None:
            self.sink.setVolume(self._volume)

    def position(self) -> int:
        if self.sink is not None and self._state in ("playing", "paused"):
            processed_usecs = max(0, self.sink.processedUSecs() - self._start_usecs)
            played_frames = int(processed_usecs * self.sample_rate / 1_000_000)
            return min(self._frame_count, self._anchor_frame + played_frames)
        return int(min(self._anchor_frame, self._frame_count))

    def _set_pcm(self, samples: np.ndarray) -> None:
        clipped = np.clip(np.asarray(samples, dtype=np.float64), -1.0, 1.0)
        pcm16 = np.round(clipped * 32_767.0).astype("<i2", copy=False)
        self._pcm = pcm16.tobytes()
        self._frame_count = int(samples.size)

    def _start_sink(self, frame: int) -> None:
        if self.sink is None:
            return
        frame = int(max(0, min(frame, self._frame_count)))
        self._anchor_frame = frame

        if self.buffer is not None:
            old_buffer = self.buffer
            self.buffer = None
            old_buffer.deleteLater()

        self.buffer = QBuffer(self)
        self.buffer.setData(QByteArray(self._pcm))
        self.buffer.open(QIODevice.OpenModeFlag.ReadOnly)
        self.buffer.seek(frame * 2)

        self.sink.stop()
        self.sink.start(self.buffer)
        self._start_usecs = max(0, self.sink.processedUSecs())

    def _set_state(self, state: str) -> None:
        self._state = state
        self.stateChanged.emit(state)

    def _tick(self) -> None:
        pos = self.position()
        self.positionChanged.emit(pos)
        if self._frame_count and pos >= self._frame_count:
            self.stop()
