"""跳点检测与局部修复的核心 DSP.

检测思路
--------
孤立跳点(啪声/掉码)在波形上表现为 1~2 个采样相对周围"中位波形"的突跳,
而真实敲击的起振/衰减是连续的, 频谱与包络都有结构. 所以检测分两级:

1. 对每个声道做滑动中值滤波得到 ``med[n]``, 偏差 ``d[n] = x[n] - med[n]``;
   再用局部中位绝对偏差 (MAD) 归一化得到稳健 z 分数.
   孤立跳点 ``|d|`` 很大且 ``z`` 极高; 噪声/音乐细节的 z 通常只有个位数.
2. 超过绝对幅度门限与 z 门限的采样按 ``merge_gap`` 聚成事件:
   - 事件宽度 > ``max_run`` -> 判定为连续瞬态 (真实起振等), 不进入列表;
   - 宽度内但邻域仍有接近强度的突跳 -> ``protected`` (需人工确认, 默认不修);
   - 其余 -> ``spike`` (可自动修复).
另外 ``background_db`` 为可选的背景保护: 事件所在局部背景高于该值时,
即使像跳点也标为 ``protected``, 避免在强演奏段里误改真实音.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace

import numpy as np

EPS = 1e-12


def to_db(value: float) -> float:
    return float(20.0 * np.log10(max(float(abs(value)), EPS)))


def from_db(db: float) -> float:
    return float(10.0 ** (float(db) / 20.0))


def median_filter(x: np.ndarray, window: int) -> np.ndarray:
    """滑动中值滤波 (反射边界), 仅依赖 NumPy."""
    x = np.asarray(x, dtype=np.float64).reshape(-1)
    n = x.shape[0]
    if n == 0:
        return x.copy()
    w = int(window)
    if w <= 1:
        return x.copy()
    if w % 2 == 0:
        w += 1
    if w >= n:
        return np.full(n, float(np.median(x)))
    half = w // 2
    padded = np.pad(x, (half, half), mode="reflect")
    windows = np.lib.stride_tricks.sliding_window_view(padded, w)
    return np.median(windows, axis=1)


@dataclass
class DetectParams:
    # 绝对幅度门限: 偏离中位波形的幅度 (dBFS)
    abs_threshold_db: float = -30.0
    # 稳健 z 门限: |偏差| / 局部 MAD
    z_threshold: float = 14.0
    # 中值滤波窗口 (采样), 需要大于跳点宽度
    median_window: int = 9
    # 局部 MAD 窗口
    mad_window: int = 31
    # 事件宽度上限, 超过则视为连续瞬态, 不列为跳点
    max_run: int = 4
    # 候选点间隔 <= 该值时合并为同一事件
    merge_gap: int = 2
    # 事件峰值需比邻域最大偏差高出多少 dB, 否则标为 protected
    isolation_db: float = 6.0
    isolation_guard: int = 2
    isolation_span: int = 6
    # 背景保护: 事件两侧窗口的中位幅度高于该值则 protected; -200 关闭
    background_db: float = -60.0
    background_window: int = 48
    # 真实起振保护: 事件邻域中位波形斜率峰值高于该值 -> protected
    # (真实敲击的起振沿一定陡, 数字跳点不会带动中位波形)
    onset_guard_db: float = -50.0
    onset_guard_span: int = 6

    def normalized(self) -> "DetectParams":
        return replace(
            self,
            abs_threshold_db=float(np.clip(self.abs_threshold_db, -160.0, 6.0)),
            z_threshold=float(np.clip(self.z_threshold, 1.0, 200.0)),
            median_window=int(np.clip(self.median_window, 3, 255)),
            mad_window=int(np.clip(self.mad_window, 3, 4095)),
            max_run=int(np.clip(self.max_run, 1, 64)),
            merge_gap=int(np.clip(self.merge_gap, 0, 64)),
            isolation_db=float(np.clip(self.isolation_db, 0.0, 60.0)),
            isolation_guard=int(np.clip(self.isolation_guard, 1, 64)),
            isolation_span=int(np.clip(self.isolation_span, 1, 256)),
            background_db=float(np.clip(self.background_db, -200.0, 20.0)),
            background_window=int(np.clip(self.background_window, 8, 8192)),
            onset_guard_db=float(np.clip(self.onset_guard_db, -200.0, 20.0)),
            onset_guard_span=int(np.clip(self.onset_guard_span, 1, 256)),
        )


@dataclass
class Detection:
    channel: int
    start: int                 # 建议修复范围 (含)
    end: int                   # 建议修复范围 (含)
    peak_frame: int
    deviation_db: float        # 峰值处相对中位波形的偏差
    z_score: float
    background_db: float
    slope_db: float
    run: int
    kind: str                  # "spike" | "protected"
    reason: str

    @property
    def is_spike(self) -> bool:
        return self.kind == "spike"

    @property
    def width(self) -> int:
        return self.end - self.start + 1

    def shifted(self, delta: int) -> "Detection":
        return replace(self, start=self.start + delta, end=self.end + delta,
                       peak_frame=self.peak_frame + delta)

    def contains(self, frame: int, pad: int = 0) -> bool:
        return self.start - pad <= frame <= self.end + pad


@dataclass
class ChannelDetectResult:
    channel: int
    detections: list[Detection] = field(default_factory=list)
    mad_db_median: float = -200.0
    abs_threshold: float = 0.0
    total_candidates: int = 0   # 含被排除的连续瞬态


@dataclass
class DetectResult:
    channels: list[ChannelDetectResult]
    params: DetectParams

    def detections(self, channel: int | None = None) -> list[Detection]:
        out: list[Detection] = []
        for ch in self.channels:
            if channel is None or ch.channel == channel:
                out.extend(ch.detections)
        return out

    @property
    def spikes(self) -> list[Detection]:
        return [d for d in self.detections() if d.kind == "spike"]

    @property
    def protected(self) -> list[Detection]:
        return [d for d in self.detections() if d.kind == "protected"]


def deviation_and_score(x: np.ndarray, params: DetectParams) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    x = np.asarray(x, dtype=np.float64).reshape(-1)
    p = params.normalized()
    med = median_filter(x, p.median_window)
    dev = x - med
    abs_dev = np.abs(dev)
    mad = median_filter(abs_dev, p.mad_window)
    denom = np.maximum(mad, EPS)
    z = abs_dev / denom
    return dev, z, mad


def background_level(x: np.ndarray, start: int, end: int, window: int) -> float:
    n = x.shape[0]
    lo = max(0, start - window)
    hi = min(n, end + 1 + window)
    parts = []
    if lo < start:
        parts.append(np.abs(x[lo:start]))
    if end + 1 < hi:
        parts.append(np.abs(x[end + 1:hi]))
    if not parts:
        return 0.0
    vals = np.concatenate(parts)
    return float(np.median(vals)) if vals.size else 0.0


def _neighbor_peak(abs_dev: np.ndarray, start: int, end: int, guard: int, span: int) -> float:
    n = abs_dev.shape[0]
    left_hi = max(0, start - guard)
    left_lo = max(0, left_hi - span)
    right_lo = min(n, end + 1 + guard)
    right_hi = min(n, right_lo + span)
    peak = 0.0
    if left_lo < left_hi:
        peak = max(peak, float(np.max(abs_dev[left_lo:left_hi])))
    if right_lo < right_hi:
        peak = max(peak, float(np.max(abs_dev[right_lo:right_hi])))
    return peak


def _local_slope_peak(med_slope: np.ndarray, start: int, end: int, span: int) -> float:
    n = med_slope.shape[0]
    lo = max(0, start - span)
    hi = min(n, end + 1 + span)
    if lo >= hi:
        return 0.0
    return float(np.max(med_slope[lo:hi]))


def _group(indices: np.ndarray, gap: int) -> list[tuple[int, int]]:
    groups: list[tuple[int, int]] = []
    if indices.size == 0:
        return groups
    start = prev = int(indices[0])
    for raw in indices[1:]:
        idx = int(raw)
        if idx - prev - 1 <= gap:
            prev = idx
        else:
            groups.append((start, prev))
            start = prev = idx
    groups.append((start, prev))
    return groups


def detect_channel_arrays(x: np.ndarray, params: DetectParams) -> list[Detection]:
    p = params.normalized()
    x = np.asarray(x, dtype=np.float64).reshape(-1)
    n = x.shape[0]
    if n < 3:
        return []
    abs_thresh = from_db(p.abs_threshold_db)
    med = median_filter(x, p.median_window)
    dev = x - med
    abs_dev = np.abs(dev)
    mad = median_filter(abs_dev, p.mad_window)
    z = abs_dev / np.maximum(mad, EPS)
    med_slope = np.abs(np.diff(med, prepend=med[0]))
    candidates = (abs_dev >= abs_thresh) & (z >= p.z_threshold)
    detections: list[Detection] = []
    for start, end in _group(np.flatnonzero(candidates), p.merge_gap):
        run = end - start + 1
        if run > p.max_run:
            continue  # 连续瞬态, 不当作跳点
        seg = abs_dev[start:end + 1]
        peak_off = int(np.argmax(seg))
        peak_frame = start + peak_off
        peak_dev_db = to_db(float(seg[peak_off]))
        neighbor = _neighbor_peak(abs_dev, start, end, p.isolation_guard, p.isolation_span)
        margin_db = peak_dev_db - to_db(neighbor)
        bg_db = to_db(background_level(x, start, end, p.background_window))
        slope = _local_slope_peak(med_slope, start, end, p.onset_guard_span)
        slope_db = to_db(slope)
        kind = "spike"
        reason = "孤立跳点"
        if slope_db > p.onset_guard_db:
            kind = "protected"
            reason = f"邻域中位波形陡峭 (起振沿 {slope_db:.1f} dBFS > {p.onset_guard_db:.1f} dBFS)"
        elif margin_db < p.isolation_db:
            kind = "protected"
            reason = f"邻域存在接近强度的突跳 (余量 {margin_db:.1f} dB < {p.isolation_db:.1f} dB)"
        elif p.background_db > -199.0 and bg_db > p.background_db:
            kind = "protected"
            reason = f"处于强信号背景 ({bg_db:.1f} dBFS > {p.background_db:.1f} dBFS)"
        detections.append(
            Detection(
                channel=0,
                start=start,
                end=end,
                peak_frame=peak_frame,
                deviation_db=peak_dev_db,
                z_score=float(z[peak_frame]),
                background_db=bg_db,
                slope_db=slope_db,
                run=run,
                kind=kind,
                reason=reason,
            )
        )
    return detections


def detect(x: np.ndarray, params: DetectParams | None = None,
           channel: int | None = None) -> DetectResult:
    """检测二维 (frames, channels) 数组; channel 非空时只分析该声道."""
    p = (params or DetectParams()).normalized()
    arr = np.asarray(x, dtype=np.float64)
    if arr.ndim == 1:
        arr = arr[:, None]
    channels: list[ChannelDetectResult] = []
    for ch in range(arr.shape[1]):
        if channel is not None and ch != channel:
            continue
        x = arr[:, ch]
        if x.shape[0] == 0:
            channels.append(ChannelDetectResult(channel=ch,
                                                abs_threshold=from_db(p.abs_threshold_db)))
            continue
        dev, z, mad = deviation_and_score(x, p)
        dets = detect_channel_arrays(x, p)
        for d in dets:
            d.channel = ch
        channels.append(
            ChannelDetectResult(
                channel=ch,
                detections=dets,
                mad_db_median=to_db(float(np.median(mad))) if mad.size else -200.0,
                abs_threshold=from_db(p.abs_threshold_db),
                total_candidates=len(dets),
            )
        )
    return DetectResult(channels=channels, params=p)


# --------------------------------------------------------------------------
# 区间合并与修复
# --------------------------------------------------------------------------

def merge_spans(spans: list[tuple[int, int]], gap: int = 1) -> tuple[list[tuple[int, int]], list[tuple[tuple[int, int], tuple[int, int]]]]:
    """合并重叠或间距 <= gap 的区间.

    返回 (合并后区间, [(原区间A, 原区间B), ...]) 供界面提示合并了哪些候选.
    """
    ordered = sorted((int(a), int(b)) for a, b in spans if b >= a)
    out: list[tuple[int, int]] = []
    merges: list[tuple[tuple[int, int], tuple[int, int]]] = []
    for a, b in ordered:
        if out and a <= out[-1][1] + gap + 1:
            prev = out[-1]
            if a <= prev[1] + 1:
                merges.append((prev, (a, b)))
            out[-1] = (prev[0], max(prev[1], b))
        else:
            out.append((a, b))
    return out, merges


def repair_channel(x: np.ndarray, spans: list[tuple[int, int]], method: str = "linear") -> np.ndarray:
    """用区间外锚点重建被标记的采样; 区间外的采样逐位保留."""
    x = np.asarray(x, dtype=np.float64)
    y = x.copy()
    n = x.shape[0]
    if n == 0:
        return y
    ordered = sorted((max(0, int(a)), min(n - 1, int(b))) for a, b in spans)
    for i in range(1, len(ordered)):
        if ordered[i][0] <= ordered[i - 1][1] + 1:
            raise ValueError("修复区间重叠或相邻, 请先合并")
    for a, b in ordered:
        if a > b:
            continue
        if a == 0 and b == n - 1:
            y[:] = 0.0
            continue
        left_idx = a - 1
        right_idx = b + 1
        if left_idx >= 0:
            y0 = x[left_idx]
        elif right_idx + 1 < n:
            y0 = 2.0 * x[right_idx] - x[right_idx + 1]
        else:
            y0 = x[right_idx]
        if right_idx < n:
            y1 = x[right_idx]
        elif left_idx - 1 >= 0:
            y1 = 2.0 * x[left_idx] - x[left_idx - 1]
        else:
            y1 = x[left_idx]
        y0 = float(np.clip(y0, -1.5, 1.5))
        y1 = float(np.clip(y1, -1.5, 1.5))
        count = b - a + 1
        if method == "cubic" and count >= 2:
            m0 = x[left_idx] - x[left_idx - 1] if (left_idx >= 0 and left_idx - 1 >= 0) else 0.0
            m1 = x[right_idx + 1] - x[right_idx] if right_idx + 1 < n else 0.0
            L = count + 1.0
            t = (np.arange(count, dtype=np.float64) + 1.0) / L
            h00 = 2 * t ** 3 - 3 * t ** 2 + 1
            h10 = t ** 3 - 2 * t ** 2 + t
            h01 = -2 * t ** 3 + 3 * t ** 2
            h11 = t ** 3 - t ** 2
            vals = h00 * y0 + h10 * (m0 * L) + h01 * y1 + h11 * (m1 * L)
            vals = np.clip(vals, min(y0, y1), max(y0, y1))
        else:
            t = (np.arange(count, dtype=np.float64) + 1.0) / (count + 1.0)
            vals = y0 + (y1 - y0) * t
        y[a:b + 1] = vals
    return y


def repair(wav_samples: np.ndarray, spans_by_channel: dict[int, list[tuple[int, int]]],
           method: str = "linear") -> np.ndarray:
    out = np.array(wav_samples, dtype=np.float64, copy=True)
    for ch, spans in spans_by_channel.items():
        if spans:
            out[:, ch] = repair_channel(out[:, ch], spans, method)
    return out


def region_error_db(repaired: np.ndarray, reference: np.ndarray,
                    spans: list[tuple[int, int]], channel: int | None = None) -> tuple[float, float]:
    """区间内修复结果与参考(干净原声)的 RMS/峰值误差 (dBFS)."""
    r = np.asarray(repaired, dtype=np.float64)
    ref = np.asarray(reference, dtype=np.float64)
    mask = np.zeros(r.shape[0], dtype=bool)
    for a, b in spans:
        mask[max(0, int(a)): min(r.shape[0], int(b) + 1)] = True
    if not np.any(mask):
        return -200.0, -200.0
    diff = np.abs(r[mask] - ref[mask])
    if channel is not None:
        diff = diff[:, channel]
    if diff.size == 0:
        return -200.0, -200.0
    return to_db(float(np.sqrt(np.mean(diff ** 2)))), to_db(float(np.max(diff)))
