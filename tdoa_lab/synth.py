"""可复现的样例生成：已知时差 / 反相 / 不同信噪比 / 节奏重复 / 时变。

所有样例都用固定随机种子，命令行自检和 GUI 里生成的结果完全一致。
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy.interpolate import CubicSpline

from .dsp import fractional_shift

SR = 48_000
DURATION = 2.0


@dataclass
class Sample:
    name: str
    description: str
    ch0: np.ndarray
    ch1: np.ndarray
    sr: int = SR
    truth_delay: float | None = None   # 采样点，ch1 相对 ch0；正值 = ch1 晚到
    truth_polarity: int = 1
    truth_snr_db: float | None = None
    selection: tuple[float, float] = (0.15, 0.8)  # 默认片段（起点秒, 时长秒）
    meta: dict = field(default_factory=dict)

    @property
    def duration(self) -> float:
        return len(self.ch0) / self.sr

    def truth_delay_ms(self) -> float | None:
        return None if self.truth_delay is None else self.truth_delay / self.sr * 1000.0


def _t(sr: int, dur: float) -> np.ndarray:
    return np.arange(int(round(sr * dur))) / sr


def _bursts(sr: int, dur: float, seed: int = 1) -> np.ndarray:
    """几段带衰减的扫频脉冲：宽频、峰形尖锐，适合做时差估计。"""
    t = _t(sr, dur)
    x = np.zeros_like(t)
    rng = np.random.default_rng(seed)
    specs = [(0.30, 0.055, 700, 5200), (0.78, 0.045, 1200, 7000), (1.28, 0.065, 400, 4200)]
    for start, length, f0, f1 in specs:
        n = int(length * sr)
        tt = np.arange(n) / sr
        f = f0 + (f1 - f0) * tt / length
        phase = 2 * np.pi * np.cumsum(f) / sr
        env = np.exp(-tt * 55.0) * np.sin(np.pi * np.clip(tt / 0.004, 0, 1)) ** 2
        sig = np.sin(phase) * env
        i0 = int(start * sr)
        m = max(0, min(n, x.size - i0))
        x[i0:i0 + m] += sig[:m]
    x += 0.004 * rng.standard_normal(x.size)  # 轻微底噪，不改变真值
    return x


def _click_train(sr: int, dur: float, period: float = 0.040, seed: int = 2) -> np.ndarray:
    """严格周期撞击声：互相关会出现等间距的多个近似峰。"""
    x = np.zeros(int(round(sr * dur)))
    rng = np.random.default_rng(seed)
    n_click = int(0.008 * sr)
    tt = np.arange(n_click) / sr
    click = np.sin(2 * np.pi * 2400.0 * tt) * np.exp(-tt / 0.0016)
    for start in np.arange(0.02, dur, period):
        i0 = int(start * sr)
        m = max(0, min(n_click, x.size - i0))
        x[i0:i0 + m] += click[:m]
    x += 0.003 * rng.standard_normal(x.size)
    return x


def _speechish(sr: int, dur: float, seed: int = 3) -> np.ndarray:
    """类语音的有调包络信号：多谐波 + 起伏包络。"""
    t = _t(sr, dur)
    rng = np.random.default_rng(seed)
    f0 = 120.0
    x = np.zeros_like(t)
    for k in range(1, 18):
        f = f0 * k * (1 + 0.02 * np.sin(2 * np.pi * 0.7 * t))
        x += (1.0 / k) * np.sin(2 * np.pi * f * t + rng.uniform(0, 2 * np.pi))
    env = 0.25 + 0.75 * np.abs(np.sin(2 * np.pi * 1.3 * t + 0.4)) ** 3
    x *= env
    x += 0.01 * rng.standard_normal(x.size)
    return x / (np.max(np.abs(x)) + 1e-12)


def _rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(x)))) if x.size else 0.0


def _add_noise(ref: np.ndarray, snr_db: float, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    noise = rng.standard_normal(ref.size)
    noise *= _rms(ref) / max(_rms(noise), 1e-12) / (10 ** (snr_db / 20.0))
    return noise


def time_varying_shift(x: np.ndarray, sr: int, d0: float, d1: float) -> np.ndarray:
    """按线性变化的时差重采样：out[n] ≈ x[n - d(t_n)]。"""
    n = x.size
    idx = np.arange(n, dtype=np.float64)
    t = idx / sr
    d = d0 + (d1 - d0) * t / max(t[-1], 1e-9)
    sample_at = idx - d
    cs = CubicSpline(idx, np.asarray(x, dtype=np.float64), extrapolate=True)
    return cs(sample_at)


def make_sample(
    name: str,
    base: np.ndarray,
    sr: int,
    delay: float,
    snr_db: float,
    polarity: int = 1,
    gain: float = 1.0,
    seed: int = 0,
    description: str = "",
    echo: float = 0.0,
    selection: tuple[float, float] = (0.15, 0.8),
    meta: dict | None = None,
) -> Sample:
    """ch1[n] ≈ gain * polarity * ch0[n - delay] + 噪声。"""
    ch0 = np.asarray(base, dtype=np.float64)
    shifted = fractional_shift(ch0, delay) * polarity * gain
    if echo:
        shifted = shifted + echo * fractional_shift(ch0, delay + 0.011 * sr)
    ch1 = shifted + _add_noise(ch0, snr_db, seed)
    return Sample(
        name=name,
        description=description,
        ch0=ch0,
        ch1=ch1,
        sr=sr,
        truth_delay=float(delay),
        truth_polarity=polarity,
        truth_snr_db=snr_db,
        selection=selection,
        meta=meta or {},
    )


def make_drift_sample(sr: int = SR, dur: float = DURATION, seed: int = 7) -> Sample:
    """时差从 18 采样线性变到 62 采样的“移动声源”样例。"""
    base = _bursts(sr, dur, seed=seed)
    ch1 = time_varying_shift(base, sr, 18.0, 62.0)
    ch1 = ch1 + _add_noise(base, 18.0, seed=77)
    return Sample(
        name="时变 · 移动声源",
        description="时差从 18 采样线性漂移到 62 采样（约 +22 采样/秒），用于和“反相”区分。参考真值一栏填的是中点 40，仅作定位参考。",
        ch0=base,
        ch1=ch1,
        sr=sr,
        truth_delay=40.0,  # 取中点作参考
        truth_polarity=1,
        truth_snr_db=18.0,
        selection=(0.0, 1.9),
        meta={"kind": "drift", "d0": 18.0, "d1": 62.0},
    )


def presets() -> list[tuple[str, str, callable]]:
    """返回 (键, 显示名, 生成函数)。"""
    def clean():
        return make_sample(
            "干净脉冲",
            _bursts(SR, DURATION, seed=11),
            SR, delay=7.0, snr_db=24.0, seed=101,
            description="宽频脉冲串 + 24 dB 白噪；整数时差 7 采样，作为基准。",
            selection=(0.15, 0.8), meta={"kind": "burst"},
        )

    def low_snr():
        return make_sample(
            "低信噪比 · 小数时差",
            _bursts(SR, DURATION, seed=12),
            SR, delay=-12.6, snr_db=2.0, seed=102,
            description="2 dB 白噪；时差 -12.6 采样（负值表示 ch1 早到），用于验证小数插值。",
            selection=(0.15, 0.8), meta={"kind": "burst"},
        )

    def very_noisy():
        return make_sample(
            "强噪声 · 小数时差",
            _bursts(SR, DURATION, seed=13),
            SR, delay=3.25, snr_db=-6.0, seed=103,
            description="-6 dB 白噪；时差 3.25 采样。用于观察置信度下降和参考区间变宽。",
            selection=(0.1, 1.0), meta={"kind": "burst"},
        )

    def inverted():
        return make_sample(
            "反相通道",
            _bursts(SR, DURATION, seed=14),
            SR, delay=4.0, snr_db=16.0, polarity=-1, seed=104,
            description="ch1 整体反相，时差 4 采样。用于确认不会把极性翻转误判成大时差。",
            selection=(0.15, 0.8), meta={"kind": "burst"},
        )

    def rhythmic():
        return make_sample(
            "节奏重复",
            _click_train(SR, DURATION, period=0.040, seed=15),
            SR, delay=3.0, snr_db=15.0, seed=105,
            description="40 ms 周期撞击声；互相关在 3、1923、-1917 等位置出现近似高峰，需人工确认。",
            selection=(0.0, 1.0), meta={"kind": "click", "period_ms": 40.0},
        )

    def mic():
        return make_sample(
            "类语音 · 增益差与回声",
            _speechish(SR, DURATION, seed=16),
            SR, delay=18.4, snr_db=9.0, gain=0.7, echo=0.2, seed=106,
            description="类语音信号，两通道增益不同并带 11 ms 回声；时差 18.4 采样。回声会让估计略微偏大。",
            selection=(0.1, 1.5), meta={"kind": "speech"},
        )

    def drift():
        return make_drift_sample()

    return [
        ("clean", "干净脉冲 · 整数时差", clean),
        ("low_snr", "低信噪比 · 小数时差", low_snr),
        ("very_noisy", "强噪声 · 小数时差", very_noisy),
        ("inverted", "反相通道", inverted),
        ("rhythmic", "节奏重复 · 多候选", rhythmic),
        ("mic", "类语音 · 增益差与回声", mic),
        ("drift", "时变 · 移动声源", drift),
    ]


PRESET_KEYS = {k: (name, fn) for k, name, fn in presets()}


def make_preset(key: str) -> Sample:
    if key not in PRESET_KEYS:
        raise KeyError(f"未知样例: {key}")
    return PRESET_KEYS[key][1]()
