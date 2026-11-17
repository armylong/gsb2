#!/usr/bin/env python3
"""关键行为验证：全部基于实际生成的输出文件（解码帧 + 解码音频），不只核对预计值。

用法: python3 -I scripts/verify.py
退出码 0 = 全部通过。
"""
from __future__ import annotations

import io
import json
import math
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from speedtool import render as render_mod
from speedtool import sample as sample_mod
from speedtool.segments import (Segment, SegmentError, build_plan, out_to_src,
                                src_to_out, total_duration, validate)

WORK = Path(__file__).resolve().parent.parent / "workspace" / "verify"
FPS = render_mod.FPS
SR = render_mod.SAMPLE_RATE

results: list[tuple[bool, str]] = []


def check(ok: bool, label: str, detail: str = ""):
    results.append((ok, label + (f" | {detail}" if detail else "")))
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}" + (f" | {detail}" if detail else ""))


# ---------------------------------------------------------------- A. 映射逻辑
def test_mapping():
    print("\n== A. 分段校验与双向映射（纯逻辑） ==")
    dur = 12.0
    segs = [Segment(0, 4, 0.5), Segment(4, 8, 1.0), Segment(8, 12, 2.0)]
    plan = build_plan(segs, dur)
    # 输出区间: [0,8) [8,12) [12,14]
    check(abs(total_duration(plan) - 14.0) < 1e-9, "预计总时长 14.0s")

    # 边界归属：源边界 4.0 属于第2段，但映射值与第1段终点一致
    check(abs(src_to_out(plan, 4.0) - 8.0) < 1e-9, "源边界 4.0 -> 输出 8.0（两侧一致）")
    check(abs(src_to_out(plan, 8.0) - 12.0) < 1e-9, "源边界 8.0 -> 输出 12.0（两侧一致）")
    # 输出边界 8.0 属于第2段，映射回源 4.0，与第1段终点一致
    check(abs(out_to_src(plan, 8.0) - 4.0) < 1e-9, "输出边界 8.0 -> 源 4.0（两侧一致）")
    check(abs(out_to_src(plan, 12.0) - 8.0) < 1e-9, "输出边界 12.0 -> 源 8.0（两侧一致）")
    # 首尾
    check(src_to_out(plan, 0.0) == 0.0, "首帧: 源 0 -> 输出 0")
    check(abs(out_to_src(plan, 14.0) - 12.0) < 1e-9, "末帧: 输出 14.0 -> 源 12.0（末段含终点）")

    # 网格往返一致
    ok = True
    for i in range(0, 14001):
        t = i / 1000.0
        if abs(src_to_out(plan, out_to_src(plan, t)) - t) > 1e-6:
            ok = False
            break
    check(ok, "输出->源->输出 往返一致（14001 个采样点）")
    ok = True
    for i in range(0, 12001):
        t = i / 1000.0
        if abs(out_to_src(plan, src_to_out(plan, t)) - t) > 1e-6:
            ok = False
            break
    check(ok, "源->输出->源 往返一致（12001 个采样点）")

    # 非法分段必须报明确错误
    cases = [
        ([Segment(0, 4, 1.0), Segment(3, 8, 1.0), Segment(8, 12, 1.0)], "重叠"),
        ([Segment(0, 4, 1.0), Segment(5, 12, 1.0)], "空洞"),
        ([Segment(0, 0, 1.0), Segment(0, 12, 1.0)], "零长度"),
        ([Segment(0, 12, 2.5)], "速度超上限"),
        ([Segment(0, 12, 0.3)], "速度超下限"),
        ([Segment(0, 6, 1.0)], "未覆盖全片"),
        ([Segment(2, 12, 1.0)], "开头空洞"),
        ([Segment(0, 3, 1.0)] * 6, "超过5段"),
    ]
    for segs_bad, name in cases:
        try:
            validate(segs_bad, dur)
            check(False, f"非法分段应报错: {name}")
        except SegmentError as e:
            check(bool(str(e)), f"非法分段报错: {name}", str(e))


# ---------------------------------------------------------------- 工具函数
def extract_frame(video: Path, t: float, total: float | None = None) -> Image.Image:
    """取出 t 时刻实际显示的输出帧（第 floor(t*30) 帧），按帧号精确选取。"""
    n = int(math.floor(t * FPS))
    if total is not None:
        n = min(n, int(round(total * FPS)) - 1)
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(video),
         "-vf", f"select='eq(n\\,{n})'", "-frames:v", "1",
         "-f", "image2pipe", "-vcodec", "png", "-"],
        capture_output=True, check=True)
    return Image.open(io.BytesIO(out.stdout)).convert("RGB")


def read_barcode_frame_number(img: Image.Image) -> int:
    """从样例片顶部 16 位条码读回源帧号。"""
    px = img.load()
    y = sample_mod.BARCODE_Y0 + sample_mod.BARCODE_BLOCK_H // 2
    value = 0
    for b in range(sample_mod.BARCODE_BITS):
        x = sample_mod.BARCODE_X0 + b * sample_mod.BARCODE_BLOCK_W + sample_mod.BARCODE_BLOCK_W // 2
        r, g, bl = px[x, y]
        value = (value << 1) | (1 if (r + g + bl) / 3 > 128 else 0)
    return value


def extract_audio(video: Path) -> np.ndarray:
    out = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(video),
         "-ac", "1", "-ar", str(SR), "-f", "wav", "-"],
        capture_output=True, check=True)
    with wave.open(io.BytesIO(out.stdout)) as wf:
        data = wf.readframes(wf.getnframes())
    return np.frombuffer(data, dtype="<i2").astype(np.float64) / 32768.0


def dominant_freq(audio: np.ndarray, lo=300.0, hi=600.0) -> float:
    n = len(audio)
    win = np.hanning(n)
    spec = np.abs(np.fft.rfft(audio * win))
    freqs = np.fft.rfftfreq(n, 1 / SR)
    mask = (freqs >= lo) & (freqs <= hi)
    idx = np.argmax(spec[mask])
    return freqs[mask][idx]


def beep_onsets(audio: np.ndarray, freq=1000.0, frame=1024, hop=256) -> list[float]:
    """检测 1kHz 哔声的起始时刻。"""
    n_frames = (len(audio) - frame) // hop + 1
    energy = np.empty(n_frames)
    k = int(round(freq * frame / SR))
    win = np.hanning(frame)
    for i in range(n_frames):
        seg = audio[i * hop: i * hop + frame] * win
        energy[i] = abs(np.fft.rfft(seg)[k])
    thr = max(energy.max() * 0.3, np.median(energy) * 8)
    onsets, in_beep = [], False
    for i, e in enumerate(energy):
        if e > thr and not in_beep:
            onsets.append(i * hop / SR)
            in_beep = True
        elif e <= thr:
            in_beep = False
    return onsets


# ---------------------------------------------------------------- B~E. 实测
def test_render():
    print("\n== 生成样例并按默认三段（0.5x/1.0x/2.0x）渲染 ==")
    WORK.mkdir(parents=True, exist_ok=True)
    src = WORK / "sample.mp4"
    if not src.exists():
        sample_mod.generate_sample(src)
    print(f"  样例: {src}")

    segs = [Segment(**s) for s in sample_mod.default_segments(sample_mod.SAMPLE_DURATION)]
    plan = build_plan(segs, sample_mod.SAMPLE_DURATION)
    total = total_duration(plan)
    out = WORK / "out.mp4"
    render_mod.render(src, plan, out)
    print(f"  输出: {out}  预计总时长 {total:.4f}s")

    print("\n== B. 容器级检查（ffprobe 实测） ==")
    info = render_mod.probe(out)
    check(abs(info["fps"] - FPS) < 1e-6, "输出帧率固定 30fps", f"实测 {info['fps']:.3f}")
    probe_json = json.loads(subprocess.run(
        ["ffprobe", "-v", "error", "-print_format", "json",
         "-show_streams", "-show_format", str(out)],
        capture_output=True, text=True, check=True).stdout)
    vstream = next(s for s in probe_json["streams"] if s["codec_type"] == "video")
    astream = next(s for s in probe_json["streams"] if s["codec_type"] == "audio")
    nb_frames = int(vstream["nb_frames"])
    expected_frames = round(total * FPS)
    check(nb_frames == expected_frames, "输出帧数 == round(预计时长*30)",
          f"{nb_frames} vs {expected_frames}")
    check(abs(info["duration"] - total) <= 1 / FPS + 1e-3,
          "最终时长与预计值差距 ≤ 1 个输出帧",
          f"实测 {info['duration']:.4f}s vs 预计 {total:.4f}s")
    a_dur = float(astream["duration"])
    v_dur = float(vstream["duration"])
    check(abs(a_dur - v_dur) <= 1 / FPS + 1e-3,
          "音频尾部与画面尾部对齐 ≤ 1 个输出帧",
          f"音频 {a_dur:.4f}s vs 视频 {v_dur:.4f}s")

    print("\n== C. 帧内容定位（解码输出帧条码 vs 映射表） ==")
    # 覆盖: 首帧、每段中部、每个边界±半帧、末帧
    test_times = [0.0]
    for r in plan:
        test_times.append((r.out_start + r.out_end) / 2)
    for r in plan[1:]:
        test_times += [r.out_start - 0.5 / FPS, r.out_start + 0.5 / FPS]
    test_times.append(total - 0.5 / FPS)
    for t in test_times:
        t = min(max(t, 0.0), total - 0.5 / FPS)
        img = extract_frame(out, t, total)
        actual_frame = read_barcode_frame_number(img)
        src_t = out_to_src(plan, t)
        expected_frame = src_t * FPS
        speed = next(r.speed for r in plan if src_t < r.src_end or r is plan[-1])
        tol = speed + 1.0  # 1 个输出帧折合 speed 个源帧，+1 帧取整余量
        ok = abs(actual_frame - expected_frame) <= tol
        check(ok, f"输出 t={t:7.3f}s 画面定位",
              f"条码帧号 {actual_frame} vs 映射期望 {expected_frame:.2f}（容差 {tol:.1f} 帧）")

    print("\n== D. 音频实测（保调 / 事件对齐 / 衔接爆音） ==")
    audio = extract_audio(out)
    for r in plan:
        mid = (r.out_start + r.out_end) / 2
        half = min(0.25, r.out_len * 0.4)
        seg_audio = audio[int((mid - half) * SR): int((mid + half) * SR)]
        f0 = dominant_freq(seg_audio)
        check(abs(f0 - sample_mod.TONE_FREQ) <= 5.0,
              f"第 {r.index + 1} 段（{r.speed}x）保调", f"主峰 {f0:.1f}Hz，期望 440Hz")

    onsets = beep_onsets(audio)
    expected = []
    for k in range(int(sample_mod.SAMPLE_DURATION)):
        seg = next(r for r in plan if k < r.src_end or r is plan[-1])
        if k + sample_mod.BEEP_LEN <= seg.src_end:  # 哔声完整落在某段内
            expected.append(src_to_out(plan, float(k)))
    matched = 0
    for et in expected:
        if any(abs(o - et) <= 0.08 for o in onsets):
            matched += 1
    check(matched == len(expected), "整秒哔声在输出中的时刻与映射一致（±80ms）",
          f"命中 {matched}/{len(expected)}，实测 {len(onsets)} 个哔声")

    steady = audio[int(2 * SR): int(4 * SR)]  # 慢放段中部的纯音区
    ref = np.max(np.abs(np.diff(steady))) * 3
    for r in plan[1:]:
        j = r.out_start
        w = audio[int((j - 0.005) * SR): int((j + 0.005) * SR)]
        spike = np.max(np.abs(np.diff(w))) if len(w) > 1 else 0.0
        check(spike <= max(ref, 0.05), f"衔接处 t={j:.3f}s 无爆音",
              f"跳变 {spike:.4f}（阈值 {max(ref, 0.05):.4f}）")

    print("\n== E. 首尾定位 ==")
    f0 = read_barcode_frame_number(extract_frame(out, 0.0, total))
    check(f0 == 0, "输出首帧 = 源第 0 帧", f"条码 {f0}")
    fl = read_barcode_frame_number(extract_frame(out, total - 0.5 / FPS, total))
    last_src = int(round(sample_mod.SAMPLE_DURATION * FPS)) - 1
    check(abs(fl - last_src) <= 1, "输出末帧 = 源最后一帧", f"条码 {fl} vs {last_src}")


def main():
    test_mapping()
    test_render()
    failed = [r for r in results if not r[0]]
    print(f"\n{'=' * 60}\n总计 {len(results)} 项，通过 {len(results) - len(failed)}，失败 {len(failed)}")
    if failed:
        for _, label in failed:
            print(f"  FAIL: {label}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
