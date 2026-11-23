"""命令行入口: analyze / export / gen-test / gui."""
from __future__ import annotations

import argparse
import sys
from typing import List

from .analyze import load_presentation
from .exporter import common_coverage, export_range
from .model import Presentation


def _fmt_track(t) -> str:
    parts = [f"id={t.track_id}", t.kind_label, t.codec,
             f"timescale={t.timescale}"]
    if t.handler == "vide" and t.width:
        parts.append(f"{t.width}x{t.height}")
    if t.handler == "soun" and t.sample_rate:
        parts.append(f"{t.sample_rate}Hz/{t.channels}ch")
    return " ".join(parts)


def print_presentation(pres: Presentation) -> None:
    print("== 轨道 ==")
    if pres.init:
        print(f"初始化: {pres.init.path} [字节 {pres.init.byte_start}..{pres.init.byte_end}]")
        for t in pres.tracks.values():
            print(f"  {_fmt_track(t)}")
    else:
        print("  (缺少初始化信息 moov)")

    print("== 片段 (按给定顺序) ==")
    tracks = pres.tracks
    for seg in pres.segments:
        parts = [f"#{seg.order} {seg.path}",
                 f"seq={seg.sequence_number}"]
        for ft in seg.frag_tracks:
            tinfo = tracks.get(ft.track_id)
            ts = tinfo.timescale if tinfo else 0
            r = ft.pts_range_sec(ts) if ts else None
            rng = f"[{r[0]:.3f}s..{r[1]:.3f}s]" if r else "[时间未知]"
            parts.append(f"轨{ft.track_id}: {ft.sample_count}样本 {rng}")
        if seg.truncated:
            parts.append("!!截断!!")
        print("  " + " | ".join(parts))
        for iss in seg.issues:
            print(f"      ! {iss}")

    print("== 覆盖区间 (只统计真实存在的片段) ==")
    for tid, cov in pres.coverage.items():
        t = tracks.get(tid)
        label = f"轨{tid}({t.kind_label})" if t else f"轨{tid}"
        ivs = ", ".join(f"[{a:.3f}s..{b:.3f}s]" for a, b in cov)
        print(f"  {label}: {ivs}")
    cc = common_coverage(pres)
    if len(pres.coverage) > 1:
        ivs = ", ".join(f"[{a:.3f}s..{b:.3f}s]" for a, b in cc)
        print(f"  共同覆盖: {ivs}")

    print("== 诊断 ==")
    if not pres.issues:
        print("  未发现问题")
    for i in pres.issues:
        mark = "✗" if i.severity == "error" else "△"
        print(f"  {mark} [{i.category}] {i.message}")


def cmd_analyze(args) -> int:
    pres = load_presentation(args.files)
    print_presentation(pres)
    return 1 if any(i.severity == "error" for i in pres.issues) else 0


def cmd_export(args) -> int:
    pres = load_presentation(args.files)
    rep = export_range(pres, args.start, args.end, args.output,
                       reencode=args.reencode)
    for m in rep.messages:
        print(m)
    print(f"使用片段: {', '.join(rep.segments_used)}")
    for ctype, (a, b, n) in rep.achieved.items():
        print(f"读回 {ctype}: [{a:.3f}s..{b:.3f}s] {n} 包")
    return 0 if rep.ok else 1


def cmd_gen_test(args) -> int:
    from .testgen import generate_materials, self_check
    mats = generate_materials(args.outdir, source=args.source,
                              duration=args.duration)
    for k, v in mats.items():
        if isinstance(v, list):
            print(f"{k}: {len(v)} 个文件 -> {v[0].rsplit('/', 1)[0]}")
        else:
            print(f"{k}: {v}")
    print("-- 自检 --")
    for line in self_check(args.outdir):
        print(line)
    return 0


def cmd_gui(args) -> int:
    from .app import run_gui
    return run_gui(args.files)


def main(argv: List[str] = None) -> int:
    ap = argparse.ArgumentParser(
        prog="fmp4inspect",
        description="分片 MP4 本地检查器: 轨道/片段/样本时间轴诊断, 可解码预览, 连续范围导出")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("analyze", help="分析文件 (单文件 fmp4 或 init+媒体片段)")
    p.add_argument("files", nargs="+")
    p.set_defaults(func=cmd_analyze)

    p = sub.add_parser("export", help="导出连续范围为可独立播放的 mp4")
    p.add_argument("files", nargs="+", help="init 与媒体片段 (按顺序)")
    p.add_argument("--start", type=float, required=True)
    p.add_argument("--end", type=float, required=True)
    p.add_argument("-o", "--output", required=True)
    p.add_argument("--reencode", action="store_true",
                   help="重编码以保证精确边界 (默认流拷贝, 起点对齐关键帧)")
    p.set_defaults(func=cmd_export)

    p = sub.add_parser("gen-test", help="生成正常/换序/截断测试材料并自检")
    p.add_argument("outdir")
    p.add_argument("--source", help="已有短片; 缺省用 ffmpeg 生成测试片")
    p.add_argument("--duration", type=float, default=6.0)
    p.set_defaults(func=cmd_gen_test)

    p = sub.add_parser("gui", help="启动图形界面")
    p.add_argument("files", nargs="*")
    p.set_defaults(func=cmd_gui)

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
