"""命令行入口：无界面自测 / 回归 / 导出。

示例
----
# 一条可运行的验证命令（无需 GUI，全部样例在程序内生成）
python -m alignment_tool.cli selftest

# 已知位移回归，打印误差表
python -m alignment_tool.cli regress

# 生成一对样例并导出对齐产物
python -m alignment_tool.cli demo --out tmp/demo_out
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

from .estimator import estimate_shift
from .geometry import residual_stats, warp_align
from .io_utils import export_bundle
from .regression import default_cases, run_regression, summarize
from .synthetic import make_pair, make_texture


def _print_table(rows) -> None:
    header = (
        f"{'kind':<12}{'true(dx,dy)':>16}{'est(dx,dy)':>18}"
        f"{'|err|px':>10}{'conf':>7}{'level':>8}{'RMSE':>9}{'valid':>8}"
    )
    print(header)
    print("-" * len(header))
    for r in rows:
        print(
            f"{r.kind:<12}"
            f"({r.true_dx:+6.2f},{r.true_dy:+6.2f})".rjust(16)
            + f"({r.est_dx:+6.2f},{r.est_dy:+6.2f})".rjust(18)
            + f"{r.err_norm:10.3f}{r.confidence:7.2f}{r.level:>8}"
            + f"{r.rmse:9.2f}{r.n_valid:8d}"
        )


def cmd_selftest(args: argparse.Namespace) -> int:
    """端到端冒烟测试：合成 -> 估计 -> 人工修正 -> 残差 -> 导出。"""
    print("== 1. 生成合成配对图（亚像素平移 + 亮度 + 噪声）==")
    pair = make_pair(
        kind="blobs", size=(args.width, args.height),
        dx=0.7, dy=-0.4, brightness=10.0, noise_sigma=3.0, seed=3,
    )
    print(f"   ref/moving 尺寸: {pair.ref.shape[::-1]}  "
          f"真值位移: dx={pair.dx:+.2f} dy={pair.dy:+.2f}")

    print("== 2. 相位相关 + ECC 估计位移 ==")
    est = estimate_shift(pair.ref, pair.moving)
    print(f"   方法={est.method}  估计: dx={est.dx:+.3f} dy={est.dy:+.3f}")
    print(f"   可信度={est.confidence:.2f} ({est.level})  "
          f"纹理分={est.texture_score:.2f}  次峰/主峰={est.peak_ratio:.2f}")
    for c in est.candidates[:3]:
        print(f"   候选峰: dx={c.dx:+.3f} dy={c.dy:+.3f} peak={c.peak:.4f}")

    print("== 3. 模拟人工修正 0.05px 后重新统计残差 ==")
    manual_dx, manual_dy = est.dx + 0.05, est.dy
    aligned = warp_align(pair.moving, manual_dx, manual_dy)
    stats = residual_stats(pair.ref, aligned, manual_dx, manual_dy)
    print(f"   有效像素={stats.n_valid}  填充像素={stats.n_filled}")
    print(f"   MAE={stats.mae:.3f}  RMSE={stats.rmse:.3f}  "
          f"亮度校正后 RMSE={stats.rmse_corrected:.3f}  "
          f"均值差={stats.mean_diff:+.3f}")

    print("== 4. 低纹理 / 重复条纹的可信度提示 ==")
    for kind in ("stripes", "low_texture"):
        p = make_pair(kind=kind, dx=0.7, dy=-0.4, noise_sigma=2.0, seed=5)
        e = estimate_shift(p.ref, p.moving)
        print(f"   [{kind:<11}] level={e.level:<6} conf={e.confidence:.2f} "
              f"峰比={e.peak_ratio:.2f} 纹理={e.texture_score:.2f}")
        for reason in e.reasons:
            print(f"      - {reason}")

    print("== 5. 导出带有效区域的对齐产物 ==")
    out = Path(args.out)
    paths = export_bundle(out, pair.ref, pair.moving, est.dx, est.dy)
    for name, p in paths.items():
        print(f"   {name:<10} -> {p}")

    print("== 6. 断言检查 ==")
    err = np.hypot(est.dx - pair.dx, est.dy - pair.dy)
    assert err < 0.5, f"正常纹理配准误差过大: {err:.3f}px"
    assert stats.n_valid + stats.n_filled == pair.ref.size
    assert stats.rmse_corrected <= stats.rmse + 1e-6
    for name in ("aligned", "valid_mask", "residual", "overlay"):
        assert paths[name].is_file()
    print(f"   OK: 配准误差 {err:.3f}px (<0.5px)，全部断言通过 ✓")
    return 0


def cmd_regress(args: argparse.Namespace) -> int:
    rows = run_regression(default_cases(), size=(args.width, args.height))
    _print_table(rows)
    s = summarize(rows)
    print("\n== 汇总 ==")
    for k, v in s.items():
        print(f"  {k}: {v}")
    if s["max_abs_err_textured"] >= 1.0:
        print("\n[警告] 纹理充分用例的最大误差达到 1px，需检查估计流程。", file=sys.stderr)
        return 2
    print(f"\n通过: 纹理充分用例平均误差 {s['mean_abs_err_textured']:.3f}px，"
          f"最大 {s['max_abs_err_textured']:.3f}px（均 <1px）✓")
    return 0


def cmd_demo(args: argparse.Namespace) -> int:
    pair = make_pair(
        kind=args.kind, size=(args.width, args.height),
        dx=args.dx, dy=args.dy,
        brightness=args.brightness, noise_sigma=args.noise, seed=args.seed,
    )
    est = estimate_shift(pair.ref, pair.moving)
    print(f"真值: ({pair.dx:+.3f}, {pair.dy:+.3f})  "
          f"估计: ({est.dx:+.3f}, {est.dy:+.3f})  "
          f"可信度: {est.confidence:.2f} ({est.level})")
    paths = export_bundle(args.out, pair.ref, pair.moving, est.dx, est.dy)
    for name, p in paths.items():
        print(f"  {name:<10} -> {p}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="alignment_tool", description="平移对齐工具（CLI）")
    sub = p.add_subparsers(dest="command", required=True)

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--width", type=int, default=320)
    common.add_argument("--height", type=int, default=256)

    sp = sub.add_parser("selftest", parents=[common], help="端到端冒烟验证")
    sp.add_argument("--out", default="tmp/selftest_out")
    sp.set_defaults(func=cmd_selftest)

    rp = sub.add_parser("regress", parents=[common], help="已知位移回归测试")
    rp.set_defaults(func=cmd_regress)

    dp = sub.add_parser("demo", parents=[common], help="生成单组样例并导出")
    dp.add_argument("--kind", default="blobs")
    dp.add_argument("--dx", type=float, default=0.7)
    dp.add_argument("--dy", type=float, default=-0.4)
    dp.add_argument("--brightness", type=float, default=10.0)
    dp.add_argument("--noise", type=float, default=3.0)
    dp.add_argument("--seed", type=int, default=0)
    dp.add_argument("--out", default="tmp/demo_out")
    dp.set_defaults(func=cmd_demo)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
