"""可运行验证: 核对符号、已知距离、孔洞、亚像素位置、描边宽度、PNG 回读。

运行:  python verify.py
退出码 0 = 全部通过。每项打印实测误差与容许范围。

栅格近似误差来源 (容许范围的依据):
- 像素中心采样: 边界量化 ±0.5 显示像素;
- 双线性插值: 直线边上精确, 曲边/角点附近 ≤ O((Δx)^2 · 曲率);
- 圆弧折线逼近: 弦高误差 < 0.002 em 单位 (256 源尺寸下 < 0.005 源px)。
"""
from __future__ import annotations

import os
import sys
import tempfile

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")  # QImage 无需显示服务器

import numpy as np

from sdf_glyph_tool.geometry import GLYPHS, get_glyph
from sdf_glyph_tool.sdf import (compute_sdf, clamp_sdf, rasterize_bitmap,
                                glyph_to_source, sample_sdf)
from sdf_glyph_tool.render import (RenderParams, canvas_size, render_bitmap,
                                   render_sdf_coverage, compose_rgba)
from sdf_glyph_tool import exporter

FAILURES = []


def check(name: str, ok: bool, detail: str):
    print(f"[{'PASS' if ok else 'FAIL'}] {name}: {detail}")
    if not ok:
        FAILURES.append(name)


def rect_contour(x0, y0, x1, y1):
    return [np.array([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], dtype=np.float64)]


def test_rect_sign_and_distance():
    """简单矩形: 符号与已知距离 (解析 SDF, 误差应 ~1e-6)。"""
    n = 64
    x0, x1 = 16.64, 47.36  # 与字形变换无关, 直接给定源坐标轮廓
    sdf = compute_sdf(rect_contour(x0, x0, x1, x1), n)

    def at(cx, cy):  # 像素中心 (cx+0.5, cy+0.5)
        return float(sdf[cy, cx])

    d_in = at(32, 32)            # 中心 (32.5,32.5), 到最近边 47.36-32.5=14.86
    e1 = abs(d_in - 14.86)
    check("矩形内部距离", e1 < 1e-4, f"d={d_in:.6f} 期望+14.86 误差={e1:.2e} (容差1e-4)")

    d_edge = at(10, 32)          # (10.5,32.5) 到边 x=16.64 距离 6.14, 外部为负
    e2 = abs(d_edge + 6.14)
    check("矩形外部距离/符号", e2 < 1e-4, f"d={d_edge:.6f} 期望-6.14 误差={e2:.2e}")

    d_corner = at(10, 10)        # 角点外: 到角 (16.64,16.64) 距离 6.14*sqrt(2)
    expect = -6.14 * np.sqrt(2)
    e3 = abs(d_corner - expect)
    check("矩形角点距离", e3 < 1e-4, f"d={d_corner:.6f} 期望{expect:.6f} 误差={e3:.2e}")


def test_hole_is_outside():
    """孔洞内部必须作为字形外部 (距离为负)。"""
    g = get_glyph("方框带孔")
    n = 128
    contours = glyph_to_source(g.contours, n)
    sdf = compute_sdf(contours, n)
    # 孔洞 em (38,38)-(62,62); 源坐标下孔左边沿 x=51.712, 中心线 x=64.0
    # 在 (60.0, 64.0) 采样: 到左边沿 8.288 源px, 位于线性区, 插值应精确
    d = float(sample_sdf(sdf, np.array([60.0]), np.array([64.0]))[0])
    expect = -8.288
    ok = d < 0 and abs(d - expect) < 1e-3
    check("孔洞为外部", ok, f"孔内点 d={d:.4f} 期望{expect:.4f} (负=外部)")
    # 中轴脊线处 (x=64.0) 双线性插值最多低估 0.5 源px, 属已知栅格近似
    d_ridge = float(sample_sdf(sdf, np.array([64.0]), np.array([64.0]))[0])
    print(f"       (参考: 孔心中轴采样 d={d_ridge:.3f}, 真值-12.288, "
          f"脊线插值损失 {abs(d_ridge + 12.288):.3f} 源px ≤ 0.5)")


def test_arc_distance():
    """圆弧轮廓的已知半径距离。"""
    g = get_glyph("圆弧C环")
    n = 256
    contours = glyph_to_source(g.contours, n)
    sdf = compute_sdf(contours, n)
    s = 0.8 * n / 100  # em -> 源px
    # 环心 源(128,128); 在 em 半径 35、角度 90° 处 (避开 +x 方向的开口缝)
    r_src = 35 * s
    d = float(sample_sdf(sdf, np.array([128.0]), np.array([128.0 - r_src]))[0])
    expect = (35 - 27) * s
    err = abs(d - expect)
    check("圆弧距离", err < 0.02,
          f"d={d:.4f} 期望{expect:.4f} 误差={err:.4f} 源px (容差0.02, 含折线弦高)")


def test_subpixel_translation():
    """亚像素平移: 质心位移精确, 且位图与 SDF 两条路径不错半像素。"""
    n = 64
    contours = rect_contour(16.64, 16.64, 47.36, 47.36)
    sdf = clamp_sdf(compute_sdf(contours, n), 4.0)
    bitmap = rasterize_bitmap(contours, n)
    scale = 2.0
    d = canvas_size(n, scale)
    xs, ys = np.arange(d), np.arange(d)

    def centroid_x(cov):
        return float((cov.sum(0) * xs).sum() / cov.sum())

    p0 = RenderParams(scale=scale, tx=0.0, softness_px=1.0)
    p1 = RenderParams(scale=scale, tx=0.5, softness_px=1.0)
    f0, _ = render_sdf_coverage(sdf, xs, ys, p0)
    f1, _ = render_sdf_coverage(sdf, xs, ys, p1)
    shift = centroid_x(f1) - centroid_x(f0)
    e1 = abs(shift - 0.5 * scale)
    check("亚像素平移量", e1 < 0.05,
          f"tx=0.5源px 引起质心移动 {shift:.4f} 显示px, 期望 {0.5*scale:.2f} (容差0.05)")

    cov_b = render_bitmap(bitmap, xs, ys, p0)
    drift = abs(centroid_x(cov_b) - centroid_x(f0))
    check("位图/SDF 位置一致", drift < 0.1,
          f"两条路径质心差 {drift:.4f} 显示px (容差0.1, 远小于半像素)")


def test_outline_width_vs_scale():
    """描边宽度以显示像素计: 改倍率后实测宽度仍符合读数。

    容许误差 ±1.0 显示px: 像素中心采样在两侧各引入 ≤0.5px 量化。
    """
    n = 128
    contours = rect_contour(28.16, 28.16, 99.84, 99.84)
    sdf = clamp_sdf(compute_sdf(contours, n), 8.0)
    for scale in (1.0, 2.0, 4.0):
        for outline in (2.0, 6.0):
            d = canvas_size(n, scale)
            xs = np.arange(d)
            ys = np.array([d // 2])
            p = RenderParams(scale=scale, outline_px=outline, softness_px=0.0)
            _, band = render_sdf_coverage(sdf, xs, ys, p)
            row = band[0]
            # 外轮廓左边沿处的描边带宽度
            edge_src = 28.16
            lo, hi = (edge_src - 4) * scale, (edge_src + 4) * scale
            seg = row[int(lo):int(hi)]
            width = float((seg > 0.5).sum())
            err = abs(width - outline)
            check(f"描边宽度 scale={scale} w={outline}", err <= 1.0,
                  f"实测 {width:.1f} 显示px, 期望 {outline:.1f} (容差±1.0)")


def test_outline_inside_hole():
    """孔洞描边方向: 孔内侧 (负距离) 同样出现描边带。"""
    g = get_glyph("方框带孔")
    n = 128
    contours = glyph_to_source(g.contours, n)
    sdf = clamp_sdf(compute_sdf(contours, n), 8.0)
    p = RenderParams(scale=2.0, outline_px=4.0, softness_px=0.0)
    # 孔左边沿 em x=38 -> 源 x = 12.8+38*1.024 = 51.712; 孔内侧 0.5 源px 处
    u = 51.712 + 0.5
    xs = np.array([(u + p.tx) * p.scale - 0.5])
    ys = np.array([(64.0 + p.ty) * p.scale - 0.5])
    _, band = render_sdf_coverage(sdf, xs, ys, p)
    check("孔洞内侧描边", band[0, 0] > 0.5,
          f"孔边内侧0.5源px处描边覆盖率={band[0,0]:.2f} (应>0.5)")


def test_narrow_slit_resolution_loss():
    """窄缝与源分辨率: 缝宽 < 1 源px 且无像素中心落入时, SDF 中缝隙消失。"""
    n = 64
    outer = rect_contour(10.0, 10.0, 54.0, 54.0)[0]

    def slit(w):
        return np.array([[32 - w / 2, 20.0], [32 + w / 2, 20.0],
                         [32 + w / 2, 44.0], [32 - w / 2, 44.0]])

    sdf_thin = compute_sdf([outer, slit(0.9)], n)   # 缝 31.55..32.45, 不含像素中心
    sdf_wide = compute_sdf([outer, slit(1.1)], n)   # 缝 31.45..32.55, 含 31.5/32.5
    row = 32
    thin_vals = sdf_thin[row, 31:33]
    wide_vals = sdf_wide[row, 31:33]
    check("窄缝消失(0.9px)", bool((thin_vals > 0).all()),
          f"缝内像素值 {thin_vals} 全部为正 -> 缝隙未被采样到, 重建将丢失")
    check("窄缝保留(1.1px)", bool((wide_vals < 0).any()),
          f"缝内像素值 {wide_vals} 出现负值 -> 缝隙被保留")


def test_truncation():
    """存储范围截断: 超出范围的距离被截到 ±R。"""
    n = 64
    sdf = compute_sdf(rect_contour(16.0, 16.0, 48.0, 48.0), n)
    clipped = clamp_sdf(sdf, 2.0)
    check("截断范围", clipped.max() == 2.0 and clipped.min() == -2.0,
          f"max={clipped.max():.3f} min={clipped.min():.3f} (应恰为 ±2.0)")


def test_png_roundtrip_and_repro():
    """透明 PNG 回读一致; 导出的 SDF+参数重新载入后复现同一轮廓。"""
    g = get_glyph("拱门窗(综合)")
    n = 128
    contours = glyph_to_source(g.contours, n)
    sdf = clamp_sdf(compute_sdf(contours, n), 4.0)
    p = RenderParams(scale=2.5, tx=0.3, ty=-0.2, threshold=0.0,
                     softness_px=1.5, outline_px=3.0)
    d = canvas_size(n, p.scale)
    xs, ys = np.arange(d), np.arange(d)
    fill, band = render_sdf_coverage(sdf, xs, ys, p)
    rgba = compose_rgba(fill, band)

    with tempfile.TemporaryDirectory() as tmp:
        png = os.path.join(tmp, "out.png")
        exporter.save_png_rgba(png, rgba)
        back = exporter.read_png_rgba(png)
        same = back.shape == rgba.shape and bool((back == rgba).all())
        check("PNG 回读一致", same,
              f"尺寸 {back.shape}, 与写出逐字节相同={same}")
        check("PNG 透明背景", int(back[0, 0, 3]) == 0,
              f"远角像素 alpha={back[0,0,3]} (应=0), 尺寸 {d}x{d} 与预览一致")

        base = os.path.join(tmp, "out")
        exporter.save_sdf_bundle(base, sdf, {"render": p.to_dict(),
                                             "source_size": n})
        sdf2, params = exporter.load_sdf_bundle(base + "_sdf.npy")
        p2 = RenderParams(**params["render"])
        fill2, band2 = render_sdf_coverage(sdf2, xs, ys, p2)
        repro = bool((fill2 == fill).all() and (band2 == band).all())
        check("SDF 重载复现", repro, "重载的距离场+参数逐像素复现同一轮廓")


def main():
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for t in tests:
        t()
    print()
    if FAILURES:
        print(f"共 {len(FAILURES)} 项失败: {FAILURES}")
        return 1
    print(f"全部 {len(tests)} 组检查通过。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
