"""Headless CLI: run the same pipeline as the GUI and write artefacts.

Examples
--------
Generate all samples + reports into ``out/``::

    python -m pathcheck.cli selftest --out out

Check one sample at a given epsilon and write path JSON + previews::

    python -m pathcheck.cli check --sample metaballs --eps 2 --out out

Reload an exported JSON and re-verify it against its reference mask::

    python -m pathcheck.cli verify out/metaballs.paths.json \
        --mask out/metaballs.reference.png
"""

from __future__ import annotations

import argparse
import os
import sys

import numpy as np

from .export import read_json, write_json, write_raster, write_rgb
from .pipeline import analyse
from .render import draw_ring_labels, overlay_diff, raster_diff, render_boundaries
from .report import format_report
from .samples import SAMPLES, SAMPLES_BY_KEY, generate_sample, load_mask
from .simplify import METHODS, SimplifyParams


def _params(args) -> SimplifyParams:
    return SimplifyParams(
        method=args.method,
        epsilon=args.eps,
        min_hole_ratio=args.min_hole_ratio,
        min_hole_area=args.min_hole_area,
    )


def _write_analysis(mask, params, out_dir: str, stem: str, *, preview_scale: int) -> int:
    os.makedirs(out_dir, exist_ok=True)
    a = analyse(mask, params)
    text = format_report(a)
    print(text)
    with open(os.path.join(out_dir, f"{stem}.report.txt"), "w", encoding="utf-8") as fh:
        fh.write(text + "\n")

    json_path = os.path.join(out_dir, f"{stem}.paths.json")
    a.reference_name = f"{stem}.reference.png"
    write_json(a.to_document(), json_path)

    write_raster(a.mask.astype(np.uint8) * 255,
                 os.path.join(out_dir, f"{stem}.reference.png"))
    write_raster(a.rebuild.astype(np.uint8) * 255,
                 os.path.join(out_dir, f"{stem}.rebuild.png"))

    diff = raster_diff(a.mask, a.rebuild)
    write_rgb(overlay_diff(a.mask, diff), os.path.join(out_dir, f"{stem}.diff.png"))

    proxies = _RingProxy.wrap(a.kept_rings)
    preview = render_boundaries(a.mask, proxies, scale=1)
    preview = draw_ring_labels(preview, proxies, scale=1)
    worst = a.worst_deviation
    if worst is not None and worst.max_distance > 0:
        import cv2

        x0, y0, x1, y1 = worst.bbox
        cv2.rectangle(preview, (max(0, x0), max(0, y0)),
                      (min(a.width - 1, x1), min(a.height - 1, y1)), (255, 255, 255), 1)
    if preview_scale != 1:
        import cv2

        preview = cv2.resize(
            preview,
            (a.width * preview_scale, a.height * preview_scale),
            interpolation=cv2.INTER_NEAREST,
        )
    write_rgb(preview, os.path.join(out_dir, f"{stem}.paths.png"))
    print(f"\n已写入 {out_dir}/{stem}.paths.json 等文件")
    return 0 if a.report.ok else 2


class _RingProxy:
    """Minimal ring protocol for render helpers (label/kind/index/points)."""

    def __init__(self, r):
        self.comp_id = r.comp_id
        self.kind = r.kind
        self.index = r.index
        self.points = r.simplified
        self.label = r.label

    @classmethod
    def wrap(cls, results):
        return [cls(r) for r in results]


def cmd_selftest(args) -> int:
    rc = 0
    for spec in SAMPLES:
        if args.samples and spec.key not in args.samples:
            continue
        print("#" * 70)
        print(f"# 样例 {spec.key}: {spec.title}")
        print("#" * 70)
        mask = generate_sample(spec.key)
        params = SimplifyParams(method=args.method, epsilon=args.eps)
        rc |= _write_analysis(mask, params, args.out, spec.key, preview_scale=args.scale)
    return rc


def cmd_check(args) -> int:
    if args.sample:
        mask = generate_sample(args.sample)
        stem = args.sample
    elif args.mask:
        mask = load_mask(args.mask, threshold=args.threshold)
        stem = os.path.splitext(os.path.basename(args.mask))[0]
    else:
        raise SystemExit("需要 --sample 或 --mask")
    return _write_analysis(mask, _params(args), args.out, stem, preview_scale=args.scale)


def cmd_scan(args) -> int:
    """Report the smallest epsilon that makes each sample/method fail."""
    from .pipeline import find_first_failure

    keys = args.samples or [s.key for s in SAMPLES]
    methods = args.methods
    mask_cache = {k: generate_sample(k) for k in keys}
    print(f"{'样例':10s} {'方法':8s} {'首个失败 eps':>12s}  问题")
    for key in keys:
        for method in methods:
            hit = find_first_failure(
                mask_cache[key],
                SimplifyParams(method=method),
                max_eps=args.max_eps,
                step=args.step,
            )
            if hit is None:
                print(f"{key:10s} {method:8s} {'未失败':>12s}  (<= {args.max_eps:g}px)")
            else:
                eps, a = hit
                codes = ",".join(sorted({i.code for i in a.report.errors}))
                print(f"{key:10s} {method:8s} {eps:12.2f}  {codes}")
    return 0


def cmd_verify(args) -> int:
    doc = read_json(args.paths)
    mask = load_mask(args.mask, threshold=args.threshold)
    if mask.shape != (doc.height, doc.width):
        raise SystemExit(
            f"参考掩码 {mask.shape[::-1]} 与路径文件画布 "
            f"{(doc.width, doc.height)} 不一致"
        )
    from .export import ExportedRing
    from .validate import validate_rings, compare_to_reference
    from .render import reconstruct
    from .extract import extract
    from .validate import Issue  # noqa: F401

    ex = extract(mask)

    def _label(r: ExportedRing) -> str:
        code = "O" if r.kind == "outer" else ("N" if r.kind == "notch" else f"H{r.index}")
        return f"C{r.comp}/{code}"

    entries = [
        (_label(r), r.comp, r.kind, r.index, r.points, 0.0) for r in doc.rings
    ]
    checks, issues = validate_rings(
        [e for e in entries if e[2] != "notch"],
        width=doc.width,
        height=doc.height,
    )
    notch_checks, notch_issues = validate_rings(
        [e for e in entries if e[2] == "notch"],
        width=doc.width,
        height=doc.height,
        allow_dropped_holes=True,
        check_structure=False,
    )
    checks.extend(notch_checks)
    issues.extend(notch_issues)
    rings = [type("R", (), {"points": r.points})() for r in doc.rings]
    rebuild = reconstruct(rings, doc.width, doc.height)
    report = compare_to_reference(
        mask, rebuild, checks, issues,
        reference_components=len(ex.components),
        reference_holes=ex.hole_count,
    )
    print(f"路径文件: {args.paths}")
    print(f"环 {len(doc.rings)}  面积 {report.area_ref} -> {report.area_new} "
          f"缺失 {report.missing_pixels} 多出 {report.extra_pixels} IoU {report.iou:.5f}")
    print(f"组件 {report.components_ref} -> {report.components_new}  "
          f"洞 {report.holes_ref} -> {report.holes_new}")
    for i in report.issues:
        tag = {"error": "E", "warning": "W", "info": "I"}[i.level]
        print(f"[{tag}] {i.code:24s} {i.message}")
    if not report.issues:
        print("无问题")
    if args.out:
        os.makedirs(args.out, exist_ok=True)
        diff = raster_diff(mask, rebuild)
        write_rgb(overlay_diff(mask, diff), os.path.join(args.out, "verify.diff.png"))
        write_raster(rebuild, os.path.join(args.out, "verify.rebuild.png"))
    return 0 if report.ok else 2


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m pathcheck.cli",
        description="二值图外边/内洞提取、简化检查与导出 (无界面)",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    def add_common(sp):
        sp.add_argument("--method", choices=sorted(METHODS), default="rdp")
        sp.add_argument("--eps", type=float, default=0.5,
                        help="简化容差 (像素); 0.5 保守, 1.5+ 常会压坏 1px 细桥")
        sp.add_argument("--min-hole-ratio", type=float, default=0.0,
                        help="丢弃面积比 <= 该值的洞 (0=不丢)")
        sp.add_argument("--min-hole-area", type=float, default=0.0,
                        help="丢弃面积 <= 该像素数的洞 (0=不丢)")
        sp.add_argument("--out", default="out", help="输出目录")
        sp.add_argument("--scale", type=int, default=4, help="PNG 预览放大倍数")
        sp.add_argument("--threshold", type=int, default=127)

    st = sub.add_parser("selftest", help="对所有内置样例跑完整流程并写文件")
    st.add_argument("--samples", nargs="*", choices=[s.key for s in SAMPLES],
                    help="只跑指定样例")
    add_common(st)
    st.set_defaults(func=cmd_selftest)

    ck = sub.add_parser("check", help="检查一个样例或一张图片")
    ck.add_argument("--sample", choices=[s.key for s in SAMPLES])
    ck.add_argument("--mask", help="黑白图片路径 (>=threshold 视为前景)")
    add_common(ck)
    ck.set_defaults(func=cmd_check)

    vf = sub.add_parser("verify", help="重新加载导出的 JSON 并与参考掩码对比")
    vf.add_argument("paths")
    vf.add_argument("--mask", required=True)
    vf.add_argument("--threshold", type=int, default=127)
    vf.add_argument("--out", default="")
    vf.set_defaults(func=cmd_verify)

    sc = sub.add_parser("scan", help="扫描每个样例首个使校验失败的 epsilon")
    sc.add_argument("--samples", nargs="*", choices=[s.key for s in SAMPLES])
    sc.add_argument("--methods", nargs="*", choices=sorted(METHODS),
                    default=["rdp", "approx", "vertex"])
    sc.add_argument("--max-eps", type=float, default=8.0)
    sc.add_argument("--step", type=float, default=0.5)
    sc.set_defaults(func=cmd_scan)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
