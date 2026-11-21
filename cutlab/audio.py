"""音轨对齐测量。

思路
----
把“源文件在请求起点附近的音频”和“输出文件的音频”都降成 5 ms 的能量包络，
在 ±0.8 s 内做 **归一化互相关**。峰值对应的滞后即音轨相对请求起点的内容偏移：

* ``lag > 0``：输出音轨带入了请求起点 **之前** 的内容（预滚），即音轨比画面晚到；
* ``lag < 0``：输出音轨切掉了请求起点之后的一小段，即音轨比画面早到；
* ``lag ≈ 0``：音轨严格从请求点开始。

纯 Python 实现（不依赖 numpy）。包络在几秒素材上只有几百个点，代价可忽略。
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path

from . import ffmpeg

HOP_SECONDS = 0.005


@dataclass(slots=True)
class Alignment:
    lag: float | None          # 秒；正 = 音轨带入了更早的内容
    confidence: float          # 0..1
    search: float
    peak: float = 0.0
    note: str = ""
    method: str = "envelope-ncc"

    @property
    def ok(self) -> bool:
        return self.lag is not None and self.confidence >= 0.35


def _pcm(path: str | Path, *, start: float | None, duration: float,
         rate: int = 8000) -> list[int]:
    cmd = [ffmpeg.ffmpeg_path(), "-v", "error"]
    if start is not None:
        cmd += ["-seek_timestamp", "1", "-ss", f"{max(start, 0.0):.6f}"]
    cmd += ["-t", f"{max(duration, 0.0):.6f}", "-i", str(path),
            "-map", "0:a:0", "-ac", "1", "-ar", str(rate),
            "-f", "s16le", "-acodec", "pcm_s16le", "-"]
    data = ffmpeg.run_capture(cmd)
    count = len(data) // 2
    return [int.from_bytes(data[i * 2:i * 2 + 2], "little", signed=True)
            for i in range(count)]


def _envelope(samples: list[int], rate: int, hop_seconds: float) -> list[float]:
    hop = max(1, int(rate * hop_seconds))
    env = []
    for i in range(0, len(samples) - hop + 1, hop):
        total = 0
        for s in samples[i:i + hop]:
            total += s * s
        env.append(math.sqrt(total / hop))
    return env


def _dc_removed(env: list[float]) -> list[float]:
    if not env:
        return []
    mean = sum(env) / len(env)
    return [v - mean for v in env]


def _norms(env: list[float]) -> list[float]:
    """前缀平方和，便于 O(1) 求任意窗口的范数。"""
    out = [0.0]
    for v in env:
        out.append(out[-1] + v * v)
    return out


def _window_norm(prefix: list[float], start: int, end: int) -> float:
    if end <= start:
        return 0.0
    return math.sqrt(max(0.0, prefix[end] - prefix[start]))


def _ncc_scores(template: list[float], output: list[float],
                max_lag: int) -> list[tuple[float, int]]:
    tp = _norms(template)
    op = _norms(output)
    t_norm = _window_norm(tp, 0, len(template))
    scores: list[tuple[float, int]] = []
    if t_norm <= 1e-9:
        return scores
    for lag in range(-max_lag, max_lag + 1):
        lo = max(0, -lag)
        hi = min(len(template), len(output) - lag)
        if hi - lo < max(4, len(template) // 3):
            continue
        dot = 0.0
        for i in range(lo, hi):
            dot += template[i] * output[i + lag]
        o_norm = _window_norm(op, lo + lag, hi + lag)
        if o_norm <= 1e-9:
            continue
        scores.append((dot / (t_norm * o_norm), lag))
    scores.sort(reverse=True)
    return scores


def measure(source: str | Path, output: str | Path,
            *, source_absolute_start: float, duration: float,
            search: float = 0.8, hop_seconds: float = HOP_SECONDS) -> Alignment:
    """测量输出音轨相对“请求起点”的内容偏移（秒）。"""
    rate = 8000
    pad = 0.3
    src_from = max(0.0, source_absolute_start - search - pad)
    src_len = duration + 2 * (search + pad)
    out_len = duration + 2 * search + pad

    src_samples = _pcm(source, start=src_from, duration=src_len, rate=rate)
    out_samples = _pcm(output, start=None, duration=out_len, rate=rate)
    if len(src_samples) < rate * 0.25 or len(out_samples) < rate * 0.25:
        return Alignment(None, 0.0, search, note="音频过短，无法对齐")

    src_env = _dc_removed(_envelope(src_samples, rate, hop_seconds))
    out_env = _dc_removed(_envelope(out_samples, rate, hop_seconds))
    if not src_env or not out_env:
        return Alignment(None, 0.0, search, note="音频包络为空")

    # 模板 = 源文件中“请求起点”之后 duration 秒的包络
    skip = int(round((search + pad) / hop_seconds))
    take = max(1, int(round(duration / hop_seconds)))
    template = src_env[skip:skip + take]
    if not template:
        return Alignment(None, 0.0, search, note="请求区间超出文件范围")

    energy = sum(v * v for v in template) / len(template)
    if energy < 1.0:
        return Alignment(None, 0.0, search, note="模板接近静音，无法对齐")

    max_lag = int(round(search / hop_seconds))
    scores = _ncc_scores(template, out_env, max_lag)
    if not scores:
        return Alignment(None, 0.0, search, note="重叠样本不足，无法对齐")

    peak_score, peak_lag = scores[0]
    # 置信度：峰值强度 + 与“远离峰值区域”的最佳分差
    neighborhood = max(3, int(round(0.02 / hop_seconds)))
    outside = [s for s, lag in scores if abs(lag - peak_lag) > neighborhood]
    second = outside[0] if outside else 0.0
    separation = max(0.0, peak_score - second)
    confidence = max(0.0, min(1.0, 0.5 * peak_score + 2.2 * separation))
    note = ""
    if confidence < 0.35:
        note = "音轨特征不足，建议改用更长区间或更明显的音频"
    return Alignment(round(peak_lag * hop_seconds, 4), confidence, search,
                     peak=peak_score, note=note)
