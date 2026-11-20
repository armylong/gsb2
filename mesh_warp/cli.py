"""Headless command line: verify, generate fixtures, batch warp.

Useful for CI and for the pixel-level verification described in the README.
The interactive editor is ``python -m mesh_warp.app``.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

from .editor import Editor, loaded_from_array
from .io import load_image_rgba, load_mesh_json, save_png_rgba
from .selfcheck import run_all
from .test_image import generate_test_image


def _cmd_selfcheck(args: argparse.Namespace) -> int:
    results = run_all()
    payload = [
        {"name": r.name, "passed": r.passed, "detail": r.detail, "metrics": r.metrics}
        for r in results
    ]
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        for r in results:
            print(f"[{'PASS' if r.passed else 'FAIL'}] {r.name}: {r.detail}")
    return 0 if all(r.passed for r in results) else 1


def _cmd_fixture(args: argparse.Namespace) -> int:
    image = generate_test_image(args.width, args.height)
    path = Path(args.output)
    save_png_rgba(path, image)
    print(f"wrote {path} ({args.width}x{args.height}, RGBA)")
    return 0


def _cmd_demo(args: argparse.Namespace) -> int:
    """Generate the built-in test image, deform it, export PNG + JSON."""
    out = Path(args.output_dir)
    out.mkdir(parents=True, exist_ok=True)
    image = generate_test_image(720, 540)
    loaded = loaded_from_array(image, "内置测试图.png")
    editor = Editor()
    editor.set_document(loaded, 5, 4)
    mesh = editor.mesh
    p = mesh.index(2, 1)
    ok, msg = editor.set_point_target(p, *mesh.src[p] + np.array([58.0, -42.0]))
    assert ok, msg
    editor.set_border_locked(True)
    editor.export_png(out / "warped.png")
    editor.export_json(out / "mesh.json")
    save_png_rgba(out / "source.png", image)
    print(f"wrote source.png, warped.png, mesh.json in {out}")
    return 0


def _cmd_warp(args: argparse.Namespace) -> int:
    """Apply a saved mesh JSON to an image and write the transparent PNG."""
    image = load_image_rgba(args.image)
    mesh = load_mesh_json(
        args.mesh,
        width=image.width,
        height=image.height,
        image_sha256=image.sha256 if not args.ignore_hash else None,
    )
    # Import here so the CLI stays lightweight for --help.
    from .warp import render_warp

    out = render_warp(image.rgba, mesh)
    save_png_rgba(args.output, out)
    print(
        f"wrote {args.output} ({mesh.width}x{mesh.height}); "
        f"grid {mesh.cols}x{mesh.rows}; identity={mesh.is_identity}"
    )
    return 0


def _cmd_sample(args: argparse.Namespace) -> int:
    """Inverse-map a target pixel using a saved mesh (no source image needed)."""
    mesh = load_mesh_json(args.mesh, width=args.width, height=args.height)
    src, bary = mesh.locate_target(np.array([args.x, args.y], dtype=float))
    if src is None:
        print(json.dumps({"covered": False}, ensure_ascii=False))
        return 2
    print(
        json.dumps(
            {
                "covered": True,
                "source": [float(src[0]), float(src[1])],
                "barycentric": [float(v) for v in bary],
            },
            ensure_ascii=False,
        )
    )
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m mesh_warp.cli",
        description="Mesh warp headless tooling",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("selfcheck", help="run pixel-level verification suite")
    p.add_argument("--json", action="store_true")
    p.set_defaults(func=_cmd_selfcheck)

    p = sub.add_parser("fixture", help="write the built-in test image")
    p.add_argument("output", nargs="?", default="test_image.png")
    p.add_argument("--width", type=int, default=720)
    p.add_argument("--height", type=int, default=540)
    p.set_defaults(func=_cmd_fixture)

    p = sub.add_parser("demo", help="generate test image + warped PNG + mesh JSON")
    p.add_argument("output_dir", nargs="?", default="demo_out")
    p.set_defaults(func=_cmd_demo)

    p = sub.add_parser("warp", help="apply a mesh JSON to an image")
    p.add_argument("image")
    p.add_argument("mesh")
    p.add_argument("output")
    p.add_argument("--ignore-hash", action="store_true")
    p.set_defaults(func=_cmd_warp)

    p = sub.add_parser("sample", help="look up the source of a target pixel")
    p.add_argument("mesh")
    p.add_argument("x", type=float)
    p.add_argument("y", type=float)
    p.add_argument("--width", type=int, required=True)
    p.add_argument("--height", type=int, required=True)
    p.set_defaults(func=_cmd_sample)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return int(args.func(args))
    except Exception as exc:  # noqa: BLE001 - CLI reports a clean message
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
