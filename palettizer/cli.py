"""Headless CLI for the same pipeline, useful for scripted checks.

    python -m palettizer.cli demo --list
    python -m palettizer.cli demo gradient_corners --colors 16 --mode diffusion \
        --strength 0.6 --alpha-threshold 128 --out /tmp/out.png
    python -m palettizer.cli image input.png --colors 8 --mode ordered --out /tmp/out.png

Exports always write the genuine indexed PNG plus a `.json` sidecar and
verify the result by reading it back.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from .demo import DEMOS, demo_rgba
from .imageio import ImageLoadError, load_image
from .palette import MAX_COLORS, MIN_COLORS, generate_palette
from .pngio import ExportError, export_indexed_png, read_indexed_png, readback_matches
from .quantize import ALL_MODES, MODE_LABELS, Quantizer, Settings


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="像素画有限调色板 + 抖动工具（命令行）")
    sub = parser.add_subparsers(dest="command", required=True)

    demo = sub.add_parser("demo", help="使用自生成演示素材")
    demo.add_argument("name", nargs="?", help="素材名；省略则列出全部")
    demo.add_argument("--list", action="store_true", help="列出可用素材")

    image = sub.add_parser("image", help="处理一个不超过 256px 的 PNG")
    image.add_argument("path")

    for p in (demo, image):
        p.add_argument("--colors", type=int, default=16, help=f"目标色数 {MIN_COLORS}..{MAX_COLORS}")
        p.add_argument("--mode", choices=ALL_MODES, default="none", help="抖动方式")
        p.add_argument("--strength", type=float, default=0.5, help="抖动强度 0..1")
        p.add_argument("--alpha-threshold", type=int, default=128, help="透明阈值 1..255")
        p.add_argument("--out", required=False, help="导出索引 PNG 的路径；省略则只打印统计")
    return parser


def _run(rgba, name: str, args) -> int:
    settings = Settings(
        mode=args.mode, strength=args.strength, alpha_threshold=args.alpha_threshold
    )
    opaque = (rgba[..., 3] >= settings.alpha_threshold) & (rgba[..., 3] > 0)
    palette, report = generate_palette(rgba, opaque, args.colors)
    result = Quantizer(rgba).result(palette, settings)

    h, w = rgba.shape[:2]
    print(f"素材: {name} ({w}x{h})")
    print(f"调色板: {report.summary}")
    print(f"模式: {MODE_LABELS[settings.mode]}  强度: {settings.strength:.2f}  透明阈值: {settings.alpha_threshold}")
    print(f"可见像素: {int(result.counts.sum())}  透明像素: {result.transparent_count}  透明索引: #{result.transparent_index}")
    used = result.used_visible_colors
    print(f"实际使用颜色: {used}/{result.visible_color_count}")
    for i, (color, count) in enumerate(zip(result.palette_colors.tolist(), result.counts.tolist())):
        print(f"  #{i:<2} #{color[0]:02X}{color[1]:02X}{color[2]:02X}  {count}")
    if not args.out:
        return 0
    try:
        export_indexed_png(args.out, result, settings, notes=report.summary)
        readback = read_indexed_png(args.out)
    except (ExportError, OSError) as exc:
        print(f"导出失败: {exc}", file=sys.stderr)
        return 2
    ok, message = readback_matches(result, readback)
    print(("导出成功: " if ok else "导出校验失败: ") + message)
    print(f"文件: {args.out}（参数: {Path(args.out).with_suffix('.json')}）")
    return 0 if ok else 3


def main(argv: list[str] | None = None) -> int:
    parser = _build_parser()
    args = parser.parse_args(argv)
    if args.command == "demo":
        if args.list or not args.name:
            for key, (label, _fn) in DEMOS.items():
                print(f"{key:<20} {label}")
            return 0
        if args.name not in DEMOS:
            print(f"未知素材: {args.name}", file=sys.stderr)
            return 2
        return _run(demo_rgba(args.name), DEMOS[args.name][0], args)
    try:
        rgba = load_image(args.path)
    except ImageLoadError as exc:
        print(f"载入失败: {exc}", file=sys.stderr)
        return 2
    return _run(rgba, Path(args.path).name, args)


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
