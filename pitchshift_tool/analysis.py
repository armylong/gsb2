"""处理前后对比分析: 主频、起音时间、削波位置。"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass

import numpy as np

CLIP_THRESHOLD = 0.99
NEAR_CLIP_THRESHOLD = 0.97
_MERGE_GAP_S = 0.02


def dominant_frequency(
    samples: np.ndarray, sr: int, start_s: float, end_s: float
) -> float:
    """区间内能量最强的频率 (Hz), FFT + 抛物线插值, 亚赫兹精度。"""
    a = int(start_s * sr)
    b = max(a + 2, int(end_s * sr))
    seg = np.asarray(samples, dtype=np.float64).reshape(-1)[a:b]
    if len(seg) < 8:
        return 0.0
    seg = seg - seg.mean()
    if np.max(np.abs(seg)) < 1e-8:
        return 0.0
    # 加 Hann 减少泄漏
    win = np.hanning(len(seg))
    spec = np.abs(np.fft.rfft(seg * win))
    k = int(np.argmax(spec))
    if 0 < k < len(spec) - 1:
        y0, y1, y2 = spec[k - 1], spec[k], spec[k + 1]
        denom = y0 - 2 * y1 + y2
        shift = 0.5 * (y0 - y2) / denom if abs(denom) > 1e-12 else 0.0
        k = k + float(np.clip(shift, -1.0, 1.0))
    return k * sr / len(seg)


def onset_times(
    samples: np.ndarray,
    sr: int,
    start_s: float = 0.0,
    end_s: float | None = None,
    hop: int = 256,
    n_fft: int = 1024,
    cutoff_hz: float = 2000.0,
    rel_thr: float = 1.8,
    abs_frac: float = 0.12,
) -> list[float]:
    """基于高频能量突增的起音检测, 返回起音时刻列表 (秒)。

    判别依据: 鼓点/音头是宽带的, 高频段 (>=cutoff_hz) 能量会瞬间抬升;
    而持续谐波音和相位声码器产生的纹波都是窄带的, 不污染高频段。
    候选帧需同时满足: 绝对高频能量过地板, 且相对过去 100ms 谷底的抬升倍数过阈,
    这样静默区的噪声起伏和持续音的缓慢变化都不会误报。
    对移调处理前后的信号都稳健, 起音时刻漂移在 ~15ms 内。
    """
    x = np.asarray(samples, dtype=np.float64).reshape(-1)
    if end_s is not None:
        x = x[: int(end_s * sr)]
    x = x[int(start_s * sr) :]
    if len(x) < n_fft + hop * 4:
        return []

    window = np.hanning(n_fft)
    n_frames = 1 + (len(x) - n_fft) // hop
    k0 = max(1, int(cutoff_hz * n_fft / sr))
    hf = np.empty(n_frames, dtype=np.float64)
    for f in range(n_frames):
        i0 = f * hop
        mag = np.abs(np.fft.rfft(x[i0 : i0 + n_fft] * window))
        hf[f] = np.sqrt(np.mean(mag[k0:] ** 2) + 1e-12)

    hf_max = hf.max()
    if hf_max < 1e-9:
        return []

    # 过去 ~100ms 的高频能量谷底 (滑动窗口最小值)
    ctx = max(4, int(0.1 * sr / hop))
    running_min = np.empty(n_frames)
    dq: deque[int] = deque()
    for i in range(n_frames):
        while dq and dq[0] < i - ctx + 1:
            dq.popleft()
        while dq and hf[dq[-1]] >= hf[i]:
            dq.pop()
        dq.append(i)
        running_min[i] = hf[dq[0]]

    rel = hf / np.maximum(running_min, 1e-9)
    min_gap_frames = max(1, int(0.2 * sr / hop))
    half_win = max(2, int(0.02 * sr / hop))

    picks: list[int] = []
    for i in range(n_frames - 1):
        lo, hi = max(0, i - half_win), min(n_frames, i + half_win + 1)
        if (
            hf[i] >= abs_frac * hf_max
            and rel[i] >= rel_thr
            and rel[i] == rel[lo:hi].max()
        ):
            if not picks or i - picks[-1] >= min_gap_frames:
                picks.append(i)

    frame_t = hop / sr
    return [round(start_s + p * frame_t, 4) for p in picks]


@dataclass
class ClipRegion:
    start: float
    end: float
    peak: float
    hard: bool  # True=已达到满幅(>=1.0), False=接近削波(>=0.97)


def find_clip_regions(
    samples: np.ndarray, sr: int, threshold: float = NEAR_CLIP_THRESHOLD
) -> list[ClipRegion]:
    """标出可能削波的时间段 (多声道取任一通道超限即算)。"""
    x = np.asarray(samples, dtype=np.float64)
    if x.ndim == 2:
        mag = np.max(np.abs(x), axis=1)
    else:
        mag = np.abs(x)

    over = np.where(mag >= threshold)[0]
    if len(over) == 0:
        return []

    gap = int(_MERGE_GAP_S * sr)
    regions: list[ClipRegion] = []
    run_start = over[0]
    run_prev = over[0]
    for idx in over[1:]:
        if idx - run_prev > gap:
            regions.append(_make_region(mag, run_start, run_prev, sr))
            run_start = idx
        run_prev = idx
    regions.append(_make_region(mag, run_start, run_prev, sr))
    return regions


def _make_region(mag: np.ndarray, i0: int, i1: int, sr: int) -> ClipRegion:
    peak = float(mag[i0 : i1 + 1].max())
    return ClipRegion(
        start=round(i0 / sr, 4),
        end=round((i1 + 1) / sr, 4),
        peak=round(peak, 4),
        hard=peak >= CLIP_THRESHOLD,
    )
