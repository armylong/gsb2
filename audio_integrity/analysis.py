from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np

from .models import BAND_LOSS, CHANNEL_LOSS, QUIET, Annotation, json_safe

EPS = 1e-10


@dataclass(frozen=True)
class Band:
    key: str
    name: str
    low_hz: float
    high_hz: float

    def contains(self, low: float | None = None, high: float | None = None) -> bool:
        if low is None and high is None:
            return True
        low = self.low_hz if low is None else low
        high = self.high_hz if high is None else high
        return not (self.high_hz <= low or self.low_hz >= high)


@dataclass
class AnalysisConfig:
    window_ms: float = 40.0
    hop_ms: float = 10.0
    band_drop_db: float = 12.0
    channel_drop_db: float = 22.0
    channel_abs_db: float = -38.0
    other_active_db: float = -43.0
    quiet_abs_db: float = -47.0
    quiet_drop_db: float = 18.0
    min_event_ms: float = 70.0
    merge_gap_ms: float = 75.0

    def as_dict(self) -> dict[str, float]:
        return {
            "window_ms": self.window_ms,
            "hop_ms": self.hop_ms,
            "band_drop_db": self.band_drop_db,
            "channel_drop_db": self.channel_drop_db,
            "channel_abs_db": self.channel_abs_db,
            "other_active_db": self.other_active_db,
            "quiet_abs_db": self.quiet_abs_db,
            "quiet_drop_db": self.quiet_drop_db,
            "min_event_ms": self.min_event_ms,
            "merge_gap_ms": self.merge_gap_ms,
        }


@dataclass
class ReferenceStats:
    start: float
    end: float
    frame_indices: np.ndarray
    rms_db: np.ndarray          # shape (channels,)
    band_db: np.ndarray         # shape (channels, bands)
    correlation: float | None
    warning: str = ""


@dataclass
class AnalysisResult:
    sample_rate: int
    bands: list[Band]
    config: AnalysisConfig
    frame_starts: np.ndarray
    frame_ends: np.ndarray
    centers: np.ndarray
    valid_samples: np.ndarray
    complete: np.ndarray
    rms_db: np.ndarray          # (frames, channels)
    band_db: np.ndarray         # (frames, channels, bands)
    correlation: np.ndarray     # (frames,)
    reference: ReferenceStats
    annotations: list[Annotation] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def n_frames(self) -> int:
        return len(self.centers)

    @property
    def partial_frame_indices(self) -> np.ndarray:
        return np.flatnonzero(~self.complete)

    def frame_at_time(self, t: float) -> int | None:
        if self.n_frames == 0:
            return None
        idx = int(np.searchsorted(self.centers, t))
        candidates = [i for i in (idx - 1, idx) if 0 <= i < self.n_frames]
        if not candidates:
            return 0 if t < self.centers[0] else self.n_frames - 1
        return min(candidates, key=lambda i: abs(float(self.centers[i]) - t))

    def metric_rows_for_annotation(self, ann: Annotation) -> list[dict[str, Any]]:
        """Return one row per analysis frame covered by an annotation."""
        i0 = max(0, int(np.searchsorted(self.frame_ends, ann.start, side="right")))
        i1 = int(np.searchsorted(self.frame_starts, ann.end, side="left"))
        i1 = min(self.n_frames, max(i0 + 1, i1))
        rows: list[dict[str, Any]] = []
        for i in range(i0, i1):
            row: dict[str, Any] = {
                "frame": i,
                "time": round(float(self.centers[i]), 4),
                "complete": bool(self.complete[i]),
                "rms_db": [_clean(v) for v in self.rms_db[i].tolist()],
                "correlation": _clean(float(self.correlation[i])),
            }
            if ann.bands:
                bi = next((b for b, band in enumerate(self.bands) if band.key == ann.bands[0]), None)
                if bi is not None:
                    row["band_db"] = [_clean(v) for v in self.band_db[i, :, bi].tolist()]
            rows.append(row)
        return rows


def _clean(value: float) -> float | None:
    value = float(value)
    return value if np.isfinite(value) else None


def default_bands(sample_rate: int) -> list[Band]:
    """Five log-spaced speech-oriented bands, adapted to the sample rate."""
    nyquist = sample_rate / 2.0
    low = 80.0
    top = min(8000.0, nyquist * 0.90)
    if top <= low * 2:
        low = max(20.0, nyquist * 0.05)
        top = nyquist * 0.9
    edges = np.geomspace(low, top, 6)
    names = ["低频", "中低频", "中频", "中高频", "高频"]
    bands: list[Band] = []
    for i in range(5):
        lo = float(edges[i])
        hi = float(edges[i + 1])
        if hi - lo < 1:
            continue
        bands.append(Band(f"b{i + 1}", f"{names[i]} {lo:g}–{hi:g}Hz", lo, hi))
    return bands


def _frame_rms(x: np.ndarray) -> float:
    if x.size == 0:
        return -120.0
    return float(20.0 * np.log10(np.sqrt(np.mean(x.astype(np.float64) ** 2)) + EPS))


def _frame_band_levels(x: np.ndarray, sample_rate: int, bands: list[Band]) -> list[float]:
    m = x.size
    if m < 8:
        return [-120.0] * len(bands)
    # A length-matched Hann window is important for the final short frame:
    # its value remains an actual measurement, but the UI marks it partial.
    window = np.hanning(m)
    spectrum = np.fft.rfft(x.astype(np.float64) * window)
    magnitudes = np.abs(spectrum)
    freqs = np.fft.rfftfreq(m, d=1.0 / sample_rate)
    gain = 2.0 / max(float(np.sum(window)), EPS)
    levels: list[float] = []
    for band in bands:
        idx = np.flatnonzero((freqs >= band.low_hz) & (freqs < band.high_hz))
        if idx.size == 0:
            # Pick the nearest positive FFT bin for very short tail windows.
            positive = np.flatnonzero(freqs > 0)
            if positive.size == 0:
                levels.append(-120.0)
                continue
            nearest = positive[np.argmin(np.abs(freqs[positive] - (band.low_hz + band.high_hz) / 2))]
            idx = np.array([nearest])
        mag = magnitudes[idx] * gain
        level = float(np.sqrt(np.mean(mag**2)) + EPS)
        levels.append(20.0 * np.log10(level + EPS))
    return levels


def _correlation(a: np.ndarray, b: np.ndarray) -> float:
    if a.size < 2:
        return np.nan
    aa = a.astype(np.float64) - np.mean(a)
    bb = b.astype(np.float64) - np.mean(b)
    denom = float(np.linalg.norm(aa) * np.linalg.norm(bb))
    if denom < 1e-12:
        return np.nan
    return float(np.dot(aa, bb) / denom)


def _close_gap(mask: np.ndarray, max_gap_frames: int) -> np.ndarray:
    if max_gap_frames <= 0 or mask.size < 3:
        return mask.copy()
    out = mask.copy()
    n = len(mask)
    i = 0
    while i < n:
        if not out[i]:
            j = i
            while j < n and not out[j]:
                j += 1
            left = i - 1
            right = j
            gap = j - i
            if left >= 0 and right < n and gap <= max_gap_frames and out[left] and out[right]:
                out[i:j] = True
            i = j
        else:
            i += 1
    return out


def _spans(mask: np.ndarray) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    i = 0
    n = len(mask)
    while i < n:
        if not mask[i]:
            i += 1
            continue
        j = i + 1
        while j < n and mask[j]:
            j += 1
        spans.append((i, j - 1))
        i = j
    return spans


def analyze_audio(
    samples: np.ndarray,
    sample_rate: int,
    config: AnalysisConfig | None = None,
    reference_start: float | None = None,
    reference_end: float | None = None,
    bands: list[Band] | None = None,
) -> AnalysisResult:
    """Compute frame energies, reference statistics and candidate markers.

    The function never modifies ``samples`` and never synthesizes replacement
    audio. Markers are observations only.
    """
    cfg = config or AnalysisConfig()
    if samples.ndim == 1:
        samples = samples[:, None]
    n_samples, n_channels = samples.shape
    duration = n_samples / sample_rate
    bands = bands or default_bands(sample_rate)
    n_bands = len(bands)

    window_n = max(16, int(round(cfg.window_ms / 1000.0 * sample_rate)))
    hop_n = max(1, int(round(cfg.hop_ms / 1000.0 * sample_rate)))

    starts = list(range(0, n_samples, hop_n))
    # Ensure a final frame always begins even if range's last start equals n?
    if not starts:
        starts = [0]
    if starts[-1] + hop_n < n_samples and starts[-1] + window_n < n_samples:
        # range already includes starts while < n; this branch is defensive only.
        pass

    n_frames = len(starts)
    frame_starts = np.asarray(starts, dtype=np.int64)
    frame_ends = np.minimum(n_samples, frame_starts + window_n)
    valid_samples = frame_ends - frame_starts
    complete = valid_samples >= window_n
    centers = (frame_starts + frame_ends) / 2.0 / sample_rate

    rms_db = np.full((n_frames, n_channels), -120.0, dtype=np.float64)
    band_db = np.full((n_frames, n_channels, n_bands), -120.0, dtype=np.float64)
    corr = np.full(n_frames, np.nan, dtype=np.float64)

    for i, start in enumerate(starts):
        end = int(frame_ends[i])
        frame = samples[start:end]
        for c in range(n_channels):
            x = frame[:, c]
            rms_db[i, c] = _frame_rms(x)
            band_db[i, c, :] = _frame_band_levels(x, sample_rate, bands)
        if n_channels == 2:
            corr[i] = _correlation(frame[:, 0], frame[:, 1])
        else:
            corr[i] = 1.0

    if reference_start is None:
        reference_start = 0.0
    if reference_end is None:
        reference_end = min(2.0, duration)
    reference_start = max(0.0, min(duration, float(reference_start)))
    reference_end = max(reference_start, min(duration, float(reference_end)))
    if reference_end - reference_start < 0.12 and duration >= 0.12:
        reference_start = 0.0
        reference_end = min(2.0, duration)

    ref_mask = (centers >= reference_start) & (centers <= reference_end)
    if not np.any(ref_mask):
        ref_mask = np.ones(n_frames, dtype=bool)
    ref_rms = np.median(rms_db[ref_mask], axis=0)
    ref_band = np.median(band_db[ref_mask], axis=0)
    ref_corr_values = corr[ref_mask]
    finite_corr = ref_corr_values[np.isfinite(ref_corr_values)]
    ref_corr = float(np.median(finite_corr)) if finite_corr.size else None
    ref_warning = ""
    if np.sum(ref_mask) < 5:
        ref_warning = "参考区较短，基线可能不稳"

    reference = ReferenceStats(
        start=reference_start,
        end=reference_end,
        frame_indices=np.flatnonzero(ref_mask),
        rms_db=ref_rms,
        band_db=ref_band,
        correlation=ref_corr,
        warning=ref_warning,
    )

    result = AnalysisResult(
        sample_rate=sample_rate,
        bands=bands,
        config=cfg,
        frame_starts=frame_starts,
        frame_ends=frame_ends,
        centers=centers,
        valid_samples=valid_samples,
        complete=complete,
        rms_db=rms_db,
        band_db=band_db,
        correlation=corr,
        reference=reference,
        warnings=[ref_warning] if ref_warning else [],
    )
    result.annotations = detect_markers(result)
    return result


def detect_markers(result: AnalysisResult) -> list[Annotation]:
    """Detect the three requested observation classes.

    Detection is frame-based and threshold-driven. Every returned annotation
    stores the peak frame's measured values and all thresholds used.
    """
    cfg = result.config
    n_frames, n_channels = result.rms_db.shape
    annotations: list[Annotation] = []
    if n_frames == 0:
        return annotations

    rms_def = result.reference.rms_db[None, :] - result.rms_db
    band_def = result.reference.band_db[None, :, :] - result.band_db
    gap_frames = max(0, int(round(cfg.merge_gap_ms / max(cfg.hop_ms, 1.0))))
    min_seconds = cfg.min_event_ms / 1000.0

    channel_masks: dict[int, np.ndarray] = {}
    quiet_global = np.ones(n_frames, dtype=bool)

    # ---- Whole-channel loss -------------------------------------------------
    for c in range(n_channels):
        if n_channels == 2:
            other = 1 - c
            other_ok = (
                (result.rms_db[:, other] >= cfg.other_active_db)
                & (rms_def[:, other] < max(cfg.channel_drop_db, cfg.quiet_drop_db))
            )
        else:
            # Mono has no companion track. Require a clearly active reference
            # and an almost total disappearance, leaving ordinary pauses to
            # the quiet detector.
            other_ok = (
                np.asarray(result.reference.rms_db[c] > -35.0)
                & np.ones(n_frames, dtype=bool)
            )

        loss_level_limit = np.maximum(
            cfg.channel_abs_db,
            result.reference.rms_db[c] - cfg.channel_drop_db,
        )
        mask = (
            (rms_def[:, c] >= cfg.channel_drop_db)
            & (result.rms_db[:, c] <= loss_level_limit)
            & other_ok
        )
        mask = _close_gap(mask, gap_frames)
        channel_masks[c] = mask

        for i0, i1 in _spans(mask):
            start = float(result.frame_starts[i0] / result.sample_rate)
            end = float(result.frame_ends[i1] / result.sample_rate)
            if end - start < min_seconds:
                continue
            seg = slice(i0, i1 + 1)
            worst = i0 + int(np.argmin(result.rms_db[seg, c]))
            metrics: dict[str, Any] = {
                "decision_frame": int(worst),
                "decision_time_s": _clean(float(result.centers[worst])),
                "observed_rms_db": _clean(float(result.rms_db[worst, c])),
                "reference_rms_db": _clean(float(result.reference.rms_db[c])),
                "rms_drop_db": _clean(float(rms_def[worst, c])),
                "threshold_drop_db": float(cfg.channel_drop_db),
                "threshold_abs_db": float(cfg.channel_abs_db),
                "effective_abs_limit_db": _clean(float(loss_level_limit)),
                "min_rms_db_in_interval": _clean(float(np.min(result.rms_db[seg, c]))),
                "median_rms_db_in_interval": _clean(float(np.median(result.rms_db[seg, c]))),
                "partial_frame_included": bool(np.any(~result.complete[i0:i1 + 1])),
                "criteria": "本路相对参考显著下降且接近缺失；另一路仍有信号" if n_channels == 2
                else "单声道相对参考近乎整路消失",
            }
            channels = [c]
            if n_channels == 2:
                metrics.update({
                    "other_channel_rms_db": _clean(float(result.rms_db[worst, 1 - c])),
                    "other_channel_drop_db": _clean(float(rms_def[worst, 1 - c])),
                    "other_active_threshold_db": float(cfg.other_active_db),
                    "cross_channel_correlation": _clean(float(result.correlation[worst])),
                })
            annotations.append(Annotation(
                start=start,
                end=end,
                kind=CHANNEL_LOSS,
                channels=channels,
                bands=[],
                label=f"整路缺音·{'左右'[c] if n_channels == 2 else '单声道'}",
                confidence=min(1.0, max(0.0, float(rms_def[worst, c] / (cfg.channel_drop_db * 1.5)))),
                metrics=json_safe(metrics),
            ))

    # ---- Normal/global quiet -----------------------------------------------
    # Quiet means every channel is low together. A one-sided disappearance is
    # already represented as channel loss.
    for f in range(n_frames):
        all_low = True
        for c in range(n_channels):
            low = (
                result.rms_db[f, c] <= cfg.quiet_abs_db
                or rms_def[f, c] >= cfg.quiet_drop_db
            )
            if not low or channel_masks[c][f]:
                all_low = False
                break
        quiet_global[f] = all_low
    quiet_mask = _close_gap(quiet_global, gap_frames)
    for i0, i1 in _spans(quiet_mask):
        start = float(result.frame_starts[i0] / result.sample_rate)
        end = float(result.frame_ends[i1] / result.sample_rate)
        if end - start < max(min_seconds, 0.12):
            continue
        seg = slice(i0, i1 + 1)
        worst = i0 + int(np.argmax(np.max(rms_def[seg, :], axis=1)))
        metrics = {
            "decision_frame": int(worst),
            "decision_time_s": _clean(float(result.centers[worst])),
            "rms_db_by_channel": [_clean(float(v)) for v in result.rms_db[worst].tolist()],
            "reference_rms_db_by_channel": [_clean(float(v)) for v in result.reference.rms_db.tolist()],
            "rms_drop_db_by_channel": [_clean(float(v)) for v in rms_def[worst].tolist()],
            "quiet_abs_threshold_dbfs": float(cfg.quiet_abs_db),
            "quiet_relative_threshold_db": float(cfg.quiet_drop_db),
            "median_rms_db_by_channel": [_clean(float(v)) for v in np.median(result.rms_db[seg], axis=0).tolist()],
            "cross_channel_correlation": _clean(float(result.correlation[worst])),
            "partial_frame_included": bool(np.any(~result.complete[i0:i1 + 1])),
            "criteria": "所有声道同时处于低能量，且不满足单路缺失条件",
        }
        annotations.append(Annotation(
            start=start,
            end=end,
            kind=QUIET,
            channels=[],
            bands=[],
            label="正常安静",
            confidence=0.7,
            metrics=json_safe(metrics),
        ))

    # ---- Sudden band loss ---------------------------------------------------
    for c in range(n_channels):
        for b, band in enumerate(result.bands):
            target_def = band_def[:, c, b]
            other_defs = np.delete(band_def[:, c, :], b, axis=1)
            if other_defs.size:
                other_kept_fraction = np.mean(
                    other_defs < cfg.band_drop_db * 0.72, axis=1
                )
            else:
                other_kept_fraction = np.ones(n_frames)

            # The full channel usually remains intelligible, or a majority of
            # other bands remain. During global quiet this is not a band fault.
            mask = (
                (target_def >= cfg.band_drop_db)
                & (
                    (rms_def[:, c] <= max(12.0, cfg.quiet_drop_db - 4.0))
                    | (other_kept_fraction >= 0.5)
                )
                & (~channel_masks[c])
                & (~quiet_global)
            )
            mask = _close_gap(mask, gap_frames)
            for i0, i1 in _spans(mask):
                start = float(result.frame_starts[i0] / result.sample_rate)
                end = float(result.frame_ends[i1] / result.sample_rate)
                if end - start < min_seconds:
                    continue
                seg = slice(i0, i1 + 1)
                worst = i0 + int(np.argmax(target_def[seg]))
                observed = float(result.band_db[worst, c, b])
                reference = float(result.reference.band_db[c, b])
                metrics = {
                    "decision_frame": int(worst),
                    "decision_time_s": _clean(float(result.centers[worst])),
                    "channel": c,
                    "band_key": band.key,
                    "band_name": band.name,
                    "band_low_hz": round(band.low_hz, 2),
                    "band_high_hz": round(band.high_hz, 2),
                    "observed_band_db": _clean(observed),
                    "reference_band_db": _clean(reference),
                    "band_drop_db": _clean(reference - observed),
                    "threshold_drop_db": float(cfg.band_drop_db),
                    "median_observed_band_db": _clean(float(np.median(result.band_db[seg, c, b]))),
                    "max_band_drop_db_in_interval": _clean(float(np.max(target_def[seg]))),
                    "full_band_rms_db": _clean(float(result.rms_db[worst, c])),
                    "reference_full_band_rms_db": _clean(float(result.reference.rms_db[c])),
                    "full_band_rms_drop_db": _clean(float(rms_def[worst, c])),
                    "other_bands_kept_fraction": _clean(float(other_kept_fraction[worst])),
                    "cross_channel_correlation": _clean(float(result.correlation[worst])),
                    "partial_frame_included": bool(np.any(~result.complete[i0:i1 + 1])),
                    "criteria": "该频带相对参考下降超过阈值，同时全频或其他频带仍有能量",
                }
                ch_text = f"{'左右'[c]}声道·" if n_channels == 2 else ""
                annotations.append(Annotation(
                    start=start,
                    end=end,
                    kind=BAND_LOSS,
                    channels=[c],
                    bands=[band.key],
                    label=f"频带突断·{ch_text}{band.name.split(' ')[0]}",
                    confidence=min(1.0, max(0.0, float((reference - observed) / (cfg.band_drop_db * 1.5)))),
                    metrics=json_safe(metrics),
                ))

    annotations.sort(key=lambda a: (a.start, a.kind, a.channels[0] if a.channels else -1))
    return annotations
