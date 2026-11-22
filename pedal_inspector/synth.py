"""离线合成:简单琴音(基频 + 3 个衰减泛音,起音/衰减/释音包络),渲染整轨并导出 WAV。

播放 = 播放这条完整渲染出来的缓冲,所以 "从开头听" 和 "跳到中间继续听"
在采样级完全一致;跳到踏板中间时该响的延音本来就在缓冲里。
"""
from __future__ import annotations

import wave

import numpy as np

from .model import FADEOUT_SEC, RELEASE_SEC, Voice

SR = 44100


def _synth_voice(v: Voice, sr: int = SR):
    n0 = int(round(v.start * sr))
    n1 = int(round(v.stop * sr))
    if n1 <= n0:
        return None
    t = np.arange(n0, n1) / sr - v.start
    f = 440.0 * 2 ** ((v.pitch - 69) / 12)
    ph = 2 * np.pi * f * t
    wave_ = (np.sin(ph)
             + 0.50 * np.exp(-t * 2.0) * np.sin(2 * ph)
             + 0.25 * np.exp(-t * 4.0) * np.sin(3 * ph)
             + 0.12 * np.exp(-t * 6.0) * np.sin(4 * ph))
    amp = (v.velocity / 127.0) ** 1.5 * 0.6
    # 起音 5ms,随后指数衰减到延音平台
    env = np.minimum(t / 0.005, 1.0) * (0.55 + 0.45 * np.exp(-t * 1.5))
    # 释音:从 release 时刻起指数衰减,RELEASE_SEC 后约 -60dB
    rel_t = t - (v.release - v.start)
    env *= np.where(rel_t > 0, np.exp(-rel_t * np.log(1000.0) / RELEASE_SEC), 1.0)
    if v.cut:
        # 同音重复截断:末尾 8ms 线性淡出,避免爆音
        env *= np.clip((v.stop - v.start - t) / FADEOUT_SEC, 0.0, 1.0)
    return n0, wave_ * env * amp


def render(voices: list[Voice], sr: int = SR) -> np.ndarray:
    stop = max((v.stop for v in voices), default=0.0) + 0.1
    buf = np.zeros(int(np.ceil(stop * sr)), dtype=np.float64)
    for v in voices:
        r = _synth_voice(v, sr)
        if r is not None:
            n0, data = r
            buf[n0:n0 + len(data)] += data
    peak = float(np.max(np.abs(buf))) if buf.size else 0.0
    if peak > 0.95:
        buf *= 0.95 / peak
    return buf


def to_pcm16(buf: np.ndarray) -> bytes:
    return (np.clip(buf, -1.0, 1.0) * 32767).astype("<i2").tobytes()


def export_wav(path: str, buf: np.ndarray, sr: int = SR):
    pcm = to_pcm16(buf)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm)
