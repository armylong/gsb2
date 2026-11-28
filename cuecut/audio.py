"""Audio reading, peak caching and source-anchored audition playback.

Requirement 4 hinges on this module: an audition is always read from the
**source** WAV at a fixed sample range.  Switching split modes only changes
which output file owns a region; it never seeks, never swaps buffers and
never changes the stream, so the sound at a junction stays on the same
timeline.

Playback uses PortAudio through ``sounddevice`` when available.  If the
device or library is missing (headless CI), the player still advances a
wall-clock cursor so the UI and tests behave identically.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import List, Optional, Tuple

import numpy as np
import soundfile as sf

from .model import AudioInfo

try:  # short import alias; sounddevice pulls in PortAudio
    import sounddevice as _sd
except Exception:  # pragma: no cover - only where PortAudio is absent
    _sd = None


def read_info(path: str) -> AudioInfo:
    info = sf.info(path)
    return AudioInfo(
        path=path,
        samplerate=int(info.samplerate),
        channels=int(info.channels),
        total_samples=int(info.frames),
        subtype=str(info.subtype or ""),
    )


def read_samples(path: str, first: int, count: int, dtype: str = "float64") -> np.ndarray:
    """Read an inclusive-start range from a WAV; tail may be short at EOF."""
    with sf.SoundFile(path, "r") as f:
        f.seek(max(0, first))
        return f.read(max(0, count), dtype=dtype, always_2d=True)


class AudioSource:
    """Chunked, thread-safe reader for one WAV file."""

    CHUNK = 1 << 20  # ~23 s at 44.1 kHz

    def __init__(self, path: str):
        self.info = read_info(path)
        self.path = path
        self._lock = threading.Lock()
        self._sf = sf.SoundFile(path, "r")

    def close(self) -> None:
        with self._lock:
            if self._sf is not None:
                self._sf.close()
                self._sf = None

    def read(self, first: int, count: int) -> np.ndarray:
        if count <= 0:
            return np.zeros((0, self.info.channels), dtype=np.float64)
        with self._lock:
            if self._sf is None:
                raise RuntimeError("audio source is closed")
            self._sf.seek(max(0, first))
            data = self._sf.read(count, dtype="float64", always_2d=True)
        return data

    def peaks(self, first: int, last: int, buckets: int) -> List[Tuple[float, float]]:
        """Min/max envelope for the inclusive sample range [first, last]."""
        buckets = max(1, int(buckets))
        first = max(0, min(first, self.info.total_samples))
        last = max(first - 1, min(last, self.info.total_samples - 1))
        span = last - first + 1
        if span <= 0:
            return [(0.0, 0.0)] * buckets
        if span <= self.CHUNK * 2:
            data = self.read(first, span)
            if len(data) == 0:
                return [(0.0, 0.0)] * buckets
            idx = np.linspace(0, len(data), buckets + 1).astype(np.int64)
            out = []
            for b in range(buckets):
                piece = data[idx[b]:max(idx[b] + 1, idx[b + 1])]
                if len(piece) == 0:
                    out.append((0.0, 0.0))
                else:
                    out.append((float(piece.min()), float(piece.max())))
            return out

        bucket_size = span / buckets
        mins = np.full(buckets, np.inf)
        maxs = np.full(buckets, -np.inf)
        cursor = first
        while cursor <= last:
            n = min(self.CHUNK, last - cursor + 1)
            data = self.read(cursor, n)
            if len(data) == 0:
                break
            table = np.clip(
                ((np.arange(cursor, cursor + len(data)) - first) / bucket_size).astype(np.int64),
                0,
                buckets - 1,
            )
            np.minimum.at(mins, table, data.min(axis=1))
            np.maximum.at(maxs, table, data.max(axis=1))
            cursor += n
        out = []
        for b in range(buckets):
            if not np.isfinite(mins[b]):
                out.append((0.0, 0.0))
            else:
                out.append((float(mins[b]), float(maxs[b])))
        return out


class OverviewPeaks:
    """Background-computed coarse envelope for the whole file."""

    DEFAULT_BUCKETS = 16384

    def __init__(self, source: AudioSource, buckets: int = DEFAULT_BUCKETS):
        self.source = source
        self.buckets = buckets
        self._data: Optional[List[Tuple[float, float]]] = None
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()
        self._error: Optional[str] = None
        self._cache_key: Optional[tuple] = None
        self._cache_value: Optional[List[Tuple[float, float]]] = None

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, name="overview-peaks", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        try:
            peaks = self.source.peaks(0, self.source.info.total_samples - 1, self.buckets)
        except Exception as exc:  # keep the UI alive; the fine reader still works
            self._error = str(exc)
            peaks = [(0.0, 0.0)] * self.buckets
        with self._lock:
            self._data = peaks
            # The flat placeholder returned before the pass finished may be
            # cached; drop it now that real peaks exist.
            self._cache_key = None
            self._cache_value = None

    def ready(self) -> bool:
        with self._lock:
            return self._data is not None

    @property
    def error(self) -> Optional[str]:
        return self._error

    def wait(self, timeout: Optional[float] = None) -> None:
        if self._thread is not None:
            self._thread.join(timeout)

    def get(self, view_first: int, view_last: int, width: int) -> List[Tuple[float, float]]:
        width = max(1, int(width))
        span = max(1, view_last - view_first + 1)
        total = max(1, self.source.info.total_samples)
        # Painting repeats for the same geometry (hover, playhead moves);
        # cache the last envelope per exact view to keep ticks cheap.
        cache_key = (view_first, view_last, width)
        with self._lock:
            if self._cache_key == cache_key and self._cache_value is not None:
                return self._cache_value
        value = self._compute(view_first, view_last, width, span, total)
        with self._lock:
            self._cache_key = cache_key
            self._cache_value = value
        return value

    def _compute(self, view_first: int, view_last: int, width: int, span: int, total: int) -> List[Tuple[float, float]]:
        with self._lock:
            data = self._data
        if data is None:
            # Background pass not finished: paint flat rather than blocking
            # the UI thread on a multi-minute file.
            return [(0.0, 0.0)] * width
        # Coarse cache is far cheaper; a "fine" read of the visible range is
        # capped at ~1M samples (~23 s) so zooming out never blocks the UI.
        fine_enough = span <= 1_000_000
        if not fine_enough:
            b0 = int(view_first / total * self.buckets)
            b1 = int(view_last / total * self.buckets)
            b0 = max(0, min(b0, self.buckets - 1))
            b1 = max(b0, min(b1, self.buckets - 1))
            chunk = data[b0:b1 + 1]
            if not chunk:
                return [(0.0, 0.0)] * width
            idx = np.linspace(0, len(chunk), width + 1).astype(np.int64)
            out: List[Tuple[float, float]] = []
            for i in range(width):
                a, b = idx[i], max(idx[i] + 1, idx[i + 1])
                piece = chunk[a:b]
                if not piece:
                    out.append((0.0, 0.0))
                else:
                    out.append((min(p[0] for p in piece), max(p[1] for p in piece)))
            return out
        try:
            return self.source.peaks(view_first, view_last, width)
        except Exception:
            return [(0.0, 0.0)] * width


@dataclass
class PlaybackStatus:
    active: bool
    position: int  # source sample currently being heard
    region_start: int
    region_end: int  # exclusive


class PreviewPlayer:
    """Play a source range, optionally looping; position is in source samples.

    Mode changes never touch this object's stream.  ``set_mode`` exists only
    so callers can record which split is on screen.
    """

    BLOCK = 1024

    def __init__(self, source: AudioSource):
        self.source = source
        self._lock = threading.RLock()
        self._data: Optional[np.ndarray] = None
        self._region_start = 0
        self._region_count = 0
        self._cursor = 0  # frames consumed from _data
        self._delivered = 0
        self._loop = False
        self._active = False
        self._stream = None
        self._silent = False
        self._start_time = 0.0
        self._true_end = 0  # source-exclusive end of the region
        self._volume = 1.0
        self._mode = None
        self._out_channels = 0

    # -- configuration -----------------------------------------------------
    @property
    def region(self) -> Tuple[int, int]:
        return self._region_start, self._true_end

    def set_mode(self, mode) -> None:
        """Record the visible split mode.  Deliberately does not touch audio."""
        self._mode = mode

    @property
    def mode(self):
        return self._mode

    def set_loop(self, loop: bool) -> None:
        with self._lock:
            self._loop = bool(loop)

    @property
    def loop(self) -> bool:
        with self._lock:
            return self._loop

    def set_volume(self, v: float) -> None:
        with self._lock:
            self._volume = max(0.0, min(1.0, float(v)))

    # -- transport ---------------------------------------------------------
    def start(self, first: int, last_inclusive: int, loop: Optional[bool] = None) -> None:
        """Play source samples [first, last_inclusive]; restart if playing."""
        first = max(0, int(first))
        count = max(0, min(int(last_inclusive), self.source.info.total_samples - 1) - first + 1)
        if count <= 0:
            self.stop()
            return
        data = self.source.read(first, count).astype(np.float32)
        with self._lock:
            self._data = np.ascontiguousarray(data)
            self._region_start = first
            self._true_end = first + len(data)
            self._region_count = len(data)
            self._cursor = 0
            self._delivered = 0
            self._active = True
            if loop is not None:
                self._loop = bool(loop)
            self._silent = _sd is None
            self._start_time = time.monotonic()
        if _sd is not None:
            self._open_stream()
        # _open_stream() starts the stream itself; never start it twice.

    def _open_stream(self) -> None:
        """Open an output stream; fall back to 2/mono, then to silent mode."""
        if _sd is None:
            return
        sr = self.source.info.samplerate
        candidates = [self.source.info.channels]
        if self.source.info.channels > 2:
            candidates.append(2)
        if 1 not in candidates:
            candidates.append(1)
        for ch in candidates:
            try:
                stream = _sd.OutputStream(
                    samplerate=sr,
                    channels=ch,
                    dtype="float32",
                    blocksize=self.BLOCK,
                    callback=self._callback,
                )
                stream.start()
                with self._lock:
                    self._stream = stream
                    self._out_channels = ch
                    self._delivered = 0
                return
            except Exception:
                continue
        with self._lock:
            self._silent = True
            self._stream = None

    def _callback(self, outdata, frames, time_info, status) -> None:
        with self._lock:
            data = self._data
            if data is None or not self._active:
                outdata[:] = 0
                return
            n = len(data)
            src_ch = data.shape[1]
            out_ch = self._out_channels or src_ch
            # Map source channels to the device: truncate if the device wants
            # fewer; duplicate mono if it wants more.
            if out_ch <= src_ch:
                view = data[:, :out_ch]
            else:
                view = np.repeat(data[:, :1], out_ch, axis=1)
            pos = self._cursor
            filled = 0
            guard = 0
            while filled < frames and guard < frames * 2 + 4:
                take = min(frames - filled, n - pos)
                if take <= 0:
                    if self._loop:
                        pos = 0
                        guard += 1
                        continue
                    break
                outdata[filled:filled + take, :out_ch] = view[pos:pos + take] * self._volume
                filled += take
                pos += take
                guard += 1
            if filled < frames:
                outdata[filled:] = 0
            self._cursor = pos
            self._delivered += frames
            if not self._loop and pos >= n:
                self._active = False

    def stop(self) -> None:
        stream = None
        with self._lock:
            self._active = False
            stream = self._stream
            self._stream = None
            self._out_channels = 0
        if stream is not None:
            try:
                stream.stop()
                stream.close()
            except Exception:
                pass

    def position(self) -> int:
        """Source sample currently being heard (best estimate)."""
        with self._lock:
            if not self._active and self._data is None:
                return self._region_start
            if self._silent:
                elapsed = int((time.monotonic() - self._start_time) * self.source.info.samplerate)
                n = self._region_count
                if n <= 0:
                    return self._region_start
                pos = self._cursor + elapsed
                if self._loop:
                    pos = pos % n
                return self._region_start + min(pos, n - 1)
            if self._stream is None:
                return self._region_start + min(self._cursor, max(0, self._region_count - 1))
            latency = 0
            try:
                latency = int(float(self._stream.latency) * self.source.info.samplerate)
            except Exception:
                latency = 0
            played = max(0, self._delivered - latency)
            n = self._region_count
            pos = played
            if self._loop and n > 0:
                pos = pos % n
            return self._region_start + min(pos, max(0, n - 1))

    def is_active(self) -> bool:
        with self._lock:
            if not self._active:
                return False
            if self._silent:
                elapsed = int((time.monotonic() - self._start_time) * self.source.info.samplerate)
                n = self._region_count
                if self._loop:
                    return True
                if n <= 0 or elapsed + self._cursor >= n:
                    return False
            return True

    def status(self) -> PlaybackStatus:
        return PlaybackStatus(
            active=self.is_active(),
            position=self.position(),
            region_start=self._region_start,
            region_end=self._true_end,
        )

    def shutdown(self) -> None:
        self.stop()
        with self._lock:
            self._data = None
            self._region_count = 0
