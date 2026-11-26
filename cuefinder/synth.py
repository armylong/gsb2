"""样例提示音的合成。

四段提示音共享完全相同的前 0.75 秒（三个上行的三音音阶），
后半段各不相同：a 是下滑音，b 是快速颤音加高音，c 是低音钟 + 停顿 + 高音，
d 的起始音高整体不同、结尾是另一条上行。这样检索必须依赖后半段才能区分。
"""
from __future__ import annotations

import numpy as np

FS = 16000


def _env(n: int, attack: float = 0.01, decay: float = 0.5, sr: int = FS) -> np.ndarray:
    e = np.ones(n, dtype=np.float64)
    na = int(attack * sr)
    nd = int(decay * sr)
    if na > 0:
        e[:na] = np.linspace(0.0, 1.0, na) ** 2
    if nd > 0:
        e[-nd:] *= np.linspace(1.0, 0.0, nd) ** 1.5
    return e


def _tone(dur: float, f0: float, f1: float | None = None, amp: float = 1.0,
          harmonics: tuple[float, ...] = (1.0, 0.35, 0.15), sr: int = FS) -> np.ndarray:
    n = int(dur * sr)
    freq = f0 * np.ones(n) if f1 is None else np.linspace(f0, f1, n)
    phase = 2.0 * np.pi * np.cumsum(freq) / sr
    sig = np.zeros(n)
    for k, a in enumerate(harmonics, start=1):
        sig += a * np.sin(k * phase)
    sig /= sum(harmonics)
    return amp * sig * _env(n, decay=min(0.12, dur * 0.4), sr=sr)


def _sequence(parts: list[np.ndarray], total: float, peak: float = 0.8, sr: int = FS) -> np.ndarray:
    sig = np.concatenate(parts)
    n = int(total * sr)
    if len(sig) < n:
        sig = np.concatenate([sig, np.zeros(n - len(sig))])
    sig = sig[:n]
    m = float(np.max(np.abs(sig))) or 1.0
    return sig * peak / m


def _common_prefix(sr: int = FS) -> np.ndarray:
    return np.concatenate([
        _tone(0.25, 523.25, amp=0.8, sr=sr),
        _tone(0.25, 659.25, amp=0.9, sr=sr),
        _tone(0.25, 783.99, amp=1.0, sr=sr),
    ]) * 0.9


def build_reference_set(sr: int = FS, total: float = 1.55) -> dict[str, np.ndarray]:
    pre = _common_prefix(sr)
    a_end = np.concatenate([
        _tone(0.30, 784.0, 392.0, amp=0.9, sr=sr),
        _tone(0.25, 392.0, amp=0.5, sr=sr),
        _tone(0.30, 523.0, 330.0, amp=0.7, sr=sr),
    ])
    b_end = np.concatenate([
        np.tile(np.concatenate([_tone(0.045, 880.0, amp=0.9, sr=sr),
                                _tone(0.045, 1175.0, amp=0.9, sr=sr)] * 3), 1),
        _tone(0.18, 1319.0, amp=0.9, sr=sr),
        _tone(0.18, 659.0, amp=0.5, sr=sr),
    ])
    c_end = np.concatenate([
        _tone(0.18, 196.0, amp=0.8, harmonics=(1.0, 0.5, 0.2), sr=sr),
        np.zeros(int(0.10 * sr)),
        _tone(0.20, 1319.0, amp=0.7, sr=sr),
        _tone(0.18, 1568.0, amp=0.6, sr=sr),
    ])
    d_pre = np.concatenate([
        _tone(0.25, 493.88, amp=0.8, sr=sr),
        _tone(0.25, 622.25, amp=0.9, sr=sr),
        _tone(0.25, 739.95, amp=1.0, sr=sr),
    ])
    d_end = np.concatenate([
        _tone(0.25, 440.0, 880.0, amp=0.8, sr=sr),
        _tone(0.25, 987.0, amp=0.9, sr=sr),
        _tone(0.20, 1175.0, amp=0.7, sr=sr),
    ])
    return {
        "cue_a_slide": _sequence([pre, a_end], total, sr=sr),
        "cue_b_trill": _sequence([pre, b_end], total, sr=sr),
        "cue_c_bell": _sequence([pre, c_end], total, sr=sr),
        "cue_d_rise": _sequence([d_pre, d_end], total, sr=sr),
    }


CASE_QUERIES = {
    "correct_start": {
        "source": "cue_b_trill", "start": 0.90, "end": 1.55,
        "desc": "从 b 的第 0.90 s 开始截取；期望命中 cue_b_trill，起点 0.90 s。",
    },
    "similar_prefix": {
        "source": "cue_a_slide", "start": 0.12, "end": 0.72,
        "desc": "只截了共同开头；期望判为多条共同段、依据不足。",
    },
    "background_noise": {
        "source": "cue_c_bell", "start": 0.55, "end": 1.35, "snr_db": 6.0,
        "desc": "c 的中后段加 6 dB 白噪声；期望仍命中 cue_c_bell，起点 0.55 s。",
    },
    "no_match": {
        "source": None, "start": 0.0, "end": 1.10,
        "desc": "与四条参考都无关的滑音；期望判为没有匹配。",
    },
    "middle_gap": {
        "source": "cue_d_rise", "start": 0.55, "end": 1.28,
        "silence": {"at": 0.28, "dur": 0.06},
        "gain_ramp": [0.35, 1.30],
        "desc": "从 d 中间截取，插入 60 ms 静音并把音量从 35% 渐变到 130%；"
                "期望仍命中 cue_d_rise，起点 0.55 s。",
    },
    "end_overrun": {
        "source": "cue_c_bell", "start": 0.98, "end": 1.43,
        "append": {"source": "cue_d_rise", "start": 0.90, "end": 1.12},
        "desc": "取 c 的尾巴，再续上 0.22 s 的 d 颤音；查询有效段比 c 剩余部分长，"
                "期望提示越过末尾、不能当作完整匹配。",
    },
}


def build_query(name: str, refs: dict[str, np.ndarray], sr: int = FS,
                seed: int = 0) -> np.ndarray:
    spec = CASE_QUERIES[name]
    rng = np.random.default_rng(seed)
    if spec["source"] is None:
        t = np.arange(int(spec["end"] * sr)) / sr
        base = 0.6 * np.sin(2.0 * np.pi * (300.0 * t + 80.0 * np.sin(2.0 * np.pi * 4.0 * t)))
        noise = rng.normal(0.0, 1.0, len(base))
        p = float(np.mean(base ** 2))
        return base + np.sqrt(p / 10.0 ** (6.0 / 10.0)) * noise
    src = refs[spec["source"]]
    a = int(spec["start"] * sr)
    b = int(spec["end"] * sr)
    base = src[a:b].copy()
    extra = spec.get("append")
    if extra:
        owner = refs[extra["source"]]
        base = np.concatenate([base, owner[int(extra["start"] * sr):int(extra["end"] * sr)]])
    if spec["end"] > len(src) / sr:
        need = int((spec["end"] - spec["start"]) * sr)
        if len(base) < need:
            base = np.pad(base, (0, need - len(base)), constant_values=0.0)
    silence = spec.get("silence")
    if silence:
        a = int(silence["at"] * sr)
        b = a + int(silence["dur"] * sr)
        base[a:b] = 0.0
    ramp = spec.get("gain_ramp")
    if ramp:
        base = base * np.linspace(ramp[0], ramp[1], len(base))
    snr = spec.get("snr_db")
    if snr is not None:
        noise = rng.normal(0.0, 1.0, len(base))
        p = float(np.mean(base ** 2)) or 1e-9
        base = base + np.sqrt(p / 10.0 ** (snr / 10.0)) * noise
    return base
