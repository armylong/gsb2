"""DSP 核心校验: 用已知合成通道验证估计精度。直接运行: python tests/test_dsp.py"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from ir_measure.dsp import (  # noqa: E402
    FilterSpec, SweepSpec, SynthSpec, analyze, detect_clipping,
    generate_sweep, make_synthetic_recording, reference_valid_mask,
    windowed_fr,
)

PASS = []


def check(name, cond, detail=""):
    PASS.append(cond)
    print(f"{'PASS' if cond else 'FAIL'}  {name}  {detail}")


def fr_at(freqs, mag, f):
    return float(np.interp(f, freqs, mag))


spec = SweepSpec(fs=48000, f1=20, f2=20000, duration=2.0)
sweep = generate_sweep(spec)

# 1. 恒等通道: 空白 + 扫频 → 对齐正确, 频响平坦
pre = int(0.3 * spec.fs)
rec = np.concatenate([np.zeros(pre), sweep, np.zeros(2000)])
a = analyze(rec, spec.fs, sweep)
check("恒等通道对齐", abs(a.offset - pre) <= 1, f"offset={a.offset} 期望 {pre}")
check("恒等通道主峰位置", a.peak_idx < int(0.002 * spec.fs),
      f"peak={a.peak_idx} 样本")
freqs, mag = windowed_fr(a.ir, a.peak_idx, -1.0, 30.0, spec.fs)
for f in (100, 1000, 10000):
    check(f"恒等通道频响 @{f}Hz", abs(fr_at(freqs, mag, f)) < 0.5,
          f"{fr_at(freqs, mag, f):+.2f} dB")

# 2. 已知延时 + 低通滤波: 主到达位置与频响偏差(对比基准 = 设定通道 IR 主峰,
#    滤波器群延时本身会移动主峰, 不能与纯延时参数直接比)
ss = SynthSpec(delay_ms=3.7, pre_silence_s=0.25,
               filter=FilterSpec(kind="lowpass", fc=4000.0),
               echo_on=False, noise_db=-80.0)
rec2, h, pre2 = make_synthetic_recording(sweep, spec.fs, ss)
a2 = analyze(rec2, spec.fs, sweep)
est = a2.offset + a2.peak_idx
exp = pre2 + int(np.argmax(np.abs(h)))
check("主到达估计误差 < 2 样本", abs(est - exp) < 2,
      f"估计 {est} vs 设定 {exp} 样本")
tp = int(np.argmax(np.abs(h)))  # h 为有效通道(含录音电平), 与估计同基准
freqs2, mag_est = windowed_fr(a2.ir, a2.peak_idx, -1.0, 50.0, spec.fs)
_, mag_tgt = windowed_fr(h, tp, -1.0, 50.0, spec.fs)
for f in (1000, 2000, 8000, 12000):
    d = fr_at(freqs2, mag_est, f) - fr_at(freqs2, mag_tgt, f)
    check(f"低通频响偏差 @{f}Hz < 1 dB", abs(d) < 1.0, f"{d:+.2f} dB")

# 3. 弱反射可见: 回声峰出现在设定延时处
ss3 = SynthSpec(delay_ms=2.0, pre_silence_s=0.2, echo_on=True,
                echo_delay_ms=11.0, echo_gain=0.2, noise_db=-100.0)
rec3, _, _ = make_synthetic_recording(sweep, spec.fs, ss3)
a3 = analyze(rec3, spec.fs, sweep)
lo = a3.peak_idx + int(9.0e-3 * spec.fs)
hi = a3.peak_idx + int(13.0e-3 * spec.fs)
echo_peak = np.abs(a3.ir[lo:hi]).max()
check("弱反射可分辨(-14±2 dB)",
      0.5 * 0.2 < echo_peak < 2.0 * 0.2, f"回声峰 {echo_peak:.3f} (设定 0.2)")

# 4. 削顶警告
ss4 = SynthSpec(clip=True, clip_level=0.9, echo_on=False)
rec4, _, _ = make_synthetic_recording(sweep, spec.fs, ss4)
n, run = detect_clipping(rec4)
a4 = analyze(rec4, spec.fs, sweep)
check("削顶检测", n > 0 and any("削顶" in w for w in a4.warnings),
      f"{n} 个削顶样本")

# 5. 截短警告
rec5 = np.concatenate([np.zeros(pre), sweep[: int(1.5 * spec.fs)]])
a5 = analyze(rec5, spec.fs, sweep)
check("截短检测", a5.truncated_s > 0.4 and any("截" in w or "缺少" in w
                                               for w in a5.warnings),
      f"缺 {a5.truncated_s:.2f} s")

# 6. 参考能量不足频段标记(淡出会削弱贴近 f1/f2 的边缘, 20k 被如实标为不可用)
fq = np.array([5.0, 20.0, 1000.0, 10000.0, 24000.0])
mask = reference_valid_mask(sweep, spec.fs, fq, spec.f1, spec.f2)
check("无效频段标记", list(mask) == [False, True, True, True, False],
      str(list(mask)))

print(f"\n{sum(PASS)}/{len(PASS)} 通过")
sys.exit(0 if all(PASS) else 1)
