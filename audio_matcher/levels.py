"""Loudness measurement sized for spoken interview clips.

Why this measurement instead of ITU-R BS.1770 integrated loudness:

* the user marks a handful of seconds of *speech*, not a whole programme, so
  BS.1770's absolute/relative gating over a long programme is not what the
  editor is correcting;
* every target here is a relative match between two people's clips, and RMS
  over active speech tracks that by ear very closely;
* a short, visible, deterministic pipeline is easier to audit and to re-run on
  the exported WAV than a library gated measurement.

All levels are dBFS (0 dBFS == full scale).  Silence is reported as ``None``
rather than a misleading -inf.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Iterable, Sequence

import numpy as np

# Analysis frames.  50 ms follows speech onsets and stays stable on 16/24-bit
# material.
FRAME_SECONDS = 0.050
# A frame more than this far below the loudest frame of the same selection is
# pause for the level estimate.
SILENCE_RELATIVE_DB = 35.0
# Absolute floor; a frame below this is room/electronic noise, not speech.
SILENCE_ABSOLUTE_DBFS = -60.0
# A peak this close to full scale cannot be raised without clipping.
FULL_SCALE_MARGIN_DB = 0.01
# Shortest useful selection.
MIN_USEFUL_SECONDS = 0.10
# A "speech" range that is > this share pause gets a warning.
MAX_PAUSE_SHARE = 0.70


# ---------------------------------------------------------------------------
# Intervals
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Interval:
    """A half-open sample interval ``[start, end)``."""

    start: int
    end: int

    def __post_init__(self) -> None:
        if self.end < self.start:
            raise ValueError(f"interval end {self.end} < start {self.start}")

    @property
    def length(self) -> int:
        return self.end - self.start

    def to_list(self) -> list[int]:
        return [self.start, self.end]


def normalize_intervals(
    intervals: Iterable[Interval | Sequence[int]],
) -> list[Interval]:
    """Drop empty intervals and sort by start; does not merge."""
    out: list[Interval] = []
    for item in intervals:
        if isinstance(item, Interval):
            start, end = item.start, item.end
        else:
            start, end = int(item[0]), int(item[1])
        if end < start:
            start, end = end, start
        if end > start:
            out.append(Interval(start, end))
    out.sort(key=lambda i: (i.start, i.end))
    return out


def merge_intervals(intervals: Iterable[Interval | Sequence[int]]) -> list[Interval]:
    """Union of intervals; touching intervals merge too."""
    ordered = normalize_intervals(intervals)
    merged: list[Interval] = []
    for item in ordered:
        if merged and item.start <= merged[-1].end:
            last = merged[-1]
            merged[-1] = Interval(last.start, max(last.end, item.end))
        else:
            merged.append(item)
    return merged


def subtract_intervals(
    include: Iterable[Interval | Sequence[int]],
    exclude: Iterable[Interval | Sequence[int]] | None = None,
) -> list[Interval]:
    """``union(include) - union(exclude)`` as disjoint, sorted intervals.

    Union first means overlapping speech regions are counted once; exclusion
    then removes the actual coverage, not a sum of ranges.
    """
    remaining = merge_intervals(include)
    if exclude is None:
        return remaining
    cuts = merge_intervals(exclude)
    if not cuts:
        return remaining
    result: list[Interval] = []
    for keep in remaining:
        cursor = keep.start
        for cut in cuts:
            if cut.end <= cursor:
                continue
            if cut.start >= keep.end:
                break
            if cut.start > cursor:
                result.append(Interval(cursor, min(cut.start, keep.end)))
            cursor = max(cursor, cut.end)
            if cursor >= keep.end:
                break
        if cursor < keep.end:
            result.append(Interval(cursor, keep.end))
    return [part for part in result if part.length > 0]


def clip_intervals(intervals: Iterable[Interval], frames: int) -> list[Interval]:
    """Clamp intervals into ``[0, frames)`` and drop empties."""
    out: list[Interval] = []
    for item in intervals:
        start = max(0, min(int(item.start), int(frames)))
        end = max(0, min(int(item.end), int(frames)))
        if end > start:
            out.append(Interval(start, end))
    return normalize_intervals(out)


# ---------------------------------------------------------------------------
# Frame levels
# ---------------------------------------------------------------------------


def _mono(samples: np.ndarray) -> np.ndarray:
    data = np.asarray(samples)
    if data.ndim == 2:
        if data.shape[1] == 0:
            return np.zeros(0, dtype=np.float64)
        data = data.mean(axis=1)
    return data.astype(np.float64, copy=False)


def frame_powers(
    samples: np.ndarray, sample_rate: int
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return ``(starts_s, mean_square, sample_count)`` per frame.

    The final partial frame is kept (with its smaller count) rather than
    discarded, so a 0.12 s selection is still measured honestly.
    """
    data = _mono(samples)
    frame_len = max(1, int(round(FRAME_SECONDS * sample_rate)))
    if data.size == 0:
        empty = np.zeros(0, dtype=np.float64)
        return empty, empty, np.zeros(0, dtype=np.int64)
    full = data.size // frame_len
    remainder = data.size - full * frame_len
    pieces = data[: full * frame_len].reshape(full, frame_len)
    means = [np.mean(np.square(pieces), axis=1)]
    counts = [np.full(full, frame_len, dtype=np.int64)]
    if remainder:
        tail = data[full * frame_len :]
        means.append(np.array([np.mean(np.square(tail))]))
        counts.append(np.array([tail.size], dtype=np.int64))
    mean_square = np.concatenate(means) if means else np.zeros(0)
    count = np.concatenate(counts) if counts else np.zeros(0, dtype=np.int64)
    starts = np.arange(mean_square.size, dtype=np.float64) * frame_len / sample_rate
    return starts, mean_square, count


def power_to_db(power: float) -> float | None:
    if power <= 0.0 or not math.isfinite(power):
        return None
    return 10.0 * math.log10(power)


def peak_db(data: np.ndarray) -> float | None:
    """Absolute sample peak of a block, in dBFS; ``None`` for pure silence."""
    if data.size == 0:
        return None
    peak = float(np.max(np.abs(data)))
    return 20.0 * math.log10(peak) if peak > 0 else None


def active_mask(
    frame_db: np.ndarray,
    relative_floor_db: float = SILENCE_RELATIVE_DB,
    absolute_floor_dbfs: float = SILENCE_ABSOLUTE_DBFS,
) -> np.ndarray:
    """Frames that count as speech for the loudness estimate."""
    if frame_db.size == 0:
        return np.zeros(0, dtype=bool)
    finite = np.where(np.isfinite(frame_db), frame_db, -math.inf)
    loudest = float(np.max(finite))
    if not math.isfinite(loudest):
        return np.zeros(frame_db.shape, dtype=bool)
    floor = max(loudest - relative_floor_db, absolute_floor_dbfs)
    return finite >= floor


# ---------------------------------------------------------------------------
# Multi-interval selection measurement (the model the app stores)
# ---------------------------------------------------------------------------


@dataclass
class FragmentMeasurement:
    """Measurement of one effective, disjoint interval."""

    start: int
    end: int
    duration_s: float
    active_s: float
    rms_db: float | None
    peak_db: float | None
    active_share: float
    share_of_selection: float
    warning_codes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "start_sample": self.start,
            "end_sample": self.end,
            "duration_s": self.duration_s,
            "active_s": self.active_s,
            "rms_db": self.rms_db,
            "peak_db": self.peak_db,
            "active_share": self.active_share,
            "share_of_selection": self.share_of_selection,
            "warning_codes": list(self.warning_codes),
        }

    @classmethod
    def from_dict(cls, data: dict) -> "FragmentMeasurement":
        return cls(
            start=int(data["start_sample"]),
            end=int(data["end_sample"]),
            duration_s=float(data.get("duration_s", 0.0)),
            active_s=float(data.get("active_s", 0.0)),
            rms_db=_optional_float(data.get("rms_db")),
            peak_db=_optional_float(data.get("peak_db")),
            active_share=float(data.get("active_share", 0.0)),
            share_of_selection=float(data.get("share_of_selection", 0.0)),
            warning_codes=list(data.get("warning_codes", [])),
        )


@dataclass
class SelectionMeasurement:
    """Combined measurement of speech minus excluded coverage."""

    fragments: list[FragmentMeasurement]
    effective_intervals: list[Interval]
    total_duration_s: float
    active_s: float
    rms_db: float | None
    selection_peak_db: float | None
    clip_peak_db: float | None
    frame_seconds: float
    warning_codes: list[str]
    measured_at: str

    @property
    def selection_duration_s(self) -> float:
        return sum(item.duration_s for item in self.fragments)

    @property
    def pause_share(self) -> float:
        if self.selection_duration_s <= 0:
            return 1.0
        return max(0.0, 1.0 - self.active_s / self.selection_duration_s)

    @property
    def silent(self) -> bool:
        return self.rms_db is None

    @property
    def too_short(self) -> bool:
        return "too_short" in self.warning_codes

    @property
    def provenance(self) -> list[dict]:
        """Where the effective samples came from, for display and reports."""
        return [
            {
                "start_s": item.start / max(1e-9, self._sr),
                "end_s": item.end / max(1e-9, self._sr),
                "share": item.share_of_selection,
                "rms_db": item.rms_db,
            }
            for item in self.fragments
        ]

    # ``sample_rate`` is kept out of the serialized payload but attached when
    # loading; it makes ``provenance`` readable without a parallel table.
    _sr: float = 0.0

    def to_dict(self) -> dict:
        return {
            "fragments": [f.to_dict() for f in self.fragments],
            "effective_intervals": [i.to_list() for i in self.effective_intervals],
            "total_duration_s": self.total_duration_s,
            "active_s": self.active_s,
            "rms_db": self.rms_db,
            "selection_peak_db": self.selection_peak_db,
            "clip_peak_db": self.clip_peak_db,
            "frame_seconds": self.frame_seconds,
            "warning_codes": list(self.warning_codes),
            "measured_at": self.measured_at,
        }

    @classmethod
    def from_dict(cls, data: dict, sample_rate: float = 0.0) -> "SelectionMeasurement":
        fragments = [FragmentMeasurement.from_dict(f) for f in data.get("fragments", [])]
        intervals = [Interval(int(a), int(b)) for a, b in data.get("effective_intervals", [])]
        return cls(
            fragments=fragments,
            effective_intervals=intervals,
            total_duration_s=float(data.get("total_duration_s", 0.0)),
            active_s=float(data.get("active_s", 0.0)),
            rms_db=_optional_float(data.get("rms_db")),
            selection_peak_db=_optional_float(data.get("selection_peak_db")),
            clip_peak_db=_optional_float(data.get("clip_peak_db")),
            frame_seconds=float(data.get("frame_seconds", FRAME_SECONDS)),
            warning_codes=list(data.get("warning_codes", [])),
            measured_at=str(data.get("measured_at", "")),
            _sr=float(sample_rate),
        )


def _optional_float(value: object) -> float | None:
    if value is None:
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) else None


def measure_selection(
    samples: np.ndarray,
    sample_rate: int,
    speech: Iterable[Interval | Sequence[int]],
    exclude: Iterable[Interval | Sequence[int]] | None = None,
) -> SelectionMeasurement:
    """Measure speech coverage after exclusions, without double counting.

    Overlapping speech ranges are unioned and overlapping excludes are unioned
    before subtraction, so a sample in the overlap contributes once.
    """
    data = np.asarray(samples)
    frames = int(data.shape[0]) if data.ndim else 0
    speech_iv = clip_intervals(normalize_intervals(speech), frames)
    exclude_iv = clip_intervals(normalize_intervals(exclude or []), frames)
    effective = subtract_intervals(speech_iv, exclude_iv)
    clip_peak = peak_db(data) if frames else None
    warnings: list[str] = []

    if not speech_iv:
        warnings.append("no_speech_selection")
    elif not effective:
        warnings.append("all_excluded")

    # Frame energies for every effective fragment, then one shared gate.
    all_db: list[float] = []
    per_fragment: list[tuple[Interval, np.ndarray, np.ndarray, np.ndarray, float | None]] = []
    for iv in effective:
        segment = data[iv.start : iv.end]
        starts, power, counts = frame_powers(segment, sample_rate)
        levels = np.full(power.shape, -math.inf)
        positive = power > 0
        levels[positive] = 10.0 * np.log10(power[positive])
        per_fragment.append((iv, starts, power, counts, peak_db(segment)))
        all_db.extend(float(v) for v in levels)

    if all_db:
        mask_all = active_mask(np.asarray(all_db))
        active_set = set(np.nonzero(mask_all)[0].tolist())
    else:
        active_set = set()

    fragments: list[FragmentMeasurement] = []
    kept_total = sum(iv.length for iv in effective)
    offset = 0
    total_active_samples = 0
    total_active_energy = 0.0
    for iv, _starts, power, counts, fragment_peak_db in per_fragment:
        local_flags = np.array(
            [offset + index in active_set for index in range(power.size)], dtype=bool
        )
        offset += power.size
        fragment_active_samples = int(counts[local_flags].sum()) if power.size else 0
        fragment_active_s = fragment_active_samples / float(sample_rate)
        fragment_rms: float | None = None
        if fragment_active_samples:
            energy = float(
                np.sum(power[local_flags] * counts[local_flags]) / fragment_active_samples
            )
            fragment_rms = power_to_db(energy)
            total_active_energy += energy * fragment_active_samples
            total_active_samples += fragment_active_samples
        duration = iv.length / float(sample_rate)
        share = iv.length / kept_total if kept_total else 0.0
        active_share = fragment_active_s / duration if duration else 0.0
        codes: list[str] = []
        if duration < MIN_USEFUL_SECONDS:
            codes.append("too_short")
        if fragment_rms is None:
            codes.append("silent")
        fragments.append(
            FragmentMeasurement(
                start=iv.start,
                end=iv.end,
                duration_s=duration,
                active_s=fragment_active_s,
                rms_db=fragment_rms,
                peak_db=fragment_peak_db,
                active_share=active_share,
                share_of_selection=share,
                warning_codes=codes,
            )
        )

    combined_rms = (
        power_to_db(total_active_energy / total_active_samples)
        if total_active_samples
        else None
    )
    total_duration = kept_total / float(sample_rate) if sample_rate else 0.0
    active_s = total_active_samples / float(sample_rate)

    if effective and total_duration < MIN_USEFUL_SECONDS:
        warnings.append("too_short")
    if effective and combined_rms is None:
        warnings.append("silent")
    if (
        combined_rms is not None
        and total_duration > 0
        and (1.0 - active_s / total_duration) > MAX_PAUSE_SHARE
    ):
        warnings.append("mostly_pause")
    if any(item.rms_db is None for item in fragments):
        warnings.append("some_fragments_silent")
    if any("too_short" in item.warning_codes for item in fragments):
        warnings.append("some_fragments_too_short")

    selection_peak = None
    if effective:
        selection_peak = peak_db(
            np.concatenate([data[iv.start : iv.end] for iv in effective])
        )

    return SelectionMeasurement(
        fragments=fragments,
        effective_intervals=effective,
        total_duration_s=total_duration,
        active_s=active_s,
        rms_db=combined_rms,
        selection_peak_db=selection_peak,
        clip_peak_db=clip_peak,
        frame_seconds=FRAME_SECONDS,
        warning_codes=_unique(warnings),
        measured_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        _sr=float(sample_rate),
    )


def _unique(values: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        if value not in seen:
            seen.add(value)
            out.append(value)
    return out


# ---------------------------------------------------------------------------
# Region model (persisted)
# ---------------------------------------------------------------------------


@dataclass
class Region:
    """A user-drawn half-open range, either speech or explicit exclusion."""

    kind: str  # "speech" | "exclude"
    start: int
    end: int

    def __post_init__(self) -> None:
        if self.kind not in ("speech", "exclude"):
            raise ValueError(f"unknown region kind: {self.kind!r}")
        if self.end < self.start:
            self.start, self.end = self.end, self.start

    def to_dict(self) -> dict:
        return {"kind": self.kind, "start_sample": self.start, "end_sample": self.end}

    @classmethod
    def from_dict(cls, data: dict) -> "Region":
        return cls(
            kind=str(data["kind"]),
            start=int(data["start_sample"]),
            end=int(data["end_sample"]),
        )


def regions_to_intervals(regions: Iterable[Region], kind: str) -> list[Interval]:
    return [Interval(r.start, r.end) for r in regions if r.kind == kind and r.end > r.start]


def summarize_warning(code: str) -> str:
    return {
        "no_speech_selection": "还没有讲话区",
        "all_excluded": "排除区覆盖了全部讲话区",
        "silent": "选区没有可用语音，电平无法测量",
        "too_short": "有效选区太短（< 0.10 s）",
        "mostly_pause": "选区内大部分是停顿，电平可能不稳",
        "some_fragments_silent": "有讲话区片段是静音",
        "some_fragments_too_short": "有讲话区片段太短",
    }.get(code, code)


def selection_provenance_text(measurement: SelectionMeasurement) -> str:
    if not measurement.fragments:
        return "无有效样本"
    parts = []
    for fragment in measurement.fragments:
        start = fragment.start / measurement._sr if measurement._sr else 0.0
        end = fragment.end / measurement._sr if measurement._sr else 0.0
        parts.append(f"{start:.2f}-{end:.2f}s ({fragment.share_of_selection * 100:.0f}%)")
    return "，".join(parts)


