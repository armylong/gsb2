"""内置示例合成器 (纯 numpy)。

三个示例覆盖验收要点:
1. short_gap  —— 短间隔: 正常缩短 / 区间太短原样放过 / 全删硬切, 且有一个标注点落在被删段
2. adjacent   —— 相邻修改: 重叠与首尾挨住的区间必须报冲突且整段不动
3. stereo     —— 两声道不同响点: 左右声道脉冲位置不同, 确认不会误删有声样本

所有随机数固定种子, 采样率/采样数写进同目录 README, verify.py 据此核对。
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Dict, List, Tuple

import numpy as np

from .wavfile import AudioData, write_wav

SR = 16000


def _burst(sr: int, n: int, freq: float, rng: np.random.Generator,
           noise: float = 0.01) -> np.ndarray:
    """带汉宁窗的响声脉冲 + 轻微底噪 (保证不是纯静音, 可逐帧核对)。"""
    t = np.arange(n) / sr
    env = np.hanning(n)
    tone = np.sin(2 * np.pi * freq * t) * env
    return (tone + rng.normal(0.0, noise, n)).astype(np.float64)


def _silence(n: int, rng: np.random.Generator, noise: float = 0.001) -> np.ndarray:
    """停顿: 只有底噪, 幅度远低于响声。"""
    return rng.normal(0.0, noise, n).astype(np.float64)


@dataclass
class Example:
    name: str
    title: str
    description: str
    wav_path: str
    ann_path: str


def _dump_annotation(path: str, sr: int, marks: List[Tuple[str, int]],
                     regions: List[Dict]) -> None:
    payload = {
        "sample_rate": sr,
        "marks": [
            {"label": lab, "sample": s, "time_s": round(s / sr, 6)} for lab, s in marks
        ],
        "regions": regions,
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def _make_short_gap(out_dir: str) -> Tuple[AudioData, Example]:
    """单声道 1.03s, 三段响声夹三个不同长度的停顿。"""
    rng = np.random.default_rng(20261126)
    b1, g1, b2, g2, b3, g3, b4 = 3200, 1600, 4800, 800, 3200, 480, 2400
    parts = [
        _burst(SR, b1, 440.0, rng), _silence(g1, rng),
        _burst(SR, b2, 554.0, rng), _silence(g2, rng),
        _burst(SR, b3, 659.0, rng), _silence(g3, rng),
        _burst(SR, b4, 880.0, rng),
    ]
    mono = np.concatenate(parts)[:, None]
    audio = AudioData(mono, SR)

    # 停顿区间 (起止精确落在静音帧上)
    r1s, r1e = b1, b1 + g1                       # 1600 帧静音, 保留 80ms=1280 帧
    r2s = b1 + g1 + b2
    r2e = r2s + g2                               # 800 帧, 保留 150ms=2400 帧 -> 太短放过
    r3s = r2e + b3
    r3e = r3s + g3                               # 480 帧, 保留 0 -> 硬切

    marks = [
        ("M1", 800),                  # 响声 1 内部, 必须原样保留
        ("M2", r1s + 700),            # 落在第一个停顿的删除段内 -> 被删
        ("M3", r2e + b3 // 2),        # 响声 3 内部
        ("M4", r3e + 5),              # 最后一段响声开头附近, 未删
    ]
    regions = [
        {"start": r1s, "end": r1e, "keep_ms": 80.0, "note": "短停顿, 保留80ms"},
        {"start": r2s, "end": r2e, "keep_ms": 150.0, "note": "保留需求超过区间, 应放过"},
        {"start": r3s, "end": r3e, "keep_ms": 0.0, "note": "整段删除, 硬切"},
    ]
    wav = os.path.join(out_dir, "short_gap.wav")
    ann = os.path.join(out_dir, "short_gap.annotations.json")
    write_wav(wav, audio, sampwidth=2)
    _dump_annotation(ann, SR, marks, regions)
    ex = Example(
        "short_gap", "短间隔 / 放过 / 硬切",
        "三个停顿: 正常缩短、保留需求超过区间而原样放过、保留0毫秒硬切; M2 落在被删段。",
        wav, ann,
    )
    return audio, ex


def _make_adjacent(out_dir: str) -> Tuple[AudioData, Example]:
    """单声道 2.435s, 构造重叠 + 首尾挨住的修改区 (两组冲突, 全部原样不动)。

    合法区间的正常执行路径由 short_gap 示例覆盖, 这里专门验证冲突保护。
    """
    rng = np.random.default_rng(424242)
    b1, g1, b2, g2, b3 = 6400, 640, 8000, 640, 13280
    parts = [
        _burst(SR, b1, 330.0, rng), _silence(g1, rng),
        _burst(SR, b2, 440.0, rng), _silence(g2, rng),
        _burst(SR, b3, 550.0, rng),
    ]
    audio = AudioData(np.concatenate(parts)[:, None], SR)

    g1s, g1e = b1, b1 + g1
    g2s = b1 + g1 + b2
    g2e = g2s + g2

    regions = [
        # R0/R1 在第一段静音里相互重叠
        {"start": g1s, "end": g1s + 400, "keep_ms": 50.0, "note": "冲突A左"},
        {"start": g1s + 200, "end": g1e, "keep_ms": 50.0, "note": "冲突A右(重叠)"},
        # R2/R3 在第二段静音里首尾挨住: R2 结尾 == R3 开头
        {"start": g2s, "end": g2s + 320, "keep_ms": 40.0, "note": "冲突B左"},
        {"start": g2s + 320, "end": g2e, "keep_ms": 40.0, "note": "冲突B右(挨住)"},
    ]
    marks = [
        ("N1", 2000),
        ("N2", g1s + 300),       # 落在冲突区内, 但冲突区不动 -> 标注也不删
        ("N3", g2s + 10),
        ("N4", audio.n_samples - 10),
    ]
    wav = os.path.join(out_dir, "adjacent.wav")
    ann = os.path.join(out_dir, "adjacent.annotations.json")
    write_wav(wav, audio, sampwidth=2)
    _dump_annotation(ann, SR, marks, regions)
    ex = Example(
        "adjacent", "相邻 / 重叠修改区冲突",
        "四个区间两两挨住或重叠, 必须全部报冲突并原样不动, 成品采样数与原声相同。",
        wav, ann,
    )
    return audio, ex


def _make_stereo(out_dir: str) -> Tuple[AudioData, Example]:
    """立体声 2.4s, 左右声道响点错开, 停顿区间内两声道都必须是静音。"""
    rng = np.random.default_rng(777)
    n = int(2.4 * SR)
    left = rng.normal(0.0, 0.001, n)
    right = rng.normal(0.0, 0.001, n)

    def place(ch: np.ndarray, start: int, length: int, freq: float) -> None:
        ch[start:start + length] += _burst(SR, length, freq, rng, noise=0.0)

    # 左右响点刻意错开
    place(left, 1600, 2400, 440.0)
    place(right, 2400, 2400, 494.0)
    place(left, 13600, 3200, 660.0)
    place(right, 12800, 3200, 740.0)
    place(left, 30000, 4000, 880.0)
    place(right, 30800, 4000, 988.0)
    stereo = np.stack([left, right], axis=1)
    audio = AudioData(stereo, SR)

    # 停顿: 选左右都确认静音的帧段
    regions = [
        {"start": 5200, "end": 11200, "keep_ms": 100.0, "note": "双声道共同静音1"},
        {"start": 18000, "end": 28800, "keep_ms": 120.0, "note": "双声道共同静音2"},
    ]
    marks = [
        ("L1", 1600),     # 左声道响点
        ("R1", 2400),     # 右声道响点 (与 L1 不同位置)
        ("L2", 13600),
        ("R2", 12800),
        ("MID", 20000),   # 落在第二个被删停顿内
    ]
    wav = os.path.join(out_dir, "stereo_onsets.wav")
    ann = os.path.join(out_dir, "stereo_onsets.annotations.json")
    write_wav(wav, audio, sampwidth=2)
    _dump_annotation(ann, SR, marks, regions)
    ex = Example(
        "stereo", "两声道不同响点",
        "左右脉冲位置错开; 只删两声道都静音的区间, 全部响点逐帧保留。",
        wav, ann,
    )
    return audio, ex


def generate_examples(out_dir: str) -> List[Example]:
    os.makedirs(out_dir, exist_ok=True)
    examples = [
        _make_short_gap(out_dir)[1],
        _make_adjacent(out_dir)[1],
        _make_stereo(out_dir)[1],
    ]
    readme = os.path.join(out_dir, "README.md")
    with open(readme, "w", encoding="utf-8") as f:
        f.write(
            "# 内置示例 (由 pause_editor.examples 重新生成, 种子固定)\n\n"
            f"采样率统一 {SR} Hz, 16-bit PCM。\n\n"
            "| 目录项 | 场景 |\n|---|---|\n"
            "| short_gap | 短间隔: 正常缩短 / 不足保留长度原样放过 / 硬切, M2 落在被删段 |\n"
            "| adjacent | 修改区重叠与首尾挨住, 全部冲突不动, 成品长度==原声 |\n"
            "| stereo_onsets | 左右声道响点错开, 只删双声道静音段 |\n\n"
            "核对方式: `.venv/bin/python -m pause_editor.verify`\n"
        )
    return examples
