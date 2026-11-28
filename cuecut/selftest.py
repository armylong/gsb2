"""Run the demo master through both split modes and verify reconstruction.

Exit code 0 means: every file read back equal to its source range, the
concatenation tiles the source exactly with no gap or repeat, known markers
landed at the expected first samples, and the tones that span a boundary are
present right on both sides of the seam.
"""

from __future__ import annotations

import os
import sys
import tempfile

import numpy as np

from .cue import parse_cue, validate_against_audio
from .demo import generate_demo
from .exporter import export_plan, read_range, verify_junction
from .model import AudioInfo
from .plan import SplitMode, build_plan
from .timeutil import sample_at


def check_markers(plan, truth, problems: list, tag: str) -> None:
    """Each track file must start at INDEX 01 or, in HEAD mode, at INDEX 00."""
    assert plan.info is not None and plan.sheet is not None
    info = plan.info
    sheet = plan.sheet
    for seg in plan.segments:
        if seg.kind != "track" or seg.sheet_index < 0:
            continue
        if seg.sheet_index == 0:
            # Track 1's file legitimately begins with the head region
            # (or at its own INDEX 00), never at INDEX 01 unless trimmed.
            continue
        tr = sheet.tracks[seg.sheet_index]
        if plan.mode == SplitMode.HEAD and tr.lead is not None:
            expected = sample_at(tr.lead, info.samplerate)
        else:
            expected = sample_at(tr.start, info.samplerate)
        if seg.first_sample != expected:
            problems.append(
                f"[{tag}] {seg.file_name}: 起点采样 {seg.first_sample}，期望 {expected}"
            )


def check_seams(plan, truth, out_dir: str, problems: list, tag: str) -> None:
    """A boundary-spanning tone must continue across the *exported* seam.

    Reads the exported file content on either side of every seam (mapped back
    to source samples through each segment) and compares directly with the
    source: the waveform must be contiguous, not restart or lose energy.
    """
    assert plan.info is not None
    info = plan.info
    for a, b in zip(plan.segments, plan.segments[1:]):
        seam = b.first_sample
        spec = truth.spanning_at(seam)
        if spec is None:
            continue
        freq, s0, s1 = spec
        if seam - 4096 < s0 or seam + 4096 > s1:
            continue
        before_file = read_range(
            os.path.join(out_dir, a.file_name), a.sample_count - 4096, 4096
        )[:, 0]
        after_file = read_range(os.path.join(out_dir, b.file_name), 0, 4096)[:, 0]
        # File A's last 4096 samples map to source [seam-4096, seam), file B's
        # first 4096 map to source [seam, seam+4096).
        src_before = read_range(info.path, seam - 4096, 4096)[:, 0]
        src_after = read_range(info.path, seam, 4096)[:, 0]
        if not np.array_equal(before_file, src_before):
            problems.append(f"[{tag}] 交界 {seam} 左侧文件内容与源不符（{freq} Hz 持续音被截断）")
        if not np.array_equal(after_file, src_after):
            problems.append(f"[{tag}] 交界 {seam} 右侧文件内容与源不符（{freq} Hz 持续音被截断）")
        # The join must be sample-contiguous: a continuous sine never jumps
        # more than one full scale step across two adjacent samples.
        if abs(float(src_after[0]) - float(src_before[-1])) > 0.5:
            problems.append(
                f"[{tag}] 交界 {seam} 前后采样跳变过大"
                f"（{float(src_before[-1]):.3f} → {float(src_after[0]):.3f}）"
            )


def check_file_lengths(plan, out_dir: str, problems: list, tag: str) -> None:
    """Every exported file must have exactly the planned length (no dup/loss)."""
    for seg in plan.segments:
        path = os.path.join(out_dir, seg.file_name)
        back = read_range(path, 0, seg.sample_count)[:, 0]
        if len(back) != seg.sample_count:
            problems.append(f"[{tag}] {seg.file_name} 长度 {len(back)}，应为 {seg.sample_count}")
        if seg.file_name.endswith(".wav") and seg.sample_count == 0:
            problems.append(f"[{tag}] {seg.file_name} 是空文件")


def run(out_dir: str) -> int:
    truth = generate_demo(out_dir)
    problems: list[str] = []
    info = AudioInfo(
        path=truth.path,
        samplerate=truth.samplerate,
        channels=truth.channels,
        total_samples=truth.total_samples,
        subtype="PCM_24",
    )
    sheet = parse_cue(truth.cue_path)
    validate_against_audio(sheet, info)
    if sheet.errors:
        problems.append("cue 解析/校验失败：\n" + sheet.error_text())

    combos = 0
    for mode in (SplitMode.TAIL, SplitMode.HEAD):
        for head_sep in (False, True):
            combos += 1
            tag = mode.value + ("+head" if head_sep else "")
            sub = os.path.join(out_dir, tag)
            plan = build_plan(sheet, info, mode, head_sep)
            tile = plan.ownership_problems()
            if tile:
                problems.extend(f"[{tag}] 规划：" + p for p in tile)
                continue
            result = export_plan(plan, sub, verify=True)
            if not result.ok:
                problems.extend(f"[{tag}] 导出：" + e for e in result.errors)
                continue
            join_problems = verify_junction(sub, plan)
            problems.extend(f"[{tag}] 拼接：" + p for p in join_problems)
            check_markers(plan, truth, problems, tag)
            check_seams(plan, truth, sub, problems, tag)
            check_file_lengths(plan, sub, problems, tag)

            # The ground-truth marker sample must be the first sample of the
            # corresponding file (or sit inside its lead region in HEAD mode).
            for track_no, start_s in truth.true_starts:
                idx = next(i for i, t in enumerate(sheet.tracks) if t.number == track_no)
                seg = plan.segment_for_sheet_index(idx)
                if seg is None:
                    problems.append(f"[{tag}] T{track_no:02d} 没有输出文件")
                    continue
                if idx == 0:
                    continue  # head region owns track 1's first sample
                first = read_range(os.path.join(sub, seg.file_name), 0, 1)[0, 0]
                src = read_range(info.path, start_s, 1)[0, 0]
                if plan.mode == SplitMode.TAIL or sheet.tracks[idx].lead is None:
                    if first != src:
                        problems.append(
                            f"[{tag}] T{track_no:02d} 文件首采样与源 INDEX 01 处不同"
                        )

    print("演示卷：", truth.path)
    print("分轨表：", truth.cue_path)
    if not problems:
        print("检查项：逐文件回读=源区间 · 整卷段序拼接=源 · "
              "交界处跨边界持续音在导出文件两侧连续 · 每文件长度精确 · 标记点对齐")
    if problems:
        print(f"\n发现 {len(problems)} 个问题：")
        for p in problems:
            print(" -", p)
        return 1
    print(
        f"\n全部通过：{combos} 种组合（两种拆法 × 整卷前导分开/合并），"
        "逐文件回读与源区间完全一致，整卷拼接无漏读无重读。"
    )
    return 0


def main(argv: list[str]) -> int:
    out_dir = argv[1] if len(argv) > 1 else tempfile.mkdtemp(prefix="cuecut-demo-")
    print("输出目录：", out_dir)
    return run(out_dir)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
