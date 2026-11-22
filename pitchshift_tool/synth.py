"""程序生成的标准测试信号 (固定内容, 每次生成完全一致)。

立体声, 8 秒, 44.1kHz:
  - 左右各有不同的持续音 (L 220Hz / R 330Hz), 另有两声道共有的 440Hz 居中音,
    用于考察共有声像是否被处理推到一侧;
  - 4 个短音头 (指数衰减的宽频脉冲) 落在已知时刻, 用于检查起音时间是否保持;
  - 整体峰值归一化到 0.8, 给移调处理留出余量。
"""

from __future__ import annotations

import numpy as np

TEST_SR = 44100
TEST_DURATION = 8.0
SUSTAIN_FREQ_L = 220.0
SUSTAIN_FREQ_R = 330.0
COMMON_FREQ = 440.0
# 音头中心时刻 (秒), 处理前后应保持一致
ONSET_TIMES = (1.0, 2.5, 4.0, 5.5)
ONSET_DECAY_MS = 60.0


def _onset_pulse(t: np.ndarray, center: float, decay_s: float) -> np.ndarray:
    """以 center 为起点的单边指数衰减宽频脉冲 (模拟鼓点/音头)。"""
    dt = t - center
    # 先裁掉会溢出的大负值, 再取指数, 避免 exp 上溢告警
    safe = np.clip(dt / decay_s, -60.0, 60.0)
    env = np.where(dt >= 0, np.exp(-safe), 0.0)
    rng = np.random.default_rng(int(center * 1000) + 7)
    noise = rng.standard_normal(len(t)).astype(np.float32)
    # 加一点低频正弦, 让起音主频也可测量
    body = np.sin(2 * np.pi * 120.0 * t + 0.3)
    return env.astype(np.float32) * (0.7 * noise + 0.3 * body).astype(np.float32)


def build_test_signal(sr: int = TEST_SR, duration: float = TEST_DURATION) -> np.ndarray:
    """返回 float32 立体声数组, shape=(n, 2), 峰值 0.8。"""
    n = int(round(sr * duration))
    t = np.arange(n, dtype=np.float32) / sr

    # 固定音高持续音: 左右不同内容 + 两声道共有成分
    left = 0.5 * np.sin(2 * np.pi * SUSTAIN_FREQ_L * t)
    right = 0.5 * np.sin(2 * np.pi * SUSTAIN_FREQ_R * t)
    common = 0.35 * np.sin(2 * np.pi * COMMON_FREQ * t)
    left += common
    right += common

    # 短音头: 两声道同一时刻、同一波形 (居中的打击声)
    decay_s = ONSET_DECAY_MS / 1000.0
    for c in ONSET_TIMES:
        pulse = _onset_pulse(t, c, decay_s)
        left += 0.6 * pulse
        right += 0.6 * pulse

    stereo = np.stack([left, right], axis=1).astype(np.float32)
    peak = float(np.max(np.abs(stereo)))
    stereo = stereo * (0.8 / peak)
    return np.ascontiguousarray(stereo)
