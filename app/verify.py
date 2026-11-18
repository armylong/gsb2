"""验证: 从导出文件实际解码的数据出发, 核对倒放结果.

用法: python -m app.verify <原片.mp4> <导出.mp4> <起点帧> <终点帧>
检查项(均允许有损编码误差, 用最近邻/相关度而非字节相等):
  1. 帧数与总时长不变
  2. 区间外每一输出帧与对应原帧一致, 区间内为原帧逆序
  3. 音频区间外不变、区间内逆序
  4. 左右声道未被交换
"""

from __future__ import annotations

import sys
from fractions import Fraction
from pathlib import Path

import numpy as np

from .core import (
    FrameRange,
    audio_sample_bounds,
    reverse_audio_segment,
    video_frame_mapping,
)
from .media import load_media


def _thumb(frame: np.ndarray, size: tuple[int, int] = (96, 54)) -> np.ndarray:
    """降采样灰度图, 用于有损容忍的帧匹配."""
    h, w = frame.shape[:2]
    th, tw = size
    ys = (np.linspace(0, h - 1, th)).astype(int)
    xs = (np.linspace(0, w - 1, tw)).astype(int)
    gray = frame[np.ix_(ys, xs)].mean(axis=2)
    return gray


def match_frames(src: list[np.ndarray], out: list[np.ndarray]) -> tuple[list[int], list[float]]:
    """每个输出帧找最近的原帧, 返回 (匹配下标, 平均绝对差)."""
    src_thumbs = [_thumb(f) for f in src]
    mapping, errs = [], []
    for of in out:
        ot = _thumb(of)
        diffs = [float(np.abs(ot - st).mean()) for st in src_thumbs]
        best = int(np.argmin(diffs))
        mapping.append(best)
        errs.append(diffs[best])
    return mapping, errs


def _corr(a: np.ndarray, b: np.ndarray) -> float:
    n = min(a.shape[-1], b.shape[-1])
    if n == 0:
        return 0.0
    a = a[..., :n].astype(np.float64).ravel()
    b = b[..., :n].astype(np.float64).ravel()
    if a.std() < 1e-9 and b.std() < 1e-9:
        return 1.0
    return float(np.corrcoef(a, b)[0, 1])


def _rel_err(a: np.ndarray, b: np.ndarray, floor: float) -> float:
    """||a-b|| / max(||b||, floor): 对静音段也稳定的相对误差."""
    n = min(a.shape[-1], b.shape[-1])
    if n == 0:
        return 0.0
    a = a[..., :n].astype(np.float64)
    b = b[..., :n].astype(np.float64)
    diff = np.linalg.norm(a - b)
    ref = max(float(np.linalg.norm(b)), floor)
    return float(diff / ref)


def verify(src_path: str, out_path: str, f0: int, f1: int) -> list[str]:
    src = load_media(src_path)
    out = load_media(out_path)
    rng = FrameRange(f0, f1)
    expected = video_frame_mapping(src.n_frames, rng)
    failures: list[str] = []

    # 1. 帧数与时长
    if out.n_frames != src.n_frames:
        failures.append(f"帧数不一致: 原 {src.n_frames} vs 导出 {out.n_frames}")
    if abs(out.duration - src.duration) > float(1 / src.fps):
        failures.append(f"时长差超过一帧: 原 {src.duration:.4f}s vs 导出 {out.duration:.4f}s")
    if out.fps != src.fps:
        failures.append(f"帧率不一致: 原 {out.fps} vs 导出 {src.fps}")

    # 2. 帧顺序(最近邻匹配, 容忍有损编码)
    if out.n_frames == src.n_frames:
        mapping, errs = match_frames(src.frames, out.frames)
        bad = [i for i, (m, e) in enumerate(zip(mapping, expected)) if m != e]
        if bad:
            failures.append(
                f"帧顺序不符的输出帧: {bad[:10]}{'...' if len(bad) > 10 else ''} (共{len(bad)}个)"
            )
        worst = max(errs)
        print(f"帧匹配最大平均差: {worst:.2f}/255 (有损编码误差)")

    # 3/4. 音频
    if src.has_audio:
        if not out.has_audio:
            failures.append("原片有音轨但导出没有")
        else:
            ab = audio_sample_bounds(rng, src.fps, src.sample_rate, src.audio.shape[1])
            print(
                f"音频采样边界: [{ab.s0}, {ab.s1}) / {ab.total_samples}, "
                f"舍入差 err0={ab.err0:+.3f} err1={ab.err1:+.3f} 采样点"
            )
            s, o = src.audio, out.audio
            floor = 1e-3 * float(np.linalg.norm(s.astype(np.float64))) + 1e-12
            # 区间外不变
            e_pre = _rel_err(s[:, : ab.s0], o[:, : ab.s0], floor)
            e_post = _rel_err(s[:, ab.s1 :], o[:, ab.s1 :], floor)
            # 区间内逆序: 导出区间 vs 原区间反转
            rev = s[:, ab.s0 : ab.s1][:, ::-1]
            e_seg = _rel_err(rev, o[:, ab.s0 : ab.s1], floor)
            c_seg = _corr(rev, o[:, ab.s0 : ab.s1])
            # 声道未交换: 与"期望成品"(原音按区间反转)逐声道对比,
            # 同声道相关度应显著高于交换后
            expected_audio = reverse_audio_segment(s, ab.s0, ab.s1)
            if s.shape[0] == 2:
                c_same = (_corr(expected_audio[0], o[0]) + _corr(expected_audio[1], o[1])) / 2
                c_swap = (_corr(expected_audio[0], o[1]) + _corr(expected_audio[1], o[0])) / 2
            else:
                c_same, c_swap = 1.0, -1.0
            print(
                f"音频相对误差: 区间前 {e_pre:.5f} | 区间后 {e_post:.5f} | "
                f"区间内(对反转原音) {e_seg:.5f} (相关度 {c_seg:.4f}) | "
                f"同声道 {c_same:.4f} vs 交换 {c_swap:.4f}"
            )
            if e_pre > 0.05:
                failures.append(f"区间前音频被改动 (相对误差 {e_pre:.5f})")
            if e_post > 0.05:
                failures.append(f"区间后音频被改动 (相对误差 {e_post:.5f})")
            if e_seg > 0.05:
                failures.append(f"区间内音频不是原音频的逆序 (相对误差 {e_seg:.5f})")
            if s.shape[0] == 2 and not (c_same > 0.9 and c_same > c_swap + 0.3):
                failures.append(f"左右声道疑似被交换 (同 {c_same:.4f} / 换 {c_swap:.4f})")
            # 覆盖一致: 导出音频长度与视频时长差在一个视频帧以内
            av_dur = out.audio.shape[1] / out.sample_rate
            if abs(av_dur - out.duration) > float(1 / out.fps):
                failures.append(
                    f"音视频覆盖差超过一帧: 音频 {av_dur:.4f}s vs 视频 {out.duration:.4f}s"
                )
    elif out.has_audio:
        failures.append("原片无音轨但导出凭空添加了音轨")

    return failures


def main(argv: list[str]) -> int:
    if len(argv) != 5:
        print(__doc__)
        return 2
    _, src, out, f0, f1 = argv
    failures = verify(src, out, int(f0), int(f1))
    if failures:
        print("\n验证失败:")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("\n全部验证通过 ✔")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
