"""无界面核对: 生成测试图 -> 校验测试点原始数值、拉伸映射颜色、归一化差值。

用法:
  python -m bandview.verify [目录]
不传目录时使用系统临时目录。退出码 0 表示全部通过。
"""

from __future__ import annotations

import os
import sys
import tempfile

import numpy as np

from .constants import (
    HIGH_CLIP_RGBA,
    LOW_CLIP_RGBA,
    LOW_DENOM_RGBA,
    NODATA_RGBA,
)
from .generate import generate_sample_dataset
from .io_utils import load_band
from .rendering import normalized_difference, render_composite, render_grayscale, render_ndvi


def _approx_equal(a: float, b: float, tol: float = 1.0) -> bool:
    return abs(a - b) <= tol


def run_checks(outdir: str) -> tuple[bool, list[str]]:
    meta = generate_sample_dataset(outdir)
    log: list[str] = []
    ok = True

    def check(cond: bool, msg: str) -> None:
        nonlocal ok
        log.append(("PASS " if cond else "FAIL ") + msg)
        ok = ok and cond

    nodata = float(meta["nodata_value"])
    bands = {
        name: load_band(os.path.join(outdir, f"{name}.npy"), nodata=nodata)
        for name in meta["band_names"]
    }
    shape = (meta["height"], meta["width"])
    for name, band in bands.items():
        check(band.shape == shape, f"{name} 尺寸 {band.shape}")
        check(band.dtype == np.dtype(meta["dtype"]), f"{name} 保留高位深 dtype={band.dtype}")

    # 1) 测试点原始数值与元数据一致, 无值点掩码正确
    for point in meta["test_points"]:
        x, y = point["x"], point["y"]
        for name, expected in point["values"].items():
            actual = int(bands[name].data[y, x])
            check(actual == expected, f"测试点 {point['label']} ({x},{y}) {name}={actual} 期望 {expected}")
        if point["label"] == "nodata":
            check(
                all(not bands[n].valid[y, x] for n in bands),
                "无值测试点在所有波段均标记为无效",
            )

    # 2) 全图自动范围下灰度渲染: 最小有效像素 -> 近黑, 最大 -> 近白, 无值 -> 品红
    b1 = bands["b1"]
    stats = b1.stats_in(None)
    gray = render_grayscale(b1, stats.minimum, stats.maximum, show_clip=True)
    valid_min_yx = np.unravel_index(
        np.argmin(np.where(b1.valid, b1.data.astype(np.float64), np.inf)), b1.shape
    )
    valid_max_yx = np.unravel_index(
        np.argmax(np.where(b1.valid, b1.data.astype(np.float64), -np.inf)), b1.shape
    )
    check(tuple(gray[valid_min_yx][:3]) == (0, 0, 0), "最小有效像素拉伸为黑色")
    check(tuple(gray[valid_max_yx][:3]) == (255, 255, 255), "最大有效像素拉伸为白色")
    nodata_ys, nodata_xs = np.nonzero(~b1.valid)
    check(tuple(gray[nodata_ys[0], nodata_xs[0]]) == NODATA_RGBA, "无值像素渲染为品红覆盖色")

    # 3) 窄范围必然同时产生上下界裁剪覆盖色, 且可与无值区分
    span = stats.maximum - stats.minimum
    narrow_lo = stats.minimum + 0.25 * span
    narrow_hi = stats.minimum + 0.75 * span
    narrow = render_grayscale(b1, narrow_lo, narrow_hi, show_clip=True)
    low_mask = np.all(narrow == LOW_CLIP_RGBA, axis=2)
    high_mask = np.all(narrow == HIGH_CLIP_RGBA, axis=2)
    check(low_mask.sum() > 0, f"窄范围下有 {int(low_mask.sum())} 个下界裁剪点 (青色)")
    check(high_mask.sum() > 0, f"窄范围下有 {int(high_mask.sum())} 个上界裁剪点 (红色)")
    check(not np.any(low_mask & ~b1.valid), "裁剪标记不落在无值像素上")

    # 4) 合成: b1/b3/b4 -> R/G/B, 树叶与灰路颜色可分
    comp_ranges = tuple(
        (bands[n].stats_in(None).minimum, bands[n].stats_in(None).maximum)
        for n in ("b1", "b3", "b4")
    )
    comp = render_composite(
        (bands["b1"], bands["b3"], bands["b4"]),
        comp_ranges,
    )
    lx, ly = meta["leaf_pixel"]
    rx, ry = meta["road_pixel"]
    leaf_rgb = comp[ly, lx, :3].astype(int)
    road_rgb = comp[ry, rx, :3].astype(int)
    color_dist = float(np.abs(leaf_rgb - road_rgb).sum())
    check(color_dist > 60, f"合成图树叶 {tuple(leaf_rgb)} 与灰路 {tuple(road_rgb)} 颜色距离 {color_dist:.0f}")

    # 5) 归一化差值: b4-b3 / b4+b3, 树叶应为正; 交换后反号
    eps = float(meta["denom_eps_suggested"])
    ndvi, valid, low_denom = normalized_difference(bands["b4"], bands["b3"], eps)
    ndvi_swap, _, _ = normalized_difference(bands["b3"], bands["b4"], eps)
    check(ndvi[ly, lx] > 0.3, f"树叶 NDVI(b4,b3)={ndvi[ly, lx]:.4f} 明显为正")
    check(
        _approx_equal(float(ndvi[ly, lx]), float(-ndvi_swap[ly, lx]), tol=1e-9),
        "交换 a/b 后读数精确反号",
    )
    check(bool(np.allclose(ndvi[valid], -ndvi_swap[valid], atol=1e-9)), "全图交换后整体反号")

    # 6) 分母过小的独立显示: 构造一对和为 0 的波段
    a_data = np.array([[5, -5, 7], [0, 8, 9]], dtype=np.float64)
    b_data = np.array([[-5, 5, 2], [0, 0, 0]], dtype=np.float64)
    from .model import BandData as _BD

    fa = _BD("fa", a_data, np.ones_like(a_data, dtype=bool))
    fb = _BD("fb", b_data, np.ones_like(b_data, dtype=bool))
    rgba, nd, vd, ld = render_ndvi(fa, fb, denom_eps=1e-6)
    check(bool(ld[0, 0]) and bool(ld[0, 1]), "|a+b|≈0 的像素进入分母过小掩码")
    check(tuple(rgba[0, 0]) == LOW_DENOM_RGBA, "分母过小渲染为独立蓝色")
    check(_approx_equal(float(nd[0, 2]), (7 - 2) / 9.0, tol=1e-12), "正常像素 NDVI 数值正确")
    check(_approx_equal(float(nd[1, 1]), 1.0, tol=1e-12), "b=0 时 (a-0)/(a+0) 落在 +1 边界")
    check(_approx_equal(float(nd[1, 2]), 1.0, tol=1e-12), "b=0 时读数稳定为 +1")

    # 7) 浮点 NaN 作为无值
    fdata = np.array([[1.0, np.nan], [3.0, 4.0]], dtype=np.float32)
    fband = _BD("f", fdata, np.isfinite(fdata))
    check(not fband.valid[0, 1] and fband.valid[0, 0], "浮点 NaN 自动判为无值")
    fstats = fband.stats_in(None)
    check(fstats.count == 3 and fstats.minimum == 1.0, "统计自动跳过无值像素")

    # 8) PNG 与 npy 内容一致 (Qt 16 位往返)
    png_band = load_band(os.path.join(outdir, "b2.png"), nodata=nodata)
    check(np.array_equal(png_band.data, bands["b2"].data), "16 位 PNG 与 npy 像素值完全一致")

    return ok, log


def main(argv: list[str] | None = None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    outdir = argv[0] if argv else tempfile.mkdtemp(prefix="bandview_verify_")
    target = os.path.join(outdir, "bandview_sample")
    ok, log = run_checks(target)
    print("\n".join(log))
    print(f"\n数据目录: {target}")
    print("结果:", "全部通过 ✅" if ok else "存在失败 ❌")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
