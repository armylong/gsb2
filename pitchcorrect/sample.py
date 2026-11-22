"""可复现样例生成。

构造一条"真实世界"录音: 一台带速在漂移的录音机同时录下内容与参考音。
所有信号先在真实时间轴 t 上生成(参考音严格 f_nom、内容严格 880 Hz、
打点位于已知真实时刻), 再用时变重采样模拟带速漂移, 得到文件时间轴 τ
上的两轨 wav。地面真值(ground truth)随返回值/JSON 一并给出, 供测试对照。
"""
from __future__ import annotations

import json

import numpy as np


def _click(sr: int, dur_s: float = 0.03) -> np.ndarray:
    """一个衰减的短促打点(宽频瞬态, 容易在包络上被找到)。"""
    k = int(sr * dur_s)
    tt = np.arange(k) / sr
    env = np.exp(-tt / (dur_s / 4.0))
    # 加一点低频振荡, 听感像"嗒"的一声
    return env * np.sin(2.0 * np.pi * 880.0 * tt)


def generate_sample(wav_path: str, *, sr: int = 48000, duration: float = 8.0,
                    f_nom: float = 1000.0, seed: int = 20240517,
                    json_path: str | None = None) -> dict:
    """生成样例立体声 wav(0=内容, 1=参考)并返回地面真值。"""
    rng = np.random.default_rng(seed)
    n = int(duration * sr)
    t = np.arange(n) / sr
    dt = 1.0 / sr

    # --- 已知的带速偏差 e(t): 恒定偏高 + 慢漂移 + 快抖动, 全部有界 ---
    e_true = (
        0.004                                              # 固定偏高 0.4%
        + 0.012 * np.sin(2.0 * np.pi * 0.15 * t)          # 慢漂 ±1.2%, 周期 6.7s
        + 0.004 * np.sin(2.0 * np.pi * 2.3 * t + 1.1)     # 快抖动 ±0.4%, 2.3Hz
        + 0.0015 * np.sin(2.0 * np.pi * 7.0 * t)          # 更快的小抖动
    )

    # 录音机在真实时间 t 内录到的磁带位置 τ: dτ/dt = 1/(1+e)
    tau_of_t = np.concatenate(
        ([0.0], np.cumsum(1.0 / (1.0 + e_true[:-1])) * dt))
    total_tape_time = float(tau_of_t[-1])

    # --- 真实时间轴上的信号 ---
    ref_true = 0.30 * np.sin(2.0 * np.pi * f_nom * t)       # 严格恒定参考音

    # 内容: 连续 880 Hz 纯音(校正后应回到 880 Hz) + 几个已知时刻的打点
    content_true = 0.18 * np.sin(2.0 * np.pi * 880.0 * t)
    click_times = [1.2, 3.0, 5.5, 7.0]
    for ct in click_times:
        s = int(ct * sr)
        clk = 0.85 * _click(sr)
        e = min(n, s + clk.size)
        content_true[s:e] += clk[: e - s]

    # 轻微本底噪声
    noise_floor = 0.004
    ref_true += noise_floor * rng.standard_normal(n)
    content_true += noise_floor * rng.standard_normal(n)

    # --- 参考轨掉块: 一个短缺口(可桥接) + 一个长缺口(必须保留) ---
    dropouts_true = [
        {"start": 2.0, "end": 2.28, "kind": "short"},   # 0.28 s
        {"start": 4.1, "end": 5.7, "kind": "long"},     # 1.6 s
    ]
    dropout_mask = np.zeros(n, dtype=bool)
    for d in dropouts_true:
        dropout_mask[(t >= d["start"]) & (t <= d["end"])] = True
    # 掉块处参考音几乎消失, 只剩噪声(模拟录音丢失/被噪声取代)
    ref_true = np.where(dropout_mask,
                        noise_floor * 1.5 * rng.standard_normal(n),
                        ref_true)

    # --- 模拟录音机: 文件按磁带时间 τ 均匀采样。
    # 每个文件样本 k 对应真实时间 src_t[k](τ 轴到 t 轴的反函数),
    # 在 src_t 处对真实信号插值, 即得到带漂移的录音 ---
    n_file = int(total_tape_time * sr)
    tau = np.arange(n_file) / sr
    src_t = np.clip(np.interp(tau, tau_of_t, t), 0.0, t[-1])
    src_pos = src_t * sr

    def resample_at(sig: np.ndarray, positions: np.ndarray) -> np.ndarray:
        pos = np.clip(positions, 0.0, n - 1.0001)
        i0 = np.floor(pos).astype(np.int64)
        frac = pos - i0
        i1 = np.minimum(i0 + 1, n - 1)
        return (1.0 - frac) * sig[i0] + frac * sig[i1]

    ref_file = resample_at(ref_true, src_pos).astype(np.float32)
    content_file = resample_at(content_true, src_pos).astype(np.float32)

    stereo = np.stack((content_file, ref_file), axis=1)
    pcm = np.round(np.clip(stereo, -1.0, 1.0) * 32767.0).astype(np.int16)
    from scipy.io import wavfile
    wavfile.write(wav_path, sr, pcm)

    file_duration = n_file / sr

    # 缺口在文件时间轴上的近似位置(供界面/测试对照)
    dropouts_file = []
    for d in dropouts_true:
        f0 = float(np.interp(d["start"], t, tau_of_t))
        f1 = float(np.interp(d["end"], t, tau_of_t))
        dropouts_file.append({**d, "file_start": round(f0, 4),
                              "file_end": round(f1, 4)})

    truth = {
        "sr": sr,
        "duration_true_s": duration,
        "duration_file_s": round(file_duration, 4),
        "f_nom": f_nom,
        "content_tone_hz": 880.0,
        "click_times_true_s": click_times,
        "e_model": "0.004 + 0.012 sin(2π0.15t) + 0.004 sin(2π2.3t+1.1) "
                   "+ 0.0015 sin(2π7t)",
        "dropouts_true_s": dropouts_true,
        "dropouts_file_s": dropouts_file,
        "channels": {"content": 0, "reference": 1},
        "seed": seed,
    }
    if json_path:
        with open(json_path, "w", encoding="utf-8") as fh:
            json.dump(truth, fh, ensure_ascii=False, indent=2)
    return truth
