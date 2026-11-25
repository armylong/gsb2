"""内置短片端到端自检：生成素材、标区、预览、增量放置并导出验证。"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Any

# 默认自动化运行使用 offscreen；真正打开窗口时由 --show 覆盖。
if "--show" not in sys.argv:
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtGui import QImage, QPainter  # noqa: E402
from PySide6.QtWidgets import QApplication  # noqa: E402

from .layout import render_subtitle  # noqa: E402
from .main_window import MainWindow  # noqa: E402
from .media import extract_frame, probe_video  # noqa: E402
from .sample_video import generate_sample  # noqa: E402


def _image_diff_stats(path_a: Path, path_b: Path, box) -> dict[str, float]:
    a = QImage(path_a).convertToFormat(QImage.Format.Format_RGB888)
    b = QImage(path_b).convertToFormat(QImage.Format.Format_RGB888)
    if a.width() != b.width() or a.height() != b.height():
        raise AssertionError("对比帧尺寸不一致")

    x0 = max(0, int(box.x))
    y0 = max(0, int(box.y))
    x1 = min(a.width(), int(box.right) + 1)
    y1 = min(a.height(), int(box.bottom) + 1)
    total = 0
    changed = 0
    diff_sum = 0
    for y in range(y0, y1, 2):
        for x in range(x0, x1, 2):
            ca = a.pixelColor(x, y)
            cb = b.pixelColor(x, y)
            d = (
                abs(ca.red() - cb.red())
                + abs(ca.green() - cb.green())
                + abs(ca.blue() - cb.blue())
            ) / 3.0
            diff_sum += d
            total += 1
            if d > 28:
                changed += 1
    return {
        "mean_diff": diff_sum / max(1, total),
        "changed_ratio": changed / max(1, total),
        "samples": total,
    }


def _save_source_coordinate_preview(
    video_path: Path,
    t: float,
    cue,
    placement,
    engine,
    out_path: Path,
    frame_path: Path | None = None,
) -> None:
    if frame_path is None:
        frame_path = out_path.with_name(out_path.stem + "_frame.png")
    extract_frame(video_path, t, frame_path)
    image = QImage(frame_path)
    painter = QPainter(image)
    try:
        laid = engine.layout(cue.text)
        render_subtitle(painter, laid, placement.box, engine.style)
    finally:
        painter.end()
    image.save(str(out_path), "PNG")


def run_demo(out_dir: str | Path = "examples/demo", show: bool = False) -> dict[str, Any]:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    app = QApplication.instance() or QApplication(sys.argv)

    assets = generate_sample(out)
    frames_dir = out / "frames"
    frames_dir.mkdir(exist_ok=True)

    win = MainWindow()
    # 走和用户点击按钮相同的探测/打开路径。
    win.open_video(assets.video_path)
    win.open_srt(assets.srt_path)
    win.project.duration = 12.0
    win.view.duration = 12.0
    win.slider.setMaximum(12000)
    win.resize(1380, 860)
    if show:
        win.show()
    else:
        win.show()
        app.processEvents()

    # 模拟用户在当前时间拖出四个源坐标矩形，再补上精确起止时间。
    for spec in assets.obstacles:
        win.view.time = spec.start
        win.add_drawn_obstacle(spec.rect)
        created = win.project.obstacles[-1]
        created.name = spec.name
        created.start = spec.start
        created.end = spec.end
    win.store.refresh_all()
    win._refresh_all_views()

    issues_before_manual = [
        {"cue_id": i.cue_id, "time": i.time, "markers": i.marker_times, "message": i.message}
        for i in win.store.issues()
    ]
    if len(issues_before_manual) != 1:
        raise AssertionError(f"示例应恰好产生 1 个无法自动放置的字幕，实际: {issues_before_manual}")

    conflict_cue = win.cues[3]
    laid = win.store.planner.layouts.layout(conflict_cue.text)
    manual_x = (1280 - laid.box_w) / 2
    manual_y = 318.0
    win.commit_manual_position(conflict_cue.id, manual_x, manual_y)
    if win.store.issues():
        raise AssertionError("人工指定中心安全区后不应仍有未解决冲突")

    # 把所有“候选安全集变化时刻”都步进一遍，确保 UI 跳转/绘制路径无异常。
    win.rebuild_moments()
    win._refresh_moment_combo()
    for i in range(len(win.moments)):
        win.jump_to_moment(i)
        app.processEvents()
    moment_step_count = len(win.moments)

    # 改变预览控件尺寸后再做一次源坐标反算自检。
    win.view.resize(1100, 620)
    app.processEvents()
    win.view.resize(860, 520)
    app.processEvents()

    win.save_project(out / "demo_project.json")

    # 保存两张 GUI 预览截图和两张源坐标预览图。
    preview_checks = []
    preview_specs = [
        ("preview_slide_avoidance", 6.6, win.cues[2].id),
        ("preview_manual_center", 10.3, conflict_cue.id),
    ]
    for name, t, cue_id in preview_specs:
        source_frame = frames_dir / f"{name}_source.png"
        extract_frame(assets.video_path, t, source_frame)
        image = QImage(source_frame)
        win.view.frame_image = image
        win.view.time = t
        win.view.current_cue_id = cue_id
        win.view.resize(960, 540)
        app.processEvents()
        win.view.repaint()
        app.processEvents()
        grab_path = out / f"{name}_widget.png"
        win.view.grab().save(str(grab_path), "PNG")

        cue = next(c for c in win.cues if c.id == cue_id)
        placement = win.store.placements[cue_id]
        source_preview = out / f"{name}_source_coords.png"
        _save_source_coordinate_preview(
            assets.video_path,
            t,
            cue,
            placement,
            win.store.planner.layouts,
            source_preview,
            frames_dir / f"{name}_coords_frame.png",
        )
        preview_checks.append(
            {
                "name": name,
                "time": t,
                "cue_id": cue_id,
                "placement": asdict(placement.box),
                "slot_id": placement.slot_id,
                "widget_png": str(grab_path),
                "source_preview_png": str(source_preview),
            }
        )

    output_path = out / "subtitled_demo.mp4"
    # 走 GUI 的导出入口；它和预览共用 win.store 中的 placements。
    win.export_to(output_path)

    info = probe_video(output_path)
    if (info.width, info.height) != (1280, 720):
        raise AssertionError(f"导出分辨率错误: {info.width}x{info.height}")
    if info.duration < 11.5:
        raise AssertionError(f"导出时长过短: {info.duration}")

    # 时间一致性：字幕中帧应在字框内产生明显叠加；结束后同一区域应明显减弱。
    timing_checks = []
    for cue, sample_t in ((win.cues[0], 1.4), (win.cues[2], 7.0), (conflict_cue, 10.35)):
        placement = win.store.placements[cue.id]
        mid_original = frames_dir / f"check_{cue.id}_src_mid.png"
        mid_output = frames_dir / f"check_{cue.id}_out_mid.png"
        end_original = frames_dir / f"check_{cue.id}_src_end.png"
        end_output = frames_dir / f"check_{cue.id}_out_end.png"
        end_t = min(11.9, cue.end + 0.25)
        extract_frame(assets.video_path, sample_t, mid_original)
        extract_frame(output_path, sample_t, mid_output)
        extract_frame(assets.video_path, end_t, end_original)
        extract_frame(output_path, end_t, end_output)
        mid_stats = _image_diff_stats(mid_original, mid_output, placement.box)
        end_stats = _image_diff_stats(end_original, end_output, placement.box)
        if mid_stats["changed_ratio"] < 0.08:
            raise AssertionError(f"{cue.id} 播放时间内字框叠加差异过小: {mid_stats}")
        if end_stats["changed_ratio"] > mid_stats["changed_ratio"] * 0.45:
            raise AssertionError(
                f"{cue.id} 结束后仍有过强字幕区域差异: mid={mid_stats}, end={end_stats}"
            )
        timing_checks.append(
            {
                "cue_id": cue.id,
                "visible_at": sample_t,
                "ended_check_at": end_t,
                "mid": mid_stats,
                "after_end": end_stats,
            }
        )

    moments = [
        {"time": m.time, "cue_id": m.cue_id, "reason": m.reason, "safe": m.safe_slot_ids}
        for m in win.moments
    ]
    report: dict[str, Any] = {
        "status": "ok",
        "out_dir": str(out.resolve()),
        "video": str(assets.video_path.resolve()),
        "srt": str(assets.srt_path.resolve()),
        "output_video": str(output_path.resolve()),
        "output_srt": str(output_path.with_suffix(".srt").resolve()),
        "ffprobe": asdict(info),
        "issues_before_manual": issues_before_manual,
        "placements": {
            cid: {
                "slot_id": p.slot_id,
                "safe": p.safe,
                "manual": p.manual,
                "box": asdict(p.box),
                "collisions": list(p.collisions),
            }
            for cid, p in win.store.placements.items()
        },
        "moments": moments,
        "moment_step_count": moment_step_count,
        "preview_checks": preview_checks,
        "timing_checks": timing_checks,
    }
    (out / "e2e_report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    if show:
        win.show()
        app.exec()
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="运行字幕避让内置端到端演示")
    parser.add_argument("--out", default="examples/demo", help="输出目录")
    parser.add_argument("--show", action="store_true", help="显示窗口并保持打开")
    args = parser.parse_args()
    report = run_demo(args.out, show=args.show)
    print(json.dumps({"status": report["status"], "out_dir": report["out_dir"]}, ensure_ascii=False))
    # Qt Multimedia 的 FFmpeg 后端在部分 macOS/offscreen 进程退出阶段会出现
    # 与业务无关的 teardown 段错误；报告和文件此时均已落盘，直接干净退出。
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
