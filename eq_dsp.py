"""三段均衡 DSP 核心。

所有频响曲线、实时处理、离线导出共用同一套 RBJ 双二阶系数设计函数,
保证"看到的曲线"与"听到的/导出的结果"一致。
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from scipy.signal import freqz, lfilter

MIN_FREQ = 20.0
MAX_GAIN_DB = 24.0
MIN_Q = 0.3
MAX_Q = 10.0
SHELF_Q = math.sqrt(0.5)  # 架式段固定斜率 (Butterworth)


def max_freq(fs: int) -> float:
    """当前采样率下允许的最高可调频率。"""
    return 0.45 * fs


@dataclass
class BandParams:
    enabled: bool = False
    freq: float = 100.0
    gain_db: float = 0.0
    q: float = 1.0  # 仅峰值段使用


@dataclass
class EQParams:
    low: BandParams
    mid: BandParams
    high: BandParams
    master_gain_db: float = 0.0
    bypass: bool = False

    @staticmethod
    def default(fs: int) -> "EQParams":
        fmax = max_freq(fs)
        return EQParams(
            low=BandParams(enabled=True, freq=200.0, gain_db=0.0),
            mid=BandParams(enabled=True, freq=1000.0, gain_db=0.0, q=1.0),
            high=BandParams(enabled=True, freq=min(6000.0, fmax), gain_db=0.0),
            master_gain_db=0.0,
            bypass=False,
        )


def clamp_params(p: EQParams, fs: int) -> EQParams:
    """把参数限制在当前采样率可用范围内。"""
    fmax = max_freq(fs)
    for band in (p.low, p.mid, p.high):
        band.freq = min(max(band.freq, MIN_FREQ), fmax)
        band.gain_db = min(max(band.gain_db, -MAX_GAIN_DB), MAX_GAIN_DB)
        band.q = min(max(band.q, MIN_Q), MAX_Q)
    p.master_gain_db = min(max(p.master_gain_db, -MAX_GAIN_DB), MAX_GAIN_DB)
    return p


def _rbj(kind: str, f0: float, gain_db: float, q: float, fs: int):
    """RBJ Audio EQ Cookbook 双二阶系数, 返回 (b, a), a0 已归一化。"""
    A = 10.0 ** (gain_db / 40.0)
    w0 = 2.0 * math.pi * f0 / fs
    cosw = math.cos(w0)
    alpha = math.sin(w0) / (2.0 * q)

    if kind == "peaking":
        b0 = 1.0 + alpha * A
        b1 = -2.0 * cosw
        b2 = 1.0 - alpha * A
        a0 = 1.0 + alpha / A
        a1 = -2.0 * cosw
        a2 = 1.0 - alpha / A
    elif kind == "lowshelf":
        sq = 2.0 * math.sqrt(A) * alpha
        b0 = A * ((A + 1) - (A - 1) * cosw + sq)
        b1 = 2 * A * ((A - 1) - (A + 1) * cosw)
        b2 = A * ((A + 1) - (A - 1) * cosw - sq)
        a0 = (A + 1) + (A - 1) * cosw + sq
        a1 = -2 * ((A - 1) + (A + 1) * cosw)
        a2 = (A + 1) + (A - 1) * cosw - sq
    elif kind == "highshelf":
        sq = 2.0 * math.sqrt(A) * alpha
        b0 = A * ((A + 1) + (A - 1) * cosw + sq)
        b1 = -2 * A * ((A - 1) + (A + 1) * cosw)
        b2 = A * ((A + 1) + (A - 1) * cosw - sq)
        a0 = (A + 1) - (A - 1) * cosw + sq
        a1 = 2 * ((A - 1) - (A + 1) * cosw)
        a2 = (A + 1) - (A - 1) * cosw - sq
    else:
        raise ValueError(kind)

    b = np.array([b0 / a0, b1 / a0, b2 / a0])
    a = np.array([1.0, a1 / a0, a2 / a0])
    return b, a


IDENTITY_B = np.array([1.0, 0.0, 0.0])
IDENTITY_A = np.array([1.0, 0.0, 0.0])


def design_stages(params: EQParams, fs: int):
    """按当前参数设计串联各级 (b, a)。禁用段与旁路不产生任何级。"""
    if params.bypass:
        return []
    stages = []
    if params.low.enabled:
        stages.append(_rbj("lowshelf", params.low.freq, params.low.gain_db, SHELF_Q, fs))
    if params.mid.enabled:
        stages.append(_rbj("peaking", params.mid.freq, params.mid.gain_db, params.mid.q, fs))
    if params.high.enabled:
        stages.append(_rbj("highshelf", params.high.freq, params.high.gain_db, SHELF_Q, fs))
    return stages


def master_gain_linear(params: EQParams) -> float:
    return 1.0 if params.bypass else 10.0 ** (params.master_gain_db / 20.0)


def freq_response_db(params: EQParams, fs: int, freqs: np.ndarray) -> np.ndarray:
    """由实际处理所用的系数计算串联总频响 (dB)。禁用段不计, 总增益计入。"""
    freqs = np.asarray(freqs, dtype=float)
    w = 2.0 * np.pi * freqs / fs
    h = np.ones(len(freqs), dtype=complex)
    for b, a in design_stages(params, fs):
        _, hh = freqz(b, a, worN=w)
        h *= hh
    h *= master_gain_linear(params)
    return 20.0 * np.log10(np.maximum(np.abs(h), 1e-12))


def band_response_db(kind: str, band: BandParams, fs: int, freqs: np.ndarray) -> np.ndarray:
    """单段频响 (dB), 用于界面分段曲线。与串联处理使用同一设计函数。"""
    b, a = _rbj(kind, band.freq, band.gain_db,
                band.q if kind == "peaking" else SHELF_Q, fs)
    w = 2.0 * np.pi * np.asarray(freqs, dtype=float) / fs
    _, h = freqz(b, a, worN=w)
    return 20.0 * np.log10(np.maximum(np.abs(h), 1e-12))


def process_offline(data: np.ndarray, params: EQParams, fs: int) -> np.ndarray:
    """离线导出处理: 与实时链使用完全相同的系数, 零初始状态, 不做任何归一化。"""
    x = np.asarray(data, dtype=np.float64)
    if x.ndim == 1:
        x = x[:, None]
    y = x.copy()
    for b, a in design_stages(params, fs):
        for ch in range(y.shape[1]):
            y[:, ch] = lfilter(b, a, y[:, ch])
    y *= master_gain_linear(params)
    return y.astype(np.float32)


class EQChain:
    """实时处理链: 与 design_stages 相同的系数, 但参数变化时系数平滑过渡,
    避免爆音; 寻址/暂停/循环回卷时通过 reset() 清除滤波余音。"""

    N_STAGES = 3  # 低架 / 峰值 / 高架, 位置固定

    def __init__(self, n_channels: int, fs: int, tau: float = 0.015):
        self.fs = fs
        self.n_ch = n_channels
        self.tau = tau  # 系数平滑时间常数 (秒)
        self._params = EQParams.default(fs)
        # 每段当前/目标系数
        self._cur_b = [IDENTITY_B.copy() for _ in range(self.N_STAGES)]
        self._cur_a = [IDENTITY_A.copy() for _ in range(self.N_STAGES)]
        self._tgt_b = [IDENTITY_B.copy() for _ in range(self.N_STAGES)]
        self._tgt_a = [IDENTITY_A.copy() for _ in range(self.N_STAGES)]
        self._identity = [True] * self.N_STAGES
        # 每段每通道滤波状态 (lfilter 的 zi)
        self._zi = [np.zeros((n_channels, 2)) for _ in range(self.N_STAGES)]
        self._cur_gain = 1.0
        self._tgt_gain = 1.0

    def set_params(self, params: EQParams):
        """GUI 线程调用; params 整体替换, 读取端无锁也安全。"""
        self._params = params

    def reset(self):
        """清除所有滤波状态 (寻址/暂停/循环回卷时调用)。"""
        for zi in self._zi:
            zi[:] = 0.0

    def _refresh_targets(self):
        p = self._params
        kinds = ("lowshelf", "peaking", "highshelf")
        bands = (p.low, p.mid, p.high)
        for i, (kind, band) in enumerate(zip(kinds, bands)):
            if p.bypass or not band.enabled:
                self._tgt_b[i] = IDENTITY_B
                self._tgt_a[i] = IDENTITY_A
            else:
                q = band.q if kind == "peaking" else SHELF_Q
                b, a = _rbj(kind, band.freq, band.gain_db, q, self.fs)
                self._tgt_b[i] = b
                self._tgt_a[i] = a
        self._tgt_gain = master_gain_linear(p)

    def process(self, block: np.ndarray) -> np.ndarray:
        """处理一块 (n, ch) float32 音频, 返回新数组。"""
        n = block.shape[0]
        if n == 0:
            return block
        self._refresh_targets()
        k = 1.0 - math.exp(-n / (self.tau * self.fs))

        y = block
        for i in range(self.N_STAGES):
            cb, ca = self._cur_b[i], self._cur_a[i]
            tb, ta = self._tgt_b[i], self._tgt_a[i]
            if self._identity[i] and np.array_equal(tb, IDENTITY_B) and np.array_equal(ta, IDENTITY_A):
                # 段已收敛到直通: 跳过处理, 并清掉可能残留的状态
                self._zi[i][:] = 0.0
                continue
            cb += k * (tb - cb)
            ca += k * (ta - ca)
            if np.max(np.abs(tb - cb)) < 1e-7 and np.max(np.abs(ta - ca)) < 1e-7:
                cb[:] = tb
                ca[:] = ta
            self._identity[i] = bool(np.array_equal(cb, IDENTITY_B) and np.array_equal(ca, IDENTITY_A))
            if not self._identity[i]:
                if y is block:
                    y = block.copy()
                zi = self._zi[i]
                for ch in range(y.shape[1]):
                    y[:, ch], zi[ch] = lfilter(cb, ca, y[:, ch], zi=zi[ch])

        # 总增益: 逐样本几何平滑, 无拉链噪声
        tg = self._tgt_gain
        cg = self._cur_gain
        if abs(tg - cg) > 1e-6:
            alpha = 1.0 - math.exp(-1.0 / (self.tau * self.fs))
            t = np.arange(n, dtype=np.float64)
            gains = tg + (cg - tg) * (1.0 - alpha) ** t
            if y is block:
                y = block.copy()
            y *= gains[:, None].astype(np.float32)
            self._cur_gain = float(tg + (cg - tg) * (1.0 - alpha) ** n)
            if abs(self._cur_gain - tg) < 1e-5:
                self._cur_gain = tg
        elif cg != 1.0:
            if y is block:
                y = block.copy()
            y *= np.float32(cg)
        return y
