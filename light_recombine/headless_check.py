"""无头验证脚本: 不启动 GUI 也能跑重组与导出。

用法:
  # 内置示例: 对比全量合成 vs 镜面压到 0, 输出 PNG 与逐像素差异
  python -m light_recombine.headless_check --example --outdir out/

  # 真实 npy 目录 + 参数 JSON 复现
  python -m light_recombine.headless_check --npy-dir DIR --params p.json --outdir out/
"""

from __future__ import annotations

import argparse
import json
import os

import numpy as np

from .channels import CHANNEL_ORDER, ChannelSet, LoadedChannel, LoadStatus
from .composite import DisplayParams, ParamState, compute_composite
from .example_scene import build_example_scene
from .io_npy import load_channels, load_params
from .io_png import write_png_rgb8


def _example_set() -> ChannelSet:
    scene = build_example_scene()
    return ChannelSet(channels={
        n: LoadedChannel(n, LoadStatus.OK, data=scene[n]) for n in scene
    })


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="无头灯光重组验证")
    ap.add_argument("--example", action="store_true", help="使用内置示例")
    ap.add_argument("--npy-dir", help="含 base/emission/diffuse/specular npy 的目录")
    ap.add_argument("--params", help="调整参数 JSON, 不给则倍率全 1")
    ap.add_argument("--spec-scale", type=float,
                    help="直接指定镜面倍率 (例如 0 = 完全压掉)")
    ap.add_argument("--outdir", required=True)
    args = ap.parse_args(argv)

    os.makedirs(args.outdir, exist_ok=True)

    if args.example:
        cs = _example_set()
    elif args.npy_dir:
        paths = {n: os.path.join(args.npy_dir, f"{n}.npy")
                 for n in CHANNEL_ORDER}
        cs = load_channels(paths)
    else:
        ap.error("需要 --example 或 --npy-dir")

    if cs.reference_shape is None:
        print("没有可用通道, 退出。")
        return 2

    params = ParamState()
    display = DisplayParams()
    if args.params:
        params, display, _ = load_params(args.params)
    if args.spec_scale is not None:
        params.multipliers["specular"] = args.spec_scale

    # 基准: 镜面倍率 1.0; 对照: 当前参数
    base_params = ParamState()
    full = compute_composite(cs, base_params, display)
    adjusted = compute_composite(cs, params, display)

    write_png_rgb8(os.path.join(args.outdir, "full.png"), full.srgb8)
    write_png_rgb8(os.path.join(args.outdir, "adjusted.png"), adjusted.srgb8)
    for name in CHANNEL_ORDER:
        if adjusted.raw[name] is not None:
            write_png_rgb8(
                os.path.join(args.outdir, f"channel_{name}.png"),
                _channel_screen(cs, params, display, name))

    # 关键验收: 压镜面时 diffuse 逐像素不变
    diff = np.abs(adjusted.contributions["diffuse"]
                  - full.contributions["diffuse"])
    spec_kept = adjusted.contributions["specular"]
    report = {
        "specular_multiplier": params.multipliers["specular"],
        "diffuse_max_abs_diff_vs_full": float(diff.max()),
        "specular_max_after_scale": float(spec_kept.max()),
        "linear_max_before_display": float(adjusted.linear.max()),
        "linear_min_before_display": float(adjusted.linear.min()),
        "missing_channels": adjusted.missing,
        "outputs": sorted(os.listdir(args.outdir)),
    }
    with open(os.path.join(args.outdir, "verify_report.json"), "w",
              encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2))

    if params.multipliers["specular"] != 1.0:
        if diff.max() == 0.0:
            print("验收通过: 镜面倍率改动后, 漫反射贡献逐像素完全保留。")
            return 0
        print("验收失败: 漫反射贡献发生了不该有的变化。")
        return 1
    return 0


def _channel_screen(cs, params: ParamState, display: DisplayParams,
                    name: str) -> np.ndarray:
    from .composite import display_image
    res = compute_composite(
        cs, _solo_params(name, params), display)
    return display_image(res.contributions[name], display)


def _solo_params(name: str, src: ParamState) -> ParamState:
    p = ParamState(multipliers=dict(src.multipliers),
                   solo={n: n == name for n in CHANNEL_ORDER})
    return p


if __name__ == "__main__":
    raise SystemExit(main())
