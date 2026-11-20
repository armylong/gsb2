"""时差估计核心。

约定:
    ch1[n] ≈ ch0[n - delay]      (delay 为采样点数，正值表示 ch1 晚到)
    互相关 r[k] = sum_n ch0[n] * ch1[n + k]，峰值位置 k 即 delay。
    反相时 ch1[n] ≈ -ch0[n - delay]，用取反后的互相关来区分。

只依赖 numpy / scipy，命令行自检与 UI 共用同一套实现。
"""

from __future__ import annotations

import numpy as np
from scipy.fft import irfft, next_fast_len, rfft
from scipy.signal import get_window

from .models import DriftResult, Peak, TdoaResult

# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------


def _xcorr(a: np.ndarray, b: np.ndarray, max_lag: int) -> np.ndarray:
    """原始互相关，lag ∈ [-max_lag, max_lag]；b[n] ≈ a[n-lag] 时峰在 +lag。"""
    nfft = next_fast_len(a.size + b.size + 2 * max_lag + 1)
    r = irfft(np.conj(rfft(a, nfft)) * rfft(b, nfft), nfft)
    return r[np.arange(-max_lag, max_lag + 1) % nfft]


def normalized_xcorr(a: np.ndarray, b: np.ndarray, max_lag: int) -> tuple[np.ndarray, np.ndarray]:
    """归一化互相关（NCC），值域约 -1..1，返回 (ncc, lags)。

    在每个滞后上用重叠区的局部能量归一化，再乘 sqrt(重叠比例)，
    避免短片段两端因重叠变少而出现虚假高峰。
    """
    a = np.asarray(a, dtype=np.float64).reshape(-1)
    b = np.asarray(b, dtype=np.float64).reshape(-1)
    n = min(a.size, b.size)
    a, b = a[:n], b[:n]
    max_lag = int(max(0, min(max_lag, n - 1)))
    lags = np.arange(-max_lag, max_lag + 1)

    raw = _xcorr(a, b, max_lag)
    ea = np.concatenate(([0.0], np.cumsum(a * a)))
    eb = np.concatenate(([0.0], np.cumsum(b * b)))
    k = lags
    pos = np.maximum(k, 0)
    neg = np.maximum(-k, 0)
    # k >= 0: a[0:n-k] 对 b[k:n]；k < 0: a[-k:n] 对 b[0:n+k]
    e_a = np.where(k >= 0, ea[n - pos], ea[n] - ea[neg])
    e_b = np.where(k >= 0, eb[n] - eb[pos], eb[n - neg])
    denom = np.sqrt(np.maximum(e_a, 1e-300) * np.maximum(e_b, 1e-300))
    ncc = np.divide(raw, denom, out=np.zeros_like(raw), where=denom > 1e-18)

    overlap = np.maximum(n - np.abs(k), 0)
    ncc *= np.sqrt(overlap / max(n, 1))
    return ncc, lags


def _parabolic(y: np.ndarray, i: int) -> float:
    """三点抛物线插值，返回相对 i 的亚采样偏移，范围 (-1, 1)。"""
    if i <= 0 or i >= len(y) - 1:
        return 0.0
    y0, y1, y2 = float(y[i - 1]), float(y[i]), float(y[i + 1])
    denom = y0 - 2.0 * y1 + y2
    if abs(denom) < 1e-18 or abs(y1) < 1e-18:
        return 0.0
    return float(np.clip(0.5 * (y0 - y2) / denom, -0.999, 0.999))


def _find_peaks(corr: np.ndarray, max_lag: int, count: int, min_sep: int):
    """在 ±max_lag 内找若干个互斥峰，返回 [(lag, value)]，按高度降序。"""
    tmp = corr.copy()
    found: list[tuple[int, float]] = []
    for _ in range(max(count * 8, 8)):
        if len(found) >= count:
            break
        i = int(np.argmax(tmp))
        if not np.isfinite(tmp[i]) or tmp[i] <= 0:
            break
        if all(abs(i - (lag + max_lag)) >= min_sep for lag, _ in found):
            found.append((i - max_lag, float(corr[i])))
            lo, hi = max(0, i - min_sep), min(tmp.size, i + min_sep + 1)
            tmp[lo:hi] = -np.inf
        else:
            tmp[i] = -np.inf
    found.sort(key=lambda kv: kv[1], reverse=True)
    return found


def _sharpness(corr: np.ndarray, i: int) -> float:
    if i <= 0 or i >= corr.size - 1:
        return 0.0
    return float(
        np.clip((2 * corr[i] - corr[i - 1] - corr[i + 1]) / (abs(corr[i]) + 1e-12), 0.0, 1.0)
    )


def _confidence(value: float, best: float, sharp: float, floor: float, n_peaks: int) -> float:
    """启发式 0..1 置信度：峰高比 + 与噪声底分离度 + 峰形尖锐度。不是统计概率。"""
    if best <= 0:
        return 0.0
    ratio = max(0.0, value) / best
    sep = float(np.clip((value - floor) / max(best - floor, 1e-12), 0.0, 1.0))
    conf = 0.55 * ratio + 0.30 * sep + 0.15 * sharp
    if n_peaks > 1:
        conf *= 0.92
    return float(np.clip(conf, 0.0, 1.0))


def _is_periodic(peaks: list[Peak], sr: int, best: float) -> tuple[bool, float]:
    """判断接近等高的候选峰是否近似等间距（重复节奏/回声）。返回 (是否, 周期采样)。"""
    lags = sorted(p.lag for p in peaks if best > 0 and p.score >= 0.90 * best)
    if len(lags) < 3:
        return False, 0.0
    gaps = np.diff(lags)
    gaps = gaps[gaps > 0]
    if gaps.size < 2:
        return False, 0.0
    period = float(np.median(gaps))
    tol = max(2.0, 0.01 * period)
    hits = int(np.sum(np.abs(gaps - period) <= tol))
    return hits >= max(2, gaps.size - 1), period


# ---------------------------------------------------------------------------
# 主估计
# ---------------------------------------------------------------------------


def estimate_delay(
    ch0: np.ndarray,
    ch1: np.ndarray,
    sr: int,
    max_lag: int | None = None,
    top_k: int = 6,
    detrend: bool = True,
    window: str | None = "hann",
    min_sep_ms: float = 3.0,
    force_polarity: int | None = None,
) -> TdoaResult:
    """估计 ch1 相对 ch0 的到达时差，保留多个候选峰并区分反相。

    force_polarity: 手动指定 +1/-1 时跳过自动极性判断（用于界面里的人工复核）。
    """
    a = np.asarray(ch0, dtype=np.float64).reshape(-1)
    b = np.asarray(ch1, dtype=np.float64).reshape(-1)
    n = min(a.size, b.size)
    if n < 8:
        raise ValueError("片段太短，至少需要 8 个采样点")
    a, b = a[:n], b[:n]
    if detrend:
        a = a - np.mean(a)
        b = b - np.mean(b)

    w = get_window(window, n) if window else None
    a_w = a * w if w is not None else a
    b_w = b * w if w is not None else b

    if max_lag is None:
        max_lag = n - 1
    max_lag = int(max(1, min(max_lag, n - 1)))

    corr_p, lags = normalized_xcorr(a_w, b_w, max_lag)
    corr_n, _ = normalized_xcorr(a_w, -b_w, max_lag)

    pmax, nmax = float(np.max(corr_p)), float(np.max(corr_n))
    if force_polarity in (-1, 1):
        polarity = int(force_polarity)
        corr = corr_n if polarity < 0 else corr_p
    else:
        polarity, corr = (1, corr_p) if pmax >= nmax * 1.01 else (-1, corr_n)
    polarity_margin = abs(pmax - nmax) / max(pmax, nmax, 1e-12)

    # 噪声地板：用差分的稳健尺度，避免把平滑旁瓣当成噪声
    floor = float(np.median(np.abs(np.diff(corr)))) * 1.4826 or 1e-9

    min_sep = max(1, int(round(min_sep_ms * sr / 1000.0)))
    raw = _find_peaks(corr, max_lag, top_k, min_sep)
    if not raw:
        raw = [(int(np.argmax(corr)) - max_lag, float(np.max(corr)))]

    best = raw[0][1]
    # 物理先验：几个峰几乎等高时，优先选 |lag| 较小的那个作为主峰。
    # 周期信号的无歧义解无法从单段互相关确定，这里只给一个可解释的默认值。
    if len(raw) > 1 and best > 0:
        close = [kv for kv in raw if kv[1] >= 0.95 * best]
        close.sort(key=lambda kv: abs(kv[0]))
        chosen = close[0]
        raw = [chosen] + [kv for kv in raw if kv is not chosen]

    peaks: list[Peak] = []
    for rank, (lag, val) in enumerate(raw):
        ratio = max(0.0, val) / best if best > 0 else 0.0
        if rank == 0:
            label = "主峰"
        elif ratio >= 0.90:
            label = "近似等高候选"
        elif ratio >= 0.35:
            label = "次峰"
        else:
            label = "弱候选"
        peaks.append(
            Peak(
                lag=int(lag),
                score=float(max(0.0, val)),
                confidence=_confidence(val, best, _sharpness(corr, lag + max_lag), floor, len(raw)),
                label=label,
                sub_shift=_parabolic(corr, lag + max_lag),
                ambiguous=bool(rank > 0 and ratio >= 0.90),
            )
        )

    notes: list[str] = []
    if polarity < 0:
        notes.append(
            f"检测到反相：ch1 与 ch0 波形极性相反（同相/反相相关差 {polarity_margin:.0%}，"
            "已自动按反相估计时差）"
        )
    amb = [p for p in peaks[1:] if p.ambiguous]
    if amb:
        periodic, period = _is_periodic(peaks, sr, best)
        if periodic:
            notes.append(
                f"存在 {len(amb)} 个近似等高的候选峰，间距约 {period:.0f} 采样"
                f"（{period / sr * 1000:.1f} ms），符合重复节奏/回声特征；"
                "单段互相关无法唯一确定，请结合波形手动选择"
            )
            for p in amb:
                p.label = "重复节奏候选"
        else:
            notes.append(
                f"存在 {len(amb)} 个高度接近的候选峰（非等间距），请结合局部波形手动选择"
            )

    return TdoaResult(
        peaks=peaks,
        lags=lags,
        correlogram=corr,
        max_lag=max_lag,
        sr=int(sr),
        delay=float(peaks[0].lag),
        sub_shift=float(peaks[0].sub_shift),
        polarity=polarity,
        polarity_margin=float(polarity_margin),
        notes=notes,
    )


# ---------------------------------------------------------------------------
# 时间变化 / 漂移
# ---------------------------------------------------------------------------


def sliding_delay(
    ch0: np.ndarray,
    ch1: np.ndarray,
    sr: int,
    win_s: float = 0.20,
    hop_s: float = 0.10,
    max_lag: int | None = None,
    polarity: int = 1,
    min_confidence: float = 0.3,
) -> DriftResult:
    """按滑动窗口估计局部时差，用于区分“固定时差 + 反相”和“时差随时间变化”。"""
    a = np.asarray(ch0, dtype=np.float64).reshape(-1)
    b = np.asarray(ch1, dtype=np.float64).reshape(-1) * (1 if polarity >= 0 else -1)
    n = min(a.size, b.size)
    a, b = a[:n], b[:n]
    win = max(64, int(win_s * sr))
    hop = max(1, int(hop_s * sr))
    if n < win:
        win = max(32, n // 2)
        hop = max(1, win // 2)
    if max_lag is None:
        max_lag = min(n - 1, int(0.08 * sr))

    starts = list(range(0, max(1, n - win + 1), hop))
    if starts and starts[-1] + win < n:
        starts.append(n - win)

    times, delays, lo, hi = [], [], [], []
    for s in starts:
        seg_a, seg_b = a[s:s + win], b[s:s + win]
        try:
            r = estimate_delay(seg_a, seg_b, sr, max_lag=max_lag, top_k=1, window="hann")
        except ValueError:
            continue
        main = r.main_peak
        if main.confidence < min_confidence:
            continue
        half = 1.96 * max(0.5, (1.0 - main.confidence) * 3.0)
        times.append((s + win / 2) / sr)
        delays.append(main.refined_lag)
        lo.append(main.refined_lag - half)
        hi.append(main.refined_lag + half)

    t = np.asarray(times, dtype=np.float64)
    d = np.asarray(delays, dtype=np.float64)
    if d.size >= 3:
        # 三点中值平滑，压掉个别窗口跳到重复峰上的离群值
        if d.size >= 5:
            ds = d.copy()
            for i in range(1, d.size - 1):
                ds[i] = np.median(d[i - 1:i + 2])
            d = ds
        slope = float(np.polyfit(t, d, 1)[0])
        fitted = np.polyval(np.polyfit(t, d, 1), t)
        residual = d - fitted
        mad = float(np.median(np.abs(residual - np.median(residual))))
        drift = float(np.median(d[-max(1, d.size // 4):]) - np.median(d[: max(1, d.size // 4)]))
        changed = abs(drift) > max(2.0, 5.0 * mad)
        note = (
            f"局部时差从约 {np.median(d[: max(1, d.size // 4)]):+.1f} 变到约 "
            f"{np.median(d[-max(1, d.size // 4):]):+.1f} 采样（拟合 {slope:+.2f} 采样/秒），"
            "两路之间存在相对时间变化，单一时差值只是近似"
            if changed
            else f"各窗口时差基本一致（拟合斜率 {slope:+.2f} 采样/秒），未发现明显时间变化"
        )
    else:
        slope = drift = 0.0
        changed = False
        note = "有效窗口太少，无法做时变分析"
        lo = list(lo) if hasattr(lo, "__len__") else lo

    return DriftResult(
        times=t,
        delays=d,
        lo=np.asarray(lo, dtype=np.float64),
        hi=np.asarray(hi, dtype=np.float64),
        slope_per_s=slope,
        drift_samples=drift,
        changed=changed,
        note=note,
    )


def reference_interval(
    ch0: np.ndarray,
    ch1: np.ndarray,
    sr: int,
    delay: float,
    polarity: int = 1,
    blocks: int = 5,
    block_s: float = 0.25,
    max_lag: int | None = None,
) -> tuple[float, float, float, list[float]]:
    """把片段切成若干块分别估时差，给出 95% 参考区间。

    返回 (mean, lo, hi, 各块估计)。块数很少时用 t 分布临界值，避免过度自信。
    """
    a = np.asarray(ch0, dtype=np.float64).reshape(-1)
    b = np.asarray(ch1, dtype=np.float64).reshape(-1) * (1 if polarity >= 0 else -1)
    n = min(a.size, b.size)
    a, b = a[:n], b[:n]
    block = max(64, int(block_s * sr))
    if n < block:
        block = max(16, n // 2)
    starts = np.linspace(0, max(0, n - block), blocks).astype(int)
    ests: list[float] = []
    tol = max(4.0, 0.02 * abs(delay) + 2.0)
    for s in starts:
        if n - s < 16:
            continue
        try:
            r = estimate_delay(a[s:s + block], b[s:s + block], sr, max_lag=max_lag, top_k=1, window="hann")
        except ValueError:
            continue
        if abs(r.main_peak.refined_lag - delay) <= tol:
            ests.append(float(r.main_peak.refined_lag))
    if len(ests) >= 2:
        arr = np.asarray(ests)
        mean = float(np.mean(arr))
        se = float(np.std(arr, ddof=1) / np.sqrt(arr.size))
        tcrit = {2: 12.706, 3: 4.303, 4: 3.182, 5: 2.776, 6: 2.571}.get(arr.size, 1.96)
        half = tcrit * se
        return mean, mean - half, mean + half, ests
    return float(delay), float(delay) - 1.0, float(delay) + 1.0, ests


# ---------------------------------------------------------------------------
# 重采样 / 对齐 / 文件
# ---------------------------------------------------------------------------


def fractional_shift(x: np.ndarray, shift: float) -> np.ndarray:
    """FFT 相位旋转实现小数采样平移。

    shift > 0 表示把信号向右移动（延后）shift 个采样。
    """
    x = np.asarray(x, dtype=np.float64)
    if x.size == 0 or abs(shift) < 1e-12:
        return x.copy()
    nfft = next_fast_len(x.size * 2)
    X = rfft(x, nfft)
    phase = np.exp(-2j * np.pi * np.arange(X.size) * shift / nfft)
    return irfft(X * phase, nfft)[: x.size]


def align_to_reference(ch1: np.ndarray, delay: float, polarity: int = 1) -> np.ndarray:
    """把 ch1 对齐到 ch0：先按 polarity 取正/反相，再左移 delay。

    即 aligned[n] = polarity * ch1[n + delay]，与 ch0[n] 对齐。
    """
    y = np.asarray(ch1, dtype=np.float64) * (1 if polarity >= 0 else -1)
    return fractional_shift(y, -float(delay))


def resample_to(x: np.ndarray, sr_in: int, sr_out: int) -> np.ndarray:
    if sr_in == sr_out or x.size == 0:
        return np.asarray(x, dtype=np.float64)
    from math import gcd

    from scipy.signal import resample_poly

    g = gcd(int(sr_in), int(sr_out))
    return resample_poly(np.asarray(x, dtype=np.float64), sr_out // g, sr_in // g)


def write_wav(path: str, data: np.ndarray, sr: int) -> None:
    """写 16-bit PCM wav。data 形状为 (n,) 或 (n, ch)。"""
    import wave

    d = np.asarray(data, dtype=np.float64)
    if d.ndim == 1:
        d = d[:, None]
    peak = float(np.max(np.abs(d))) if d.size else 0.0
    if peak > 1.0:
        d = d / peak * 0.99
    pcm = (np.clip(d, -1.0, 1.0) * 32767.0).astype("<i2")
    with wave.open(path, "wb") as w:
        w.setnchannels(d.shape[1])
        w.setsampwidth(2)
        w.setframerate(int(sr))
        w.writeframes(pcm.tobytes())


def read_wav(path: str) -> tuple[np.ndarray, int]:
    """读 PCM wav，返回 (data[n, ch], sr)，float64 归一化到 ±1。"""
    import wave

    with wave.open(path, "rb") as w:
        sr = w.getframerate()
        nch = w.getnchannels()
        sw = w.getsampwidth()
        raw = w.readframes(w.getnframes())
    if sw == 1:
        arr = (np.frombuffer(raw, dtype=np.uint8).astype(np.float64) - 128.0) / 128.0
    elif sw == 2:
        arr = np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0
    elif sw == 4:
        arr = np.frombuffer(raw, dtype="<i4").astype(np.float64) / 2147483648.0
    else:
        raise ValueError(f"不支持的采样位宽: {sw * 8} bit（需要 8/16/32-bit PCM）")
    if nch > 1:
        arr = arr.reshape(-1, nch)
    else:
        arr = arr.reshape(-1, 1)
    return arr, sr
