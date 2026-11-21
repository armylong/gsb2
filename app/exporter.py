"""片段导出与逐帧核对.

导出用 select 滤镜按帧序号截取 (与取帧同一套计数), 重编码保证帧边界准确;
同时写出帧号清单 CSV. 无损导出 (ffv1) 时可以把成片的每一帧与源素材
逐字节比对, 有损导出只核对帧数和首尾帧号.
"""
from __future__ import annotations

import csv
import hashlib
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from .framesource import FrameSource
from .media import MediaInfo, probe
from .timecode import RateMode, Timecode, format_tc, frame_to_tc, tc_to_frame


@dataclass
class ExportResult:
    out_path: str
    csv_path: str
    first_frame: int          # 源素材帧号 (0 起)
    last_frame: int
    count: int
    first_tc: str
    last_tc: str
    lossless: bool


@dataclass
class VerifyReport:
    ok: bool
    count_expected: int
    count_actual: int
    compared_bytes: bool
    mismatches: list[int] = field(default_factory=list)  # 不一致的导出帧序号
    note: str = ""


def export_segment(info: MediaInfo, out_path: str, in_frame: int, out_frame: int,
                   include_out: bool, mode: RateMode, start_tc: Timecode,
                   lossless: bool = False) -> ExportResult:
    """导出 [in_frame, out_frame] (include_out 决定出点是否包含) 并写帧号清单."""
    last = out_frame if include_out else out_frame - 1
    if last < in_frame:
        raise ValueError("出点必须不早于入点 (不含出点时至少留一帧)")
    count = last - in_frame + 1
    start_frame = tc_to_frame(start_tc, mode)

    fps = info.fps
    vf = f"select='between(n,{in_frame},{last})',setpts=N*{fps.denominator}/{fps.numerator}/TB"
    cmd = ["ffmpeg", "-v", "error", "-y", "-i", info.path, "-vf", vf,
           "-r", str(fps), "-fps_mode", "cfr"]
    if lossless:
        cmd += ["-c:v", "ffv1", "-level", "3"]
    else:
        cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p"]
    cmd += [out_path]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"ffmpeg 导出失败: {r.stderr.strip()[:500]}")

    first_tc = format_tc(frame_to_tc(start_frame + in_frame, mode), mode)
    last_tc = format_tc(frame_to_tc(start_frame + last, mode), mode)
    csv_path = str(Path(out_path).with_suffix(".frames.csv"))
    with open(csv_path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow([f"# 源文件: {info.path}"])
        w.writerow([f"# 制式: {mode.value}; 出点{'包含' if include_out else '不包含'}"])
        w.writerow([f"# 首帧: 源帧号 {in_frame} 时间码 {first_tc}; "
                    f"末帧: 源帧号 {last} 时间码 {last_tc}; 共 {count} 帧"])
        w.writerow(["导出序号", "源帧号(0起)", "源时间码"])
        for i in range(count):
            src_n = in_frame + i
            w.writerow([i, src_n, format_tc(frame_to_tc(start_frame + src_n, mode), mode)])

    return ExportResult(out_path, csv_path, in_frame, last, count, first_tc, last_tc, lossless)


def verify_export(src_info: MediaInfo, result: ExportResult) -> VerifyReport:
    """逐帧核对成片与源素材: 先数帧数, 无损导出再逐帧比对画面字节."""
    exp_info = probe(result.out_path)
    actual = exp_info.frame_count
    if actual != result.count:
        return VerifyReport(False, result.count, actual or -1, False,
                            note=f"成片帧数 {actual} 与预期 {result.count} 不符")
    if not result.lossless:
        return VerifyReport(True, result.count, actual, False,
                            note="有损导出: 已核对帧数与首尾帧号, 画面内容请抽帧人工比对")
    mismatches = []
    with FrameSource(src_info) as src, FrameSource(exp_info) as exp:
        for i in range(result.count):
            a = src.frame(result.first_frame + i)
            b = exp.frame(i)
            if a is None or b is None:
                mismatches.append(i)
                continue
            if hashlib.sha1(a).digest() != hashlib.sha1(b).digest():
                mismatches.append(i)
            if len(mismatches) > 20:
                break
    ok = not mismatches
    note = "无损导出逐帧比对: 全部一致" if ok else f"无损导出逐帧比对: {len(mismatches)} 帧不一致"
    return VerifyReport(ok, result.count, actual, True, mismatches, note)
