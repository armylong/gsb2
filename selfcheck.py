#!/usr/bin/env python3
"""端到端自检: 生成各档位测试片 -> 独立识别 -> 与计划匹配 -> 校验结论.

用法:
    python selfcheck.py            # 全部档位
    python selfcheck.py --quick    # 只跑核心档位
运行不依赖 pytest; 退出码 0 表示全部通过.
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
import tempfile
import traceback
from typing import Any

from syncmark import analyzer, export, generator, model


class Case:
    def __init__(self, profile: str, expect: dict[str, Any], desc: str):
        self.profile = profile
        self.expect = expect
        self.desc = desc


CASES = [
    Case("clean", {"matched": 12, "missing": 0, "extra": 0,
                   "has_global_offset": False, "has_local_issue": False},
         "基线: 全部匹配, 无偏移"),
    Case("offset", {"matched": 12, "missing": 0, "extra": 0,
                    "has_global_offset": True, "has_local_issue": False,
                    "audio_offset_ms": 120.0},
         "整体音频偏移 +120ms: 只报整体偏移, 不报个别问题"),
    Case("offset_early", {"matched": 12, "missing": 0, "extra": 0,
                          "has_global_offset": True, "has_local_issue": False,
                          "audio_offset_ms": -90.0},
                          "整体音频偏移 -90ms"),
    Case("missing_first", {"matched": 11, "missing": 1, "extra": 0,
                           "has_global_offset": True, "has_local_issue": True},
         "首段缺失 + 整体偏移: 1 号标记未找到"),
    Case("repeat_mid", {"matched": 12, "missing": 0, "extra": 1,
                        "has_global_offset": False, "has_local_issue": True},
         "中部重复一次: 多出 1 个计划外标记"),
    Case("event_shift", {"matched": 12, "missing": 0, "extra": 0,
                         "has_global_offset": False, "has_local_issue": True},
         "个别事件偏移: 只有 7 号标记被判为个别问题"),
    Case("glitch", {"matched": 12, "missing": 0, "extra": 0,
                    "has_global_offset": False, "has_local_issue": False,
                    "merged_duplicate": True},
         "短暂重复帧: 不产生第二次闪光"),
    Case("full", {"matched": 10, "missing": 2, "extra": 1,
                  "has_global_offset": True, "has_local_issue": True,
                  "boundary_missing_tail": True},
         "综合故障: 首尾各缺一个, 中部多一个, 声音整体偏"),
    Case("edge_zero", {"matched": 12, "missing": 0, "extra": 0,
                       "has_global_offset": False, "first_frame": 0.0},
         "边界: 首个标记正好在第 0 帧"),
    Case("edge_truncated", {"matched": 11, "missing": 1, "extra": 0,
                            "has_global_offset": False, "has_local_issue": True,
                            "boundary_missing_tail": True},
         "边界: 末尾刚好少一段"),
]

QUICK = {"clean", "offset", "missing_first", "repeat_mid", "event_shift", "full"}


def run_case(c: Case, tmpdir: str) -> tuple[bool, list[str]]:
    film = os.path.join(tmpdir, f"{c.profile}.mp4")
    msgs: list[str] = []

    def fail(msg: str) -> None:
        msgs.append("FAIL " + msg)

    plan = generator.make_fault_profile(film, c.profile)
    analysis = analyzer.analyze_film(film)
    report = analyzer.match_plan(analysis, plan)
    summed = report["summary"]

    for key in ("matched", "missing", "extra"):
        if key in c.expect and summed[key] != c.expect[key]:
            fail(f"{key}: 期望 {c.expect[key]}, 实际 {summed[key]}")

    if "has_global_offset" in c.expect and summed["has_global_offset"] != c.expect["has_global_offset"]:
        fail(f"has_global_offset: 期望 {c.expect['has_global_offset']}, 实际 {summed['has_global_offset']}")
    if "has_local_issue" in c.expect and summed["has_local_issue"] != c.expect["has_local_issue"]:
        fail(f"has_local_issue: 期望 {c.expect['has_local_issue']}, 实际 {summed['has_local_issue']}")

    if "audio_offset_ms" in c.expect:
        got = report["sync"]["audio"]
        if not got["applicable"]:
            fail(f"声音整体偏移未上报: {got}")
        elif abs(got["seconds"] * 1000 - c.expect["audio_offset_ms"]) > 12.0:
            fail(f"声音整体偏移 期望约 {c.expect['audio_offset_ms']}ms, 实际 {got['seconds'] * 1000:.1f}ms")

    if c.expect.get("merged_duplicate"):
        merged = [d for d in report["detections"]["video"] if d["duplicate_frames"]]
        if len(merged) != 1 or merged[0]["merged_runs"] < 2:
            fail(f"重复帧没有被合并, 检出 {len(report['detections']['video'])} 段")
        if report["summary"]["extra"] != 0:
            fail("重复帧被当成了第二个闪光")

    if "first_frame" in c.expect:
        b = report["boundary"]
        ff = b.get("first_frame_time")
        if ff is None or abs(float(ff) - c.expect["first_frame"]) > 1e-6:
            fail(f"第一帧时刻不匹配: {ff}")
        start = b["items"][0]
        if not start.get("passed"):
            fail(f"起点检查未通过: {start}")
        if start.get("first_detected_frame") != 0:
            fail(f"首标记未检出于第 0 帧: {start}")

    if c.expect.get("boundary_missing_tail"):
        b = report["boundary"]
        if not b.get("ends_with_missing_segment"):
            fail("末尾缺段没有被识别出来")
        tail = next(i for i in b["items"] if i["name"] == "末尾")
        if "ends_abruptly" not in tail or not tail["ends_abruptly"]:
            fail(f"末尾形态判断不足: {tail}")

    # 独立识别不得依赖计划: 用一份空计划跑一遍, 检出数量必须一致
    blank = analyzer.match_plan(
        analysis,
        {"markers": [], "video": None, "audio": None, "faults": {}, "plan_path": None})
    if len(blank["detections"]["video"]) != len(report["detections"]["video"]):
        fail("空计划下画面检出数不同")
    if blank["summary"]["matched"] != 0:
        fail("空计划不应有匹配")
    export.export_html(blank, os.path.join(tmpdir, f"{c.profile}.noplan.html"))
    export.export_markdown(blank, os.path.join(tmpdir, f"{c.profile}.noplan.md"))

    # 报告能重新读回
    rpath = os.path.join(tmpdir, f"{c.profile}.syncreport.json")
    model.write_json_atomic(rpath, report)
    back = model.read_json(rpath)
    if back.get("schema") != model.SCHEMA_REPORT or len(back.get("events", [])) != len(report["events"]):
        fail("报告重新读取后不一致")

    # 导出对照表
    export.export_html(report, os.path.join(tmpdir, f"{c.profile}.html"))
    export.export_markdown(report, os.path.join(tmpdir, f"{c.profile}.md"))
    if not os.path.getsize(os.path.join(tmpdir, f"{c.profile}.html")):
        fail("HTML 导出为空")

    analysis.release()
    return (not msgs), msgs


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--keep", action="store_true", help="保留生成的短片")
    args = ap.parse_args(argv)

    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        print("缺少 ffmpeg/ffprobe", file=sys.stderr)
        return 2

    tmpdir = tempfile.mkdtemp(prefix="syncmark-selfcheck-")
    failures = 0
    try:
        cases = [c for c in CASES if (not args.quick or c.profile in QUICK)]
        for i, c in enumerate(cases, 1):
            print(f"[{i}/{len(cases)}] {c.profile:15s} {c.desc} … ", end="", flush=True)
            try:
                ok, msgs = run_case(c, tmpdir)
            except Exception:  # noqa: BLE001
                ok = False
                msgs = ["EXCEPTION\n" + traceback.format_exc()]
            print("通过" if ok else "失败")
            for m in msgs:
                print("    " + m.replace("\n", "\n    "))
            if not ok:
                failures += 1
    finally:
        if not args.keep:
            shutil.rmtree(tmpdir, ignore_errors=True)
        else:
            print(f"短片保留在 {tmpdir}")

    print()
    if failures:
        print(f"{failures} 个档位失败")
        return 1
    print("全部通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
