#!/usr/bin/env python3
"""Self-check covering the acceptance criteria.

Run with::

    python verify.py            # human readable report
    python verify.py --quiet    # exit code only

Checks
-----
1. Single-image Laplacian decomposition rebuilds the input exactly
   (odd sizes included, no shifted/dropped rows or columns).
2. Constant masks: all-1 reproduces A, all-0 reproduces B (uint8 exact).
3. Odd image sizes survive decomposition, blending and export.
4. Export round trip: the PNG on disk equals the preview, the mask PNG equals
   the mask at original resolution, and the record holds the level count.
5. Linear-light blending against independent colour samples, with the
   tolerance stated below.

Exit status is 0 only when every check passes.
"""

from __future__ import annotations

import argparse
import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from mblend.color import (  # noqa: E402
    linear_to_rgb8,
    rgb8_to_linear,
    srgb_to_linear,
)
from mblend.engine import MODE_NAIVE, MODE_PYRAMID, BlendConfig, BlendEngine  # noqa: E402
from mblend.export import export_result, read_png  # noqa: E402
from mblend.pyramid import (  # noqa: E402
    build_pyramid,
    max_levels,
    reconstruct_pyramid,
)
from mblend.samples import make_sample  # noqa: E402

# Tolerances used throughout the report.
RECONSTRUCTION_TOL = 1e-5      # linear light, float32 round trip
PYRAMID_ENDPOINT_TOL = 1e-6    # linear light before the sRGB conversion
COLOUR_TOL_SRGB8 = 1           # one 8-bit code value
EXPORT_TOL_SRGB8 = 0           # PNG bytes must be identical to the preview

_failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    status = "PASS" if ok else "FAIL"
    print(f"[{status}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        _failures.append(name)


def check_reconstruction() -> None:
    for size in ((97, 131), (643, 979), (401, 3), (5, 5)):
        image = np.random.default_rng(hash(size) % 2**32).random(
            (*size, 3), dtype=np.float32
        )
        levels = max_levels(*size)
        pyramid = build_pyramid(image, levels)
        rebuilt = reconstruct_pyramid(pyramid)
        error = float(np.max(np.abs(rebuilt - image)))
        ok = rebuilt.shape == image.shape and error <= RECONSTRUCTION_TOL
        detail = f"{size[1]}×{size[0]}, {levels} 层, 最大误差 {error:.2e}"
        if rebuilt.shape != image.shape:
            detail += f", 尺寸 {rebuilt.shape} ≠ {image.shape}"
        check(f"单图分解重建 {size[1]}×{size[0]}", ok, detail)


def check_constant_endpoints() -> None:
    a, b = make_sample("odd_size")
    engine = BlendEngine(a, b)
    height, width = a.shape[:2]
    levels = min(6, engine.max_levels)
    mask_a = np.ones((height, width), dtype=np.float32)
    mask_b = np.zeros((height, width), dtype=np.float32)

    out_a = linear_to_rgb8(engine.result(mask_a, BlendConfig(MODE_PYRAMID, levels)))
    out_b = linear_to_rgb8(engine.result(mask_b, BlendConfig(MODE_PYRAMID, levels)))
    check(
        "掩码全 1 → 完整 A (多分辨率)",
        np.array_equal(out_a, a),
        f"8-bit 最大差 {int(np.abs(out_a.astype(int) - a.astype(int)).max())}",
    )
    check(
        "掩码全 0 → 完整 B (多分辨率)",
        np.array_equal(out_b, b),
        f"8-bit 最大差 {int(np.abs(out_b.astype(int) - b.astype(int)).max())}",
    )

    naive_a = linear_to_rgb8(engine.result(mask_a, BlendConfig(MODE_NAIVE, levels)))
    naive_b = linear_to_rgb8(engine.result(mask_b, BlendConfig(MODE_NAIVE, levels)))
    check("掩码全 1 → 完整 A (普通混合)", np.array_equal(naive_a, a))
    check("掩码全 0 → 完整 B (普通混合)", np.array_equal(naive_b, b))

    float_a = engine.result(mask_a, BlendConfig(MODE_PYRAMID, levels))
    float_b = engine.result(mask_b, BlendConfig(MODE_PYRAMID, levels))
    err = max(
        float(np.max(np.abs(float_a - engine.a_linear))),
        float(np.max(np.abs(float_b - engine.b_linear))),
    )
    check(
        "线性光端点误差",
        err <= PYRAMID_ENDPOINT_TOL,
        f"最大 {err:.2e} ≤ {PYRAMID_ENDPOINT_TOL:.0e}",
    )


def check_identical_pair() -> None:
    a, _ = make_sample("odd_size")
    engine = BlendEngine(a, a)
    height, width = a.shape[:2]
    mask = np.tile(
        np.linspace(0.0, 1.0, width, dtype=np.float32)[None, :], (height, 1)
    )
    for levels in (2, 4, 6):
        out = linear_to_rgb8(engine.result(mask, BlendConfig(MODE_PYRAMID, levels)))
        check(
            f"相同图片混合无接缝/亮度偏移 ({levels} 层)",
            np.array_equal(out, a),
            "与输入逐字节一致",
        )


def check_odd_export() -> None:
    a, b = make_sample("odd_size")
    height, width = a.shape[:2]
    mask = np.tile(
        np.linspace(0.0, 1.0, width, dtype=np.float32)[None, :], (height, 1)
    )
    engine = BlendEngine(a, b)
    result = engine.result(mask, BlendConfig(MODE_PYRAMID, 4))
    with tempfile.TemporaryDirectory() as directory:
        info = export_result(
            directory, "odd", result, mask, mode=MODE_PYRAMID, levels=4
        )
        png = read_png(info.output_png)
        mask_png = read_png(info.mask_png)
        record = __import__("json").loads(Path(info.record_json).read_text("utf-8"))

    check(
        "奇数尺寸导出保持原分辨率",
        png.shape == (height, width, 3),
        f"{png.shape[1]}×{png.shape[0]}",
    )
    check(
        "导出回读与预览逐字节一致",
        np.array_equal(png, linear_to_rgb8(result)),
        f"容差 {EXPORT_TOL_SRGB8}",
    )
    check(
        "掩码导出为原尺寸灰度",
        mask_png.shape == (height, width),
        f"{mask_png.shape[1]}×{mask_png.shape[0]}",
    )
    check(
        "导出记录含当前层数",
        record["levels"] == 4 and record["mode"] == MODE_PYRAMID,
        f"mode={record['mode']}, levels={record['levels']}",
    )


def check_linear_light() -> None:
    """Independent colour samples; blending must happen in linear light."""
    # 50 % black + 50 % white in linear light -> 188 sRGB, not 128.
    black = rgb8_to_linear(np.array([[[0, 0, 0]]], np.uint8))
    white = rgb8_to_linear(np.array([[[255, 255, 255]]], np.uint8))
    grey = linear_to_rgb8(0.5 * black + 0.5 * white)[0, 0]
    check(
        "50% 黑 + 50% 白 → 188 (线性光)",
        abs(int(grey[0]) - 188) <= COLOUR_TOL_SRGB8,
        f"得到 {int(grey[0])}, 容差 ±{COLOUR_TOL_SRGB8}",
    )

    # 25 % pure red + 75 % black -> 137 sRGB.
    red = rgb8_to_linear(np.array([[[255, 0, 0]]], np.uint8))
    mixed = linear_to_rgb8(0.25 * red)[0, 0]
    check(
        "25% 纯红 → 137 (线性光)",
        abs(int(mixed[0]) - 137) <= COLOUR_TOL_SRGB8
        and int(mixed[1]) == 0
        and int(mixed[2]) == 0,
        f"得到 {tuple(int(c) for c in mixed)}, 容差 ±{COLOUR_TOL_SRGB8}",
    )

    # sRGB encode/decode round trip.
    values = np.linspace(0.0, 1.0, 4096, dtype=np.float32)
    from mblend.color import linear_to_srgb

    error = float(np.max(np.abs(linear_to_srgb(srgb_to_linear(values)) - values)))
    check(
        "sRGB ↔ 线性光往返",
        error <= 1e-5,
        f"最大误差 {error:.2e} ≤ 1e-5",
    )


def check_odd_sizes() -> None:
    for height, width in ((97, 131), (643, 979), (65, 27)):
        levels = min(6, max_levels(height, width))
        a = np.random.default_rng(11).integers(
            0, 256, (height, width, 3), dtype=np.uint8
        )
        b = np.random.default_rng(12).integers(
            0, 256, (height, width, 3), dtype=np.uint8
        )
        engine = BlendEngine(a, b)
        mask = np.full((height, width), 0.5, dtype=np.float32)
        out = engine.result(mask, BlendConfig(MODE_PYRAMID, levels))
        check(
            f"奇数尺寸 {width}×{height} 混合不偏移/不少行列",
            out.shape == (height, width, 3),
            f"{levels} 层, 输出 {out.shape[1]}×{out.shape[0]}",
        )


def main() -> int:
    parser = argparse.ArgumentParser(description="多分辨率混合工具自检")
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    if args.quiet:
        import contextlib
        import io

        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            check_reconstruction()
            check_constant_endpoints()
            check_identical_pair()
            check_odd_export()
            check_linear_light()
            check_odd_sizes()
    else:
        print("多分辨率混合工具 · 自检")
        print("=" * 60)
        check_reconstruction()
        print()
        check_constant_endpoints()
        print()
        check_identical_pair()
        print()
        check_odd_export()
        print()
        check_linear_light()
        print()
        check_odd_sizes()
        print("=" * 60)
        if _failures:
            print(f"{len(_failures)} 项失败: {', '.join(_failures)}")
        else:
            print("全部通过")
            print(
                f"允许误差: 重建 ≤ {RECONSTRUCTION_TOL:.0e}（线性光）；"
                f"端点 ≤ {PYRAMID_ENDPOINT_TOL:.0e}（线性光）；"
                f"颜色与导出 ±{COLOUR_TOL_SRGB8} 个 8-bit 色阶"
                f"（导出要求 {EXPORT_TOL_SRGB8}）"
            )
    return 1 if _failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
