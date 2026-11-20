"""按时间映射把待对齐录音渲染到参考时间轴上.

输出的 wav 与参考录音等长、同采样率、同声道数 (单声道会复制)。

缺失区间 (待对齐录音里没有的声音) 在导出中写为静音, 并在说明文件里
明确列出有效声音区间, 避免被误认为原本有录音。
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
from scipy.interpolate import CubicSpline

from .align import AlignmentResult
from .audio import write_wav

# 渲染分块: 每块按参考时间轴切分, 控制内存
_RENDER_CHUNK_S = 8.0


@dataclass
class RenderSummary:
    output_path: Path
    frames: int
    sample_rate: int
    channels: int
    silent_regions: list[tuple[float, float]]
    valid_regions: list[tuple[float, float]]
    gain_applied: float
    peak: float
    rms: float

    def as_dict(self) -> dict:
        return {
            "output_file": self.output_path.name,
            "frames": self.frames,
            "sample_rate": self.sample_rate,
            "channels": self.channels,
            "duration_s": round(self.frames / float(self.sample_rate), 5),
            "silent_regions_s": [[round(a, 4), round(b, 4)] for a, b in self.silent_regions],
            "valid_sound_regions_s": [[round(a, 4), round(b, 4)] for a, b in self.valid_regions],
            "peak": round(self.peak, 5),
            "rms": round(self.rms, 5),
            "gain_applied": round(self.gain_applied, 5),
        }


def preview_envelope(result: AlignmentResult, bins: int = 1600) -> dict:
    """参考时间轴上的包络 (绘制用)。

    返回 dict:
        ref_times      参考时间 (bins,)
        ref_peak       参考录音峰值包络
        aligned_peak   对齐结果包络 (缺失/越界处为 0)
        take_peak      待对齐录音原始包络 (按自身时间轴)
        take_times     上述包络前的参考时间 (缺失处保持接缝值)
        gap_mask       该参考时刻是否处于静音/缺失区间
    """

    ref = result.ref_clip
    take = result.take_clip
    bins = max(64, int(bins))
    dur = ref.duration
    edges = np.linspace(0.0, dur, bins + 1)
    xs = 0.5 * (edges[:-1] + edges[1:])
    take_times = np.asarray(result.curve.take_time_at(xs), dtype=np.float64)
    take_idx = np.clip(take_times * take.sample_rate, 0, take.frames - 1)
    take_mono = take.mono()
    take_abs = np.abs(take_mono)
    aligned = np.interp(take_idx, np.arange(take.frames), take_abs)
    gap = _gap_mask(result, xs)
    out_of_range = (take_times < 0.0) | (take_times > take.duration)
    aligned[(gap | out_of_range)] = 0.0
    ref_idx = np.clip(xs * ref.sample_rate, 0, ref.frames - 1)
    ref_peak = np.abs(np.interp(ref_idx, np.arange(ref.frames), ref.mono()))
    return {
        "ref_times": xs,
        "ref_peak": ref_peak.astype(np.float32),
        "aligned_peak": aligned.astype(np.float32),
        "take_peak": take_abs.astype(np.float32),
        "take_duration": take.duration,
        "gap_mask": gap,
        "take_times": take_times.astype(np.float32),
        "out_of_range": out_of_range,
    }


def _gap_mask(result: AlignmentResult, times: np.ndarray) -> np.ndarray:
    mask = np.zeros_like(times, dtype=bool)
    for gap in result.gaps:
        mask |= (times >= gap.ref_start) & (times < gap.ref_end)
    return mask


def _coverage(result: AlignmentResult) -> list[tuple[float, float]]:
    return list(result.coverage_regions)


def position_consistency(
    result: AlignmentResult,
    wav_path: str | Path,
    windows_s: list[tuple[float, float]] | None = None,
    tolerance_ms: float = 2.0,
) -> dict:
    """比较导出 wav 与当前预览在若干参考时间窗口内的位置一致性。

    用于"导出结果再次打开后应与预览保持相同位置"的自动验证。
    """

    import soundfile as sf
    from scipy import signal as _signal

    data, sr = sf.read(str(wav_path), dtype="float64", always_2d=True)
    if sr != result.ref_clip.sample_rate:
        raise ValueError("导出文件采样率与参考录音不一致")
    if data.shape[0] != result.ref_clip.frames:
        raise ValueError("导出文件长度与参考录音不一致")
    if windows_s is None:
        windows_s = []
        for a, b in result.coverage_regions:
            if b - a >= 2.0:
                windows_s.append((a + 0.25, min(b - 0.25, a + 1.75)))
        if not windows_s:
            windows_s = [(0.0, min(1.0, result.ref_duration))]
    lags_ms: list[float] = []
    details: list[dict] = []
    for (a, b) in windows_s:
        if b - a < 0.2:
            continue
        preview, psr = render_reference_compare(result, "aligned", a, b, sr)
        seg = data[int(round(a * sr)):int(round(a * sr)) + len(preview)]
        if seg.shape[0] < len(preview):
            seg = np.pad(seg, ((0, len(preview) - seg.shape[0]), (0, 0)))
        x = preview.mean(axis=1)
        y = seg.mean(axis=1)
        x = x - x.mean()
        y = y - y.mean()
        denom = np.linalg.norm(x) * np.linalg.norm(y)
        if denom < 1e-9:
            continue
        corr = _signal.correlate(y, x, mode="full", method="fft")
        lags = _signal.correlation_lags(len(y), len(x), mode="full")
        # 只接受 ±20ms 内的位置; 超出说明位置不一致
        keep = np.abs(lags) <= int(0.020 * sr)
        best = int(np.argmax(np.where(keep, corr, -np.inf)))
        lag_ms = float(lags[best]) / sr * 1000.0
        lags_ms.append(lag_ms)
        details.append({
            "start_s": round(a, 3),
            "end_s": round(b, 3),
            "lag_ms": round(lag_ms, 3),
            "ncc": round(float(corr[best] / denom), 4),
        })
    max_abs = max((abs(v) for v in lags_ms), default=0.0)
    return {
        "ok": max_abs <= tolerance_ms,
        "max_abs_lag_ms": round(max_abs, 3),
        "tolerance_ms": tolerance_ms,
        "windows": details,
    }


def render_aligned(
    result: AlignmentResult,
    output_path: str | Path,
    subtype: str = "FLOAT",
) -> RenderSummary:
    """把待对齐录音按结果的时间映射渲染到参考时间轴, 并与参考等长。

    该函数只做时间映射与必要的最小静音填充, 不做音量/包络处理。
    """

    ref = result.ref_clip
    take = result.take_clip
    n = ref.frames
    sr = ref.sample_rate
    ch = ref.channels
    take_sr = take.sample_rate
    take_data = take.samples.astype(np.float64, copy=False)
    take_frames = take.frames

    # 待对齐录音的每个声道各自插值; 待对齐录音为单声道时复制到参考声道
    take_channels = []
    for c in range(ch):
        src_idx = c if c < take.samples.shape[1] else 0
        take_channels.append(take_data[:, src_idx])
    splines = []
    for sig in take_channels:
        x = np.arange(take_frames, dtype=np.float64)
        splines.append(CubicSpline(x, sig, extrapolate=False))

    out = np.zeros((n, ch), dtype=np.float32)
    curve = result.curve
    take_times_all = np.asarray(curve.take_time_at(np.arange(n) / float(sr)), dtype=np.float64)

    # 缺失区间与被参考时间轴覆盖之外的区域写静音
    gap_mask = _gap_mask(result, np.arange(n) / float(sr))
    outside = (take_times_all < 0.0) | (take_times_all > (take_frames - 1) / float(take_sr))
    silent = gap_mask | outside
    # 缺失区间边界处做 5 ms 淡入淡出, 避免爆音; 不影响有效区间内部
    fade = max(1, int(0.005 * sr))
    fade_curve = np.linspace(0.0, 1.0, fade, endpoint=True)

    chunk = max(1, int(_RENDER_CHUNK_S * sr))
    for start in range(0, n, chunk):
        end = min(n, start + chunk)
        if not np.any(~silent[start:end]):
            continue
        tt = take_times_all[start:end]
        valid = ~silent[start:end]
        if not np.any(valid):
            continue
        idx = tt[valid] * take_sr  # 待对齐录音采样索引
        for c in range(ch):
            vals = splines[c](idx)
            vals = np.where(np.isfinite(vals), vals, 0.0)
            block = out[start:end, c]
            block[valid] = vals.astype(np.float32)
    # 在静音区间边缘施加短淡变, 避免切换处爆音 (不改变有效区间内部)
    out = _apply_edge_fades(out, silent, fade_curve)

    peak = float(np.max(np.abs(out))) if out.size else 0.0
    if peak > 1.0:
        # 不做隐式限幅; 明确告知调用方
        raise ValueError(
            f"对齐结果峰值 {peak:.3f} 超出 [-1, 1]; 请先在外部处理增益 (本工具不做混音/增益处理)"
        )
    write_wav(output_path, out, sr, subtype=subtype)
    rms = float(np.sqrt(np.mean(out.astype(np.float64) ** 2))) if out.size else 0.0
    return RenderSummary(
        output_path=Path(output_path),
        frames=n,
        sample_rate=sr,
        channels=ch,
        silent_regions=[(g.ref_start, g.ref_end) for g in result.gaps],
        valid_regions=_coverage(result),
        gain_applied=1.0,
        peak=peak,
        rms=rms,
    )


def _silence_edges(silent: np.ndarray) -> list[tuple[int, int]]:
    padded = np.concatenate([[False], silent, [False]])
    diff = np.diff(padded.astype(np.int8))
    starts = np.where(diff == 1)[0]
    ends = np.where(diff == -1)[0]
    return list(zip(starts.tolist(), ends.tolist()))


def _apply_edge_fades(out: np.ndarray, silent: np.ndarray, fade_curve: np.ndarray) -> np.ndarray:
    """在静音区间的两侧给 *非静音* 侧加短淡入/淡出, 避免切换处爆音。"""

    fade = len(fade_curve)
    n = out.shape[0]
    for a, b in _silence_edges(silent):
        # 静音前 (有效声音) 结尾淡出
        lo = max(0, a - fade)
        if a - lo > 1:
            ramp = fade_curve[-(a - lo):][::-1]
            out[lo:a] *= ramp[:, None]
        # 静音后 (有效声音) 开头淡入
        hi = min(n, b + fade)
        if hi - b > 1:
            ramp = fade_curve[: hi - b]
            out[b:hi] *= ramp[:, None]
    return out


def render_reference_compare(result: AlignmentResult, clip_key: str,
                             start_s: float, end_s: float,
                             sample_rate: int = 48_000) -> tuple[np.ndarray, int]:
    """用于 A/B 对照试听的短片段。

    clip_key:
        "reference" -> 参考录音原样
        "aligned"   -> 同一参考时间区间上的对齐结果 (缺失区间为静音)

    返回 (立体声 float32 (frames, 2), 采样率)。两段的时间轴完全一致。
    """

    from scipy.interpolate import CubicSpline as _CS

    if end_s <= start_s:
        raise ValueError("试听区间终点必须大于起点")
    ref = result.ref_clip
    take = result.take_clip
    if clip_key not in ("reference", "aligned"):
        raise ValueError("clip_key 必须是 'reference' 或 'aligned'")
    sr = int(sample_rate)
    frames = max(1, int(round((end_s - start_s) * sr)))
    ref_times = start_s + np.arange(frames) / float(sr)

    if clip_key == "reference":
        out = np.zeros((frames, 2), dtype=np.float32)
        splines = []
        for c in range(ref.channels):
            src = ref.samples[:, c].astype(np.float64)
            splines.append(_CS(np.arange(ref.frames, dtype=np.float64), src, extrapolate=False))
        idx = ref_times * ref.sample_rate
        for c in range(2):
            sp = splines[c if c < len(splines) else 0]
            vals = sp(idx)
            out[:, c] = np.where(np.isfinite(vals), vals, 0.0).astype(np.float32)
        return out, sr

    # aligned: 用同一参考时间取样, 缺失区间为 0
    out = np.zeros((frames, 2), dtype=np.float32)
    take_times = np.asarray(result.curve.take_time_at(ref_times), dtype=np.float64)
    take_samples = take_times * take.sample_rate
    in_range = (take_samples >= 0) & (take_samples <= take.frames - 1)
    gap = _gap_mask(result, ref_times)
    valid = in_range & (~gap)
    splines = []
    for c in range(take.channels):
        src = take.samples[:, c].astype(np.float64)
        splines.append(_CS(np.arange(take.frames, dtype=np.float64), src, extrapolate=False))
    for c in range(2):
        sp = splines[c if c < len(splines) else 0]
        vals = sp(take_samples[valid])
        vals = np.where(np.isfinite(vals), vals, 0.0).astype(np.float32)
        out[valid, c] = vals
    return out, sr
