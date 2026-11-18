"""生成带双声道差异的干净信号与受损版本 (窄带音 + 短时噪声)。

用法:
    python -m tools.make_test_signals --outdir test_assets

输出:
    clean.wav    干净立体声 (左右内容不同, 非折叠单声道)
    damaged.wav  在 clean 基础上加入:
                 - 一段持续窄带干扰音 (仅出现在左声道, 验证不串音)
                 - 两处短时宽带噪声爆发, 其中一处靠近开头、一处靠近结尾
    manifest.txt 噪声位置 (秒 / Hz), 供测试与人工比对使用
"""

from __future__ import annotations

import argparse
import os

import numpy as np
import soundfile as sf

SR = 44100
DURATION = 12.0          # 秒, 远低于 1 分钟限制
TONE_FREQ = 3200.0       # 窄带干扰频率
TONE_T0, TONE_T1 = 3.0, 5.0
BURSTS = [(0.15, 0.28), (11.55, 11.72)]   # 靠近首尾的短时异常
BURST_BAND = (1500.0, 6000.0)


def _clean_signal(rng: np.ndarray.random.Generator) -> np.ndarray:
    t = np.arange(int(DURATION * SR)) / SR
    # 左右使用不同频率组合与不同啁啾, 保证双声道差异明确
    left = (0.32 * np.sin(2 * np.pi * 220 * t)
            + 0.22 * np.sin(2 * np.pi * (330 + 40 * np.sin(2 * np.pi * 0.2 * t)) * t)
            + 0.10 * np.sin(2 * np.pi * 880 * t))
    right = (0.30 * np.sin(2 * np.pi * 277 * t + 0.7)
             + 0.20 * np.sin(2 * np.pi * (415 + 30 * np.sin(2 * np.pi * 0.17 * t)) * t)
             + 0.12 * np.sin(2 * np.pi * 1100 * t + 1.3))
    # 轻微幅度包络, 避免生硬
    env = 0.85 + 0.15 * np.sin(2 * np.pi * 0.1 * t)
    clean = np.stack([left * env, right * env], axis=1)
    # 归一化到 -6 dBFS 左右
    peak = np.max(np.abs(clean))
    clean = clean / peak * 0.5
    return clean.astype(np.float64)


def _add_damage(clean: np.ndarray,
                rng: np.ndarray.random.Generator) -> np.ndarray:
    damaged = clean.copy()
    t = np.arange(clean.shape[0]) / SR

    # 1) 窄带持续干扰, 只加在左声道 -> 右声道应完全不受影响
    mask_tone = (t >= TONE_T0) & (t < TONE_T1)
    tone = 0.25 * np.sin(2 * np.pi * TONE_FREQ * t)
    # 两端 20 ms 淡入淡出, 干扰自身不带爆音
    fade = int(0.02 * SR)
    env = np.ones_like(t)
    i0 = int(TONE_T0 * SR)
    i1 = int(TONE_T1 * SR)
    env[i0:i0 + fade] = np.linspace(0, 1, fade)
    env[i1 - fade:i1] = np.linspace(1, 0, fade)
    damaged[mask_tone, 0] += tone[mask_tone] * env[mask_tone]

    # 2) 短时宽带噪声爆发 (带通), 左右都加但使用独立随机样本
    from scipy.signal import butter, sosfilt
    sos = butter(6, [BURST_BAND[0], BURST_BAND[1]],
                 btype="bandpass", fs=SR, output="sos")
    for b0, b1 in BURSTS:
        j0, j1 = int(b0 * SR), int(b1 * SR)
        length = j1 - j0
        for ch in range(2):
            noise = rng.standard_normal(length)
            noise = sosfilt(sos, noise)
            noise /= max(np.max(np.abs(noise)), 1e-9)
            burst_env = np.hanning(length)
            damaged[j0:j1, ch] += 0.45 * noise * burst_env
    peak = np.max(np.abs(damaged))
    if peak > 0.99:
        damaged *= 0.99 / peak
    return damaged


def generate(outdir: str, seed: int = 10798) -> dict:
    os.makedirs(outdir, exist_ok=True)
    rng = np.random.default_rng(seed)
    clean = _clean_signal(rng)
    damaged = _add_damage(clean, rng)

    clean_path = os.path.join(outdir, "clean.wav")
    damaged_path = os.path.join(outdir, "damaged.wav")
    sf.write(clean_path, clean, SR, subtype="PCM_16")
    sf.write(damaged_path, damaged, SR, subtype="PCM_16")

    manifest = os.path.join(outdir, "manifest.txt")
    with open(manifest, "w", encoding="utf-8") as f:
        f.write("# 测试信号说明 (采样率 %d Hz, 时长 %.1fs, 立体声)\n"
                % (SR, DURATION))
        f.write("clean.wav   干净参考, 左右声道内容不同\n")
        f.write("damaged.wav 受损版本, 与 clean 等长等采样率\n")
        f.write("tone: %.1f Hz, %.2f-%.2fs, 仅左声道\n"
                % (TONE_FREQ, TONE_T0, TONE_T1))
        for b0, b1 in BURSTS:
            f.write("burst: %.2f-%.2fs, 带通 %.0f-%.0f Hz, 双声道独立噪声\n"
                    % (b0, b1, BURST_BAND[0], BURST_BAND[1]))
        f.write("注意: 首段 burst 距开头 %.2fs, 末段距结尾 %.2fs, "
                "用于验证首尾选区完整输出\n"
                % (BURSTS[0][0], DURATION - BURSTS[1][1]))
    return {
        "clean": clean_path,
        "damaged": damaged_path,
        "manifest": manifest,
        "tone_hz": TONE_FREQ,
        "tone_window": (TONE_T0, TONE_T1),
        "bursts": BURSTS,
        "sr": SR,
        "duration": DURATION,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--outdir", default="test_assets")
    ap.add_argument("--seed", type=int, default=10798)
    args = ap.parse_args()
    info = generate(args.outdir, args.seed)
    print("已生成测试信号:")
    for k, v in info.items():
        print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
