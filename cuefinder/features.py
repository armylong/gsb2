"""短音的帧级特征提取。

设计要点：
- 统一重采样到 16 kHz，单声道；
- 25 ms 窗 / 5 ms 步长，40 维三角滤波器组；
- 幅度压缩（sqrt）后逐帧去均值并做单位化，抵消音量变化；
- 用帧能量自动裁剪静音，并保留原始样本用于波形对齐和试听；
- 同时给出频谱平坦度和帧间变化量，用来判断"查询没有明显特征"。
"""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

import numpy as np
from scipy.signal import stft

FS = 16000
WIN = 400          # 25 ms
HOP = 80           # 5 ms
NFFT = 512
N_MELS = 40
FMIN = 80.0
FMAX = 7600.0

ACT_REL_DB = 45.0      # 相对最大帧能量低 45 dB 视为静音
ABS_FLOOR_DB = -80.0   # 绝对静音下限（满量程 -80 dB）
MATCH_COS = 0.55       # 单帧余弦达到该值算“一致”


class EmptyAudioError(Exception):
    """整段没有可分析的音频能量。"""


@dataclass(frozen=True)
class FeatureConfig:
    fs: int = FS
    win: int = WIN
    hop: int = HOP
    nfft: int = NFFT
    n_mels: int = N_MELS
    fmin: float = FMIN
    fmax: float = FMAX
    act_rel_db: float = ACT_REL_DB
    abs_floor_db: float = ABS_FLOOR_DB
    compression: str = "sqrt"     # sqrt / power
    sub_floor: float = 0.0        # 每频带减去的底噪比例（0 表示不减）
    min_frames: int = 5           # 少于此帧数视为“太短”


DEFAULT_CONFIG = FeatureConfig()


@lru_cache(maxsize=8)
def _mel_filterbank(n_mels: int, nfft: int, fs: int, fmin: float, fmax: float) -> np.ndarray:
    def hz_to_mel(f):
        return 2595.0 * np.log10(1.0 + f / 700.0)

    def mel_to_hz(m):
        return 700.0 * (10.0 ** (m / 2595.0) - 1.0)

    pts = mel_to_hz(np.linspace(hz_to_mel(fmin), hz_to_mel(fmax), n_mels + 2))
    bins = np.floor((nfft + 1) * pts / fs).astype(int)
    bins = np.clip(bins, 0, nfft // 2)
    fb = np.zeros((n_mels, nfft // 2 + 1), dtype=np.float64)
    for i in range(1, n_mels + 1):
        left, center, right = int(bins[i - 1]), int(bins[i]), int(bins[i + 1])
        if center <= left:
            center = left + 1
        if right <= center:
            right = center + 1
        center = min(center, nfft // 2)
        right = min(right, nfft // 2)
        if center > left:
            fb[i - 1, left:center] = np.linspace(0.0, 1.0, center - left, endpoint=False)
        if right > center:
            fb[i - 1, center:right] = np.linspace(1.0, 0.0, right - center, endpoint=False)
    return fb


def frame_rms(x: np.ndarray, win: int, hop: int) -> np.ndarray:
    n = max(1, (len(x) - win) // hop + 1)
    idx = np.clip(np.arange(win)[None, :] + hop * np.arange(n)[:, None], 0, max(len(x) - 1, 0))
    return np.sqrt(np.mean(x[idx] ** 2, axis=1) + 1e-14)


@dataclass
class FeatureSet:
    """一条音频（参考或查询）的特征。"""

    samples: np.ndarray          # 原始（去直流）波形
    fs: int
    cfg: FeatureConfig
    feats: np.ndarray            # (n_mels, T) 逐帧单位化特征，静音帧为 0
    rn: np.ndarray               # (T,) 每帧能量（单位化前 L2）
    active: np.ndarray           # (T,) bool
    db: np.ndarray               # (T,) 帧能量 dB
    mel: np.ndarray              # (n_mels, T) 压缩后的幅度谱
    t0: int                      # 激活区间起止（样本下标，左闭右开）
    t1: int
    flatness: float
    flux: float
    duration: float
    active_duration: float

    @property
    def n(self) -> int:
        return int(self.feats.shape[1])

    @property
    def active_frames(self) -> int:
        return int(np.count_nonzero(self.active))

    @property
    def onset_sec(self) -> float:
        return self.t0 / float(self.fs)

    @property
    def active_end_sec(self) -> float:
        return self.t1 / float(self.fs)

    @property
    def active_samples(self) -> np.ndarray:
        return self.samples[self.t0:self.t1]

    @property
    def active_signal(self) -> np.ndarray:
        return self.active

    def frame_times(self) -> np.ndarray:
        """帧起点（秒），相对文件开头。"""
        return (self.t0 + np.arange(self.n) * self.cfg.hop) / float(self.fs)


def _spectral_flatness(mel: np.ndarray, active: np.ndarray) -> float:
    vals = []
    for i in range(mel.shape[1]):
        if not active[i]:
            continue
        p = mel[:, i] + 1e-20
        vals.append(float(np.exp(np.mean(np.log(p))) / (np.mean(p) + 1e-20)))
    return float(np.median(vals)) if vals else 1.0


def _temporal_flux(feats: np.ndarray, active: np.ndarray) -> float:
    vals = []
    for i in range(feats.shape[1] - 1):
        if active[i] and active[i + 1]:
            vals.append(float(np.linalg.norm(feats[:, i] - feats[:, i + 1]) / np.sqrt(2.0)))
    return float(np.median(vals)) if vals else 0.0


def extract_features(samples: np.ndarray, cfg: FeatureConfig = DEFAULT_CONFIG) -> FeatureSet:
    """把波形转成帧特征。静音/空输入抛 EmptyAudioError。"""
    x = np.asarray(samples, dtype=np.float64).ravel()
    if x.size == 0:
        raise EmptyAudioError("音频为空")
    x = x - float(np.mean(x))
    if not np.all(np.isfinite(x)):
        x = np.nan_to_num(x, nan=0.0, posinf=0.0, neginf=0.0)

    pad = 0
    if len(x) < cfg.win:
        pad = cfg.win - len(x)
        xp = np.pad(x, (0, pad))
    else:
        xp = x

    _, _, z = stft(xp, fs=cfg.fs, window="hann", nperseg=cfg.win,
                   noverlap=cfg.win - cfg.hop, nfft=cfg.nfft,
                   boundary=None, padded=False)
    power = np.abs(z) ** 2
    fb = _mel_filterbank(cfg.n_mels, cfg.nfft, cfg.fs, cfg.fmin, cfg.fmax)
    mel = fb @ power                                        # (n_mels, T)
    n_frames = mel.shape[1]
    db = 20.0 * np.log10(frame_rms(xp, cfg.win, cfg.hop)[:n_frames] + 1e-9)

    peak_db = float(np.max(db))
    threshold = max(peak_db - cfg.act_rel_db, cfg.abs_floor_db)
    active = db > threshold
    if not np.any(active):
        raise EmptyAudioError("没有可分析的音频能量")

    idx = np.flatnonzero(active)
    a0 = int(idx[0])
    a1 = int(idx[-1]) + 1
    mel_t = mel[:, a0:a1]
    active_t = active[a0:a1]
    db_t = db[a0:a1]

    if cfg.sub_floor > 0:
        noise = np.percentile(mel_t, 10, axis=1, keepdims=True)
        mel_t = np.maximum(mel_t - cfg.sub_floor * noise, 1e-12)
    else:
        mel_t = np.maximum(mel_t, 1e-12)

    if cfg.compression == "sqrt":
        comp = np.sqrt(mel_t)
    elif cfg.compression == "power":
        comp = mel_t
    else:
        raise ValueError(f"未知压缩方式: {cfg.compression}")

    centered = comp - comp.mean(axis=0, keepdims=True)
    centered = np.where(active_t[None, :], centered, 0.0)
    rn = np.sqrt(np.sum(centered ** 2, axis=0))
    feats = np.zeros_like(centered)
    np.divide(centered, rn[None, :], out=feats, where=rn[None, :] > 1e-9)

    flatness = _spectral_flatness(mel_t, active_t)
    flux = _temporal_flux(feats, active_t)

    return FeatureSet(
        samples=x,
        fs=cfg.fs,
        cfg=cfg,
        feats=feats,
        rn=rn,
        active=active_t,
        db=db_t,
        mel=mel_t,
        t0=int(a0 * cfg.hop),
        t1=int(min(len(x), a1 * cfg.hop + cfg.win)),
        flatness=flatness,
        flux=flux,
        duration=len(x) / float(cfg.fs),
        active_duration=float(np.count_nonzero(active_t)) * cfg.hop / cfg.fs,
    )
