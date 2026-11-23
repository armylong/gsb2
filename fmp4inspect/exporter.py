"""导出可独立播放的连续范围, 并读回核对实际覆盖."""
from __future__ import annotations

import json
import os
import subprocess
import tempfile
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from .analyze import EPS_SEC
from .model import Presentation, Segment


@dataclass
class ExportReport:
    out_path: str
    requested: Tuple[float, float]
    segments_used: List[str] = field(default_factory=list)
    reencode: bool = False
    # 读回结果: codec_type -> (min_pts, max_end, packet_count)
    achieved: Dict[str, Tuple[float, float, int]] = field(default_factory=dict)
    ok: bool = False
    messages: List[str] = field(default_factory=list)


def common_coverage(pres: Presentation) -> List[Tuple[float, float]]:
    """所有轨道共同覆盖的连续区间 (缺失片段不计入)."""
    if not pres.coverage:
        return []
    itvs = None
    for tid, cov in pres.coverage.items():
        if itvs is None:
            itvs = list(cov)
        else:
            itvs = _intersect(itvs, cov)
    return itvs or []


def _intersect(a, b):
    out = []
    for s1, e1 in a:
        for s2, e2 in b:
            s, e = max(s1, s2), min(e1, e2)
            if e - s > EPS_SEC:
                out.append((s, e))
    return out


def check_range_covered(pres: Presentation, start: float, end: float
                        ) -> Dict[int, List[Tuple[float, float]]]:
    """返回每条轨在 [start,end] 内未被覆盖的洞; 空 dict 表示全覆盖."""
    holes: Dict[int, List[Tuple[float, float]]] = {}
    for tid, cov in pres.coverage.items():
        th = []
        cursor = start
        for s, e in sorted(cov):
            if e <= cursor + EPS_SEC:
                continue
            if s > cursor + EPS_SEC:
                th.append((cursor, min(s, end)))
            cursor = max(cursor, e)
            if cursor >= end - EPS_SEC:
                break
        if cursor < end - EPS_SEC:
            th.append((cursor, end))
        if th:
            holes[tid] = th
    return holes


def _segments_for_range(pres: Presentation, start: float, end: float) -> List[Segment]:
    """与 [start,end] 有交集的片段, 按 tfdt 排序."""
    picked = []
    for seg in pres.segments:
        best_tfdt = None
        overlaps = False
        for ft in seg.frag_tracks:
            tinfo = pres.tracks.get(ft.track_id)
            if not tinfo or not tinfo.timescale:
                continue
            r = ft.pts_range_sec(tinfo.timescale)
            if r and r[1] > start - EPS_SEC and r[0] < end + EPS_SEC:
                overlaps = True
            if ft.tfdt is not None:
                best_tfdt = ft.tfdt if best_tfdt is None else min(best_tfdt, ft.tfdt)
        if overlaps:
            picked.append((best_tfdt or 0, seg.order, seg))
    picked.sort(key=lambda x: (x[0], x[1]))
    return [s for _, _, s in picked]


def export_range(pres: Presentation, start: float, end: float, out_path: str,
                 reencode: bool = False) -> ExportReport:
    report = ExportReport(out_path=out_path, requested=(start, end),
                          reencode=reencode)
    if pres.init is None:
        report.messages.append("错误: 缺少初始化片段, 无法导出")
        return report
    if end <= start:
        report.messages.append("错误: 结束时间必须大于起始时间")
        return report

    holes = check_range_covered(pres, start, end)
    if holes:
        for tid, th in holes.items():
            for s, e in th:
                report.messages.append(
                    f"错误: 轨道 {tid} 在 [{s:.3f}s, {e:.3f}s] 没有数据 "
                    f"(片段缺失), 该范围不能作为连续区间导出")
        return report

    segs = _segments_for_range(pres, start, end)
    if not segs:
        report.messages.append("错误: 范围内没有任何片段")
        return report
    report.segments_used = [s.label for s in segs]

    tmpdir = tempfile.mkdtemp(prefix="fmp4exp_")
    concat = os.path.join(tmpdir, "concat.mp4")
    with open(concat, "wb") as f:
        f.write(pres.read_init_bytes())
        for s in segs:
            f.write(pres.read_segment_bytes(s))

    cmd = ["ffmpeg", "-y", "-v", "error", "-ss", f"{start:.6f}",
           "-to", f"{end:.6f}", "-i", concat, "-map", "0"]
    if reencode:
        cmd += ["-c:v", "libx264", "-c:a", "aac"]
    else:
        cmd += ["-c", "copy"]
    cmd += ["-avoid_negative_ts", "make_zero", out_path]
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        report.messages.append("ffmpeg 导出失败: " +
                               r.stderr.decode("utf-8", "replace")[:500])
        return report

    # 读回核对: 导出文件时间轴已重置为 0, 因此按"时长"与请求区间长度核对
    report.achieved = readback_range(out_path)
    req_dur = end - start
    ok = True
    for ctype, (a_s, a_e, n) in report.achieved.items():
        dur = a_e - a_s
        if a_s > 0.5:
            report.messages.append(
                f"警告: {ctype} 输出起点 {a_s:.3f}s 未归零")
            ok = False
        if dur < req_dur - 0.15:
            report.messages.append(
                f"警告: {ctype} 实际覆盖时长 {dur:.3f}s 短于请求 "
                f"{req_dur:.3f}s (缺少末尾数据)")
            ok = False
    report.ok = ok
    report.messages.insert(
        0, f"导出完成: {out_path} (请求 [{start:.3f}s, {end:.3f}s] 长 {req_dur:.3f}s, "
           f"{'重编码' if reencode else '流拷贝'}, 输出时间轴从 0 开始)")
    return report


def readback_range(path: str) -> Dict[str, Tuple[float, float, int]]:
    """读回文件, 返回 codec_type -> (最早PTS, 最晚包结束, 包数)."""
    r = subprocess.run(
        ["ffprobe", "-v", "error", "-show_packets", "-of", "json", path],
        capture_output=True)
    out: Dict[str, Tuple[float, float, int]] = {}
    if r.returncode != 0:
        return out
    try:
        data = json.loads(r.stdout.decode("utf-8", "replace"))
    except json.JSONDecodeError:
        return out
    acc: Dict[str, List[float]] = {}
    cnt: Dict[str, int] = {}
    for p in data.get("packets", []):
        ctype = p.get("codec_type", "?")
        pts = p.get("pts_time")
        if pts is None:
            continue
        pts = float(pts)
        dur = float(p.get("duration_time", 0) or 0)
        if ctype not in acc:
            acc[ctype] = [pts, pts + dur]
            cnt[ctype] = 0
        acc[ctype][0] = min(acc[ctype][0], pts)
        acc[ctype][1] = max(acc[ctype][1], pts + dur)
        cnt[ctype] += 1
    return {c: (v[0], v[1], cnt[c]) for c, v in acc.items()}
