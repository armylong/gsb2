"""无界面重复生成:

    .venv/bin/python -m lenticular_tool.cli generate lenticular_project.json \
        --out interlaced.png --layer layer.png --cal calibration.png

参数 JSON 由界面“保存参数 JSON”产生; 外部 PNG 路径按 JSON 所在目录解析。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PySide6 import QtGui, QtWidgets

from . import core
from .calibration import build_calibration_strip
from .params import ProjectFile, ViewSource
from .qtio import load_png_rgba, save_png, save_qimage_png
from .samples import make_sample


def load_views(pf: ProjectFile) -> tuple[list, list[ViewSource]]:
    views, sources = [], []
    shape = None
    for src in pf.views:
        arr = None
        if src.kind == "file" and src.path and Path(src.path).exists():
            try:
                arr = load_png_rgba(src.path)
            except Exception:
                arr = None
        if arr is None:
            arr = make_sample(src.sample_index)
            if src.kind == "file":
                src = ViewSource(kind="sample", sample_index=src.sample_index,
                                 label=src.label or "missing->sample")
        if shape is None:
            shape = arr.shape[:2]
        if arr.shape[:2] != shape:
            continue
        views.append(arr)
        sources.append(src)
    if not (2 <= len(views) <= 4):
        raise SystemExit("工程文件里需要 2–4 张同尺寸视角图")
    return views, sources


def cmd_generate(args) -> int:
    # QGuiApplication 就够(QPainter 画样例 / PNG 插件需要)
    app = QtWidgets.QApplication.instance() or QtWidgets.QApplication(sys.argv[:1])
    pf = ProjectFile.load_json(args.project)
    views, _ = load_views(pf)
    p = pf.params
    n = len(views)
    p.order = p.normalized_order(n)
    h, w = views[0].shape[:2]
    pitch = core.effective_pitch(p, w)
    inter = core.interlace(views, p, pitch=pitch)
    assign = core.assignment_map(h, w, n, pitch, p)
    layer = core.source_layer(assign, n,
                              [(225, 64, 64), (48, 116, 224),
                               (34, 160, 96), (238, 158, 28)])
    dpi = p.dpi

    if args.out:
        path = save_png(inter, args.out, dpi=dpi)
        print(f"交错图 {w}x{h} -> {path}")
    if args.layer:
        path = save_png(layer, args.layer, dpi=dpi)
        print(f"来源图层 -> {path}")
    if args.cal:
        strip = build_calibration_strip(w, p, n, dpi=dpi)
        path = save_qimage_png(strip, args.cal, dpi=dpi)
        print(f"校准条 -> {path} ({strip.width()}x{strip.height()})")
    if not (args.out or args.layer or args.cal):
        print("没有指定 --out/--layer/--cal, 仅完成计算。")
    print(f"P={pitch:.6f}px  right_phase="
          f"{core.edge_phases(h, w, pitch, p)['right_edge']:.6f}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="按保存的参数重复生成交错 PNG")
    sub = parser.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("generate", help="从工程 JSON 生成 PNG")
    g.add_argument("project", help="参数 JSON 路径")
    g.add_argument("--out", help="交错原像素 PNG 输出路径")
    g.add_argument("--layer", help="来源彩色图层 PNG 输出路径")
    g.add_argument("--cal", help="带刻度校准条 PNG 输出路径")
    g.set_defaults(func=cmd_generate)
    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
