from __future__ import annotations

import json
from pathlib import Path

import numpy as np
from PySide6.QtCore import QBuffer, QByteArray, QObject, QTimer, Signal
from PySide6.QtGui import QImage
from PySide6.QtMultimedia import QAudioFormat, QAudioSink

from .core import AUDIO_RATE, META_KEY, Segment


def gray_to_qimage(gray: np.ndarray) -> QImage:
    arr = np.ascontiguousarray(gray, dtype=np.uint8)
    h, w = arr.shape
    img = QImage(arr.data, w, h, int(arr.strides[0]), QImage.Format.Format_Grayscale8)
    # copy() detaches the QImage from the NumPy buffer lifetime.
    return img.copy()


def qimage_to_gray(img: QImage) -> np.ndarray:
    img = img.convertToFormat(QImage.Format.Format_Grayscale8)
    h = img.height()
    w = img.width()
    bpl = img.bytesPerLine()
    bits = img.constBits()
    if hasattr(bits, "tobytes"):
        raw = bits.tobytes()
    else:
        raw = bytes(bits)
    arr = np.frombuffer(raw, dtype=np.uint8, count=h * bpl).reshape(h, bpl)
    return arr[:, :w].copy()


def save_track_png(path: str | Path, gray: np.ndarray, meta: dict) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    img = gray_to_qimage(gray)
    img.setText(META_KEY, json.dumps(meta, ensure_ascii=False, separators=(",", ":")))
    if not img.save(str(path), "PNG"):
        raise OSError(f"无法写入 PNG：{path}")


def load_track_png(path: str | Path) -> tuple[np.ndarray, dict, list[Segment]]:
    path = Path(path)
    img = QImage(str(path))
    if img.isNull():
        raise ValueError(f"无法读取 PNG：{path}")
    text = img.text(META_KEY)
    if text:
        try:
            meta = json.loads(text)
        except json.JSONDecodeError:
            meta = {}
    else:
        meta = {}
    gray = qimage_to_gray(img)
    if not meta:
        h, w = gray.shape
        meta = {"width_px": w, "center_x": w / 2.0, "n_rows": h}
    segments = [Segment.from_dict(d) for d in meta.get("segments", [])]
    return gray, meta, segments


class AudioPlayer(QObject):
    positionChanged = Signal(float, float)
    playbackStopped = Signal()

    def __init__(self, parent: QObject | None = None) -> None:
        super().__init__(parent)
        self._sink: QAudioSink | None = None
        self._buffer: QBuffer | None = None
        self._offset = 0.0
        self._end: float | None = None
        self._duration = 0.0
        self._timer = QTimer(self)
        self._timer.setInterval(30)
        self._timer.timeout.connect(self._poll)

    def play(
        self,
        samples: np.ndarray,
        rate: int = AUDIO_RATE,
        start: float = 0.0,
        end: float | None = None,
    ) -> None:
        self.stop()
        y = np.nan_to_num(np.asarray(samples, dtype=np.float32), nan=0.0)
        a = max(0, int(start * rate))
        b = len(y) if end is None else min(len(y), int(end * rate))
        part = np.clip(y[a:b], -1.0, 1.0)
        pcm = np.round(part * 32767).astype("<i2").tobytes()

        fmt = QAudioFormat()
        fmt.setSampleRate(rate)
        fmt.setChannelCount(1)
        fmt.setSampleFormat(QAudioFormat.SampleFormat.Int16)

        self._sink = QAudioSink(fmt, self)
        self._buffer = QBuffer(self)
        self._buffer.setData(QByteArray(pcm))
        self._buffer.open(QBuffer.OpenModeFlag.ReadOnly)
        self._offset = a / rate
        self._end = end
        self._duration = len(y) / rate
        self._sink.start(self._buffer)
        self._timer.start()

    def stop(self) -> None:
        self._timer.stop()
        if self._sink is not None:
            self._sink.stop()
            self._sink.deleteLater()
            self._sink = None
        if self._buffer is not None:
            self._buffer.close()
            self._buffer.deleteLater()
            self._buffer = None
        self.playbackStopped.emit()

    def _poll(self) -> None:
        if self._sink is None:
            return
        pos = self._offset + self._sink.processedUSecs() / 1_000_000.0
        if self._end is not None and pos >= self._end:
            self.stop()
            return
        if self._duration and pos >= self._duration + 0.05:
            self.stop()
            return
        self.positionChanged.emit(min(pos, self._duration), self._duration)
