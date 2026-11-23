"""Clipping analysis, repair and verification.

Everything here is plain numpy and independent of Qt so it can be tested
headlessly.  Coordinates are in samples; ranges are half-open [start, end).
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from .wavio import WavData, encode_wav, load_wav, quantize

STATUS_SUSPECTED = "suspected"
STATUS_CONFIRMED = "confirmed"
STATUS_EXCLUDED = "excluded"
USER_STATUSES = (STATUS_CONFIRMED, STATUS_EXCLUDED)

CONFIDENCE_HIGH = "high"
CONFIDENCE_MEDIUM = "medium"
CONFIDENCE_LOW = "low"

CONFIDENCE_LABELS = {
    CONFIDENCE_HIGH: "高",
    CONFIDENCE_MEDIUM: "中",
    CONFIDENCE_LOW: "低(仅供参考)",
}

STATUS_LABELS = {
    STATUS_SUSPECTED: "可疑",
    STATUS_CONFIRMED: "已确认",
    STATUS_EXCLUDED: "已排除",
}

METHOD_LABELS = {
    "auto": "自动",
    "hermite": "三次埃尔米特",
    "lpc": "线性预测",
    "line": "两端平滑连接",
    "none": "未改动",
}


def db_to_amp(db: float) -> float:
    return float(10.0 ** (db / 20.0))


def amp_to_db(amp: float) -> float:
    if amp <= 0:
        return -math.inf
    return float(20.0 * math.log10(amp))


# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------


@dataclass
class DetectionConfig:
    pos_dbfs: float = -0.10
    neg_dbfs: float = -0.10
    min_run: int = 2
    join_gap: int = 1

    @property
    def pos_threshold(self) -> float:
        return db_to_amp(self.pos_dbfs)

    @property
    def neg_threshold(self) -> float:
        return db_to_amp(self.neg_dbfs)


@dataclass
class Segment:
    channel: int
    polarity: int  # +1 positive clipping, -1 negative clipping
    start: int
    end: int
    status: str = STATUS_SUSPECTED
    source: str = "auto"  # "auto" or "user"
    level: float = 0.0
    flat_ratio: float = 0.0
    hint: str = ""
    uid: int = 0

    @property
    def length(self) -> int:
        return self.end - self.start

    def overlaps(self, other: "Segment") -> bool:
        return (
            self.channel == other.channel
            and self.start < other.end
            and other.start < self.end
        )

    def copy(self) -> "Segment":
        return Segment(
            channel=self.channel,
            polarity=self.polarity,
            start=self.start,
            end=self.end,
            status=self.status,
            source=self.source,
            level=self.level,
            flat_ratio=self.flat_ratio,
            hint=self.hint,
            uid=self.uid,
        )


def _runs(mask: np.ndarray) -> list[tuple[int, int]]:
    if mask.size == 0 or not mask.any():
        return []
    padded = np.empty(mask.size + 2, dtype=np.int8)
    padded[0] = 0
    padded[-1] = 0
    padded[1:-1] = mask
    diff = np.diff(padded)
    starts = np.flatnonzero(diff == 1)
    ends = np.flatnonzero(diff == -1)
    return [(int(s), int(e)) for s, e in zip(starts, ends)]


def _join_close_runs(
    runs: list[tuple[int, int]],
    x: np.ndarray,
    polarity: int,
    threshold: float,
    join_gap: int,
) -> list[tuple[int, int]]:
    if join_gap <= 0 or len(runs) < 2:
        return runs
    merged: list[tuple[int, int]] = [runs[0]]
    for s, e in runs[1:]:
        ps, pe = merged[-1]
        gap = s - pe
        if gap <= join_gap:
            gap_vals = x[pe:s]
            # Only bridge a micro dropout that is still very close to the
            # plateau; a real quiet gap ends the clipping event.
            if gap_vals.size == 0 or np.all(
                (gap_vals if polarity > 0 else -gap_vals) >= threshold * 0.80
            ):
                merged[-1] = (ps, e)
                continue
        merged.append((s, e))
    return merged


def _flat_stats(values: np.ndarray, polarity: int) -> tuple[float, float]:
    peak = float(values.max()) if polarity > 0 else float(-values.min())
    level = float(np.median(np.abs(values)))
    tol = 2.5 / 32768.0
    flat_ratio = float(np.mean(np.abs(values) >= peak - tol))
    return level, flat_ratio


def _square_hint(
    x: np.ndarray,
    runs: list[tuple[int, int]],
    index: int,
    levels: list[float],
    opposite_runs: list[tuple[int, int]],
    opposite_levels: list[float],
    max_gap: int = 6,
) -> bool:
    """A square wave is a flat plateau joined almost directly to an opposite
    plateau of similar height.  This is only a hint for the user, never an
    auto-exclude.
    """
    s, e = runs[index]
    level = levels[index]
    if level <= 0:
        return False
    for k, (js, je) in enumerate(opposite_runs):
        other = opposite_levels[k]
        if other <= 0:
            continue
        before_gap = s - je
        after_gap = js - e
        adjacent = (0 <= before_gap <= max_gap) or (0 <= after_gap <= max_gap)
        if adjacent and abs(other - level) <= 0.30 * max(level, other):
            return True
    return False


def detect_segments(
    samples: np.ndarray,
    sample_rate: int,
    config: DetectionConfig,
    previous: tuple[Segment, ...] | list[Segment] = (),
) -> list[Segment]:
    """Detect clipping plateaus per channel and polarity.

    Segments the user has already confirmed or excluded are preserved even if
    the new threshold no longer detects them, and their interval is unioned
    with any newly detected interval so raising the threshold cannot shrink a
    confirmed repair region.
    """
    samples = np.asarray(samples, dtype=np.float64)
    if samples.ndim == 1:
        samples = samples[:, None]
    frames, channels = samples.shape
    detected: list[Segment] = []
    for ch in range(channels):
        x = samples[:, ch]
        per_polarity: dict[int, tuple[list[tuple[int, int]], list[float], float]] = {}
        for polarity, threshold in (
            (1, config.pos_threshold),
            (-1, config.neg_threshold),
        ):
            mask = x >= threshold if polarity > 0 else x <= -threshold
            runs = _runs(mask)
            runs = _join_close_runs(runs, x, polarity, threshold, config.join_gap)
            runs = [(s, e) for s, e in runs if e - s >= config.min_run]
            levels = [_flat_stats(x[s:e], polarity)[0] for s, e in runs]
            per_polarity[polarity] = (runs, levels, threshold)
        for polarity, (runs, levels, _threshold) in per_polarity.items():
            opp_runs, opp_levels, _ = per_polarity[-polarity]
            for i, (s, e) in enumerate(runs):
                level, flat_ratio = _flat_stats(x[s:e], polarity)
                hint = ""
                if flat_ratio >= 0.75:
                    if level < 0.9990:
                        hint = "平顶未到满幅"
                    if _square_hint(
                        x, runs, i, levels, opp_runs, opp_levels
                    ):
                        hint = "方波样/本就平直?"
                detected.append(
                    Segment(
                        channel=ch,
                        polarity=polarity,
                        start=s,
                        end=e,
                        level=level,
                        flat_ratio=flat_ratio,
                        hint=hint,
                    )
                )

    # Preserve explicit user decisions.
    pinned = [seg for seg in previous if seg.status in USER_STATUSES]
    result: list[Segment] = []
    used: set[int] = set()
    for old in pinned:
        overlapping = [
            i
            for i, new in enumerate(detected)
            if i not in used
            and new.channel == old.channel
            and new.polarity == old.polarity
            and new.start < old.end
            and old.start < new.end
        ]
        if overlapping:
            lo = min(old.start, *(detected[i].start for i in overlapping))
            hi = max(old.end, *(detected[i].end for i in overlapping))
            for i in overlapping:
                used.add(i)
            merged = old.copy()
            merged.start, merged.end = lo, hi
            # Refresh display statistics from the union, but keep the decision.
            vals = samples[lo:hi, old.channel]
            level, flat_ratio = _flat_stats(vals, old.polarity)
            merged.level, merged.flat_ratio = level, flat_ratio
            merged.hint = old.hint
            result.append(merged)
        else:
            kept = old.copy()
            note = "低于当前门槛，已保留确认"
            if old.status == STATUS_EXCLUDED:
                note = "低于当前门槛，已保留排除"
            kept.hint = (kept.hint + "；" if kept.hint else "") + note
            result.append(kept)
    for i, seg in enumerate(detected):
        if i not in used:
            result.append(seg)

    # Merge any resulting overlaps with the same decision, keep deterministic order.
    result.sort(key=lambda s: (s.channel, s.start, s.polarity))
    merged_result: list[Segment] = []
    for seg in result:
        if merged_result:
            last = merged_result[-1]
            if (
                last.channel == seg.channel
                and last.polarity == seg.polarity
                and last.status == seg.status
                and seg.start < last.end
            ):
                last.end = max(last.end, seg.end)
                last.start = min(last.start, seg.start)
                if seg.hint and seg.hint not in last.hint:
                    last.hint = (last.hint + "；" if last.hint else "") + seg.hint
                continue
        merged_result.append(seg)
    return merged_result


def segments_to_mask(
    segments: list[Segment],
    channel: int,
    frames: int,
    include_excluded: bool = False,
) -> np.ndarray:
    mask = np.zeros(frames, dtype=bool)
    for seg in segments:
        if seg.channel != channel:
            continue
        if seg.status == STATUS_EXCLUDED and not include_excluded:
            continue
        mask[seg.start : seg.end] = True
    return mask


# ---------------------------------------------------------------------------
# Local analysis helpers used by repair
# ---------------------------------------------------------------------------


def estimate_period(
    left: np.ndarray,
    right: np.ndarray,
    sample_rate: int,
    f_min: float = 60.0,
    f_max: float = 450.0,
    window: int = 1024,
) -> int | None:
    """Estimate the dominant pitch period from whichever side has clean audio.

    Uses a cumulative-mean-normalised difference function (YIN-style), which
    survives the harmonic-rich voiced signal much better than a plain
    autocorrelation peak pick.  Returns None when neither side is periodic
    enough to trust.
    """
    best: tuple[float, float] | None = None
    for ctx in (left[-window:], right[:window]):
        if ctx.size < max(32, window // 4):
            continue
        period, clarity = _yin_period(
            ctx, sample_rate, f_min=f_min, f_max=f_max
        )
        if period is None:
            continue
        if best is None or clarity < best[0]:
            best = (clarity, period)
    if best is None:
        return None
    return int(round(best[1]))


def _yin_period(
    x: np.ndarray, sample_rate: int, f_min: float, f_max: float
) -> tuple[float | None, float]:
    x = np.asarray(x, dtype=np.float64)
    if x.size < 64:
        return None, math.inf
    x = x - np.mean(x)
    if float(np.max(np.abs(x))) < 1e-7:
        return None, math.inf
    tau_min = max(2, int(sample_rate / f_max))
    tau_max = min(x.size // 2, int(sample_rate / f_min))
    if tau_max <= tau_min + 2:
        return None, math.inf
    n = x.size
    # Difference function via autocorrelation of the window.
    nfft = 1 << (2 * n - 1).bit_length()
    spec = np.fft.rfft(x, nfft)
    ac = np.fft.irfft(spec * np.conjugate(spec), nfft)[: n]
    sq = np.concatenate(([0.0], np.cumsum(x * x)))
    d = np.empty(tau_max + 1)
    d[0] = 0.0
    for tau in range(1, tau_max + 1):
        d[tau] = sq[n - tau] + sq[n] - sq[tau] - 2.0 * ac[tau]
    cmnd = np.ones_like(d)
    running = np.cumsum(d[1:])
    for tau in range(1, tau_max + 1):
        denom = running[tau - 1]
        cmnd[tau] = d[tau] * tau / denom if denom > 1e-12 else 1.0
    candidates = np.flatnonzero(cmnd[tau_min : tau_max + 1] < 0.15)
    if candidates.size:
        tau = int(candidates[0]) + tau_min
        while tau + 1 <= tau_max and cmnd[tau + 1] < cmnd[tau]:
            tau += 1
    else:
        tau = tau_min + int(np.argmin(cmnd[tau_min : tau_max + 1]))
    clarity = float(cmnd[tau])
    if clarity > 0.35:
        return None, clarity
    if 1 <= tau < tau_max:
        a, b, c = cmnd[tau - 1], cmnd[tau], cmnd[tau + 1]
        den = a - 2.0 * b + c
        if abs(den) > 1e-12:
            tau = tau + 0.5 * (a - c) / den
    return float(tau), clarity


def _context_bounds(
    clip_mask: np.ndarray,
    start: int,
    end: int,
    max_context: int,
) -> tuple[int, int, int, int]:
    frames = clip_mask.size
    i = start - 1
    while i >= 0 and not clip_mask[i] and start - 1 - i < max_context:
        i -= 1
    left_start = i + 1
    j = end
    while j < frames and not clip_mask[j] and j - end < max_context:
        j += 1
    right_end = j
    return left_start, start, end, right_end


def _slope(values: np.ndarray, sample_rate: int = 44100, f_max: float = 450.0) -> tuple[float, bool]:
    """Endpoint slope, robust to a sharp edge sitting inside the fit window.

    A least-squares line over 24 samples next to a square-wave edge reports a
    huge slope, and Hermite then overshoots by 4x.  Clamp to the steepest
    slope a signal band-limited at ``f_max`` could actually have.
    """
    if values.size < 2:
        return 0.0, False
    t = np.arange(values.size, dtype=np.float64)
    try:
        m = float(np.polyfit(t, values, 1)[0])
    except Exception:
        return 0.0, False
    cap = 1.5 * (2.0 * math.pi * f_max / float(sample_rate))
    return float(np.clip(m, -cap, cap)), True


def _hermite(
    y0: float,
    y1: float,
    m0: float,
    m1: float,
    n: int,
) -> np.ndarray:
    if n <= 0:
        return np.zeros(0)
    t = np.arange(1, n + 1, dtype=np.float64) / (n + 1)
    span = float(n + 1)
    h00 = 2 * t**3 - 3 * t**2 + 1
    h10 = t**3 - 2 * t**2 + t
    h01 = -2 * t**3 + 3 * t**2
    h11 = t**3 - t**2
    return h00 * y0 + h10 * span * m0 + h01 * y1 + h11 * span * m1


def _lpc_coefficients(signal: np.ndarray, order: int) -> np.ndarray | None:
    signal = signal - np.mean(signal)
    n = signal.size
    if n < order + 2:
        return None
    ac = np.correlate(signal, signal, mode="full")[n - 1 : n + order]
    if ac[0] <= 1e-12:
        return None
    ac = ac.copy()
    ac[0] *= 1.0001
    ac[0] += 1e-12
    a = np.zeros(order + 1)
    a[0] = 1.0
    err = ac[0]
    for i in range(1, order + 1):
        acc = ac[i]
        for j in range(1, i):
            acc += a[j] * ac[i - j]
        k = -acc / err
        if not np.isfinite(k):
            return None
        a[1:i] = a[1:i] + k * a[i - 1 : 0 : -1]
        a[i] = k
        err *= 1.0 - k * k
        if err <= 1e-12:
            return None
    return a


def _lpc_extrapolate(
    history: np.ndarray,
    order: int,
    n: int,
    limit: float,
) -> tuple[np.ndarray, bool]:
    coeffs = _lpc_coefficients(history, order)
    if coeffs is None:
        return np.zeros(n), False
    buf = list(history[-order:].astype(np.float64))
    out = np.empty(n)
    limited = False
    for i in range(n):
        pred = -sum(coeffs[j] * buf[-j] for j in range(1, order + 1))
        if not np.isfinite(pred):
            return np.zeros(n), False
        if abs(pred) > limit:
            pred = math.copysign(limit, pred)
            limited = True
        out[i] = pred
        buf.append(pred)
        if len(buf) > order:
            buf.pop(0)
    return out, limited


@dataclass
class RepairResult:
    values: np.ndarray
    method: str
    confidence: str
    flags: list[str] = field(default_factory=list)
    left_context: int = 0
    right_context: int = 0
    period: int | None = None
    clamped: bool = False
    ratio: float | None = None
    mode: str = "hermite"  # hermite | blend | line | none


def repair_region(
    samples: np.ndarray,
    sample_rate: int,
    channel: int,
    start: int,
    end: int,
    polarity: int,
    clip_mask: np.ndarray,
    method: str = "auto",
) -> RepairResult:
    """Reconstruct one clipped run from the clean audio on either side.

    Only samples in [start, end) are produced; the surrounding clean samples
    are never modified.  Confidence is reported separately from the values so
    a long gap is never presented as a confident restoration.
    """
    x = np.asarray(samples[:, channel], dtype=np.float64)
    frames = x.size
    n = end - start
    if n <= 0:
        return RepairResult(np.zeros(0), "none", CONFIDENCE_LOW, ["空区间"])
    mask = np.asarray(clip_mask, dtype=bool)
    ls, _, _, re_ = _context_bounds(mask, start, end, max_context=4096)
    left_ctx = x[ls:start]
    right_ctx = x[end:re_]
    period = estimate_period(left_ctx, right_ctx, sample_rate)
    flags: list[str] = []

    slope_win = 24
    left_fit = left_ctx[-min(slope_win, left_ctx.size) :]
    right_fit = right_ctx[: min(slope_win, right_ctx.size)]
    m0, have_m0 = _slope(left_fit, sample_rate)
    m1, have_m1 = _slope(right_fit, sample_rate)
    y0 = float(x[start - 1]) if start > 0 else None
    y1 = float(x[end]) if end < frames else None

    use_lpc = method == "lpc"
    if method == "auto":
        use_lpc = period is not None and n > 0.6 * period

    local_peak = 0.0
    if left_ctx.size:
        local_peak = max(local_peak, float(np.max(np.abs(left_ctx))))
    if right_ctx.size:
        local_peak = max(local_peak, float(np.max(np.abs(right_ctx))))
    # A bridge may honestly land slightly above the ceiling (the cut-off peak
    # was higher), but it must not run away; export warns about the rest.
    limit = max(1.0, 1.10 * local_peak)

    # Decide how much of the bridge we are entitled to invent.  A short gap is
    # a continuity repair; a long gap is only a connection guess and must be
    # shown as such instead of a confident restore.
    ratio: float | None = None
    dur_ms = 1000.0 * n / sample_rate
    if period is not None:
        ratio = n / float(period)
        if ratio > 2.0:
            mode, confidence = "line", CONFIDENCE_LOW
            flags.append(f"长段缺失约 {ratio:.1f} 个周期，只是连接推测")
        elif ratio > 0.6:
            mode, confidence = "blend", CONFIDENCE_MEDIUM
        else:
            mode, confidence = "hermite", CONFIDENCE_HIGH
    elif dur_ms > 10.0:
        mode, confidence = "line", CONFIDENCE_LOW
        flags.append(f"长段缺失 {dur_ms:.1f} ms，无稳定周期可参考")
    elif dur_ms > 3.0:
        mode, confidence = "hermite", CONFIDENCE_MEDIUM
    else:
        mode, confidence = "hermite", CONFIDENCE_HIGH

    if left_ctx.size < 4 or right_ctx.size < 4:
        flags.append("端点上下文不足")
        confidence = CONFIDENCE_LOW

    values: np.ndarray | None = None
    used = "hermite"
    limited = False
    if y0 is not None and y1 is not None:
        if mode == "line":
            # Honest fallback: smooth connection between the two clean ends.
            t = (np.arange(1, n + 1, dtype=np.float64)) / (n + 1.0)
            smooth = t * t * (3.0 - 2.0 * t)
            values = y0 + (y1 - y0) * smooth
            used = "line"
        elif use_lpc and left_ctx.size >= 8 and right_ctx.size >= 8:
            forward, lim1 = _lpc_extrapolate(
                left_ctx, min(16, left_ctx.size - 2), n, limit
            )
            backward_rev, lim2 = _lpc_extrapolate(
                right_ctx[::-1], min(16, right_ctx.size - 2), n, limit
            )
            backward = backward_rev[::-1]
            limited = lim1 or lim2
            if forward.size == n and backward.size == n:
                # Endpoint correction so the bridge really joins both sides.
                t = np.linspace(0.0, 1.0, n + 2)[1:-1]
                forward = forward + (y0 - forward[0]) * (1.0 - t)
                backward = backward + (y1 - backward[-1]) * t
                w = 0.5 * (1.0 - np.cos(np.pi * t))
                values = (1.0 - w) * forward + w * backward
                if mode == "blend":
                    # Keep the safe shape as a reference and blend in only
                    # part of the predictive detail.
                    line = y0 + (y1 - y0) * (t * t * (3.0 - 2.0 * t))
                    values = 0.6 * values + 0.4 * line
                used = "lpc"
        if values is None:
            values = _hermite(y0, y1, m0, m1, n)
            used = "hermite"
            if mode == "blend":
                t = np.linspace(0.0, 1.0, n + 2)[1:-1]
                line = y0 + (y1 - y0) * (t * t * (3.0 - 2.0 * t))
                values = 0.6 * values + 0.4 * line
    elif y0 is not None:
        # Clipping runs to the end of the file: only left information exists.
        values = y0 + m0 * np.arange(1, n + 1)
        used = "hermite"
        flags.append("右侧无上下文，仅单侧外推")
        confidence = CONFIDENCE_LOW
    elif y1 is not None:
        values = y1 + m1 * np.arange(-n, 0)
        used = "hermite"
        flags.append("左侧无上下文，仅单侧外推")
        confidence = CONFIDENCE_LOW
    else:
        values = x[start:end].copy()
        used = "none"
        flags.append("整段无上下文，未改动")
        confidence = CONFIDENCE_LOW

    if not np.all(np.isfinite(values)):
        values = x[start:end].copy()
        used = "none"
        flags.append("预测不稳定，已放弃改动")
        confidence = CONFIDENCE_LOW

    # Even when the shape is plausible, do not let a bridge explode far
    # outside the local level.  That would look like a restoration and it is
    # not one.  A modest overshoot above 0 dBFS is left alone on purpose: it
    # is the honest estimate of what the ceiling cut off, and the export step
    # warns about it instead of silently squashing it here.
    extreme = float(np.max(np.abs(values))) if values.size else 0.0
    if extreme > limit:
        values = np.clip(values, -limit, limit)
        flags.append("预测幅度已限制")
        if confidence == CONFIDENCE_HIGH:
            confidence = CONFIDENCE_MEDIUM

    if limited:
        if confidence == CONFIDENCE_HIGH:
            confidence = CONFIDENCE_MEDIUM
    return RepairResult(
        values=values,
        method=used,
        confidence=confidence,
        flags=flags,
        left_context=int(left_ctx.size),
        right_context=int(right_ctx.size),
        period=period,
        clamped=limited,
        ratio=ratio,
        mode=mode,
    )


# ---------------------------------------------------------------------------
# Repair records / changed sample audit
# ---------------------------------------------------------------------------


@dataclass
class RepairRecord:
    channel: int
    start: int
    end: int
    polarity: int
    method: str
    confidence: str
    flags: list[str]
    values: np.ndarray  # replacement samples for [start, end)
    changed_runs: list[tuple[int, int]]
    changed_count: int
    max_delta: float
    segment_uid: int = 0

    @property
    def length(self) -> int:
        return self.end - self.start

    def snapshot(self) -> "RepairRecord":
        return RepairRecord(
            channel=self.channel,
            start=self.start,
            end=self.end,
            polarity=self.polarity,
            method=self.method,
            confidence=self.confidence,
            flags=list(self.flags),
            values=self.values.copy(),
            changed_runs=list(self.changed_runs),
            changed_count=self.changed_count,
            max_delta=self.max_delta,
            segment_uid=self.segment_uid,
        )


def change_runs(
    before: np.ndarray, after: np.ndarray, start: int
) -> list[tuple[int, int]]:
    """Runs where two equal-length region arrays differ, offset by start."""
    a = np.asarray(before, dtype=np.float64)
    b = np.asarray(after, dtype=np.float64)
    changed = a != b
    runs = _runs(changed)
    return [(start + s, start + e) for s, e in runs]


def make_repair_record(
    original: np.ndarray,
    sample_rate: int,
    segment: Segment,
    clip_mask: np.ndarray,
    method: str = "auto",
) -> RepairRecord:
    result = repair_region(
        original,
        sample_rate,
        segment.channel,
        segment.start,
        segment.end,
        segment.polarity,
        clip_mask,
        method=method,
    )
    before = original[segment.start : segment.end, segment.channel]
    changed = before != result.values
    runs = change_runs(before, result.values, segment.start)
    max_delta = (
        float(np.max(np.abs(result.values[changed] - before[changed])))
        if changed.any()
        else 0.0
    )
    return RepairRecord(
        channel=segment.channel,
        start=segment.start,
        end=segment.end,
        polarity=segment.polarity,
        method=result.method,
        confidence=result.confidence,
        flags=list(result.flags),
        values=result.values,
        changed_runs=runs,
        changed_count=int(np.count_nonzero(changed)),
        max_delta=max_delta,
        segment_uid=segment.uid,
    )


def apply_repairs(original: np.ndarray, records: list[RepairRecord]) -> np.ndarray:
    out = np.array(original, dtype=np.float64, copy=True)
    for rec in records:
        out[rec.start : rec.end, rec.channel] = rec.values
    return out


def records_to_change_runs(
    records: list[RepairRecord], channels: int, frames: int
) -> dict[int, list[tuple[int, int]]]:
    result: dict[int, list[tuple[int, int]]] = {}
    for ch in range(channels):
        mask = np.zeros(frames, dtype=bool)
        for rec in records:
            if rec.channel != ch:
                continue
            for s, e in rec.changed_runs:
                mask[s:e] = True
        result[ch] = _runs(mask)
    return result


def format_sample_time(index: int, sample_rate: int) -> str:
    seconds = index / float(sample_rate)
    minutes = int(seconds // 60)
    rest = seconds - minutes * 60
    return f"{minutes:02d}:{rest:06.3f}"


def format_runs(
    runs: list[tuple[int, int]], sample_rate: int, max_items: int = 6
) -> str:
    if not runs:
        return "无"
    parts = [
        f"{format_sample_time(s, sample_rate)}–{format_sample_time(e, sample_rate)} "
        f"[{s}:{e}]"
        for s, e in runs[:max_items]
    ]
    if len(runs) > max_items:
        parts.append(f"… 另 {len(runs) - max_items} 段")
    return "；".join(parts)


# ---------------------------------------------------------------------------
# Headroom / export verification
# ---------------------------------------------------------------------------


@dataclass
class HeadroomReport:
    original_peak: float
    repaired_peak: float
    new_peak: float
    headroom_db: float
    overflow_count: int
    bits: int
    quant_step: float
    fits: bool

    @property
    def peak_dbfs(self) -> float:
        return amp_to_db(self.repaired_peak)


def headroom_report(
    original: np.ndarray,
    repaired: np.ndarray,
    bits: int,
) -> HeadroomReport:
    """Compare peaks of the original and the would-be export.

    ``fits`` is about the *written* integer range: a peak of exactly 1.0 clips
    to the positive rail, which is fine and expected, but anything above 1.0
    would be flattened on export and must be surfaced before the user saves.
    """
    orig_peak = float(np.max(np.abs(original))) if original.size else 0.0
    rep_peak = float(np.max(np.abs(repaired))) if repaired.size else 0.0
    overflow = int(np.count_nonzero(np.abs(repaired) > 1.0))
    return HeadroomReport(
        original_peak=orig_peak,
        repaired_peak=rep_peak,
        new_peak=max(0.0, rep_peak - orig_peak),
        headroom_db=amp_to_db(1.0) - amp_to_db(max(rep_peak, 1e-12)),
        overflow_count=overflow,
        bits=bits,
        quant_step=1.0 / float(2 ** (bits - 1)),
        fits=overflow == 0,
    )


def _to_int(samples: np.ndarray, bits: int) -> np.ndarray:
    return quantize(np.asarray(samples, dtype=np.float64), bits)


def export_wav(
    path: str | Path,
    repaired: np.ndarray,
    sample_rate: int,
    bits: int,
) -> None:
    data = encode_wav(repaired, sample_rate, bits)
    Path(path).write_bytes(data)


@dataclass
class VerificationReport:
    ok: bool
    frames: int
    bits: int
    changed_runs: dict[int, list[tuple[int, int]]]
    changed_frames: dict[int, int]
    outside_runs: dict[int, list[tuple[int, int]]]
    outside_frames: dict[int, int]
    max_quant_error_lsb: float
    mismatch_frames: int
    sample_rate: int
    clipped_frames: int = 0
    note: str = ""

    @property
    def has_clipping(self) -> bool:
        return self.clipped_frames > 0

    @property
    def total_changed(self) -> int:
        return sum(self.changed_frames.values())

    @property
    def total_outside(self) -> int:
        return sum(self.outside_frames.values())


def verify_export(
    path: str | Path,
    original: np.ndarray,
    repaired: np.ndarray,
    bits: int,
    intended_ranges: dict[int, list[tuple[int, int]]],
    sample_rate: int,
) -> VerificationReport:
    """Re-read the written WAV and check exactly which frames differ.

    The comparison baseline is the original re-encoded at the export depth, so
    a bit-depth change alone does not look like a modification.  Differences
    are checked per channel: a frame may only differ on a channel where it was
    intended, so a repair on the left channel can never quietly change the
    right one.
    """
    loaded: WavData = load_wav(path)
    if loaded.samples.shape != original.shape:
        raise ValueError(
            f"导出文件形状 {loaded.samples.shape} 与原文件 {original.shape} 不一致"
        )
    export_ints = _to_int(loaded.samples, bits)
    baseline_ints = _to_int(original, bits)
    expected_ints = _to_int(repaired, bits)
    # Frames where the float bridge exceeded full scale and the writer had to
    # flatten it.  This is a known, warned-about loss, not a scope violation,
    # but it must show up in the verification instead of being hidden.
    clipped_frames = int(np.count_nonzero(np.abs(repaired) > 1.0))

    frames = int(original.shape[0])
    changed_runs: dict[int, list[tuple[int, int]]] = {}
    changed_frames: dict[int, int] = {}
    outside_runs: dict[int, list[tuple[int, int]]] = {}
    outside_frames: dict[int, int] = {}
    mismatch_total = 0
    outside_total = 0
    for ch in range(original.shape[1]):
        allowed = np.zeros(frames, dtype=bool)
        for s, e in intended_ranges.get(ch, []):
            allowed[s:e] = True
        ch_changed = export_ints[:, ch] != baseline_ints[:, ch]
        ch_expected = export_ints[:, ch] != expected_ints[:, ch]
        ch_outside = ch_changed & ~allowed
        changed_runs[ch] = _runs(ch_changed)
        changed_frames[ch] = int(np.count_nonzero(ch_changed))
        outside_runs[ch] = _runs(ch_outside)
        outside_frames[ch] = int(np.count_nonzero(ch_outside))
        mismatch_total += int(np.count_nonzero(ch_expected))
        outside_total += int(np.count_nonzero(ch_outside))

    quant_err = (
        float(np.max(np.abs(loaded.samples - np.clip(repaired, -1.0, 1.0))))
        * (2 ** (bits - 1))
    )
    return VerificationReport(
        ok=mismatch_total == 0 and outside_total == 0,
        frames=frames,
        bits=bits,
        changed_runs=changed_runs,
        changed_frames=changed_frames,
        outside_runs=outside_runs,
        outside_frames=outside_frames,
        max_quant_error_lsb=quant_err,
        mismatch_frames=mismatch_total,
        sample_rate=sample_rate,
        clipped_frames=clipped_frames,
    )
