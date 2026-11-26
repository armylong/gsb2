"""Target-time parsing and scrub intervals."""

from __future__ import annotations

import json
import math
import os
from typing import Any

from .probe import TIME_EPSILON


def parse_target_times(
    times: str | None = None,
    times_file: str | None = None,
    interval: float | None = None,
    duration: float | None = None,
) -> list[float]:
    values: list[float] = []
    if interval is not None:
        if interval <= 0:
            raise ValueError("--interval must be positive")
        if duration is None or duration <= 0:
            raise ValueError("duration is required for interval sampling")
        t = 0.0
        # Include every grid point up to the terminal time.  A grid point
        # within one microsecond of duration is represented by duration itself.
        while t <= duration + TIME_EPSILON:
            values.append(min(t, duration))
            next_t = t + interval
            if next_t <= t + TIME_EPSILON:
                raise ValueError("interval is too small to make progress")
            t = next_t
    if times:
        values.extend(_parse_times_text(times))
    if times_file:
        values.extend(_parse_times_file(times_file))
    if not values:
        raise ValueError("provide --interval, --times, or --times-file")

    cleaned: list[float] = []
    for v in values:
        if not math.isfinite(v):
            raise ValueError(f"target time {v!r} is not finite")
        if v < -TIME_EPSILON:
            raise ValueError(f"target time {v} is before the zero timeline")
        if duration is not None and v > duration + TIME_EPSILON:
            raise ValueError(f"target time {v:.6f} exceeds timeline duration {duration:.6f}")
        v = max(0.0, min(v, duration if duration is not None else v))
        if not cleaned or abs(v - cleaned[-1]) > TIME_EPSILON:
            cleaned.append(round(float(v), 9))
    cleaned.sort()
    # Sorting can reveal duplicates not adjacent during parsing.
    deduped: list[float] = []
    for v in cleaned:
        if not deduped or abs(v - deduped[-1]) > TIME_EPSILON:
            deduped.append(v)
    return deduped


def _parse_times_text(text: str) -> list[float]:
    stripped = text.strip()
    if not stripped:
        return []
    if stripped.startswith("["):
        try:
            data = json.loads(stripped)
            return [parse_timecode(x) for x in data]
        except (json.JSONDecodeError, TypeError, ValueError) as exc:
            raise ValueError(f"invalid JSON time list {text!r}: {exc}") from exc
    # Accept commas, semicolons, and whitespace.  A leading @ is harmless
    # for VTT-style lists copied by users.
    for ch in ";,\n\t":
        stripped = stripped.replace(ch, " ")
    out: list[float] = []
    for token in stripped.split():
        token = token.strip().lstrip("@")
        if not token:
            continue
        out.append(parse_timecode(token))
    return out


def _parse_times_file(path: str) -> list[float]:
    if not os.path.exists(path):
        raise FileNotFoundError(path)
    with open(path, "r", encoding="utf-8") as fh:
        text = fh.read().strip()
    if path.lower().endswith(".json"):
        try:
            data = json.loads(text)
            if isinstance(data, dict) and "times" in data:
                data = data["times"]
            return [parse_timecode(x) for x in data]
        except (json.JSONDecodeError, TypeError, ValueError) as exc:
            raise ValueError(f"invalid JSON time file {path}: {exc}") from exc
    return _parse_times_text(text)


def parse_timecode(token: str) -> float:
    """Parse seconds as float or ``hh:mm:ss.mmm`` / ``mm:ss.mmm``."""
    token = str(token).strip()
    if ":" not in token:
        return float(token)
    parts = token.split(":")
    try:
        nums = [float(p) for p in parts]
    except ValueError as exc:
        raise ValueError(f"invalid timecode {token!r}") from exc
    if len(nums) == 3:
        h, m, s = nums
        return h * 3600 + m * 60 + s
    if len(nums) == 2:
        m, s = nums
        return m * 60 + s
    raise ValueError(f"invalid timecode {token!r}")


def build_scrub_intervals(targets: list[float], duration: float) -> list[dict[str, Any]]:
    """Partition the timeline into forward intervals anchored at targets.

    Interval i starts at target i (the first interval also covers time zero)
    and ends just before target i+1.  The final interval ends at the terminal
    duration; that terminal instant maps to the final tile.
    """
    if not targets:
        raise ValueError("at least one target is required")
    intervals: list[dict[str, Any]] = []
    for i, t in enumerate(targets):
        start = 0.0 if i == 0 else t
        if i + 1 < len(targets):
            end = targets[i + 1]
            intervals.append(
                {
                    "start": round(start, 9),
                    "end": round(end, 9),
                    "endExclusive": True,
                    "terminalEndInclusive": False,
                }
            )
        else:
            intervals.append(
                {
                    "start": round(start, 9),
                    "end": round(duration, 9),
                    "endExclusive": False,
                    "terminalEndInclusive": True,
                }
            )
    return intervals
