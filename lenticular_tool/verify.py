"""命令行本地校验:

    .venv/bin/python -m lenticular_tool.verify
    .venv/bin/python -m lenticular_tool.verify --crops ./check_crops

会跑数值自检, 并打印四个内置例子在图首/图中/图尾的相位与像素占用;
``--crops`` 额外导出放大的 PNG 裁片供人眼核对。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import core
from .params import PRESETS


def format_report() -> tuple[str, bool]:
    checks = core.run_self_checks()
    ok_all = all(c.ok for c in checks)
    lines = ["=" * 78, "柱镜工具本地校验", "=" * 78]
    for c in checks:
        lines.append(f"[{'PASS' if c.ok else 'FAIL'}] {c.name}")
        lines.append(f"       {c.detail}")
    lines.append("")

    # 每个预设的首中尾
    from .params import LensParams  # noqa
    H, W = 800, 1200
    for key, factory in PRESETS.items():
        name, p = factory()
        n = len(p.order)
        pitch = core.effective_pitch(p, W)
        ep = core.edge_phases(H, W, pitch, p)
        lines.append("-" * 78)
        lines.append(f"例子 {key}: {name}")
        lines.append(f"  P={pitch:.6f}px  W/P={W / pitch:.6f}  "
                     f"右端相位={ep['right_edge']:.5f}")
        for spot in core.spot_reports(H, W, n, p, pitch):
            counts = ", ".join(f"v{i + 1}={c}" for i, c in enumerate(spot.counts))
            lines.append(
                f"  {spot.title} #{spot.lens_index:<4d} "
                f"x={spot.center_x:8.2f} 边界[{spot.boundary_left:8.2f},"
                f"{spot.boundary_right:8.2f}] "
                f"片内相位 {spot.first_pixel_phase:.3f}→"
                f"{spot.last_pixel_phase:.3f}  {counts}")
            for w in spot.warnings:
                lines.append(f"      ⚠ {w}")
    lines.append("=" * 78)
    lines.append("全部通过 ✅" if ok_all else "存在失败项 ❌")
    return "\n".join(lines), ok_all


def export_crops(out_dir: str | Path) -> list[Path]:
    """为每个预设导出首/中/尾放大裁片(彩色来源图层)。"""
    from PySide6 import QtWidgets  # noqa: F401  (确保 QApplication 存在)
    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication(sys.argv[:1])
    from .crops import render_spot_crop
    from .qtio import save_qimage_png
    from .samples import make_samples

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    views_cache: dict[int, list] = {}

    for key, factory in PRESETS.items():
        name, p = factory()
        n = len(p.order)
        if n not in views_cache:
            views_cache[n] = make_samples(n)
        views = views_cache[n]
        H, W = views[0].shape[:2]
        pitch = core.effective_pitch(p, W)
        assign = core.assignment_map(H, W, n, pitch, p)
        layer = core.source_layer(assign, n,
                                  [(225, 64, 64), (48, 116, 224),
                                   (34, 160, 96), (238, 158, 28)])
        for spot in core.spot_reports(H, W, n, p, pitch):
            pix = render_spot_crop(layer, spot, p, pitch, n, scale=8)
            path = out_dir / f"{key}_{spot.key}_lens{spot.lens_index}.png"
            save_qimage_png(pix.toImage(), path)
            written.append(path)
    return written


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="柱镜交错工具本地校验")
    parser.add_argument("--crops", metavar="DIR", default=None,
                        help="把各例子图首/中/尾的放大裁片导出到 DIR")
    args = parser.parse_args(argv)

    text, ok = format_report()
    print(text)
    if args.crops:
        paths = export_crops(args.crops)
        print(f"\n已写出 {len(paths)} 张裁片到 {Path(args.crops).resolve()}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
