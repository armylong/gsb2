"""命令行入口：无界面地执行同样的分割与导出，便于批处理与自动校验。

示例
----
python -m ccstats.cli demo --key diagonal --conn 4
python -m ccstats.cli demo --key noise --despeckle 2 --fill 2
python -m ccstats.cli image photo.png --threshold 110 --polarity dark --export-dir out
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2

from .demos import DEMO_ORDER, expected_for_params, get_demo
from .export import export_all
from .imageio import ImageLoadError, load_image
from .models import Connectivity, FilterCriteria, Polarity, SegmentParams, ThresholdMode, ThresholdParams
from .segment import segment


def _params_from_args(args) -> SegmentParams:
    th = ThresholdParams(
        mode=ThresholdMode(args.mode),
        polarity=Polarity(args.polarity),
        fixed_value=args.threshold,
        local_radius=args.local_radius,
        local_offset=args.local_offset,
    )
    return SegmentParams(
        threshold=th,
        connectivity=Connectivity(args.conn),
        despeckle_radius=args.despeckle,
        fill_radius=args.fill,
    )


def _criteria_from_args(args) -> FilterCriteria:
    return FilterCriteria(min_area=args.min_area, max_area=args.max_area,
                          exclude_border=args.exclude_border)


def _print_summary(result, gray, info: dict) -> None:
    h, w = gray.shape
    print(f"图像 {w}×{h} px  阈值: {result.params.threshold.describe()}")
    print(f"邻接: {result.params.connectivity.value}  去噪 ≤{result.calc.get('despeckle_area', 0)} px  "
          f"填隙 ≤{result.calc.get('fill_area', 0)} px")
    print(f"二值处理范围: 整幅图像；前景像素 阈值后 {result.calc['base_pixels']} → 最终 {result.calc['foreground_pixels']}")
    print(f"全部区域 {result.total_count} · 当前计入 {result.included_count} · "
          f"计入总面积 {result.included_area} px")
    for rec in result.regions:
        s = rec.stats
        print(f"  #{s.label_id:<3d} 面积={s.area:<6d} 质心=({s.centroid_x:.2f},{s.centroid_y:.2f}) "
              f"外接=({s.bbox[0]},{s.bbox[1]},{s.bbox[2]},{s.bbox[3]}) "
              f"触边={'是' if s.touches_border else '否'} 孔洞={s.hole_count}({s.hole_area}px) "
              f"{'计入' if rec.included else '排除：' + rec.reason.text}")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="二维连通域分割统计（命令行）")
    sub = p.add_subparsers(dest="source", required=True)

    def add_common(sp):
        sp.add_argument("--mode", choices=["fixed", "local"], default="fixed")
        sp.add_argument("--threshold", type=int, default=128, help="固定阈值 0..255")
        sp.add_argument("--polarity", choices=["dark", "bright"], default="dark")
        sp.add_argument("--local-radius", type=int, default=15)
        sp.add_argument("--local-offset", type=int, default=10)
        sp.add_argument("--conn", type=int, choices=[4, 8], default=8)
        sp.add_argument("--despeckle", type=int, default=0, help="去小噪点等效半径")
        sp.add_argument("--fill", type=int, default=0, help="填小间隙等效半径")
        sp.add_argument("--min-area", type=int, default=0)
        sp.add_argument("--max-area", type=int, default=0)
        sp.add_argument("--exclude-border", action="store_true")
        sp.add_argument("--export-dir", type=str, default="")
        sp.add_argument("--json", action="store_true", help="以 JSON 输出统计")

    pd = sub.add_parser("demo", help="运行自生成演示")
    pd.add_argument("--key", choices=DEMO_ORDER, default="circular")
    pd.add_argument("--check", action="store_true", help="与演示预期精确比对，不一致返回非零")
    add_common(pd)

    pi = sub.add_parser("image", help="处理一张本地图像")
    pi.add_argument("path")
    add_common(pi)

    args = p.parse_args(argv)
    params = _params_from_args(args)
    criteria = _criteria_from_args(args)

    if args.source == "demo":
        demo = get_demo(args.key)
        gray = demo.image
        bgr = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
        info = {"path": f"demo:{demo.name}", "size": (gray.shape[1], gray.shape[0])}
        stem = f"demo_{demo.key}"
    else:
        try:
            img, gray, info = load_image(args.path)
        except ImageLoadError as exc:
            print(f"错误：{exc}", file=sys.stderr)
            return 2
        bgr = img if img.ndim == 3 else cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
        stem = Path(args.path).stem

    result = segment(gray, params, criteria)
    if args.json:
        print(json.dumps({
            "total": result.total_count,
            "included": result.included_count,
            "included_area": result.included_area,
            "calc": result.calc,
            "regions": [r.to_row() for r in result.regions],
        }, ensure_ascii=False, indent=2))
    else:
        _print_summary(result, gray, info)

    if args.export_dir:
        paths = export_all(result, bgr, args.export_dir, stem, info)
        print("已导出：")
        for k, v in paths.items():
            print(f"  {k}: {v}")

    if args.source == "demo" and args.check:
        demo = get_demo(args.key)
        exp = expected_for_params(demo, args.conn, args.despeckle, args.fill)
        if exp is None:
            print(f"提示：{demo.name} 没有覆盖 去噪={args.despeckle} 填隙={args.fill} 的预期值；"
                  f"仅默认参数与噪点演示的 2/4 半径组合提供精确预期。", file=sys.stderr)
            return 2
        got_areas = sorted(r.stats.area for r in result.regions)
        got_holes = sorted(r.stats.hole_count for r in result.regions)
        ok = (result.total_count == exp["total"]
              and got_areas == sorted(exp["areas"])
              and (not exp.get("holes") or got_holes == sorted(exp["holes"])))
        print(f"预期: 区域 {exp['total']} 面积 {exp['areas']} 孔洞 {exp['holes']}")
        print(f"实际: 区域 {result.total_count} 面积 {got_areas} 孔洞 {got_holes}")
        print("校验：" + ("通过" if ok else "失败"))
        return 0 if ok else 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
