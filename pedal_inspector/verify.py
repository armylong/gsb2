"""回读 WAV,对照事件明细核对:每个音符的响起时间、整段尾部消音时间。"""
from __future__ import annotations

import wave

import numpy as np

from .model import Voice, pitch_name
from .synth import SR


def read_wav(path: str) -> tuple[np.ndarray, int]:
    with wave.open(path, "rb") as w:
        sr = w.getframerate()
        n = w.getnframes()
        ch = w.getnchannels()
        data = np.frombuffer(w.readframes(n), dtype="<i2").astype(np.float64) / 32768.0
        if ch > 1:
            data = data.reshape(-1, ch).mean(axis=1)
    return data, sr


def _frame_rms(data: np.ndarray, win=512, hop=256) -> np.ndarray:
    n = 1 + max(0, (len(data) - win) // hop)
    out = np.empty(n)
    for i in range(n):
        seg = data[i * hop:i * hop + win]
        out[i] = np.sqrt(np.mean(seg * seg)) if len(seg) else 0.0
    return out


def detect_onsets(data: np.ndarray, sr: int, min_gap=0.08) -> list[float]:
    """正向能量通量(能量突增)检测起音。延音/连奏下音符可能首尾交叠,
    不能用 "安静->有声" 的门限,要看能量的上升沿。"""
    rms = _frame_rms(data)
    # 平滑掉释音/泛音干涉造成的能量抖动
    k = np.ones(5) / 5
    rms = np.convolve(rms, k, mode="same")
    hop_sec = 256 / sr
    flux = np.diff(rms, prepend=rms[0])
    peak = float(flux.max()) if len(flux) else 0.0
    if peak <= 0:
        return []
    thresh = max(0.004, 0.30 * peak)
    onsets = []
    last = -1e9
    for i in range(1, len(rms)):
        t = i * hop_sec
        if (flux[i] >= thresh and rms[i] > 0.015
                and flux[i] >= flux[i - 1]
                and (i + 1 >= len(flux) or flux[i] >= flux[i + 1])
                and t - last > min_gap):
            onsets.append(t)
            last = t
    return onsets


def detect_tail(data: np.ndarray, sr: int, thresh=0.005) -> float:
    """最后一个能量超过阈值的时刻(近似实际消音时间)。"""
    rms = _frame_rms(data)
    hop_sec = 256 / sr
    idx = np.nonzero(rms > thresh)[0]
    return float(idx[-1] * hop_sec) if len(idx) else 0.0


def check_wav(path: str, voices: list[Voice], onset_tol=0.06, tail_tol=0.15) -> str:
    data, sr = read_wav(path)
    onsets = detect_onsets(data, sr)
    tail = detect_tail(data, sr)

    expected = sorted(v.start for v in voices)
    # 同一时刻的音(和弦)在音频里只表现为一个起音
    expected_groups = []
    for s in expected:
        if not expected_groups or s - expected_groups[-1][-1] > 0.03:
            expected_groups.append([s])
        else:
            expected_groups[-1].append(s)
    lines = [f"文件: {path}", f"采样率 {sr},时长 {len(data)/sr:.3f}s",
             f"检测到 {len(onsets)} 个起音;事件明细 {len(expected)} 个音,"
             f"同一时刻合并后 {len(expected_groups)} 个起音时刻", ""]

    ok = 0
    for v in sorted(voices, key=lambda v: v.start):
        best, best_d = None, 1e9
        for o in onsets:
            d = abs(o - v.start)
            if d < best_d:
                best, best_d = o, d
        good = best is not None and best_d <= onset_tol
        ok += 1 if good else 0
        lines.append(f"  {v.name():>4} 期望 {v.start:7.3f}s  实测 "
                     f"{(f'{best:7.3f}s' if best is not None else '   --  ')} "
                     f"偏差 {(f'{best_d*1000:5.1f}ms' if best is not None else '  --')}  "
                     f"{'OK' if good else '不匹配!'}")
    lines.append("")

    expected_tail = max((v.stop for v in voices), default=0.0)
    tail_ok = abs(tail - expected_tail) <= tail_tol
    lines.append(f"起音匹配 {ok}/{len(expected)}")
    lines.append(f"尾部:期望约 {expected_tail:.3f}s 消音,实测 {tail:.3f}s "
                 f"({'OK' if tail_ok else '偏差过大!'})")
    lines.append("结论: " + ("全部通过" if ok == len(expected) and tail_ok else "存在不一致,请检查"))
    return "\n".join(lines)
