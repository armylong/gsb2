"""核心 DSP:样例生成、分频段底噪分析、窄频嗡声检测与陷波减弱、WAV 读写。

只依赖 numpy,WAV 用标准库 wave,方便无 GUI 环境做自检。
"""
from __future__ import annotations

import json
import wave
from dataclasses import dataclass, field, asdict
from pathlib import Path

import numpy as np

SR = 48000  # 内部统一采样率

# 标准倍频程中心频率 (Hz),上限到 16k
BAND_CENTERS = np.array([31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000])

MIN_SEG_SEC = 0.5        # 短于此长度给出"过短"警告
REJECT_SEG_SEC = 0.2     # 短于此长度直接拒绝
TRANSIENT_CREST_DB = 12  # 短时 RMS 峰值/中位数超过该值视为夹带瞬态
CLIP_THRESH = 0.98       # 接近满幅视为削波
HUM_PROMINENCE_DB = 10   # 谱峰高出局部中位底噪该值以上记为窄频嗡声
DRIFT_WARN_DB = 3        # 首尾基线差超过该值提示漂移


# ---------------------------------------------------------------- 样例生成

def _db2lin(db: float) -> float:
    return 10.0 ** (db / 20.0)


def generate_example(kind: str, sr: int = SR, dur: float = 12.0, seed: int = 7) -> np.ndarray:
    """生成内置示例,单声道 float32,范围 [-1, 1]。

    kind:
      stable_hum   稳定白噪底噪 + 50Hz 嗡声及谐波(基线稳定)
      drifting     底噪电平缓慢起伏 + 嗡声频率缓慢漂移(基线不稳)
      transient    稳定底噪中夹带几次大瞬态(用于触发警告)
      signal       含 50Hz 嗡声的"节目信号",用于演示估计并减弱窄音
    """
    rng = np.random.default_rng(seed)
    n = int(sr * dur)
    t = np.arange(n) / sr

    noise = rng.standard_normal(n).astype(np.float64)
    noise *= _db2lin(-60)  # -60 dBFS 底噪

    if kind == "stable_hum":
        x = noise + 0.02 * np.sin(2 * np.pi * 50 * t) \
                  + 0.008 * np.sin(2 * np.pi * 150 * t + 0.7)
    elif kind == "drifting":
        # 电平缓慢漂移 ±6 dB,嗡声频率 50→54 Hz 缓漂
        level = _db2lin(6 * np.sin(2 * np.pi * t / dur))
        f_inst = 50 + 4 * t / dur
        phase = 2 * np.pi * np.cumsum(f_inst) / sr
        x = noise * level + 0.02 * np.sin(phase)
    elif kind == "transient":
        x = noise + 0.015 * np.sin(2 * np.pi * 50 * t)
        for tc in (2.0, 5.5, 9.0):  # 三次"磕碰"瞬态
            i0 = int(tc * sr)
            burst = rng.standard_normal(int(0.03 * sr)) * 0.5
            burst *= np.hanning(len(burst))
            x[i0:i0 + len(burst)] += burst
    elif kind == "signal":
        # 节目信号:若干短音 + 稳定嗡声 + 底噪
        x = noise * 0.5 + 0.02 * np.sin(2 * np.pi * 50 * t) \
                          + 0.008 * np.sin(2 * np.pi * 150 * t)
        for tc, f in ((1.0, 440), (3.0, 660), (5.0, 550), (7.0, 880), (9.0, 330)):
            i0, ln = int(tc * sr), int(0.8 * sr)
            env = np.hanning(ln)
            x[i0:i0 + ln] += 0.15 * env * np.sin(2 * np.pi * f * t[i0:i0 + ln])
    else:
        raise ValueError(f"未知示例类型: {kind}")

    return np.clip(x, -1.0, 1.0).astype(np.float32)


# ---------------------------------------------------------------- 基础度量

def dbfs(x: np.ndarray) -> float:
    rms = float(np.sqrt(np.mean(np.asarray(x, dtype=np.float64) ** 2)))
    return 20 * np.log10(max(rms, 1e-12))


def welch_db(x: np.ndarray, sr: int, nperseg: int = 8192) -> tuple[np.ndarray, np.ndarray]:
    """简化版 Welch:返回 (freqs, 功率谱 dB/Hz 近似)。"""
    x = np.asarray(x, dtype=np.float64)
    nperseg = min(nperseg, len(x))
    if nperseg < 256:
        nperseg = max(256, len(x))
    win = np.hanning(nperseg)
    step = nperseg // 2
    acc, cnt = None, 0
    for i0 in range(0, len(x) - nperseg + 1, step):
        seg = x[i0:i0 + nperseg] * win
        p = np.abs(np.fft.rfft(seg)) ** 2 / (np.sum(win ** 2) * sr)
        acc = p if acc is None else acc + p
        cnt += 1
    if cnt == 0:  # 片段不足一帧,直接整段算
        seg = x * np.hanning(len(x))
        acc = np.abs(np.fft.rfft(seg)) ** 2 / (np.sum(np.hanning(len(x)) ** 2) * sr)
        cnt = 1
    psd = acc / cnt
    freqs = np.fft.rfftfreq(nperseg, 1 / sr)
    return freqs, 10 * np.log10(np.maximum(psd, 1e-20))


def band_levels_db(x: np.ndarray, sr: int) -> np.ndarray:
    """按倍频程带积分,返回每带电平 dBFS(相对满幅功率)。"""
    freqs, psd_db = welch_db(x, sr)
    psd = 10 ** (psd_db / 10)
    edges = BAND_CENTERS / np.sqrt(2)
    edges = np.append(edges, BAND_CENTERS[-1] * np.sqrt(2))
    out = np.full(len(BAND_CENTERS), -120.0)
    for i in range(len(BAND_CENTERS)):
        m = (freqs >= edges[i]) & (freqs < edges[i + 1])
        if m.any():
            out[i] = 10 * np.log10(max(np.trapezoid(psd[m], freqs[m]), 1e-20))
    return out


# ---------------------------------------------------------------- 片段体检

@dataclass
class SegmentReport:
    index: int
    start: float
    end: float
    duration: float
    rms_db: float
    peak: float
    crest_db: float
    bands: list[float]
    hums: list[dict] = field(default_factory=list)   # {freq, prominence_db}
    warnings: list[str] = field(default_factory=list)
    accepted: bool = True


def check_segment(x: np.ndarray, sr: int, index: int, start: float, end: float) -> SegmentReport:
    seg = np.asarray(x, dtype=np.float64)
    dur = len(seg) / sr
    peak = float(np.max(np.abs(seg))) if len(seg) else 0.0

    # 短时 RMS 峰值/中位比 → 瞬态检测
    win = max(1, int(0.05 * sr))
    nwin = len(seg) // win
    if nwin >= 4:
        r = np.sqrt(np.mean(seg[:nwin * win].reshape(nwin, win) ** 2, axis=1))
        crest = 20 * np.log10(max(r.max(), 1e-12) / max(np.median(r), 1e-12))
    else:
        crest = 0.0

    rep = SegmentReport(
        index=index, start=round(start, 3), end=round(end, 3),
        duration=round(dur, 3), rms_db=round(dbfs(seg), 2),
        peak=round(peak, 4), crest_db=round(crest, 2),
        bands=[round(v, 2) for v in band_levels_db(seg, sr)],
        hums=detect_hums(seg, sr),
    )
    if dur < REJECT_SEG_SEC:
        rep.accepted = False
        rep.warnings.append(f"片段过短({dur:.2f}s < {REJECT_SEG_SEC}s),已拒绝")
    elif dur < MIN_SEG_SEC:
        rep.warnings.append(f"片段偏短({dur:.2f}s < {MIN_SEG_SEC}s),低频段统计不可靠")
    if crest > TRANSIENT_CREST_DB:
        rep.warnings.append(f"检测到明显瞬态(峰值/中位 {crest:.1f} dB),疑似非底噪声音,建议换段")
    if peak > CLIP_THRESH:
        rep.warnings.append(f"峰值 {peak:.2f} 接近满幅,可能削波")
    return rep


# ---------------------------------------------------------------- 嗡声检测

def detect_hums(x: np.ndarray, sr: int, max_hums: int = 8) -> list[dict]:
    """在平均谱上找高出局部中位底噪的窄峰。"""
    if len(x) < sr // 4:
        return []
    freqs, psd_db = welch_db(x, sr, nperseg=16384)
    # 局部中位底噪(±25 bin 滑窗)
    k = 25
    floor = np.array([np.median(psd_db[max(0, i - k):i + k + 1]) for i in range(len(psd_db))])
    prom = psd_db - floor
    cands = []
    for i in range(2, len(psd_db) - 2):
        if prom[i] > HUM_PROMINENCE_DB and psd_db[i] == psd_db[i - 2:i + 3].max():
            cands.append((prom[i], i))
    cands.sort(reverse=True)
    # 合并相距 <5 Hz 的峰;频率用抛物线插值细化(粗 bin 会导致陷波打偏)
    df = freqs[1] - freqs[0]
    picked: list[dict] = []
    for p, i in cands:
        l, c, r = psd_db[i - 1], psd_db[i], psd_db[i + 1]
        denom = l - 2 * c + r
        frac = 0.5 * (l - r) / denom if abs(denom) > 1e-9 else 0.0
        f = float(freqs[i] + np.clip(frac, -1, 1) * df)
        if f < 20 or f > sr / 2 - 100:
            continue
        if all(abs(f - h["freq"]) > 5 for h in picked):
            picked.append({"freq": round(f, 1), "prominence_db": round(float(p), 1)})
        if len(picked) >= max_hums:
            break
    return picked


# ---------------------------------------------------------------- 基线汇总

@dataclass
class BaselineReport:
    n_segments: int
    band_median: list[float]        # 各带中位电平 dB
    band_spread: list[float]        # 各带 max-min(波动)dB
    overall_spread_db: float
    hums: list[dict]                # 在多片段中反复出现的嗡声
    drift: list[dict]               # 首尾对比 [{band_hz, delta_db}]
    drift_detected: bool
    warnings: list[str]

    def to_json(self, path: str | Path, extra: dict | None = None):
        payload = {"baseline": asdict(self)}
        if extra:
            payload.update(extra)
        Path(path).write_text(json.dumps(payload, ensure_ascii=False, indent=2))


def build_baseline(reports: list[SegmentReport]) -> BaselineReport:
    """汇总多个无声片段:中位基线、波动、首尾漂移、稳定嗡声。"""
    reps = [r for r in reports if r.accepted]
    warnings: list[str] = []
    if not reps:
        return BaselineReport(0, [], [], 0.0, [], [], False, ["没有可用的无声片段"])
    if len(reps) < 2:
        warnings.append("仅 1 个有效片段,无法评估波动与漂移,建议至少 2~3 段")

    bands = np.array([r.bands for r in reps])           # (n_seg, n_band)
    median = np.median(bands, axis=0)
    spread = bands.max(axis=0) - bands.min(axis=0)

    # 嗡声:出现在 ≥ 一半片段中的频率(±3 Hz 归并)
    freq_hits: dict[float, list[float]] = {}
    for r in reps:
        for h in r.hums:
            for key in list(freq_hits):
                if abs(key - h["freq"]) <= 3:
                    freq_hits[key].append(h["prominence_db"])
                    break
            else:
                freq_hits[h["freq"]] = [h["prominence_db"]]
    min_hits = max(1, len(reps) // 2 + len(reps) % 2)
    hums = [{"freq": f, "prominence_db": round(float(np.mean(v)), 1), "segments": len(v)}
            for f, v in sorted(freq_hits.items()) if len(v) >= min_hits]

    # 首尾对比:按时间排序后前半 vs 后半
    reps_t = sorted(reps, key=lambda r: r.start)
    half = max(1, len(reps_t) // 2)
    first, last = np.array([r.bands for r in reps_t[:half]]), np.array([r.bands for r in reps_t[-half:]])
    delta = np.median(last, axis=0) - np.median(first, axis=0)
    drift = [{"band_hz": float(BAND_CENTERS[i]), "delta_db": round(float(delta[i]), 2)}
             for i in range(len(BAND_CENTERS))]
    drift_detected = bool(np.any(np.abs(delta) > DRIFT_WARN_DB))
    if drift_detected:
        worst = int(np.argmax(np.abs(delta)))
        warnings.append(
            f"首尾基线漂移明显:{BAND_CENTERS[worst]:g}Hz 带变化 {delta[worst]:+.1f} dB,设备底噪不稳定")

    for r in reps:
        warnings.extend(f"[片段{r.index}] {w}" for w in r.warnings)

    return BaselineReport(
        n_segments=len(reps),
        band_median=[round(float(v), 2) for v in median],
        band_spread=[round(float(v), 2) for v in spread],
        overall_spread_db=round(float(spread.max()), 2),
        hums=hums, drift=drift, drift_detected=drift_detected,
        warnings=warnings,
    )


# ---------------------------------------------------------------- 窄音减弱

def _notch_biquad(f0: float, sr: int, q: float = 30.0) -> tuple[np.ndarray, np.ndarray]:
    w0 = 2 * np.pi * f0 / sr
    alpha = np.sin(w0) / (2 * q)
    b = np.array([1.0, -2 * np.cos(w0), 1.0])
    a = np.array([1 + alpha, -2 * np.cos(w0), 1 - alpha])
    return b / a[0], a / a[0]


def _lfilter(b: np.ndarray, a: np.ndarray, x: np.ndarray) -> np.ndarray:
    """直接 II 型转置,纯 numpy 实现,避免 scipy 依赖。"""
    n = len(x)
    y = np.empty(n, dtype=np.float64)
    z1 = z2 = 0.0
    b0, b1, b2 = b
    a1, a2 = a[1], a[2]
    for i in range(n):
        xi = x[i]
        yi = b0 * xi + z1
        z1 = b1 * xi - a1 * yi + z2
        z2 = b2 * xi - a2 * yi
        y[i] = yi
    return y


def reduce_tones(x: np.ndarray, sr: int, freqs: list[float] | None = None,
                 q: float = 30.0) -> tuple[np.ndarray, list[float]]:
    """估计并级联陷波减弱稳定窄音。freqs=None 时自动检测。返回 (处理后, 陷波频率表)。"""
    x = np.asarray(x, dtype=np.float64)
    if freqs is None:
        freqs = [h["freq"] for h in detect_hums(x, sr)]
    y = x.copy()
    for f in freqs:
        if 20 <= f < sr / 2 - 100:
            b, a = _notch_biquad(f, sr, q)
            y = _lfilter(b, a, y)
    return y.astype(np.float32), list(freqs)


def tone_power_db(x: np.ndarray, sr: int, freq: float, half_bw: float = 5.0) -> float:
    """freq ± half_bw 内的功率,用于自检验证陷波效果。"""
    freqs, psd_db = welch_db(x, sr, nperseg=16384)
    m = (freqs >= freq - half_bw) & (freqs <= freq + half_bw)
    return float(10 * np.log10(max(np.sum(10 ** (psd_db[m] / 10)), 1e-20)))


# ---------------------------------------------------------------- WAV IO

def read_wav(path: str | Path) -> tuple[np.ndarray, int]:
    """读 WAV → (float32 单声道 [-1,1], 采样率)。"""
    with wave.open(str(path), "rb") as w:
        sr, ch, sw = w.getframerate(), w.getnchannels(), w.getsampwidth()
        raw = w.readframes(w.getnframes())
    if sw == 2:
        a = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    elif sw == 3:
        b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3)
        a = (b[:, 0] | b[:, 1] << 8 | b[:, 2] << 16).astype(np.int32)
        a = np.where(a >= 1 << 23, a - (1 << 24), a).astype(np.float32) / float(1 << 23)
    elif sw == 4:
        a = np.frombuffer(raw, dtype=np.int32).astype(np.float32) / float(1 << 31)
    else:
        raise ValueError(f"不支持的位深: {sw * 8} bit")
    if ch > 1:
        a = a.reshape(-1, ch).mean(axis=1)
    return a.astype(np.float32), sr


def write_wav(path: str | Path, x: np.ndarray, sr: int):
    a = np.clip(np.asarray(x, dtype=np.float32), -1, 1)
    pcm = (a * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
