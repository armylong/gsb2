"""命令行入口：无头自检 / 启动 PySide6 图形界面。"""
from __future__ import annotations

import argparse
import os
import sys
import time

import numpy as np

from . import __version__
from .analysis import (
    boundary_mask,
    boundary_transitions,
    error_map,
    error_stats,
    error_to_rgb,
    level_histogram,
)
from .levels import describe_levels, parse_custom_levels, spaced_levels, uniform_levels
from .patterns import PATTERN_KINDS, generate_pattern
from .pngio import read_png, write_png
from .quantize import METHODS, add_noise, quantize


def run_selftest(outdir: str, size: int = 256) -> int:
    """不依赖 GUI 的端到端验证，返回退出码。"""
    os.makedirs(outdir, exist_ok=True)
    failures: list[str] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        mark = "PASS" if ok else "FAIL"
        print(f"[{mark}] {name}" + (f" -- {detail}" if detail else ""))
        if not ok:
            failures.append(name)

    t0 = time.perf_counter()

    # 1. 全部测试图都能生成，形状/取值/透明区正确
    for kind in PATTERN_KINDS:
        gray, alpha = generate_pattern(kind, size)
        base_ok = (gray.shape == (size, size) and gray.dtype == np.float64
                   and 0.0 <= gray.min() and gray.max() <= 1.0
                   and alpha.shape == gray.shape)
        if kind == "grayscale":
            ok = base_ok  # 纯灰度图无透明区
        else:
            ok = base_ok and np.any(alpha == 0.0)  # 其余样例带透明区
        check(f"pattern:{kind}", bool(ok), f"shape={gray.shape}")

    # 2. 三种间距方案 + 自定义级别解析
    lu = spaced_levels(6, "uniform")
    ld = spaced_levels(6, "gamma-dark", 2.2)
    ll = spaced_levels(6, "gamma-light", 2.2)
    check("levels:uniform", np.allclose(lu, np.linspace(0, 1, 6)))
    check("levels:gamma-dark-denser-in-shadow",
          (ld[1] - ld[0]) < (lu[1] - lu[0]) < (ll[1] - ll[0]),
          describe_levels(ld))
    custom = parse_custom_levels("0 32 64 128 255")
    check("levels:custom-8bit", custom.size == 5 and abs(custom[-1] - 1.0) < 1e-9,
          describe_levels(custom))
    custom_f = parse_custom_levels("0, 0.25, 0.5, 0.75, 1")
    check("levels:custom-float", np.allclose(custom_f, [0, .25, .5, .75, 1]))

    # 3. 五种量化方法输出都严格落在级别集合上；透明像素保持不变
    gray, alpha = generate_pattern("composite", size)
    levels = spaced_levels(8, "gamma-dark", 2.2)
    noisy = add_noise(gray, alpha, strength=0.02, seed=42)
    trans = alpha == 0
    for method in METHODS:
        q = quantize(noisy, alpha, levels, method=method, seed=42)
        unique_vals = np.unique(q[alpha > 0])
        on_levels = all(np.any(np.abs(levels - v) < 1e-9) for v in unique_vals)
        transparent_ok = np.allclose(q[trans], noisy[trans])
        check(f"quantize:{method}", on_levels and transparent_ok,
              f"levels_used={unique_vals.size}/{levels.size}")

    # 4. 噪声可按种子复现，且不同种子结果不同
    n1 = add_noise(gray, alpha, 0.03, seed=7)
    n2 = add_noise(gray, alpha, 0.03, seed=7)
    n3 = add_noise(gray, alpha, 0.03, seed=8)
    check("noise:reproducible-seed", np.array_equal(n1, n2))
    check("noise:different-seed-differs", not np.array_equal(n1, n3))
    n_zero = add_noise(gray, alpha, 0.0, seed=1)
    check("noise:zero-strength-identity", np.array_equal(n_zero, gray))
    check("noise:transparent-untouched", np.allclose(n1[trans], gray[trans]))

    # 5. 向下取级产生硬色带（均匀坡度上边界数 == 级别数-1）
    g_flat, a_flat = generate_pattern("gradient", size)
    lv5 = uniform_levels(5)
    q_floor = quantize(g_flat, a_flat, lv5, method="floor")
    bm = boundary_mask(q_floor, a_flat)
    # 每条不透明扫描线上应有 4 条竖直边界
    middle_row = size // 2
    edges_on_row = np.count_nonzero(bm[middle_row, :]) // 2
    check("banding:floor-boundary-count", edges_on_row == 4, f"edges={edges_on_row}")
    hist = level_histogram(q_floor, a_flat, lv5)
    check("histogram:pixels-sum-to-opaque", int(hist.sum()) == int(np.count_nonzero(a_flat)),
          f"sum={hist.sum()}")
    transitions = boundary_transitions(q_floor, a_flat, lv5, max_rows=8)
    check("banding:transitions-listed", len(transitions) > 0, f"first={transitions[:1]}")

    # 6. 抖动方法边界更碎（边界像素显著多于 floor）
    q_fs = quantize(noisy, alpha, levels, method="fs", seed=1)
    bm_fs = boundary_mask(q_fs, alpha)
    check("dither:fs-breaks-bands", bm_fs.sum() > bm.sum())

    # 7. 误差图统计 + 往返 PNG 读写（灰阶图保留 alpha）
    err = error_map(noisy, q_fs, alpha)
    stats = error_stats(err, alpha)
    check("error:stats-sane", 0 <= stats["rmse"] <= 1 and stats["count"] == int((alpha > 0).sum()),
          f"rmse={stats['rmse']:.4f}")
    gray_path = os.path.join(outdir, "quantized_gray.png")
    write_png(gray_path, q_fs, alpha)
    rg, ra = read_png(gray_path)
    roundtrip_gray = np.max(np.abs(rg - np.round(q_fs * 255) / 255.0))
    roundtrip_alpha = np.max(np.abs(ra - np.round(alpha * 255) / 255.0))
    check("png:gray-alpha-roundtrip", roundtrip_gray < 1.5 / 255 and roundtrip_alpha < 1.5 / 255,
          f"gray_err={roundtrip_gray:.4f}")

    err_rgb = error_to_rgb(err, alpha)
    err_path = os.path.join(outdir, "error_map.png")
    write_png(err_path, err_rgb, alpha)
    _, ra2 = read_png(err_path)
    check("png:error-map-alpha-kept", np.allclose(ra2, np.round(alpha * 255) / 255, atol=1.5 / 255))

    # 8. 外部灰度 PNG 也能再量化（8-bit 往返后用容差比较，避免浮点精确相等）
    q_loaded = quantize(rg, ra, uniform_levels(4), method="nearest")
    target4 = uniform_levels(4)
    used = np.unique(q_loaded[ra > 0])
    on_target = all(np.min(np.abs(target4 - v)) < 1e-6 for v in used)
    check("load:external-png-quantizable", on_target, f"values={np.round(used, 4).tolist()}")

    # 附：把原始综合样例也导出，方便人工查看
    write_png(os.path.join(outdir, "source_composite.png"), noisy, alpha)

    elapsed = time.perf_counter() - t0
    print(f"\nselftest {len(failures)} failure(s), {elapsed:.2f}s, outputs in {outdir}")
    print(f"bandviewer {__version__}, python {sys.version.split()[0]}, numpy {np.__version__}")
    return 1 if failures else 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="bandviewer",
        description="灰阶量化色带观察器：连续高光转指定灰阶并观察色带",
    )
    parser.add_argument("--selftest", action="store_true", help="运行无头端到端验证后退出")
    parser.add_argument("--outdir", default="tmp/selftest", help="自检产物输出目录")
    parser.add_argument("--size", type=int, default=256, help="自检测试图边长")
    parser.add_argument("--version", action="store_true", help="打印版本后退出")
    args = parser.parse_args(argv)

    if args.version:
        print(__version__)
        return 0
    if args.selftest:
        return run_selftest(args.outdir, args.size)

    # 延迟导入，保证 --selftest 在没有 PySide6 的环境里也能跑
    from .app import run_gui

    return run_gui()


if __name__ == "__main__":
    raise SystemExit(main())
