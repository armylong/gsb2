"""Time scale helpers shared by the model, the exporter and the GUI."""

from __future__ import annotations

from fractions import Fraction


def sample_at(t: Fraction, samplerate: int) -> int:
    """Sample index at or before time ``t`` (floor)."""
    return int((t * samplerate).__floor__())


def time_at(sample: int, samplerate: int) -> Fraction:
    return Fraction(sample, samplerate)


def format_mmssff(t: Fraction) -> str:
    """Cue-sheet style MM:SS:FF (75 frames per second), rounded down."""
    frames = int((t * 75).__floor__())
    ff = frames % 75
    secs = frames // 75
    mm, ss = divmod(secs, 60)
    return f"{mm:02d}:{ss:02d}:{ff:02d}"


def format_clock(t: Fraction, signed: bool = False) -> str:
    """MM:SS.mmm, with an explicit sign when asked (used for in-track time)."""
    seconds = float(t)
    sign = "-" if seconds < 0 else ("+" if signed else "")
    seconds = abs(seconds)
    mm = int(seconds // 60)
    rest = seconds - mm * 60
    return f"{sign}{mm:02d}:{rest:06.3f}"


def format_duration(sample_count: int, samplerate: int) -> str:
    return format_clock(time_at(sample_count, samplerate))


def nice_step(span_seconds: float) -> float:
    """Pick a human tick spacing for a ruler of the given visible span."""
    candidates = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30,
                  60, 120, 300, 600, 900, 1800, 3600]
    target = span_seconds / 8.0
    for c in candidates:
        if c >= target:
            return c
    return candidates[-1]
