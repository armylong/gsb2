"""Command line interface for the stencil checker."""

from __future__ import annotations

import argparse
import json
import sys

from .core import verify_export


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="黑白刷色模板检查器")
    parser.add_argument("--check", help="reload and verify an exported binary image")
    parser.add_argument("--keep", choices=["black", "white"], default="black")
    parser.add_argument("--thin-width", type=int, default=3)
    parser.add_argument("--json", action="store_true", help="emit machine-readable JSON")
    parser.add_argument(
        "--strict",
        action="store_true",
        help="exit with status 3 when floating components remain",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    if args.check:
        result = verify_export(args.check, args.keep, args.thin_width)
        payload = {
            "path": args.check,
            "keep_color": args.keep,
            "width": int(result.paper.shape[1]),
            "height": int(result.paper.shape[0]),
            "component_count": result.component_count,
            "floating_count": result.floating_count,
            "floating_labels": result.floating_labels,
            "thin_point_count": len(result.thin_points),
            "thin_points": [
                {"x": p.x, "y": p.y, "width_px": p.width_px, "label": p.label}
                for p in result.thin_points
            ],
            "components": [
                {
                    "label": c.label,
                    "area": c.area,
                    "bbox": list(c.bbox),
                    "frame_connected": c.frame_connected,
                }
                for c in result.components.values()
            ],
        }
        if args.json:
            print(json.dumps(payload, ensure_ascii=False, indent=2))
        else:
            print(f"复核文件: {args.check}")
            print(f"图像尺寸: {payload['width']}x{payload['height']}")
            print(f"纸块总数: {result.component_count}")
            print(f"剩余悬空块: {result.floating_count}")
            for label in result.floating_labels:
                c = result.components[label]
                print(f"  #{label}: area={c.area}, bbox={c.bbox}")
            print(f"过细连点: {len(result.thin_points)}")
        if args.strict and result.floating_count:
            return 3
        return 0

    from .gui import run_gui

    return run_gui(sys.argv)


if __name__ == "__main__":
    raise SystemExit(main())
