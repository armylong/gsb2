"""Real-time playback via sounddevice.

The player owns one output stream.  Everything it plays is a pre-rendered
buffer, so the preview and the export use exactly the same render code and
timeline.  Stop/abort bumps a generation counter, so any block still in
flight is replaced by silence and an old loop can never leak into the next
one.
"""

from __future__ import annotations

import threading
from typing import Callable

import numpy as np


class AudioPlayer:
    def __init__(self, samplerate: int = 44100, channels: int = 2):
        self.samplerate = samplerate
        self.channels = channels
        self._lock = threading.Lock()
        self._buf: np.ndarray | None = None
        self._pos = 0
        self._loop = False
        self._playing = False
        self._generation = 0
        self._stream = None
        self._on_finished: Callable[[], None] | None = None
        self._error: str | None = None

    # -- configuration ------------------------------------------------------
    def configure(self, samplerate: int, channels: int) -> None:
        """Match the loaded material; recreates the stream when needed.

        Output streams are opened with at least two channels because many
        CoreAudio devices reject mono; a mono source is duplicated to both
        channels for auditioning only (the export stays mono).
        """
        out_channels = max(2, int(channels))
        if samplerate == self.samplerate and out_channels == self.channels:
            return
        self.stop()
        self.close()
        self.samplerate = int(samplerate)
        self.channels = out_channels

    def close(self) -> None:
        stream, self._stream = self._stream, None
        if stream is not None:
            try:
                stream.stop(ignore_errors=True)
                stream.close(ignore_errors=True)
            except Exception:
                pass

    # -- transport ----------------------------------------------------------
    @property
    def playing(self) -> bool:
        return self._playing

    @property
    def error(self) -> str | None:
        return self._error

    def play(self, audio: np.ndarray, *, loop: bool = False,
             on_finished: Callable[[], None] | None = None) -> bool:
        """Start playback of a complete rendered buffer.

        Returns False if no audio device could be opened; the caller can
        still export.  The buffer is copied and converted to the stream's
        channel count (without collapsing stereo).
        """
        data = np.asarray(audio, dtype=np.float32)
        if data.ndim == 1:
            data = data[:, None]
        if data.shape[1] != self.channels:
            if data.shape[1] == 1 and self.channels == 2:
                data = np.repeat(data, 2, axis=1)
            elif data.shape[1] > self.channels:
                data = data[:, : self.channels]
            elif data.shape[1] < self.channels:
                data = np.repeat(data, self.channels, axis=1)
        data = np.ascontiguousarray(data)
        if data.shape[0] == 0:
            return False

        with self._lock:
            self._generation += 1
            self._buf = data
            self._pos = 0
            self._loop = bool(loop)
            self._playing = True
            self._on_finished = on_finished

        ok = self._ensure_stream()
        if not ok:
            with self._lock:
                self._playing = False
                self._buf = None
            return False
        return True

    def stop(self) -> None:
        """Hard stop: discard queued audio and silence the device."""
        with self._lock:
            self._generation += 1
            self._playing = False
            self._buf = None
            self._pos = 0
            self._on_finished = None
        stream = self._stream
        if stream is not None:
            try:
                # abort discards the device queue, so not even one block of
                # the previous loop survives into the next play().
                stream.abort(ignore_errors=True)
                stream.start()
            except Exception:
                pass

    # -- stream plumbing ----------------------------------------------------
    def _ensure_stream(self) -> bool:
        if self._stream is not None:
            try:
                if not self._stream.active:
                    self._stream.start()
                return True
            except Exception as exc:  # pragma: no cover - device specific
                self._error = str(exc)
                return False
        try:
            import sounddevice as sd

            self._stream = sd.OutputStream(
                samplerate=self.samplerate,
                channels=self.channels,
                dtype="float32",
                callback=self._callback,
                blocksize=256,
            )
            self._stream.start()
            self._error = None
            return True
        except Exception as exc:  # pragma: no cover - device specific
            self._stream = None
            self._error = f"无法打开音频输出设备: {exc}"
            return False

    def _callback(self, outdata, frames, time_info, status):  # noqa: ANN001
        del time_info, status
        with self._lock:
            gen = self._generation
            buf = self._buf
            pos = self._pos
            loop = self._loop
            if not self._playing or buf is None:
                outdata.fill(0)
                return
            total = buf.shape[0]
            written = 0
            while written < frames:
                if pos >= total:
                    if loop:
                        pos = 0
                    else:
                        self._playing = False
                        self._buf = None
                        finished = self._on_finished
                        self._on_finished = None
                        outdata[written:].fill(0)
                        # notify outside of the audio cycle
                        if finished is not None:
                            threading.Thread(target=finished, daemon=True).start()
                        return
                n = min(frames - written, total - pos)
                outdata[written:written + n] = buf[pos:pos + n]
                written += n
                pos += n
            # A newer generation means stop()/play() raced this block; the
            # caller already discarded it, so do not persist its position.
            if gen == self._generation:
                self._pos = pos


def preview_slice(source_samples: np.ndarray, start: int, end: int,
                  fade_in_s: float, fade_out_s: float,
                  samplerate: int) -> np.ndarray:
    """Render a single slice with the same fade rules, for auditioning."""
    clip = np.asarray(source_samples[start:end], dtype=np.float32)
    if clip.size == 0:
        return clip
    clip = clip.copy()
    n = clip.shape[0]
    fi = min(int(round(max(0.0, fade_in_s) * samplerate)), n)
    fo = min(int(round(max(0.0, fade_out_s) * samplerate)), n)
    if fi > 0:
        ramp = np.linspace(0.0, 1.0, fi, dtype=np.float32)
        clip[:fi] *= ramp if clip.ndim == 1 else ramp[:, None]
    if fo > 0:
        ramp = np.linspace(1.0, 0.0, fo, dtype=np.float32)
        clip[n - fo:] *= ramp if clip.ndim == 1 else ramp[:, None]
    return clip
