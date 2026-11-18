# -*- coding: utf-8 -*-
"""两条重采样路径。

路径 A — 基础线性插值: 纯 numpy 实现, 不做任何抗混叠低通。
        下采样时超过新奈奎斯特频率的成分会直接折叠回来, 用于暴露混叠问题。
路径 B — 高质量抗混叠: soxr (SoX Resampler, libsoxr), 'HQ' 档带限重采样。

两条路径共用相同输入、目标采样率与音量(全程不做增益/响度处理)。
目标采样率 == 输入采样率时, 直接返回原始采样数据的副本(逐样本相同)。
输出点数统一为 round(输入时长 * 目标采样率), 两条路径等长。
"""
from __future__ import annotations

import numpy as np
import soxr

from .audioio import Track


def expected_num_frames(input_track: Track, target_sr: int) -> int:
    """按 输入时长 * 目标采样率 四舍五入得到目标点数。"""
    return int(round(input_track.num_frames / float(input_track.sr) * target_sr))


def _fit_length(x: np.ndarray, n_out: int) -> np.ndarray:
    """把重采样结果精确裁/补到目标点数(soxr 通常已精确, 此处为兜底)。"""
    n = x.shape[0]
    if n == n_out:
        return np.ascontiguousarray(x, dtype=np.float32)
    if n > n_out:
        return np.ascontiguousarray(x[:n_out], dtype=np.float32)
    pad = n_out - n
    if x.ndim == 1:
        x = np.pad(x, (0, pad))
    else:
        x = np.pad(x, ((0, pad), (0, 0)))
    return np.ascontiguousarray(x, dtype=np.float32)


def linear_resample(x: np.ndarray, in_sr: int, out_sr: int, n_out: int) -> np.ndarray:
    """路径 A: 线性插值重采样(无抗混叠滤波), 支持单/双声道。"""
    if out_sr == in_sr:
        return np.array(x, dtype=np.float32, copy=True)

    n_in = x.shape[0]
    # 输出样本对应在输入时间轴上的浮点位置, 端点对齐
    idx = np.arange(n_out, dtype=np.float64) * (n_in - 1) / max(n_out - 1, 1)
    i0 = np.floor(idx).astype(np.int64)
    i1 = np.minimum(i0 + 1, n_in - 1)
    frac = (idx - i0).astype(np.float32)

    if x.ndim == 1:
        y = x[i0].astype(np.float32) * (1.0 - frac) + x[i1].astype(np.float32) * frac
    else:
        f = frac[:, None]
        y = x[i0].astype(np.float32) * (1.0 - f) + x[i1].astype(np.float32) * f
    return np.ascontiguousarray(y, dtype=np.float32)


def high_quality_resample(
    x: np.ndarray, in_sr: int, out_sr: int, n_out: int
) -> np.ndarray:
    """路径 B: soxr HQ 带抗混叠滤波的高质量重采样。"""
    if out_sr == in_sr:
        return np.array(x, dtype=np.float32, copy=True)
    y = soxr.resample(x, in_sr, out_sr, quality="HQ")
    return _fit_length(y, n_out)


def convert(input_track: Track, target_sr: int, method: str) -> Track:
    """按指定方法生成一路结果 Track。

    method: 'linear' | 'high_quality'
    """
    if method not in ("linear", "high_quality"):
        raise ValueError(f"未知重采样方法: {method}")
    n_out = expected_num_frames(input_track, target_sr)

    if target_sr == input_track.sr:
        # 相同采样率: 保持原采样数据, 不做任何处理
        y = np.array(input_track.samples, dtype=np.float32, copy=True)
        note = "目标采样率与输入相同, 原样复制采样数据"
    elif method == "linear":
        y = linear_resample(input_track.samples, input_track.sr, target_sr, n_out)
        note = "线性插值, 无抗混叠滤波"
    else:
        y = high_quality_resample(
            input_track.samples, input_track.sr, target_sr, n_out
        )
        note = "soxr HQ 带抗混叠滤波"

    name = {
        "linear": f"线性插值 @ {target_sr/1000:.1f}kHz",
        "high_quality": f"高质量(抗混叠) @ {target_sr/1000:.1f}kHz",
    }[method]
    return Track(
        name=name,
        sr=target_sr,
        samples=y,
        kind="result",
        tone_specs=list(input_track.tone_specs),
        source_name=input_track.name,
        note=note,
    )
