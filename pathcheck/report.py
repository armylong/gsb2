"""Human-readable text report (CLI output and the GUI's "复制报告")."""

from __future__ import annotations

from .pipeline import Analysis


def format_report(a: Analysis, *, max_issues: int = 60) -> str:
    r = a.report
    ex = a.extraction
    lines: list[str] = []
    lines.append("== 边界检查报告 ==")
    lines.append(
        f"画布 {a.width}x{a.height}  前景像素 {ex.pixel_count}"
        f"  组件 {len(ex.components)}  洞 {ex.hole_count}"
        f"  (含 {sum(len(c.notches) for c in ex.components)} 个对角凹口, 不计作洞)"
    )
    lines.append(
        f"简化 {a.params.describe()}  顶点 "
        f"{sum(r.original_points for r in a.rings)} -> "
        f"{sum(r.simplified_points for r in a.kept_rings)}"
    )
    lines.append("")
    lines.append("-- 结构 / 栅格对比 --")
    lines.append(
        f"面积   参考 {r.area_ref} -> 重建 {r.area_new} "
        f"(缺失 {r.missing_pixels}, 多出 {r.extra_pixels}, IoU {r.iou:.5f})"
    )
    lines.append(
        f"连通性 组件 {r.components_ref} -> {r.components_new}  "
        f"洞 {r.holes_ref} -> {r.holes_new}  "
        f"欧拉数 {r.euler_ref} -> {r.euler_new}"
    )
    if r.ok:
        lines.append("结论: 通过 (无 error 级问题)")
    else:
        lines.append(f"结论: 未通过 ({len(r.errors)} 个 error)")
    lines.append("")
    lines.append("-- 环 (每条边归属的组件) --")
    for ring in ex.rings:
        dev = next((x.deviation for x in a.rings if x.label == ring.label), None)
        border = ring.border_description(a.width, a.height)
        extra = ""
        if dev is not None:
            extra = f"  最大偏离 {dev.max_distance:.2f}px @ {dev.vertex}"
        lines.append(
            f"  {ring.label:8s} {ring.describe():24s} 面积 {ring.area:8.1f} "
            f"顶点 {len(ring.points):3d}  {border}{extra}"
        )
    dropped = [x for x in a.rings if x.dropped]
    for x in dropped:
        lines.append(f"  {x.label:8s} 已按策略移除")
    lines.append("")
    lines.append("-- 问题 --")
    if not a.issues:
        lines.append("  无")
    for i, issue in enumerate(a.issues[:max_issues]):
        tag = {"error": "E", "warning": "W", "info": "I"}.get(issue.level, "?")
        lines.append(f"  [{tag}] {issue.code:24s} {issue.message}")
    if len(a.issues) > max_issues:
        lines.append(f"  ... 另有 {len(a.issues) - max_issues} 条")
    worst = a.worst_deviation
    if worst is not None and worst.max_distance > 0:
        lines.append("")
        lines.append(
            f"-- 最大偏离区域 -- bbox {worst.bbox} "
            f"原始点 {worst.original_point} <-> 简化点 {worst.simplified_point} "
            f"(epsilon {worst.epsilon:g}px)"
        )
    return "\n".join(lines)
