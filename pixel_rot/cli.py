"""命令行入口: 无 GUI 环境下生成样例、批量导出与往返自检。

示例:
  python -m pixel_rot.cli sample --out sample.png
  python -m pixel_rot.cli export --image s.png --angles 0,45,90 --out out/
  python -m pixel_rot.cli roundtrip --image s.png
  python -m pixel_rot.cli gui
"""

from __future__ import annotations

import argparse
from pathlib import Path

from .core import (
    EXPAND,
    FIXED,
    METHODS,
    load_png,
    preset_center,
    roundtrip_check,
    save_png,
)
from .exporting import export_batch
from .sample import build_sample, sample_ascii


def _parse_angles(text: str) -> list[float]:
    return [float(t.strip()) for t in text.split(",") if t.strip()]


def _load_or_sample(image: str | None):
    if image:
        return load_png(image), []
    return build_sample()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="pixel_rot", description="像素旋转对照工具")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_sample = sub.add_parser("sample", help="生成内置样例 PNG")
    p_sample.add_argument("--out", default="sample.png")

    p_export = sub.add_parser("export", help="批量导出一组角度")
    p_export.add_argument("--image", help="输入 PNG; 省略则用内置样例")
    p_export.add_argument("--angles", default="0,15,30,45,60,75,90,135,180,270")
    p_export.add_argument("--out", default="rotation_export")
    p_export.add_argument("--center", choices=["corner", "pixel_center"], default="corner")
    p_export.add_argument("--canvas", choices=[EXPAND, FIXED], default=EXPAND)
    p_export.add_argument("--methods", default=",".join(METHODS))
    p_export.add_argument("--ss", type=int, default=4)
    p_export.add_argument("--threshold", type=float, default=0.5)

    p_rt = sub.add_parser("roundtrip", help="90°x4 往返自检")
    p_rt.add_argument("--image", help="输入 PNG; 省略则用内置样例")
    p_rt.add_argument("--center", choices=["corner", "pixel_center"], default="corner")

    sub.add_parser("gui", help="启动本地对照窗")

    args = parser.parse_args(argv)

    if args.cmd == "sample":
        img, _ = build_sample()
        save_png(args.out, img)
        print(sample_ascii(img))
        print(f"\n已写入 {args.out} ({img.width}x{img.height}, {len(img.palette)} 色)")
        return 0

    if args.cmd == "export":
        img, rois = _load_or_sample(args.image)
        center = preset_center(img, args.center)
        methods = [m.strip() for m in args.methods.split(",") if m.strip()]
        fixed = img.size if args.canvas == FIXED else None
        manifest = export_batch(
            img,
            Path(args.out),
            _parse_angles(args.angles),
            methods=methods,
            center=center,
            canvas_mode=args.canvas,
            fixed_size=fixed,
            rois=rois,
            supersample=args.ss,
            coverage_threshold=args.threshold,
        )
        print(f"导出 {len(manifest['entries'])} 张到 {args.out}")
        for e in manifest["entries"]:
            st = e["stats"]
            print(
                f"  {e['file']:<32} {e['angle']:>6g}° {e['method']:<11} "
                f"px={st['pixel_count']:<3} 连通={st['components']:<2} "
                f"洞={len(st['holes'])} 越界={e['outside_pixels']} "
                f"碰撞={e['collisions']} 中心={tuple(round(v,2) for v in e['center_out'])}"
            )
        return 0

    if args.cmd == "roundtrip":
        img, _ = _load_or_sample(args.image)
        center = preset_center(img, args.center)
        all_ok = True
        for method in METHODS:
            rep = roundtrip_check(img, method, center)
            all_ok &= rep.ok
            mark = "PASS" if rep.ok else "FAIL"
            print(f"[{mark}] {method:<11} center={tuple(round(v,2) for v in rep.center)}  {rep.detail}")
        return 0 if all_ok else 1

    if args.cmd == "gui":
        from .app import main as gui_main

        return gui_main()

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
