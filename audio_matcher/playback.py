"""Playback for the source and the rendered result.

QtMultimedia details that matter here:

* a sink's format is fixed while running, so each ``play`` builds a fresh
  sink;
* pulling buffers from a Python ``QIODevice`` is the least glitchy mode, so
  the PCM is prepared up front and served sequentially;
* the device may only accept certain sample formats/channel counts, so the
  mono float data is converted to whatever the device's preferred format uses
  (Int16 or Float32) and duplicated to its channel count.

When QtMultimedia is unavailable (headless CI, missing plugin) the player
reports that and the app still measures and exports; auditioning is the only
feature that needs it.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

try:  # pragma: no cover - import path depends on the Qt build
    from PySide6.QtCore import QByteArray, QIODevice, QObject, QTimer, Signal
    from PySide6.QtMultimedia import QAudio, QAudioFormat, QAudioSink, QMediaDevices

    _QT_AUDIO_AVAILABLE = True
except Exception:  # pragma: no cover - only on Qt builds without Multimedia
    class _UnavailableSignal:
        """Stand-in so the class body still defines cleanly without Qt."""

        def __init__(self, *args, **kwargs) -> None:
            pass

        def connect(self, *args, **kwargs) -> None:
            pass

        def emit(self, *args, **kwargs) -> None:
            pass

    QByteArray = None  # type: ignore[assignment]
    QIODevice = object  # type: ignore[assignment,misc]
    QObject = object  # type: ignore[assignment,misc]
    QTimer = None  # type: ignore[assignment]
    Signal = _UnavailableSignal  # type: ignore[assignment]
    QAudio = QAudioFormat = QAudioSink = QMediaDevices = None  # type: ignore[assignment]
    _QT_AUDIO_AVAILABLE = False


def audio_available() -> bool:
    return bool(_QT_AUDIO_AVAILABLE)


def _resample_linear(samples: np.ndarray, source_rate: int, target_rate: int) -> np.ndarray:
    """Linear resample: enough for auditioning, and no SciPy dependency."""
    data = np.asarray(samples, dtype=np.float64)
    if source_rate == target_rate or data.size == 0:
        return data
    ratio = target_rate / float(source_rate)
    out_count = max(1, int(round(data.size * ratio)))
    src_positions = np.arange(out_count, dtype=np.float64) / ratio
    left = np.floor(src_positions).astype(np.int64)
    right = np.minimum(left + 1, data.size - 1)
    frac = src_positions - left
    return data[left] * (1.0 - frac) + data[right] * frac


def encode_pcm(
    samples: np.ndarray,
    source_rate: int,
    target_rate: int,
    channels: int,
    sample_format: str,
) -> bytes:
    """Resample, clamp, duplicate channels and serialize to raw bytes.

    ``sample_format`` is ``"int16"`` or ``"float"`` to match the
    ``QAudioFormat.SampleFormat`` the sink accepted.
    """
    data = np.clip(_resample_linear(samples, source_rate, target_rate), -1.0, 1.0)
    if channels > 1:
        # Frame-interleaved: each input sample repeated for every channel.
        data = np.repeat(data, channels)
    if sample_format == "float":
        return data.astype("<f4").tobytes()
    ints = np.round(data * 32767.0).astype("<i2")
    return ints.tobytes()


@dataclass(frozen=True)
class PlaybackRequest:
    """What to play, and where it came from."""

    samples: np.ndarray
    sample_rate: int
    label: str


class AudioPlayer(QObject):
    """One shared player; each :meth:`play` replaces whatever was playing."""

    started = Signal(str)
    finished = Signal(str)
    failed = Signal(str)

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._sink = None
        self._stream = None
        self._label = ""
        self._available = _QT_AUDIO_AVAILABLE
        self._error_text = ""
        self._finish_reported = False

    # ---------------------------------------------------------------- status

    @property
    def available(self) -> bool:
        return self._available

    @property
    def error_text(self) -> str:
        return self._error_text

    def is_playing(self) -> bool:
        if self._sink is None:
            return False
        return self._sink.state() == QAudio.State.ActiveState

    # --------------------------------------------------------------- playback

    def play(self, request: PlaybackRequest) -> bool:
        self.stop()
        if not self._available:
            return self._fail("当前环境没有可用的 QtMultimedia 音频输出")
        samples = np.asarray(request.samples, dtype=np.float64)
        if samples.size == 0:
            return self._fail("选区为空，没有可播放的样本")
        output = QMediaDevices.defaultAudioOutput()
        if output is None or output.isNull():
            self._available = False
            return self._fail("没有检测到音频输出设备")

        fmt = self._choose_format(output)
        if fmt is None or not fmt.isValid():
            return self._fail("音频设备不接受单声道 Int16/Float32 格式")
        sample_format = (
            "float"
            if fmt.sampleFormat() == QAudioFormat.SampleFormat.Float
            else "int16"
        )
        pcm = encode_pcm(
            samples,
            request.sample_rate,
            fmt.sampleRate(),
            fmt.channelCount(),
            sample_format,
        )
        if not pcm:
            return self._fail("选区转换后为空")
        return self._start(output, fmt, pcm, request.label)

    def _choose_format(self, output):
        """Prefer mono Int16 at the device rate, then relax as needed."""
        preferred = output.preferredFormat()
        rate = preferred.sampleRate() or 48000
        for channels in (1, preferred.channelCount() or 2):
            for sample_format in (
                QAudioFormat.SampleFormat.Int16,
                QAudioFormat.SampleFormat.Float,
            ):
                candidate = QAudioFormat()
                candidate.setSampleRate(rate)
                candidate.setChannelCount(channels)
                candidate.setSampleFormat(sample_format)
                if output.isFormatSupported(candidate):
                    return candidate
        fallback = output.preferredFormat()
        return fallback if output.isFormatSupported(fallback) else None

    def _start(self, output, fmt, pcm: bytes, label: str) -> bool:
        self._finish_reported = False
        self._stream = _PcmStream(pcm, self)
        if not self._stream.open(QIODevice.OpenModeFlag.ReadOnly):
            self._stream = None
            return self._fail("无法打开音频数据流")
        self._stream.finished.connect(self._on_stream_finished)
        self._sink = QAudioSink(output, fmt, self)
        self._sink.stateChanged.connect(self._on_state_changed)
        self._label = label
        self._sink.start(self._stream)
        self.started.emit(label)
        return True

    def stop(self) -> None:
        sink, stream = self._sink, self._stream
        self._sink = None
        self._stream = None
        if sink is not None:
            try:
                sink.stop()
            except RuntimeError:
                pass
            sink.deleteLater()
        if stream is not None:
            try:
                stream.close()
            except RuntimeError:
                pass

    def _fail(self, message: str) -> bool:
        self._error_text = message
        self.failed.emit(message)
        return False

    # ----------------------------------------------------------------- slots

    def _on_state_changed(self, state) -> None:
        if self._sink is None:
            return
        if state == QAudio.State.StoppedState:
            error = self._sink.error() if self._sink else QAudio.Error.NoError
            if error != QAudio.Error.NoError:
                self._fail(f"音频输出错误: {error}")
                self.stop()
        elif state == QAudio.State.IdleState:
            # The device drained the last buffer.
            self._report_finished()

    def _on_stream_finished(self) -> None:
        # Give the sink a moment to drain, then stop and report.
        if QTimer is not None:
            QTimer.singleShot(150, self._report_finished)

    def _report_finished(self) -> None:
        if self._finish_reported:
            return
        self._finish_reported = True
        label = self._label
        if QTimer is not None:
            QTimer.singleShot(50, self.stop)
        self.finished.emit(label)


class _PcmStream(QIODevice):
    """Sequential read-only device feeding raw PCM to a QAudioSink."""

    finished = Signal()

    def __init__(self, data: bytes, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._buffer = QByteArray(data)
        self._offset = 0
        self._done = False

    def readData(self, maxlen: int):  # noqa: N802 - Qt override
        if self._done:
            return QByteArray()
        chunk = self._buffer.mid(self._offset, maxlen)
        self._offset += chunk.size()
        if self._offset >= self._buffer.size():
            self._done = True
            self.finished.emit()
        return chunk

    def writeData(self, data) -> int:  # noqa: N802 - Qt override
        return 0

    def bytesAvailable(self) -> int:  # noqa: N802 - Qt override
        return self._buffer.size() - self._offset + super().bytesAvailable()

    def isSequential(self) -> bool:  # noqa: N802 - Qt override
        return True

    def atEnd(self) -> bool:  # noqa: N802 - Qt override
        return self._offset >= self._buffer.size()
