"""音名 / 音分换算。

注意：频率 (Hz) 是测量得到的客观量，与基准音高 A4 无关。
A4 只影响音名和“相对最近半音的音分偏差”的显示。
"""

from __future__ import annotations

import math

import numpy as np

SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]


def freq_to_midi(freq, a4: float = 440.0):
    """频率转 MIDI 数（可为浮点、数组或 NaN）。"""
    f = np.asarray(freq, dtype=float)
    with np.errstate(divide="ignore", invalid="ignore"):
        return 69.0 + 12.0 * np.log2(f / float(a4))


def midi_to_freq(midi, a4: float = 440.0):
    return float(a4) * 2.0 ** ((np.asarray(midi, dtype=float) - 69.0) / 12.0)


def midi_to_note_name(midi, prefer_flat: bool = False) -> str:
    names = FLAT_NAMES if prefer_flat else SHARP_NAMES
    m = int(round(float(midi)))
    return f"{names[m % 12]}{m // 12 - 1}"


def freq_to_note_name(freq, a4: float = 440.0, prefer_flat: bool = False) -> str:
    if freq is None or not math.isfinite(float(freq)):
        return "—"
    return midi_to_note_name(freq_to_midi(freq, a4), prefer_flat)


def cents_from_nearest(freq, a4: float = 440.0):
    """相对最近平均律半音的音分偏差，范围约 [-50, +50)。NaN 透传。"""
    m = freq_to_midi(freq, a4)
    return (m - np.round(m)) * 100.0


def nearest_note_freq(freq, a4: float = 440.0):
    """距 freq 最近的平均律音的频率。"""
    return midi_to_freq(np.round(freq_to_midi(freq, a4)), a4)
