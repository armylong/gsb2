"""wav 读写、重采样、时长对齐、响度与循环交叉淡化.

全部离线处理,  float64 内部计算, 导出时再转 int16。
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from scipy.io import wavfile
from scipy.signal import resample_poly

TARGET_RMS = 0.1          # 导出/试听统一响度目标 (RMS, 满刻度为 1)
PEAK_HEADROOM = 0.89      # 峰值上限, 约 -1 dBFS
END_FADE_S = 0.005        # 首尾 5ms 淡入淡出, 防爆音


def load_mono(path: str | Path, target_sr: int) -> tuple[np.ndarray, int]:
    """读 wav, 多声道混成单声道, 重采样到 target_sr。保留原始幅度, 不做归一化。"""
    sr, data = wavfile.read(str(path))
    if data.ndim > 1:
        data = data.mean(axis=1)
    if np.issubdtype(data.dtype, np.integer):
        x = data.astype(np.float64) / np.iinfo(data.dtype).max
    elif data.dtype == np.float32:
        x = data.astype(np.float64)
    else:
        x = data.astype(np.float64)
    if sr != target_sr:
        g = math.gcd(int(sr), int(target_sr))
        x = resample_poly(x, target_sr // g, sr // g)
    return np.ascontiguousarray(x), int(sr)


def fit_modulator(x: np.ndarray, target_len: int) -> np.ndarray:
    """调制声对齐目标长度: 长则截断, 短则补零(尾部天然静音保留)。说话声不循环。"""
    if len(x) == target_len:
        return x
    if len(x) > target_len:
        return x[:target_len].copy()
    out = np.zeros(target_len, dtype=np.float64)
    out[: len(x)] = x
    return out


def loop_carrier(x: np.ndarray, target_len: int, sr: int,
                 fade_s: float = 0.02) -> np.ndarray:
    """把载波声循环铺到 target_len, 接点用等功率交叉淡化消除咔哒声。

    载波比目标长时直接截断; 短时反复拼接, 相邻两段在重叠区做 cos/sin 淡化。
    """
    x = np.asarray(x, dtype=np.float64)
    if target_len <= 0:
        return np.zeros(0, dtype=np.float64)
    if len(x) >= target_len:
        out = x[:target_len].copy()
    else:
        fade_len = int(sr * fade_s)
        fade_len = max(1, min(fade_len, len(x) // 2))
        out = np.zeros(target_len, dtype=np.float64)
        pos = 0
        n = len(x)
        while pos < target_len:
            end = min(pos + n, target_len)
            count = end - pos
            if pos == 0:
                out[:count] = x[:count]
            else:
                ov = min(fade_len, count)
                t = np.linspace(0.0, math.pi / 2, ov, endpoint=False)
                out[pos: pos + ov] = (out[pos: pos + ov] * np.cos(t)
                                      + x[:ov] * np.sin(t))
                if count > ov:
                    out[pos + ov: end] = x[ov:count]
            pos = end
    _apply_end_fades(out, sr)
    return out


def _apply_end_fades(x: np.ndarray, sr: int) -> None:
    n = int(sr * END_FADE_S)
    n = min(n, len(x) // 2)
    if n <= 1:
        return
    ramp = np.linspace(0.0, 1.0, n)
    x[:n] *= ramp
    x[-n:] *= ramp[::-1]


def normalize_loudness(x: np.ndarray,
                       target_rms: float = TARGET_RMS,
                       peak_limit: float = PEAK_HEADROOM) -> tuple[np.ndarray, float]:
    """统一响度: 向 target_rms 靠拢, 同时峰值不许超过 peak_limit。静音原样返回。"""
    rms = float(np.sqrt(np.mean(x ** 2))) if len(x) else 0.0
    peak = float(np.max(np.abs(x))) if len(x) else 0.0
    if rms < 1e-7 or peak < 1e-7:
        return x.copy(), 1.0
    scale = min(target_rms / rms, peak_limit / peak)
    return x * scale, float(scale)


def measure(x: np.ndarray, sr: int, edge_s: float = 0.05) -> dict:
    """给导出对照用的测量值: 采样率、时长、首尾响度、整体 RMS/峰值。"""
    x = np.asarray(x, dtype=np.float64)
    n_edge = min(len(x) // 2, int(sr * edge_s))
    head = x[:n_edge] if n_edge else x[:1]
    tail = x[-n_edge:] if n_edge else x[-1:]
    return {
        "sr": int(sr),
        "samples": int(len(x)),
        "duration_s": float(len(x) / sr) if sr else 0.0,
        "rms": float(np.sqrt(np.mean(x ** 2))) if len(x) else 0.0,
        "peak": float(np.max(np.abs(x))) if len(x) else 0.0,
        "head_rms": float(np.sqrt(np.mean(head ** 2))) if len(head) else 0.0,
        "tail_rms": float(np.sqrt(np.mean(tail ** 2))) if len(tail) else 0.0,
    }


def save_wav(path: str | Path, x: np.ndarray, sr: int) -> None:
    """按目标响度归一化后写 16-bit PCM wav。"""
    y, _ = normalize_loudness(np.asarray(x, dtype=np.float64))
    pcm = np.clip(y, -1.0, 1.0)
    wavfile.write(str(path), int(sr), (pcm * 32767.0).astype(np.int16))
