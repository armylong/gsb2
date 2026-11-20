"""命令行入口：检测、生成测试片、自检。"""

from __future__ import annotations

import argparse
import os
import sys
import tempfile
from typing import List, Optional, Sequence

from .annotations import AnnotationStore, export_report
from .config import DetectionParams
from .detect import AnalysisResult, analyze, format_timecode, summarize
from .sample import generate_sample
from .timeline import FFmpegError, read_timeline, require_binary

DEFAULT_SIMILARITY = DetectionParams.similarity


def _params_from_args(args: argparse.Namespace) -> DetectionParams:
    return DetectionParams(
        similarity=args.similarity,
        min_duration_ms=args.min_duration_ms,
        hold_duration_ms=args.hold_duration_ms,
        drift_tolerance=args.drift_tolerance,
        context_before=args.context_before,
        context_after=args.context_after,
        black_luma=args.black_luma,
        static_hint_ms=args.static_hint_ms,
        analysis_width=args.analysis_width,
        tile=args.tile,
    )


def _print_result(result: AnalysisResult) -> None:
    stats = summarize(result)
    tl = result.timeline
    print(
        f"视频: {tl.path}\n"
        f"分辨率: {tl.width}x{tl.height}  帧数: {tl.frame_count}  "
        f"时长: {tl.duration:.3f}s  {'VFR(不等间隔)' if tl.is_vfr else 'CFR(等间隔)'}"
    )
    print(
        f"命中: {stats['total']} 段 (计入问题 {stats['active']} 段 / "
        f"已标注忽略 {stats['ignored']} 段), "
        f"冻结 {stats['by_kind']['freeze']} / 静态 {stats['by_kind']['static']} / "
        f"黑场 {stats['by_kind']['black']}"
    )
    if not result.segments:
        print("没有检测到持续时长达到阈值的停住画面。")
        return
    header = (
        f"{'#':>2}  {'开始':>12}  {'结束':>12}  {'时长ms':>7}  {'帧区间':>11}  "
        f"{'相似度':>6}  {'自动分类':<8}  {'标注':<8}  备注"
    )
    print(header)
    print("-" * len(header))
    for i, seg in enumerate(result.segments, 1):
        print(
            f"{i:>2}  {format_timecode(seg.start_time):>12}  "
            f"{format_timecode(seg.end_time):>12}  {seg.duration_ms:>7}  "
            f"{seg.frame_range_text:>11}  {seg.min_step_similarity:>6.4f}  "
            f"{seg.kind_display:<8}  {seg.label_display:<8}  {seg.note}"
        )
    if stats["ignored"]:
        print(f"\n注: 已标注为静态/黑场/忽略的 {stats['ignored']} 段不计入问题。")
    if result.warning:
        print(f"警告: {result.warning}")
    ctx = result.params.context_before
    print(f"\n每段前后各检查 {ctx} 帧，已随导出截图一并给出。")


def cmd_detect(args: argparse.Namespace) -> int:
    params = _params_from_args(args)
    timeline = read_timeline(args.video)
    store = AnnotationStore.load(args.video, args.annotations)
    result = analyze(timeline, params)
    store.apply(result.segments)

    print(f"参数: 相似度≥{params.similarity}  最短时长≥{params.min_duration_ms}ms  "
          f"漂移≤{params.effective_drift_tolerance:.4f}")
    _print_result(result)

    if args.save_annotations:
        path = store.save(args.video, result)
        print(f"\n标注已保存: {path}")
    if args.export:
        paths = export_report(
            result,
            args.export,
            snapshots=not args.no_snapshots,
            clips=args.clips,
        )
        print(f"\n已导出: {paths['csv']}")
        print(f"        {paths['json']}")
        if paths["snapshots"]:
            print(f"        截图 {len(paths['snapshots'])} 张 -> {os.path.dirname(paths['snapshots'][0])}")
        if paths["clips"]:
            print(f"        切片 {len(paths['clips'])} 个 -> {os.path.dirname(paths['clips'][0])}")
    return 0


def cmd_sample(args: argparse.Namespace) -> int:
    out_dir = args.out or os.path.join(tempfile.gettempdir(), "freeze_detect_sample")
    params = _params_from_args(args)
    info = generate_sample(out_dir, params_snapshot=params.as_dict())
    print(f"已生成测试片: {info['video']}")
    print(f"已生成标注真值: {info['truth']}")
    print(f"帧数 {info['frames']}，时长 {info['truth_data']['duration_ms']}ms，"
          f"{'VFR' if info['truth_data']['is_vfr'] else 'CFR'}")
    if args.analyze:
        timeline = info["timeline"]
        result = analyze(timeline, params)
        _print_result(result)
        if args.export:
            paths = export_report(result, args.export, snapshots=True, clips=args.clips)
            print(f"\n已导出: {paths['csv']}")
            print(f"        {paths['json']}")
            if paths["snapshots"]:
                print(f"        截图 {len(paths['snapshots'])} 张 -> "
                      f"{os.path.dirname(paths['snapshots'][0])}")
            if paths["clips"]:
                print(f"        切片 {len(paths['clips'])} 个 -> "
                      f"{os.path.dirname(paths['clips'][0])}")
    return 0


# ---------------------------------------------------------------------------
# 自检：生成测试片 -> 检测 -> 对照真值 -> 验证标注保留/时间范围/导出
# ---------------------------------------------------------------------------


def _match_detected(truth: dict, result: AnalysisResult) -> List[str]:
    errors: List[str] = []
    expected = [e for e in truth["segments"] if e["expect_detect"]]
    forbidden = [e for e in truth["segments"] if not e["expect_detect"]]

    for exp in expected:
        found = None
        for seg in result.segments:
            if seg.start_frame == exp["start_frame"] and seg.end_frame == exp["end_frame"]:
                found = seg
                break
        if found is None:
            # 允许首尾各 1 帧的边界误差，但时间必须对得上
            for seg in result.segments:
                if (
                    abs(seg.start_frame - exp["start_frame"]) <= 1
                    and abs(seg.end_frame - exp["end_frame"]) <= 1
                ):
                    found = seg
                    break
        if found is None:
            got = [
                f"{s.start_frame}-{s.end_frame}"
                for s in result.segments
                if s.start_frame <= exp["end_frame"] and s.end_frame >= exp["start_frame"]
            ]
            errors.append(
                f"期望段 {exp['name']} 帧 {exp['start_frame']}-{exp['end_frame']} 未检出"
                + (f"（重叠的有 {got}）" if got else "")
            )
            continue
        if found.auto_kind != exp["expect_auto_kind"]:
            errors.append(
                f"段 {exp['name']} 分类应为 {exp['expect_auto_kind']}，"
                f"实际 {found.auto_kind}"
            )
        # 时间范围必须以逐帧真实时长为准（误差 <= 1 帧时长）
        allowed = max(0.002, 1.5 * max(result.timeline.durations[max(found.start_frame - 1, 0)], 0.001))
        if abs(found.start_ms - exp["start_ms"]) > allowed * 1000:
            errors.append(
                f"段 {exp['name']} 开始时间误差过大: 期望 {exp['start_ms']}ms，"
                f"实际 {found.start_ms}ms"
            )
        if abs(found.end_ms - exp["end_ms"]) > allowed * 1000:
            errors.append(
                f"段 {exp['name']} 结束时间误差过大: 期望 {exp['end_ms']}ms，"
                f"实际 {found.end_ms}ms"
            )

    for exp in forbidden:
        for seg in result.segments:
            overlap = min(seg.end_frame, exp["end_frame"]) - max(
                seg.start_frame, exp["start_frame"]
            )
            if overlap >= 0 and seg.duration_ms >= 400:
                errors.append(
                    f"不应检出的 {exp['name']}(帧 {exp['start_frame']}-{exp['end_frame']}) "
                    f"却命中了 {seg.start_frame}-{seg.end_frame}"
                )
                break
    return errors


def cmd_selftest(args: argparse.Namespace) -> int:
    """一条命令跑通：生成样例 -> 检测 -> 对照真值 -> 标注保留 -> 导出。"""
    require_binary("ffmpeg")
    require_binary("ffprobe")
    failures: List[str] = []
    out_dir = args.out or tempfile.mkdtemp(prefix="freeze_selftest_")
    os.makedirs(out_dir, exist_ok=True)

    print(f"[1/6] 生成合成测试片 -> {out_dir}")
    params = DetectionParams()
    info = generate_sample(out_dir, params_snapshot=params.as_dict())
    truth = info["truth_data"]
    tl = info["timeline"]
    print(
        f"      {info['frames']} 帧 / {truth['duration_ms']}ms / "
        f"{'VFR' if truth['is_vfr'] else 'CFR'} / "
        f"逐帧时长精确帧数 {truth['timing_exact_frames']}/{tl.frame_count}"
    )
    if not truth["is_vfr"]:
        failures.append("测试片应为不等间隔(VFR)，但检测到 CFR")
    if truth["duration_ms"] != int(round(tl.duration * 1000)):
        failures.append("真值时长与逐帧时长之和不一致")

    print("[2/6] 检测并对照真值")
    result = analyze(tl, params)
    errors = _match_detected(truth, result)
    failures.extend(errors)
    for seg in result.segments:
        print(
            f"      {seg.start_frame:>3}-{seg.end_frame:<3} "
            f"{format_timecode(seg.start_time)} → {format_timecode(seg.end_time)} "
            f"({seg.duration_ms}ms) {seg.kind_display} "
            f"sim={seg.min_step_similarity:.5f}"
        )
    if result.warning:
        failures.append(f"检测警告: {result.warning}")

    print("[3/6] 校验开头/结尾冻结的时间范围来自逐帧时长")
    head = next((s for s in result.segments if s.start_frame == 0), None)
    tail = next(
        (s for s in result.segments if s.end_frame == tl.frame_count - 1), None
    )
    if head is None:
        failures.append("开头冻结未检出")
    elif head.start_ms != 0:
        failures.append(f"开头冻结开始时间应为 0ms，实际 {head.start_ms}ms")
    if tail is None:
        failures.append("结尾冻结未检出")
    else:
        expected_end = int(round(tl.frame_end(tail.end_frame) * 1000))
        if abs(tail.end_ms - expected_end) > 2:
            failures.append(
                f"结尾冻结结束时间应为 {expected_end}ms，实际 {tail.end_ms}ms"
            )
        if tail.end_frame != tl.frame_count - 1:
            failures.append("结尾冻结没有覆盖到最后一帧")

    print("[4/6] 人工标注静态/黑场，并验证复检保留标注")
    auto_static = [s for s in result.segments if s.auto_kind == "static"]
    auto_black = [s for s in result.segments if s.auto_kind == "black"]
    if not auto_static or not auto_black:
        failures.append("样例中未检出静态画面/黑场，无法验证标注功能")
    else:
        store = AnnotationStore.load(info["video"])
        store.set(auto_static[0], "static", "演示: 静态画面跳过")
        store.set(auto_black[0], "black", "演示: 黑场跳过")
        store.save(info["video"], result)

        # 复检：换一套参数(更严格)，标注必须仍在
        recheck_params = DetectionParams(
            similarity=0.9975, min_duration_ms=600, drift_tolerance=0.004
        )
        recheck = analyze(tl, recheck_params)
        reloaded = AnnotationStore.load(info["video"])
        hits = reloaded.apply(recheck.segments)
        if hits < 2:
            failures.append(f"复检时标注未保留（命中 {hits} 段，期望 2 段）")
        static_now = next(
            (s for s in recheck.segments if s.auto_kind == "static"), None
        )
        black_now = next((s for s in recheck.segments if s.auto_kind == "black"), None)
        if static_now is None or not static_now.ignored:
            failures.append("复检后静态段没有被标注为忽略")
        if black_now is None or not black_now.ignored:
            failures.append("复检后黑场段没有被标注为忽略")
        if static_now is not None:
            print(
                f"      复检参数下仍有 {len(recheck.segments)} 段，"
                f"标注命中 {hits} 段；静态段已忽略={static_now.ignored}"
            )

    print("[5/6] 检查最短持续时间与慢速变化阈值")
    short = next(
        (s for s in result.segments if 316 <= s.start_frame <= 319), None
    )
    if short is not None:
        failures.append("4 帧的短暂停顿不应被检出")
    slow_hits = [
        s
        for s in result.segments
        if s.auto_kind == "freeze" and 171 <= s.start_frame <= 260
    ]
    if slow_hits:
        failures.append(
            f"慢速变化被误判为冻结: {[(s.start_frame, s.end_frame) for s in slow_hits]}"
        )

    print("[6/6] 导出 CSV/JSON/帧截图并抽查结果")
    export_dir = os.path.join(out_dir, "report")
    paths = export_report(result, export_dir, snapshots=True, clips=False)
    for key in ("csv", "json"):
        if not os.path.exists(paths[key]):
            failures.append(f"导出文件缺失: {paths[key]}")
    if len(paths["snapshots"]) < len(result.segments):
        failures.append("截图数量少于命中段数")
    else:
        biggest = max(paths["snapshots"], key=os.path.getsize)
        if os.path.getsize(biggest) < 1024:
            failures.append("截图文件疑似为空")

    print("")
    if failures:
        print(f"自检失败：{len(failures)} 项")
        for item in failures:
            print(f"  - {item}")
        return 1
    print(
        "自检通过：VFR 逐帧时长、开头/结尾冻结、插入冻结、慢速变化排除、"
        "最短时长、静态/黑场标注复检、导出均正常。"
    )
    print(f"产物目录: {out_dir}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="freeze-detect",
        description="视频卡顿冻结检测（逐帧真实展示时长 + 相似度分段）",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    def add_params(p: argparse.ArgumentParser) -> None:
        p.add_argument("--similarity", type=float, default=DEFAULT_SIMILARITY,
                       help="相邻帧相似度阈值(0~1]，越大越严格，默认 0.995")
        p.add_argument("--min-duration-ms", type=int, default=500,
                       help="最短持续时长(毫秒)，默认 500")
        p.add_argument("--hold-duration-ms", type=int, default=200,
                       help="单帧长驻留阈值(毫秒)，默认 200")
        p.add_argument("--drift-tolerance", type=float, default=None,
                       help="相对锚点帧的累计漂移容差，默认 2.5*(1-similarity)")
        p.add_argument("--context-before", type=int, default=4,
                       help="每段之前检查/导出的帧数，默认 4")
        p.add_argument("--context-after", type=int, default=4,
                       help="每段之后检查/导出的帧数，默认 4")
        p.add_argument("--black-luma", type=float, default=0.08,
                       help="黑场判定亮度上限(0~1)，默认 0.08")
        p.add_argument("--static-hint-ms", type=int, default=2000,
                       help="多少毫秒以上的停住画面自动提示为静态画面，默认 2000")
        p.add_argument("--analysis-width", type=int, default=240,
                       help="分析缩放宽度，默认 240")
        p.add_argument("--tile", type=int, default=8,
                       help="分块特征边长(像素)，默认 8")

    det = sub.add_parser("detect", help="检测一个视频")
    det.add_argument("video", help="视频文件路径")
    add_params(det)
    det.add_argument("--annotations", default=None,
                     help="标注文件路径，默认与视频同名的 .annotations.json")
    det.add_argument("--save-annotations", action="store_true",
                     help="把当前标注写回标注文件")
    det.add_argument("--export", default=None, metavar="DIR",
                     help="导出目录(CSV/JSON/截图)")
    det.add_argument("--no-snapshots", action="store_true",
                     help="导出时不生成截图")
    det.add_argument("--clips", action="store_true",
                     help="同时导出每段的视频切片")
    det.set_defaults(func=cmd_detect)

    smp = sub.add_parser("sample", help="生成合成的测试片（含插入冻结/慢速变化）")
    smp.add_argument("--out", default=None, help="输出目录")
    add_params(smp)
    smp.add_argument("--analyze", action="store_true", help="生成后立即检测")
    smp.add_argument("--export", default=None, metavar="DIR",
                     help="检测后导出到此目录")
    smp.add_argument("--clips", action="store_true", help="同时导出切片")
    smp.set_defaults(func=cmd_sample)

    st = sub.add_parser("selftest", help="一条命令完成生成/检测/标注/导出验证")
    st.add_argument("--out", default=None, help="产物目录(默认用临时目录)")
    st.set_defaults(func=cmd_selftest)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    # 无参数时直接启动图形界面
    if not argv:
        from .gui import run_gui

        return run_gui()
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except (FFmpegError, ValueError) as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
