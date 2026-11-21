"""粒子拉伸引擎(纯 numpy)。

做法: 在选段内按分析步进取 Hann 窗粒子, 输出侧按 hop*ratio 的步进做重叠相加;
源位置加固定种子的随机抖动(左右声道共用同一位置, 保持立体声对应);
输出按窗函数和归一化, 两端加短余弦淡入淡出保证边缘平滑。
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

MIN_GRAIN = 64      # 最小窗口(采样)
MIN_HOP = 32        # 最小分析步进(采样)
MAX_OVERLAP = 0.95  # 重叠上限


class StretchError(ValueError):
    """参数越界时抛出, 信息含具体数值与调整建议。"""


@dataclass
class StretchResult:
    audio: np.ndarray          # (n, ch) float32
    sr: int
    out_centers: np.ndarray    # 每个输出粒子的中心时间(秒), 用于画输出分布
    src_positions: np.ndarray  # 每个输出粒子对应的源位置(秒, 相对选段起点)


def _validate(sr: int, sel_len: int, grain_ms: float, overlap: float,
              ratio: float, jitter_ms: float) -> tuple[int, int]:
    grain = int(round(grain_ms * sr / 1000.0))
    if grain < MIN_GRAIN:
        raise StretchError(
            f"窗口太小: {grain_ms:g}ms @ {sr}Hz = {grain} 采样 < 最小 {MIN_GRAIN} 采样, 请加大窗口")
    if sel_len < grain:
        raise StretchError(
            f"选段太短: 选段 {sel_len} 采样 ({sel_len / sr * 1000:.1f}ms) "
            f"< 窗口 {grain} 采样 ({grain_ms:g}ms); "
            f"请把窗口降到 ≤{sel_len / sr * 1000:.1f}ms 或加长选段")
    if not 0.0 <= overlap <= MAX_OVERLAP:
        raise StretchError(f"重叠需在 0~{MAX_OVERLAP:.0%} 之间, 当前 {overlap:.0%}")
    hop = int(round(grain * (1.0 - overlap)))
    if hop < MIN_HOP:
        raise StretchError(
            f"重叠过高: 窗口 {grain} 采样下分析步进 {max(hop, 1)} 采样 < 最小 {MIN_HOP} 采样; "
            f"请把重叠降到 ≤{1.0 - MIN_HOP / grain:.1%} 或加大窗口")
    if ratio <= 0:
        raise StretchError(f"拉伸倍率必须 > 0, 当前 {ratio}")
    if jitter_ms < 0:
        raise StretchError("抖动不能为负")
    return grain, hop


def grain_positions(sel_len: int, grain: int, hop: int) -> np.ndarray:
    """分析粒子起点: 等距铺满 [0, sel_len-grain], 末粒子恰好对齐选段尾(全段覆盖)。"""
    if sel_len <= grain:
        return np.array([0])
    n = max(2, int(np.ceil((sel_len - grain) / hop)) + 1)
    return np.linspace(0, sel_len - grain, n).round().astype(np.int64)


def stretch(audio: np.ndarray, sr: int, start: float, end: float, *,
            grain_ms: float = 80.0, overlap: float = 0.75, ratio: float = 8.0,
            jitter_ms: float = 5.0, seed: int = 0,
            target_sec: float | None = None) -> StretchResult:
    """把 audio[start:end] 拉伸 ratio 倍; 给 target_sec 时循环取粒子凑足指定时长。"""
    if audio.ndim == 1:
        audio = audio[:, None]
    s0 = max(0, int(round(start * sr)))
    s1 = min(len(audio), int(round(end * sr)))
    if s1 <= s0:
        raise StretchError(f"选段为空: start={start}s end={end}s")
    sel = audio[s0:s1]
    sel_len = len(sel)

    grain, hop = _validate(sr, sel_len, grain_ms, overlap, ratio, jitter_ms)
    positions = grain_positions(sel_len, grain, hop)
    win = np.hanning(grain).astype(np.float32)[:, None]

    hop_out = max(1.0, hop * ratio)
    natural = (sel_len - grain) * ratio + grain
    total = int(round(target_sec * sr)) if target_sec else int(round(natural))
    if total < grain:
        raise StretchError(
            f"目标时长太短: {total} 采样 < 一个窗口 {grain} 采样, 请加长导出时长")
    n_frames = int(np.ceil((total - grain) / hop_out)) + 1

    jitter = int(round(jitter_ms * sr / 1000.0))
    rng = np.random.default_rng(seed)
    jit = rng.integers(-jitter, jitter + 1, size=n_frames) if jitter > 0 \
        else np.zeros(n_frames, dtype=np.int64)

    out = np.zeros((total + grain, audio.shape[1]), dtype=np.float32)
    norm = np.zeros((total + grain, 1), dtype=np.float32)
    out_centers = np.empty(n_frames)
    src_positions = np.empty(n_frames)
    for i in range(n_frames):
        p = int(positions[i % len(positions)]) + int(jit[i])  # 两声道同一切片, 立体声联动
        p = min(max(p, 0), sel_len - grain)
        o = int(round(i * hop_out))
        out[o:o + grain] += sel[p:p + grain] * win
        norm[o:o + grain] += win
        out_centers[i] = (o + grain / 2) / sr
        src_positions[i] = p / sr

    np.maximum(norm, 1e-8, out=norm)
    out = (out[:total] / norm[:total]).astype(np.float32)

    # 边缘平滑: 短余弦淡入淡出
    fade = min(grain // 2, int(0.01 * sr), total // 2)
    if fade > 1:
        t = np.linspace(0, np.pi, fade, dtype=np.float32)[:, None]
        out[:fade] *= (1 - np.cos(t)) / 2
        out[-fade:] *= (1 + np.cos(t)) / 2

    return StretchResult(out, sr, out_centers, src_positions)
