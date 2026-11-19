"""无界面自动化核对: 用自生成样例真实渲染三种转场并逐项验证.

核对内容(全部来自真实输出文件):
  1. 成品总时长 / 音频末端 / 帧数 与预计值偏差 ≤ 一个输出帧
  2. 转场中点画面: 叠化为两色混合, 淡黑接近全黑, 推移两侧颜色分明且方向正确
  3. 首帧为 A 底色、末帧为 B 底色(转场外完整保留, 无意外空帧)
  4. 重叠区音频: B 路声音在转场起点进入(不提前), A 路声音在转场终点消失

运行: python -m transition_editor.verify [--work-dir build/verify]
"""
from __future__ import annotations

import argparse
import array
import math
import os
import subprocess
import sys
from dataclasses import dataclass

from .media import FPS, FRAME, HEIGHT, WIDTH, MediaError
from .render import Plan, ClipSpec, check_readback, extract_frame_rgb, render
from .samples import TONE_A, TONE_B, generate_all

AUDIO_RATE = 8000
# 判定阈值
DUR_TOL = FRAME + 1e-6          # 时长偏差 ≤ 1 帧
BLACK_MEAN_MAX = 40.0           # 淡黑中点平均亮度上限
BLEND_MIN = 70.0                # 叠化中点 R/B 分量下限(两色都在)
SIDE_DOMINANCE = 60.0           # 推移中点某侧主导色需超过另一侧这么多
ONSET_TOL = 0.30                # B 路进入时间容差(秒)
EARLY_TOL = 0.06                # 允许的最提前量(秒)


@dataclass
class Check:
    name: str
    ok: bool
    detail: str


# ---------- 画面分析 ----------

def _region_mean(rgb: bytes, w: int, h: int, x0: int, x1: int) -> tuple[float, float, float]:
    """[x0,x1) 列范围内 R/G/B 均值."""
    n = (x1 - x0) * h
    sr = sg = sb = 0
    for y in range(0, h, 4):            # 纵向抽样加速
        row = y * w * 3
        for x in range(x0, x1, 2):        # 横向抽样
            i = row + x * 3
            sr += rgb[i]; sg += rgb[i + 1]; sb += rgb[i + 2]
    cnt = (len(range(0, h, 4))) * (len(range(x0, x1, 2)))
    return sr / cnt, sg / cnt, sb / cnt


def frame_mean(rgb: bytes, w: int, h: int) -> tuple[float, float, float]:
    return _region_mean(rgb, w, h, 0, w)


# ---------- 音频分析 ----------

def decode_audio(video_path: str) -> array.array:
    """解码为单声道 8kHz s16."""
    proc = subprocess.run([
        "ffmpeg", "-v", "error", "-i", video_path,
        "-ac", "1", "-ar", str(AUDIO_RATE), "-f", "s16le", "-",
    ], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode != 0:
        raise MediaError("音频解码失败: " + proc.stderr.decode("utf-8", "replace")[-500:])
    samples = array.array("h")
    samples.frombytes(proc.stdout)
    return samples


def _goertzel_ratio(samples: array.array, start: int, n: int, freq: float) -> tuple[float, float]:
    """返回 (目标频率功率占比, 绝对功率)."""
    k = int(0.5 + n * freq / AUDIO_RATE)
    w = 2.0 * math.pi * k / n
    coeff = 2.0 * math.cos(w)
    s0 = s1 = s2 = 0.0
    total = 0.0
    for i in range(start, start + n):
        x = samples[i] / 32768.0
        total += x * x
        s0 = x + coeff * s1 - s2
        s2, s1 = s1, s0
    power = s1 * s1 + s2 * s2 - coeff * s1 * s2
    ratio = power / total if total > 1e-12 else 0.0
    return ratio, power / (n * n)


def tone_presence(samples: array.array, freq: float, win: float = 0.1, hop: float = 0.05):
    """逐窗检测某频率是否存在, 返回 [(中心时间, 是否出现)]."""
    n = int(win * AUDIO_RATE)
    step = int(hop * AUDIO_RATE)
    out = []
    t = 0.0
    while (start := int(t * AUDIO_RATE)) + n <= len(samples):
        ratio, power = _goertzel_ratio(samples, start, n, freq)
        out.append((t + win / 2, ratio > 0.3 and power > 1e-6))
        t += hop
    return out


def audio_overlap_measurements(video_path: str) -> dict:
    samples = decode_audio(video_path)
    pres_a = tone_presence(samples, TONE_A)
    pres_b = tone_presence(samples, TONE_B)
    b_on = [t for t, p in pres_b if p]
    a_on = [t for t, p in pres_a if p]
    return {
        "b_first": b_on[0] if b_on else None,
        "b_any_before": None,  # 由调用方按 offset 判定
        "b_earliest_violation": None,
        "a_last": a_on[-1] if a_on else None,
        "pres_a": pres_a, "pres_b": pres_b,
    }


# ---------- 单项核对 ----------

def check_midpoint(kind: str, direction: str, rgb: bytes, w: int, h: int) -> Check:
    r, g, b = frame_mean(rgb, w, h)
    mean = (r + g + b) / 3
    if kind == "fadeblack":
        ok = mean < BLACK_MEAN_MAX
        return Check("淡黑中点接近全黑", ok,
                     f"中点平均亮度 {mean:.1f}(阈值<{BLACK_MEAN_MAX})")
    if kind == "fade":
        ok = r > BLEND_MIN and b > BLEND_MIN
        return Check("叠化中点为两色混合", ok,
                     f"中点 R={r:.0f} B={b:.0f}(均须>{BLEND_MIN})")
    # slide: 检查左右两侧颜色与方向
    lr, _, lb = _region_mean(rgb, w, h, 0, w // 4)
    rr, _, rb = _region_mean(rgb, w, h, 3 * w // 4, w)
    if direction == "left":   # A 向左滑出, B 从右进入: 中点左红右蓝
        ok = lr > lb + SIDE_DOMINANCE and rb > rr + SIDE_DOMINANCE
        side = "左侧偏红/右侧偏蓝"
    else:                     # A 向右滑出, B 从左进入: 中点左蓝右红
        ok = lb > lr + SIDE_DOMINANCE and rr > rb + SIDE_DOMINANCE
        side = "左侧偏蓝/右侧偏红"
    return Check(f"推移中点方向正确({side})", ok,
                 f"左 R={lr:.0f}/B={lb:.0f}  右 R={rr:.0f}/B={rb:.0f}")


def run_case(kind: str, direction: str, sample_a: str, sample_b: str,
             work_dir: str, seconds: float) -> list[Check]:
    duration = 1.0
    plan = Plan(ClipSpec(sample_a, 0.0, seconds), ClipSpec(sample_b, 0.0, seconds),
                kind=kind, direction=direction, duration=duration)
    name = kind if kind != "slide" else f"slide-{direction}"
    out = os.path.join(work_dir, f"out_{name}.mp4")
    render(plan, out)

    checks: list[Check] = []

    # 1. 时长/帧数回读
    rb = check_readback(plan, out)
    checks.append(Check(
        "总时长与音频末端偏差 ≤ 1 帧", rb["ok"],
        f"预计 {rb['expected_duration']:.4f}s/{rb['expected_frames']}帧, "
        f"实际 {rb['actual_duration']:.4f}s/{rb['actual_frames']}帧, "
        f"音频末端 {rb['audio_duration']:.4f}s, "
        f"偏差 {rb['duration_deviation_frames']:.3f}帧/"
        f"{rb['audio_deviation_frames']:.3f}帧"))

    # 2. 中点画面
    mid = plan.offset + plan.duration / 2
    rgb, w, h = extract_frame_rgb(out, mid)
    checks.append(check_midpoint(kind, direction, rgb, w, h))

    # 3. 首帧/末帧底色(转场外完整保留, 无空帧)
    rgb0, _, _ = extract_frame_rgb(out, 0.0)
    r0, _, b0 = frame_mean(rgb0, w, h)
    checks.append(Check("首帧为 A 红底", r0 > b0 + SIDE_DOMINANCE,
                        f"首帧 R={r0:.0f} B={b0:.0f}"))
    rgb1, _, _ = extract_frame_rgb(out, plan.total - FRAME)
    r1, _, b1 = frame_mean(rgb1, w, h)
    checks.append(Check("末帧为 B 蓝底", b1 > r1 + SIDE_DOMINANCE,
                        f"末帧 R={r1:.0f} B={b1:.0f}"))

    # 4. 重叠区音频起止
    m = audio_overlap_measurements(out)
    offset, len_a = plan.offset, plan.len_a
    early = [t for t, p in m["pres_b"] if p and t < offset - EARLY_TOL]
    checks.append(Check(
        "B 路声音不在转场起点前出现", not early,
        f"转场起点 {offset:.3f}s, 最早 B 音 "
        + (f"{m['b_first']:.3f}s" if m["b_first"] is not None else "未检出")))
    ok_onset = m["b_first"] is not None and abs(m["b_first"] - offset) <= ONSET_TOL
    checks.append(Check(
        "B 路声音在转场起点进入", ok_onset,
        f"检出起点 {m['b_first'] and round(m['b_first'], 3)}s, "
        f"期望 {offset:.3f}±{ONSET_TOL}s"))
    late_a = [t for t, p in m["pres_a"] if p > len_a + EARLY_TOL]
    ok_a_end = (m["a_last"] is not None and not late_a
                and m["a_last"] >= len_a - 0.35)
    checks.append(Check(
        "A 路声音在转场终点消失", ok_a_end,
        f"转场终点 {len_a:.3f}s, A 音最后检出 "
        f"{m['a_last'] and round(m['a_last'], 3)}s"))
    return checks


def main() -> int:
    parser = argparse.ArgumentParser(description="真实渲染并核对三种转场")
    parser.add_argument("--work-dir", default="build/verify")
    parser.add_argument("--seconds", type=float, default=6.0)
    args = parser.parse_args()

    os.makedirs(args.work_dir, exist_ok=True)
    print(f"[1/2] 生成样例到 {args.work_dir} ...")
    sample_a, sample_b = generate_all(args.work_dir, args.seconds)

    print(f"[2/2] 渲染并核对转场 ...")
    cases = [("fade", "left"), ("slide", "left"), ("slide", "right"),
             ("fadeblack", "left")]
    all_ok = True
    for kind, direction in cases:
        name = kind if kind != "slide" else f"slide-{direction}"
        print(f"\n== {name} ==")
        try:
            checks = run_case(kind, direction, sample_a, sample_b,
                              args.work_dir, args.seconds)
        except MediaError as exc:
            print(f"  FAIL  渲染失败: {exc}")
            all_ok = False
            continue
        for c in checks:
            print(f"  {'PASS' if c.ok else 'FAIL'}  {c.name}: {c.detail}")
            all_ok = all_ok and c.ok

    print("\n== 汇总 ==")
    print("全部通过" if all_ok else "存在失败项")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
