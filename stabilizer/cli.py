"""命令行入口: 分析并导出防抖视频, 便于脚本化验证。"""
from __future__ import annotations

import argparse
import json

from . import pipeline


def main() -> None:
    ap = argparse.ArgumentParser(description="本地视频防抖 (命令行)")
    ap.add_argument("input", help="输入 mp4 (≤15s, ≤720p, CFR)")
    ap.add_argument("out_dir", help="输出目录")
    ap.add_argument("--sigma", type=float, default=8.0,
                    help="平滑强度, 高斯核标准差(帧), 默认 8")
    ap.add_argument("--cuts", type=int, nargs="*", default=None,
                    help="手动硬切首帧; 不给则使用自动检测结果")
    args = ap.parse_args()

    cache = pipeline.analyze_video(args.input)
    cuts = args.cuts if args.cuts is not None else cache.motions.auto_cuts
    _, geo = pipeline.compute(cache, cuts, args.sigma)
    out = pipeline.render_video(
        cache, geo, cuts, f"{args.out_dir}/output.mp4",
        preview=False, draw_overlay=False,
        progress_cb=lambda i, n: print(f"\r渲染 {i}/{n}", end=""),
    )
    print()
    sidecar = pipeline.build_sidecar(cache, geo, cuts, args.sigma, "output.mp4")
    p = pipeline.save_sidecar(sidecar, f"{args.out_dir}/output.sidecar.json")
    summary = {
        "output": str(out),
        "sidecar": str(p),
        "auto_cuts": cache.motions.auto_cuts,
        "used_cuts": sidecar["params"]["cut_frames"],
        "shots": [
            {"shot": s["index"], "zoom": s["uniform_zoom"],
             "retained": s["retained_area_ratio"]}
            for s in sidecar["shots"]
        ],
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
