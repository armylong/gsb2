"""内置测试样例合成。

每个样例都带 ReferenceSegment 分段参考（时间区间 + 真实基频），
可以直接和估计曲线、滑过音阶边界的位置核对。
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

FS = 22050


@dataclass
class ReferenceSegment:
    t0: float
    t1: float
    kind: str            # 'gliss' 滑音 / 'steady' 稳定音 / 'gap' 无声/噪声
    f0: float            # 稳定音基频；滑音取起点频率
    f1: float | None = None  # 滑音终点频率
    note: str = ""

    def describe(self) -> str:
        if self.kind == "gliss":
            return f"{self.t0:.2f}–{self.t1:.2f}s 滑音 {self.note} {self.f0:.1f}→{self.f1:.1f} Hz"
        if self.kind == "steady":
            return f"{self.t0:.2f}–{self.t1:.2f}s 稳定 {self.note} {self.f0:.1f} Hz"
        return f"{self.t0:.2f}–{self.t1:.2f}s {self.note}(无可靠音高)"


@dataclass
class Sample:
    key: str
    name: str
    description: str
    x: np.ndarray
    fs: int
    references: list[ReferenceSegment]


def _fade(n_fade: int) -> np.ndarray:
    return 0.5 * (1.0 - np.cos(np.pi * np.arange(n_fade) / max(1, n_fade - 1)))


def _tone(fs: int, dur: float, f0_func, harmonics: list[float],
          amp: float = 0.5, noise_level: float = 0.0,
          phase0: float = 0.0) -> np.ndarray:
    """合成准周期信号；f0_func(t) 给出 t 秒处的基频。"""
    n = int(round(fs * dur))
    t = np.arange(n) / fs
    f0 = np.vectorize(f0_func)(t)
    # 相位积分，保证频率连续变化时波形连续
    phase = 2.0 * np.pi * np.cumsum(f0) / fs + phase0
    out = np.zeros(n)
    for k, a in enumerate(harmonics, start=1):
        if a > 0:
            out += a * np.sin(k * phase + 0.1 * k)
    out *= amp / (np.sum(np.abs(harmonics)) + 1e-12)
    if noise_level > 0:
        rng = np.random.default_rng(7)
        out += noise_level * rng.standard_normal(n)
    nf = min(n // 4, int(0.008 * fs))
    if nf > 1:
        out[:nf] *= _fade(nf)
        out[-nf:] *= _fade(nf)[::-1]
    return out


def _noise(fs: int, dur: float, level: float = 0.2) -> np.ndarray:
    rng = np.random.default_rng(11)
    n = int(round(fs * dur))
    x = level * rng.standard_normal(n)
    nf = min(n // 4, int(0.005 * fs))
    if nf > 1:
        x[:nf] *= _fade(nf)
        x[-nf:] *= _fade(nf)[::-1]
    return x


def _silence(fs: int, dur: float) -> np.ndarray:
    return np.zeros(int(round(fs * dur)))


def _join(parts: list[np.ndarray]) -> np.ndarray:
    return np.concatenate(parts) if parts else np.zeros(1)


def make_glissando(fs: int = FS) -> Sample:
    """长音上滑：C4 连续滑到 G4，中途跨过多个半音边界。"""
    f0, f1 = 261.63, 392.00
    x = _tone(fs, 2.0, lambda t: f0 * (f1 / f0) ** (t / 2.0),
              harmonics=[1.0, 0.5, 0.25], amp=0.5)
    refs = [ReferenceSegment(0.0, 2.0, "gliss", f0, f1, "C4→G4")]
    return Sample("gliss", "滑音 C4→G4",
                  "2 秒连续上滑，用来核对滑过半音边界时的音分轨迹。",
                  x, fs, refs)


def make_steady(fs: int = FS) -> Sample:
    """稳定音 A4，结尾轻微衰减，含真实音分参考（合成故意偏高约 +12 cent）。"""
    f_center = 440.0 * 2.0 ** (12.0 / 1200.0)  # 440 上方 12 cent
    x = _tone(fs, 1.8, lambda t: f_center,
              harmonics=[1.0, 0.6, 0.3, 0.12], amp=0.5)
    n_dec = int(0.25 * fs)
    x[-n_dec:] *= np.linspace(1.0, 0.15, n_dec) ** 2
    refs = [ReferenceSegment(0.0, 1.8, "steady", f_center, note="A4 +12cent")]
    return Sample("steady", "稳定音 A4(+12 cent)",
                  "恒定 443.06 Hz，A4=440 时音分曲线应稳定在 +12 cent 附近。",
                  x, fs, refs)


def make_gap_noise(fs: int = FS) -> Sample:
    """稳定音中间插入噪声段：曲线必须在噪声处断开，不能把两端连起来。"""
    a = _tone(fs, 0.8, lambda t: 329.63, harmonics=[1.0, 0.5, 0.25])
    gap = _noise(fs, 0.6, level=0.25)
    b = _tone(fs, 0.9, lambda t: 329.63, harmonics=[1.0, 0.5, 0.25])
    x = _join([a, gap, b])
    refs = [
        ReferenceSegment(0.0, 0.8, "steady", 329.63, note="E4"),
        ReferenceSegment(0.8, 1.4, "gap", float("nan"), note="噪声段"),
        ReferenceSegment(1.4, 2.3, "steady", 329.63, note="E4"),
    ]
    return Sample("gap", "稳定音中间加噪",
                  "E4 - 噪声 0.6s - E4；噪声段应显示为不确定/缺口，两端不连线。",
                  x, fs, refs)


def make_reappearance(fs: int = FS) -> Sample:
    """两个不同音符被无声段隔开：与“滑过边界”对照，这是重新出现有效音符。"""
    a = _tone(fs, 0.7, lambda t: 392.00, harmonics=[1.0, 0.45, 0.2])
    gap = _silence(fs, 0.5)
    b = _tone(fs, 0.8, lambda t: 329.63, harmonics=[1.0, 0.45, 0.2])
    x = _join([a, gap, b])
    refs = [
        ReferenceSegment(0.0, 0.7, "steady", 392.00, note="G4"),
        ReferenceSegment(0.7, 1.2, "gap", float("nan"), note="无声段"),
        ReferenceSegment(1.2, 2.0, "steady", 329.63, note="E4"),
    ]
    return Sample("reappear", "音符重现 G4/休止/E4",
                  "G4 - 休止 0.5s - E4；与滑音对照，这里是重新起音而非滑过边界。",
                  x, fs, refs)


def make_weak_fundamental(fs: int = FS) -> Sample:
    """基频很弱、偶次谐波强：容易被判低八度，用来观察八度跳判与备选。"""
    # 基频 196 Hz (G3)，基频只留 0.12，2/4 次谐波很强
    x = _tone(fs, 1.6, lambda t: 196.00,
              harmonics=[0.12, 1.0, 0.35, 0.8, 0.25, 0.45],
              amp=0.5, phase0=0.3)
    refs = [ReferenceSegment(0.0, 1.6, "steady", 196.00, note="G3(弱基频)")]
    return Sample("weakf0", "弱基频 G3(高次谐波强)",
                  "真实基频 196 Hz 但能量集中在 2f/4f；点选帧对比 G3/G4/G2 候选，"
                  "看低八度假想如何因“基频谱支持≈0”被否决。",
                  x, fs, refs)


BUILTIN_SAMPLES = [
    make_glissando,
    make_steady,
    make_gap_noise,
    make_reappearance,
    make_weak_fundamental,
]


def all_samples() -> list[Sample]:
    return [fn() for fn in BUILTIN_SAMPLES]
