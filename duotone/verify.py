"""无头验证脚本（不需要显示器、不需要 PySide6）：

    python -m duotone.verify            # 跑全部检查
    python -m duotone.verify --out DIR  # 同时导出一整套样例文件

检查覆盖：色彩科学公式、叠印模型、四格检查用例、分色精度、
色域外误差分布、限墨重算、调墨曲线前后读数、PNG 读写往返。
"""

from __future__ import annotations

import argparse
import sys
import tempfile

import numpy as np

from . import color as C
from . import png
from .curves import ToneCurve
from .model import InkParams, composite, ink_usage
from .samples import make_check_strip, make_color_chart, make_gradient
from .separation import (OOG_THRESHOLD, apply_ink_limit, error_stats,
                         run_pipeline, separate_image)

PASS, FAIL = "PASS", "FAIL"
results: list[tuple[str, bool, str]] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    results.append((name, bool(cond), detail))
    print(f"  [{PASS if cond else FAIL}] {name}" + (f" — {detail}" if detail else ""))


def approx(a, b, tol=1e-4) -> bool:
    return bool(np.all(np.abs(np.asarray(a) - np.asarray(b)) <= tol))


def test_color_science() -> None:
    print("== 色彩科学 ==")
    # sRGB 往返
    x = np.linspace(0, 1, 37)
    check("sRGB 编解码往返", approx(C.rgb_to_srgb(C.srgb_to_rgb(x)), x, 1e-12))
    # 白点 D65 的 Lab 约为 (100, 0, 0)
    lab_w = C.rgb_to_lab(np.ones(3))
    check("D65 白点 Lab≈(100,0,0)", approx(lab_w, [100, 0, 0], 1e-4),
          f"得 {lab_w.round(5)}")
    lab_b = C.rgb_to_lab(np.zeros(3))
    check("黑点 L≈0", abs(lab_b[0]) < 1e-6, f"L={lab_b[0]:.2e}")

    # CIEDE2000 Sharma/Wu/Dalal(2005) 官方测试集（ciede2000testdata.txt），容差 0.01
    cases = [
        ([50.0, 2.6772, -79.7751], [50.0, 0.0, -82.7485], 2.0425),
        ([50.0, 3.1571, -77.2803], [50.0, 0.0, -82.7485], 2.8615),
        ([50.0, 2.8361, -74.0200], [50.0, 0.0, -82.7485], 3.4412),
        ([50.0, -1.3802, -84.2814], [50.0, 0.0, -82.7485], 1.0000),
        ([50.0, 0.0, 0.0], [50.0, -1.0, 2.0], 2.3669),
        ([50.0, 2.4900, -0.0010], [50.0, -2.4900, 0.0009], 7.1792),
    ]
    got = [float(C.deltaE00(np.array(a), np.array(b))) for a, b, _ in cases]
    want = [c[2] for c in cases]
    ok = all(abs(g - w) < 0.01 for g, w in zip(got, want))
    check("CIEDE2000 对照 Sharma 数据(4例)", ok,
          "得 " + ", ".join(f"{g:.4f}" for g in got) + " / 期望 " + ", ".join(f"{w:.4f}" for w in want))


def test_overprint_model() -> None:
    print("== 叠印模型与检查用例 ==")
    p = InkParams.from_hex("#f4ecd8", "#1a5fb4", "#c01c28")
    # 角点必须精确落在 纸/墨A/墨B/叠印 四个原色上
    check("(a=0,b=0)=空纸", approx(composite(0.0, 0.0, p), p.paper_rgb))
    check("(a=1,b=0)=纯墨A", approx(composite(1.0, 0.0, p), p.solid_a_rgb))
    check("(a=0,b=1)=纯墨B", approx(composite(0.0, 1.0, p), p.solid_b_rgb))
    check("(a=1,b=1)=叠印色", approx(composite(1.0, 1.0, p), p.overprint_rgb))
    # Demichel 面积比例之和为 1（能量守恒），中调结果应在纸与实底之间
    mid = composite(0.5, 0.5, p)
    check("中调反射率在合法范围内", float(mid.min()) >= 0.0 and float(mid.max()) <= 1.0)
    # 检查条恰好四格：纸、A、B、叠印
    strip, labels = make_check_strip("#1a5fb4", "#c01c28", "#f4ecd8")
    expect = [p.paper_rgb, p.solid_a_rgb, p.solid_b_rgb, p.overprint_rgb]
    ok = labels == ["paper", "ink_A_100%", "ink_B_100%", "overprint_A+B"]
    for i, e in enumerate(expect):
        ok &= approx(strip[:, strip.shape[1] // 8 + i * (strip.shape[1] // 4)], e)
    check("检查条四格顺序与颜色", ok, str(labels))


def test_separation_accuracy() -> None:
    print("== 分色精度（色域内目标应被近似还原）==")
    p = InkParams.from_hex("#f4ecd8", "#1a5fb4", "#c01c28")
    # 用模型自身生成一张图 —— 它严格落在色域内，分色应低误差还原
    rng = np.random.default_rng(7)
    aa = rng.random((24, 32))
    bb = rng.random((24, 32))
    target = composite(aa, bb, p)
    sep = separate_image(target, p, grid_n=41)
    de = sep["de00"]
    check("模型内目标 ΔE00 p95 < 1.0", float(np.percentile(de, 95)) < 1.0,
          f"p95={np.percentile(de, 95):.3f}, max={de.max():.3f}")
    # 覆盖率还原：网格离散+模式搜索精度约 0.05；折叠色域存在同色异解，
    # 此时覆盖率可不同但颜色仍一致（由上面的 ΔE00 检查兜底）
    check("模型内目标覆盖率还原误差 < 0.05",
          float(np.abs(sep["a"] - aa).max()) < 0.05 and float(np.abs(sep["b"] - bb).max()) < 0.05,
          f"max|da|={np.abs(sep['a']-aa).max():.4f}")


def test_oog_distribution() -> None:
    print("== 色域外颜色与误差分布 ==")
    p = InkParams.from_hex("#ffffff", "#1a5fb4", "#c01c28")
    chart = make_color_chart(swatch=24, cols=4)  # 含高饱和绿/紫，必然出域
    sep = separate_image(chart, p, grid_n=33)
    stats = error_stats(sep["de00"], sep["out_of_gamut_mask"])
    check("色卡存在色域外色块", stats["out_of_gamut_fraction"] > 0.0,
          f"出域比例={stats['out_of_gamut_fraction']:.2%}（阈值ΔE>{OOG_THRESHOLD}）")
    for k in ("mean", "median", "p95", "p99", "max", "fraction_de_gt_2", "fraction_de_gt_5"):
        check(f"误差分布含字段 {k}", k in stats and np.isfinite(stats[k]))
    check("max >= p95 >= median", stats["max"] >= stats["p95"] >= stats["median"])


def test_ink_limit_and_curves() -> None:
    print("== 限墨重算与调墨曲线 ==")
    p = InkParams.from_hex("#f4ecd8", "#1a5fb4", "#c01c28")
    grad = make_gradient(160, 96)
    tac = 1.2
    res = run_pipeline(grad, p, ToneCurve.gamma(1.0), ToneCurve.gamma(1.0), tac=tac, grid_n=33)
    check("限墨后 TAC 不超过上限", float((res.a_final + res.b_final).max()) <= tac + 1e-9,
          f"max TAC={(res.a_final+res.b_final).max():.3f}")
    # 限墨只应让颜色变差或持平（平均误差不下降）
    raw_mean = res.stats_raw["mean"]
    final_mean = res.stats_final["mean"]
    check("限墨后平均误差不优于未限", final_mean >= raw_mean - 1e-9,
          f"raw={raw_mean:.3f} -> limited={final_mean:.3f}")

    # 曲线：减墨 gamma>1，同位置读数单调变化
    g = ToneCurve.gamma(1.8)
    res2 = run_pipeline(grad, p, g, ToneCurve.linear(), tac=2.0, grid_n=33)
    probe = res2.probe(40, 70)
    check("探针包含各阶段同位置读数",
          {"plate_a_raw", "plate_a_after_curve", "plate_a_final", "de00_raw", "de00_final"}
          <= set(probe.keys()))
    check("gamma=1.8 使中调 A 版减墨",
          probe["plate_a_after_curve"] <= probe["plate_a_raw"] + 1e-12
          and (probe["plate_a_raw"] > 0),
          f"raw={probe['plate_a_raw']:.3f} -> curve={probe['plate_a_after_curve']:.3f}")
    # 端点守恒
    check("曲线端点守恒 f(0)=0, f(1)=1",
          approx(g.apply(np.array([0.0, 1.0])), [0.0, 1.0], 1e-12))
    # 单调
    q = np.linspace(0, 1, 200)
    check("曲线单调不反转", bool(np.all(np.diff(g.apply(q)) >= -1e-12)))

    # 限墨等比缩放的直接单测
    a = np.array([0.9, 0.2])
    b = np.array([0.9, 0.4])
    al, bl, s = apply_ink_limit(a, b, 1.2)
    check("限墨等比缩放数值", approx(al, [0.6, 0.2]) and approx(bl, [0.6, 0.4])
          and approx(s, [2 / 3, 1.0]), f"scale={s.round(3)}")

    # 墨量统计
    u = ink_usage(res.a_final, res.b_final, pixel_area=0.5)
    check("墨量统计字段与单位", u["plate_a_ink_units"] >= 0 and u["pixels"] == res.a_final.size
          and approx(u["plate_a_ink_units"], res.a_final.sum() * 0.5))


def test_png_roundtrip() -> None:
    print("== PNG 读写往返 ==")
    rng = np.random.default_rng(1)
    rgb = rng.random((17, 23, 3))
    gray = rng.random((17, 23))
    with tempfile.TemporaryDirectory() as d:
        png.write_png_rgb(f"{d}/rgb.png", rgb)
        png.write_png_gray(f"{d}/g.png", gray)
        back = png.read_png_rgb_u8(f"{d}/rgb.png")
        gback = png.read_png_rgb_u8(f"{d}/g.png")
        check("RGB 8 位往返误差 <=1 量化级",
              float(np.abs(back.astype(int) - (rgb * 255 + 0.5).astype(np.uint8).astype(int)).max()) <= 1)
        check("灰度版被读为三通道同值",
              approx(gback[..., 0], gback[..., 1]) and approx(gback[..., 1], gback[..., 2]))


def main() -> int:
    ap = argparse.ArgumentParser(description="duotone 无头验证")
    ap.add_argument("--out", help="可选：把样例导出到该目录")
    args = ap.parse_args()

    test_color_science()
    test_overprint_model()
    test_separation_accuracy()
    test_oog_distribution()
    test_ink_limit_and_curves()
    test_png_roundtrip()

    if args.out:
        from .export import export_all
        p = InkParams.from_hex("#f4ecd8", "#1a5fb4", "#c01c28")
        res = run_pipeline(make_gradient(320, 200), p,
                           ToneCurve.linear(), ToneCurve.linear(), 1.4, grid_n=33)
        paths = export_all(args.out, res, source_name="gradient")
        print(f"\n样例已导出到 {args.out}:")
        for k, v in paths.items():
            print(f"  {k:12s} {v}")

    n_fail = sum(1 for _, ok, _ in results if not ok)
    print(f"\n共 {len(results)} 项检查，失败 {n_fail} 项")
    return 1 if n_fail else 0


if __name__ == "__main__":
    sys.exit(main())
