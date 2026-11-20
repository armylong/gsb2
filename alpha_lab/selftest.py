"""数值小样: 核对 over 混合、直通/预乘格式转换、sRGB/线性转换。

可独立运行:   python -m alpha_lab.selftest          (或 python -m alpha_lab --selftest)
GUI 里"运行自检"按钮也调用这里的 run_all()。
"""

from __future__ import annotations

import numpy as np

from . import core

TOL = 1e-5


def check_srgb_roundtrip():
    x = np.linspace(0.0, 1.0, 1001, dtype=np.float32)
    err = float(np.max(np.abs(core.linear_to_srgb(core.srgb_to_linear(x)) - x)))
    return ("sRGB<->线性 往返", err < 1e-4, f"max|Δ|={err:.2e}")


def check_premult_roundtrip():
    rng = np.random.default_rng(42)
    rgb = rng.random((64, 64, 3), dtype=np.float32)
    a = rng.random((64, 64), dtype=np.float32) + 0.01  # 避开 a=0 的不可恢复情形
    back = core.premult_to_straight(core.straight_to_premult(rgb, a), a)
    err = float(np.max(np.abs(back - rgb)))
    return ("直通->预乘->直通 往返", err < TOL, f"max|Δ|={err:.2e}")


def check_over_known_values():
    # 50% 不透明红 叠 不透明蓝 = (0.5, 0, 0.5), alpha=1
    fg_rgb = np.array([[[1.0, 0.0, 0.0]]], dtype=np.float32)
    fg_a = np.array([[0.5]], dtype=np.float32)
    bg_rgb = np.array([[[0.0, 0.0, 1.0]]], dtype=np.float32)
    out = core.composite_straight(fg_rgb, fg_a, bg_rgb, space="srgb")
    expect = np.array([[[0.5, 0.0, 0.5]]], dtype=np.float32)
    err = float(np.max(np.abs(out - expect)))
    return ("over 混合已知值 (sRGB 空间)", err < TOL, f"out={out.ravel().tolist()}")


def check_over_premult_equivalent():
    # 预乘形式的 over 必须与直通形式结果一致
    rng = np.random.default_rng(7)
    fg_rgb = rng.random((32, 32, 3), dtype=np.float32)
    fg_a = rng.random((32, 32), dtype=np.float32)
    bg_rgb = rng.random((32, 32, 3), dtype=np.float32)
    direct = core.composite_straight(fg_rgb, fg_a, bg_rgb, space="srgb")
    out_p, out_a = core.over_premult(
        core.straight_to_premult(fg_rgb, fg_a), fg_a, bg_rgb, np.ones_like(fg_a)
    )
    err = float(np.max(np.abs(out_p - direct))) + float(np.max(np.abs(out_a - 1.0)))
    return ("预乘 over ≡ 直通混合", err < TOL, f"max|Δ|={err:.2e}")


def check_linear_midgray():
    # 线性空间里 50% 覆盖的白叠黑 = 0.5 线性 ≈ 0.7354 sRGB (约 188/255), 而非 0.5
    fg_rgb = np.ones((1, 1, 3), dtype=np.float32)
    fg_a = np.array([[0.5]], dtype=np.float32)
    bg_rgb = np.zeros((1, 1, 3), dtype=np.float32)
    out = float(core.composite_straight(fg_rgb, fg_a, bg_rgb, space="linear")[0, 0, 0])
    expect = 0.7353569830524494  # linear_to_srgb(0.5)
    err = abs(out - expect)
    return ("线性空间中间灰 = 0.7354", err < 1e-4, f"out={out:.6f} (≈{round(out*255)}/255)")


def check_srgb_midgray():
    # 对照组: sRGB 空间直接加权得到 0.5 (128/255) —— 两者差 60 个灰阶
    fg_rgb = np.ones((1, 1, 3), dtype=np.float32)
    fg_a = np.array([[0.5]], dtype=np.float32)
    bg_rgb = np.zeros((1, 1, 3), dtype=np.float32)
    out = float(core.composite_straight(fg_rgb, fg_a, bg_rgb, space="srgb")[0, 0, 0])
    err = abs(out - 0.5)
    return ("sRGB 空间中间灰 = 0.5", err < TOL, f"out={out:.6f} (128/255)")


def check_alpha_zero_passthrough():
    # A=0 时合成结果必须完全等于背景, 且直通 RGB 数据本身不丢失
    fg_rgb = np.array([[[1.0, 1.0, 1.0]]], dtype=np.float32)  # 白色污染
    fg_a = np.array([[0.0]], dtype=np.float32)
    bg_rgb = np.array([[[0.1, 0.2, 0.3]]], dtype=np.float32)
    out = core.composite_straight(fg_rgb, fg_a, bg_rgb, space="srgb")
    err = float(np.max(np.abs(out - bg_rgb)))
    kept = bool(np.all(fg_rgb == 1.0))  # 原始通道数据仍在, 界面可展示
    return ("A=0 不影响合成且原始 RGB 保留", err < TOL and kept,
            f"max|Δ|={err:.2e}, raw RGB kept={kept}")


def check_u8_roundtrip():
    x = np.linspace(0.0, 1.0, 256, dtype=np.float32)
    err = float(np.max(np.abs(core.from_u8(core.to_u8(x)) - x)))
    return ("float<->uint8 量化误差 ≤ 1/510", err <= 1 / 510 + 1e-6, f"max|Δ|={err:.2e}")


ALL_CHECKS = [
    check_srgb_roundtrip,
    check_premult_roundtrip,
    check_over_known_values,
    check_over_premult_equivalent,
    check_linear_midgray,
    check_srgb_midgray,
    check_alpha_zero_passthrough,
    check_u8_roundtrip,
]


def run_all() -> list[tuple[str, bool, str]]:
    """返回 [(名称, 是否通过, 详情)]。"""
    results = []
    for fn in ALL_CHECKS:
        try:
            results.append(fn())
        except Exception as exc:  # 自检不应崩溃, 失败也算结果
            results.append((fn.__name__, False, f"异常: {exc!r}"))
    return results


def main() -> int:
    results = run_all()
    width = max(len(r[0]) for r in results)
    failed = 0
    for name, ok, detail in results:
        mark = "PASS" if ok else "FAIL"
        failed += not ok
        print(f"[{mark}] {name:<{width}}  {detail}")
    print(f"\n{len(results) - failed}/{len(results)} 项通过")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
