"""加载文件 -> Presentation; 诊断: 初始化缺失 / 截断 / 时间轴重叠或跳变 / 顺序错误 vs 数据缺失."""
from __future__ import annotations

from typing import Dict, List, Optional, Tuple

from .boxes import (Box, FileStructure, parse_file,
                    TFHD_DEFAULT_BASE_IS_MOOF)
from .model import (FragTrack, InitRef, Issue, Presentation, Segment, TrackInfo)

# 时间轴判定容差: 小于该值视为连续 (秒)
EPS_SEC = 0.002


def load_presentation(paths: List[str]) -> Presentation:
    """按给定顺序加载文件.

    第一个含 moov 的文件提供初始化信息; 所有 moof 按文件顺序成为媒体片段.
    单个完整 fmp4 文件同时提供两者.
    """
    init: Optional[InitRef] = None
    segments: List[Segment] = []
    issues: List[Issue] = []

    for path in paths:
        fs = parse_file(path)
        if fs.truncated_box or fs.trailing_bytes:
            # 截断信息挂到该文件最后一个片段上; 若无 moof 则记为全局问题
            pass
        if fs.has_moov and init is None:
            moov = fs.top("moov")[0]
            init = InitRef(path=path, byte_start=0, byte_end=moov.offset + moov.size,
                           tracks=_read_tracks(moov))
        moofs = fs.top("moof")
        if moofs:
            for i, moof in enumerate(moofs):
                # 片段字节范围: 从本 moof 到下一个 moof (或文件尾, 去掉 mfra)
                nxt = moofs[i + 1].offset if i + 1 < len(moofs) else None
                end = nxt if nxt is not None else _fragment_end(fs, moof)
                seg = _build_segment(fs, moof, path, moof.offset, end,
                                     order=len(segments),
                                     truncated=fs.truncated_box and nxt is None)
                segments.append(seg)
        elif not fs.has_moov:
            issues.append(Issue("warning", "init",
                                f"{path}: 既不含 moov 也不含 moof, 未使用"))

    pres = Presentation(init=init, segments=segments, issues=issues)
    _diagnose(pres)
    return pres


def _fragment_end(fs: FileStructure, moof: Box) -> int:
    end = moof.offset + moof.size
    for b in fs.boxes:
        if b.offset >= end and b.type in ("mdat", "free", "styp"):
            end = b.offset + b.size
        elif b.offset >= end and b.type in ("mfra", "sidx"):
            break
        elif b.offset >= end:
            break
    return end


def _read_tracks(moov: Box) -> Dict[int, TrackInfo]:
    tracks: Dict[int, TrackInfo] = {}
    trex_defaults: Dict[int, dict] = {}
    mvex = moov.first("mvex")
    if mvex:
        for trex in mvex.find("trex"):
            trex_defaults[trex.data.get("track_id", 0)] = trex.data
    for trak in moov.find("trak"):
        tkhd = trak.first("tkhd")
        if not tkhd:
            continue
        tid = tkhd.data.get("track_id", 0)
        info = TrackInfo(track_id=tid)
        mdia = trak.first("mdia")
        if mdia:
            mdhd = mdia.first("mdhd")
            hdlr = mdia.first("hdlr")
            if mdhd:
                info.timescale = mdhd.data.get("timescale", 0)
            if hdlr:
                info.handler = hdlr.data.get("handler_type", "?")
            minf = mdia.first("minf")
            stbl = minf.first("stbl") if minf else None
            stsd = stbl.first("stsd") if stbl else None
            if stsd:
                d = stsd.data
                info.codec = d.get("codec", "?")
                info.width = d.get("width", 0)
                info.height = d.get("height", 0)
                info.channels = d.get("channels", 0)
                info.sample_rate = d.get("sample_rate", 0)
        defs = trex_defaults.get(tid)
        if defs:
            info.default_sample_duration = defs.get("default_sample_duration", 0)
            info.default_sample_size = defs.get("default_sample_size", 0)
            info.default_sample_flags = defs.get("default_sample_flags", 0)
        tracks[tid] = info
    return tracks


def _build_segment(fs: FileStructure, moof: Box, path: str,
                   start: int, end: int, order: int, truncated: bool) -> Segment:
    seg = Segment(path=path, byte_start=start, byte_end=end, order=order,
                  truncated=truncated)
    mfhd = moof.first("mfhd")
    if mfhd:
        seg.sequence_number = mfhd.data.get("sequence_number")

    # 片段范围内的 mdat 负载
    for b in fs.boxes:
        if b.type == "mdat" and start <= b.offset < end:
            seg.mdat_payload += b.payload_size
            if b.truncated:
                seg.truncated = True

    sample_order: List[Tuple[int, int]] = []  # (frag_track序号, 样本字节) 按 trun 出现顺序
    for traf in moof.find("traf"):
        tfhd = traf.first("tfhd")
        if not tfhd:
            continue
        tid = tfhd.data.get("track_id", 0)
        tfdt_box = traf.first("tfdt")
        tfdt = tfdt_box.data.get("base_media_decode_time") if tfdt_box else None
        def_dur = tfhd.data.get("default_sample_duration", 0)
        def_size = tfhd.data.get("default_sample_size", 0)
        def_flags = tfhd.data.get("default_sample_flags", 0)
        durations: List[int] = []
        sizes: List[int] = []
        cts: List[int] = []
        sync: List[bool] = []
        ft_idx = len(seg.frag_tracks)
        for trun in traf.find("trun"):
            first_flags = trun.data.get("first_sample_flags")
            for i, s in enumerate(trun.data.get("samples", [])):
                durations.append(s.get("duration", def_dur))
                size = s.get("size", def_size)
                sizes.append(size)
                sample_order.append((ft_idx, size))
                cts.append(s.get("cts_offset", 0))
                fl = s.get("flags", first_flags if i == 0 and first_flags is not None else def_flags)
                sync.append(not ((fl >> 16) & 1))
        seg.frag_tracks.append(FragTrack(
            track_id=tid, tfdt=tfdt, sample_count=len(durations),
            durations=durations, sizes=sizes, cts_offsets=cts, sync=sync,
            data_bytes_needed=sum(sizes)))

    # mdat 数据按 trun 顺序排列: 模拟消耗, 算出每条轨实际覆盖到第几个样本
    avail = seg.mdat_payload
    covered = [0] * len(seg.frag_tracks)
    for ft_idx, size in sample_order:
        if size > avail:
            break
        avail -= size
        covered[ft_idx] += 1
    for i, ft in enumerate(seg.frag_tracks):
        ft.covered_count = covered[i]
    return seg


# ---------------------------------------------------------------- 诊断

def _diagnose(pres: Presentation) -> None:
    issues = pres.issues

    if pres.init is None:
        issues.append(Issue("error", "init",
                            "缺少初始化信息 (moov): 无法识别轨道, 媒体片段无法解码"))
    if not pres.segments:
        issues.append(Issue("error", "init", "没有找到任何媒体片段 (moof)"))
        return

    tracks = pres.tracks
    # 1) 片段级问题: 截断 / 数据不完整 / 未知轨道 / 缺 tfdt
    for seg in pres.segments:
        if seg.truncated:
            msg = f"片段 {seg.label}: 文件被截断 (box 结构不完整)"
            seg.issues.append(msg)
            issues.append(Issue("error", "truncated", msg))
        if seg.mdat_payload < seg_data_needed(seg):
            detail = ", ".join(
                f"轨{ft.track_id} 仅覆盖 {ft.covered_count}/{ft.sample_count} 样本"
                for ft in seg.frag_tracks if ft.covered_count < ft.sample_count)
            msg = (f"片段 {seg.label}: 数据不完整 —— 样本表需要 "
                   f"{seg_data_needed(seg)} 字节, mdat 实际只有 {seg.mdat_payload} 字节"
                   f" (缺 {seg_data_needed(seg) - seg.mdat_payload} 字节"
                   + (f", {detail}" if detail else "") + ")")
            seg.issues.append(msg)
            issues.append(Issue("error", "truncated", msg))
        for ft in seg.frag_tracks:
            if tracks and ft.track_id not in tracks:
                msg = (f"片段 {seg.label}: traf 引用了初始化片段中不存在的轨道 "
                       f"id={ft.track_id} (初始化片段与媒体片段不匹配)")
                seg.issues.append(msg)
                issues.append(Issue("error", "init", msg))
            if ft.tfdt is None:
                msg = f"片段 {seg.label}: 轨道 {ft.track_id} 缺少 tfdt, 无法定位时间轴"
                seg.issues.append(msg)
                issues.append(Issue("warning", "timeline", msg))

    if not tracks:
        return

    # 2) 时间轴: 按给定顺序检查, 再按 tfdt 排序对照, 区分顺序错误与数据缺失
    for tid, tinfo in tracks.items():
        segs = [(s, ft) for s in pres.segments for ft in s.frag_tracks
                if ft.track_id == tid and ft.tfdt is not None]
        if not segs:
            continue
        ts = tinfo.timescale or 1
        order_problems = _timeline_problems(segs, ts)
        sorted_segs = sorted(segs, key=lambda x: x[1].tfdt)
        sorted_problems = _timeline_problems(sorted_segs, ts)

        if order_problems and not sorted_problems:
            issues.append(Issue(
                "warning", "order",
                f"轨道 {tid} ({tinfo.kind_label}): 时间轴乱序 —— 按 tfdt 重排后完全连续, "
                f"文件本身没丢数据, 只是片段顺序错了. 乱序点: "
                + "; ".join(p for p, _ in order_problems)))
        else:
            for prob, gap in order_problems:
                sev = "warning"
                cat = "timeline"
                if "跳变" in prob or "空洞" in prob:
                    cat = "missing"
                elif "重叠" in prob:
                    cat = "overlap"
                issues.append(Issue(sev, cat, f"轨道 {tid} ({tinfo.kind_label}): {prob}"))
            if sorted_problems:
                for prob, gap in sorted_problems:
                    if "空洞" in prob or "跳变" in prob:
                        issues.append(Issue(
                            "error", "missing",
                            f"轨道 {tid} ({tinfo.kind_label}): 即使按 tfdt 正确排序仍存在"
                            f" {prob} —— 中间有片段丢失或录制中断, 不是顺序问题"))
                    elif "重叠" in prob:
                        issues.append(Issue(
                            "warning", "overlap",
                            f"轨道 {tid} ({tinfo.kind_label}): 排序后仍 {prob} —— "
                            f"存在重复/交叠的片段内容"))

    # 3) 覆盖区间 (按 tfdt 排序合并, 只统计真实存在且数据完整的样本)
    for tid, tinfo in tracks.items():
        ts = tinfo.timescale or 1
        ranges = []
        for s in pres.segments:
            for ft in s.frag_tracks:
                if ft.track_id == tid:
                    r = ft.covered_pts_range_sec(ts)
                    if r:
                        ranges.append((r[0], r[1], ft.tfdt))
        ranges.sort(key=lambda x: x[2])
        merged: List[List[float]] = []
        for start, end, _ in ranges:
            if merged and start <= merged[-1][1] + EPS_SEC:
                merged[-1][1] = max(merged[-1][1], end)
            else:
                merged.append([start, end])
        pres.coverage[tid] = [(a, b) for a, b in merged]


def seg_data_needed(seg: Segment) -> int:
    return sum(ft.data_bytes_needed for ft in seg.frag_tracks)


def _timeline_problems(segs, timescale: int) -> List[Tuple[str, float]]:
    """segs: [(Segment, FragTrack)] 按待检查顺序. 返回 (描述, 偏差秒)."""
    problems = []
    prev_end_units = None
    prev_label = None
    for seg, ft in segs:
        r = ft.pts_range_units()
        if r is None:
            continue
        start, end = r
        if prev_end_units is not None:
            eps = max(EPS_SEC * timescale, _median(ft.durations) * 1.5)
            delta = (start - prev_end_units) / timescale
            if start < prev_end_units - eps:
                problems.append((
                    f"片段 {seg.label} 显示时间回退/重叠 {abs(delta):.3f}s "
                    f"(上一片段 {prev_label} 结束于 {prev_end_units / timescale:.3f}s, "
                    f"本片段从 {start / timescale:.3f}s 开始)", delta))
            elif start > prev_end_units + eps:
                problems.append((
                    f"片段 {seg.label} 前出现时间空洞/跳变 {delta:.3f}s "
                    f"({prev_label} 结束于 {prev_end_units / timescale:.3f}s, "
                    f"本片段从 {start / timescale:.3f}s 开始)", delta))
        prev_end_units = end
        prev_label = seg.label
    return problems


def _median(xs: List[int]) -> float:
    if not xs:
        return 0.0
    s = sorted(xs)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2
