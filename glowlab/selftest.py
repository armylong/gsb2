"""无头自检：不打开窗口，直接验证引擎行为。

覆盖
----
A. 资格只由亮度决定：同亮度红/灰蒙版逐像素相等；暗红块在默认门槛下
   蒙版全 0；白点蒙版为 1。
B. 双层衰减可测：近场层与长尾层沿径向单调衰减，长尾在远处能量显著
   大于近场，且各自随 sigma 增大而扩散更远。
C. 边界零填充：贴边亮点在小画布上的内部区域，与大画布上同一光源
   同一区域的结果一致 (小画布外侧按黑场截断)。
D. 放大一致性：engine.extract 与直接数组切片逐元素相等；对任何子
   区域重算都不会改变全图结果 (渲染不接收裁剪参数)。
E. smoothstep：门槛以下为 0、以上为 1、过渡带严格单调。
F. 相邻亮点：两个相邻亮点中间的辉光是两者贡献之和量级，晕圈合并。

另带 --gui 冒烟测试：用 offscreen QPA 启动窗口并驱动一次滑杆变更。
"""

from __future__ import annotations

import argparse
import sys

import numpy as np

from . import engine, test_patterns

PASS, FAIL = "PASS", "FAIL"
failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"[{PASS if ok else FAIL}] {name}" + (f" — {detail}" if detail else ""))
    if not ok:
        failures.append(name)


def test_qualification_luma_only() -> None:
    # 精确测试：float 下手工构造同 luma 的红色与中性灰像素，蒙版必须逐元素相等
    h, w = 16, 256
    lum_line = np.linspace(0, 0.6, w, dtype=np.float32)  # 0.6 保证红分量不被 clip
    lum_field = np.broadcast_to(lum_line, (h, w)).copy()
    red = np.zeros((h, w, 3), dtype=np.float32)
    red[..., 0] = np.clip(lum_field / engine.LUMA_W[0], 0, 1)
    # 再混入一点绿并缩放，使 luma 恰好等于 lum_field
    red[..., 1] = (lum_field - red[..., 0] * engine.LUMA_W[0]) / engine.LUMA_W[1]
    gray = np.stack([lum_field] * 3, axis=-1)
    m_red = engine.qualification_mask(engine.luma(red), 0.70, 0.10)
    m_gray = engine.qualification_mask(engine.luma(gray), 0.70, 0.10)
    check("同亮度红/灰输入资格蒙版逐元素相等",
          np.allclose(m_red, m_gray, atol=1e-5),
          f"最大差异 {np.abs(m_red - m_gray).max():.2e}")

    # 实际 uint8 样图：红条与灰条按相同 luma 设计，仅有 <=1 灰度级取整误差
    img = test_patterns.luma_ramp()
    rgb = engine.to_float_rgb(img)
    lum = engine.luma(rgb)
    mask = engine.qualification_mask(lum, 0.70, 0.10)
    red_band = mask[120:392, 40:120]
    gray_band = mask[120:392, 392:472]
    lum_red = lum[120:392, 40:120]
    lum_gray = lum[120:392, 392:472]
    check("样图3 红/灰条亮度取整误差<=1级",
          np.abs(lum_red - lum_gray).max() <= 1 / 255 + 1e-6,
          f"亮度最大差异 {np.abs(lum_red - lum_gray).max():.4f}")
    check("样图3 红/灰条蒙版差异仅来自取整",
          np.abs(red_band - gray_band).max() < 0.02,
          f"蒙版最大差异 {np.abs(red_band - gray_band).max():.4f}")


def test_red_paint_never_glows() -> None:
    img = test_patterns.red_paint()
    rgb = engine.to_float_rgb(img)
    lum = engine.luma(rgb)
    params = engine.GlowParams()
    mask = engine.qualification_mask(lum, params.threshold, params.softness)
    # 暗红颜料块区域 (左上矩形) 与暗红点 (圆心 x=360,y=150)
    block = mask[60:220, 50:250]
    spot = mask[132:168, 342:378]
    check("暗红颜料块在默认门槛下无资格", block.max() == 0.0,
          f"块内最大蒙版 {block.max():.3f}, 块内最大亮度 {lum[60:220, 50:250].max():.3f}")
    check("暗红点在默认门槛下无资格", spot.max() == 0.0,
          f"最大蒙版 {spot.max():.3f}")
    # 白点完全有资格 (圆心 x=140,y=380)；只取盘内核心，避开圆盘边缘混合像素
    white = mask[370:390, 130:150]
    check("白点源完全有资格", white.min() == 1.0, f"最小蒙版 {white.min():.3f}")    # 即使把门槛降到 0.3，暗红块依旧没资格 (亮度只有约 0.1)
    low_mask = engine.qualification_mask(lum, 0.30, 0.05)
    check("门槛降到0.3暗红块仍无资格", low_mask[60:220, 50:250].max() == 0.0,
          f"最大蒙版 {low_mask[60:220, 50:250].max():.3f}")
    # 暗块区域渲染后辉光贡献为 0 (块自身不发光，只能等别处光照过来)
    result = engine.render(rgb, params)
    own_near = result.near[60:220, 50:250]
    check("暗红块近场贡献为零", own_near.max() == 0.0,
          f"最大值 {own_near.max():.2e}")


def test_two_layer_decay() -> None:
    n = 256
    img = np.zeros((n, n, 3), dtype=np.float32)
    img[n // 2, n // 2] = 1.0
    p_small = engine.GlowParams(near_sigma=6, tail_sigma=24, near_strength=1.0,
                                tail_strength=1.0, red_tint=0.0)
    p_wide = engine.GlowParams(near_sigma=12, tail_sigma=60, near_strength=1.0,
                               tail_strength=1.0, red_tint=0.0)
    r = engine.render(img, p_small)
    r_wide = engine.render(img, p_wide)
    cy = cx = n // 2
    yy, xx = np.mgrid[0:n, 0:n]
    dist2 = (xx - cx) ** 2 + (yy - cy) ** 2

    def ring_energy(layer: np.ndarray, rad: int) -> float:
        m = (dist2 >= (rad - 1) ** 2) & (dist2 < (rad + 1) ** 2)
        return float(layer[m].mean())

    radii = np.arange(4, 110)
    near_e = np.array([ring_energy(r.near, rad) for rad in radii])
    tail_e = np.array([ring_energy(r.tail, rad) for rad in radii])
    # 单调非增 (离散化允许极小抖动，用差分上界)
    check("近场层径向衰减单调", np.diff(near_e).max() < 1e-7,
          f"最大上升 {np.diff(near_e).max():.2e}")
    check("长尾层径向衰减单调", np.diff(tail_e).max() < 1e-7,
          f"最大上升 {np.diff(tail_e).max():.2e}")
    # 远处 (r=60) 长尾能量显著大于近场
    i60 = list(radii).index(60)
    check("60px 处长尾能量远超近场", tail_e[i60] > 10 * near_e[i60],
          f"tail={tail_e[i60]:.2e} near={near_e[i60]:.2e}")
    # 范围越大衰减越慢：比较 r=40 相对于峰值的归一化剩余比例
    # (固定强度下大 sigma 峰值更低，但剩余比例更高——这就是可测的衰减差别)
    small_frac = ring_energy(r.tail, 40) / max(ring_energy(r.tail, 4), 1e-12)
    wide_frac = ring_energy(r_wide.tail, 40) / max(ring_energy(r_wide.tail, 4), 1e-12)
    check("大 sigma 长尾归一化衰减更慢", wide_frac > small_frac * 2,
          f"wide剩余={wide_frac:.4f} small剩余={small_frac:.4f}")
    # 染红参数真实改变长尾颜色 (取偏离中心的点，避免源点处饱和)
    p_red = engine.GlowParams(near_sigma=6, tail_sigma=24, tail_strength=1.0,
                              red_tint=1.0)
    r_red = engine.render(img, p_red)
    t = r_red.tail[cy, cx + 20]
    check("red_tint=1 时长尾偏红", t[0] > t[2] * 5, f"R={t[0]:.3f} B={t[2]:.3f}")


def test_zero_padding_boundary() -> None:
    # 小画布：贴边亮点；大画布：同一光源周围有足够黑场
    n = 256
    small = np.zeros((n, n, 3), dtype=np.float32)
    big = np.zeros((n * 2, n * 2, 3), dtype=np.float32)
    cx, cy, rad = 128, 3, 12
    yy, xx = np.ogrid[:n, :n]
    disk = (xx - cx) ** 2 + (yy - cy) ** 2 <= rad ** 2
    small[disk] = 1.0
    yy2, xx2 = np.ogrid[: n * 2, : n * 2]
    big[(xx2 - cx) ** 2 + (yy2 - cy) ** 2 <= rad ** 2] = 1.0
    params = engine.GlowParams(near_sigma=10, tail_sigma=40)
    rs = engine.render(small, params)
    rb = engine.render(big, params)
    # 距边 >= 最长尾 2 个 sigma 的内部区域应一致 (小画布此区域不受边界影响)
    margin = 90
    region = (slice(margin, n - margin), slice(margin, n - margin))
    diff = np.abs(rs.composite[region] - rb.composite[region]).max()
    check("贴边光源内部区域与大画布一致", diff < 2e-5, f"最大差异 {diff:.2e}")
    # 贴边行辉光非零且小于同行内点 (零填充把外侧半核截掉)
    edge_row = rs.tail[0, cx]
    inner_row = rs.tail[60, cx]
    check("贴边处辉光被零填充截断 (非零且弱于内侧)",
          edge_row.sum() > 0 and edge_row.sum() < inner_row.sum(),
          f"edge={edge_row.sum():.4f} inner={inner_row.sum():.4f}")


def test_zoom_identity() -> None:
    img = test_patterns.edge_cluster()
    result = engine.render(img, engine.GlowParams())
    h, w = result.mask.shape
    rect = engine.crop_region(h, w, 70, 55, 96)
    direct = result.composite[rect[0]:rect[1], rect[2]:rect[3]]
    via_helper = engine.extract(result.composite, rect)
    check("放大切片与数组索引逐元素相等", np.array_equal(direct, via_helper))
    # 贴角夹紧
    rect_corner = engine.crop_region(h, w, 5, 5, 96)
    check("贴角裁剪自动夹紧", rect_corner == (0, 96, 0, 96), str(rect_corner))
    # 渲染接口不接收任何窗口参数：同样输入两次渲染完全相同
    r2 = engine.render(img, engine.GlowParams())
    check("同参数重复渲染逐位一致",
          np.array_equal(result.composite, r2.composite))


def test_smoothstep_shape() -> None:
    lum = np.linspace(0, 1, 1001, dtype=np.float32)
    m = engine.qualification_mask(lum, 0.6, 0.1)
    check("过渡带以下为0", m[lum < 0.5].max() == 0.0)
    check("过渡带以上为1", m[lum > 0.7].min() == 1.0)
    mid = m[(lum > 0.5) & (lum < 0.7)]
    check("过渡带严格递增", np.diff(mid).min() > 0)
    check("门槛处蒙版=0.5", abs(m[np.argmin(abs(lum - 0.6))] - 0.5) < 1e-3)


def test_adjacent_sources_merge() -> None:
    n = 200
    img = np.zeros((n, n, 3), dtype=np.float32)
    img[100, 80] = 1.0
    img[100, 120] = 1.0
    result = engine.render(img, engine.GlowParams(
        near_sigma=8, tail_sigma=30, near_strength=1.0, tail_strength=1.0))
    midpoint = result.glow[100, 100].sum()
    alone = np.zeros_like(result.glow)
    one = np.zeros((n, n, 3), dtype=np.float32)
    one[100, 80] = 1.0
    r_one = engine.render(one, engine.GlowParams(
        near_sigma=8, tail_sigma=30, near_strength=1.0, tail_strength=1.0))
    check("相邻亮点中间辉光强于单源贡献 (晕圈合并)",
          midpoint > 1.5 * r_one.glow[100, 100].sum(),
          f"双源={midpoint:.4f} 单源={r_one.glow[100, 100].sum():.4f}")


def test_pattern_luma_values() -> None:
    img = engine.to_float_rgb(test_patterns.red_paint())
    lum = engine.luma(img)
    vals = {
        "暗红块": lum[100, 100],
        "白点": lum[380, 140],
        "亮红点": lum[380, 340],
        "暗红点": lum[150, 360],
    }
    print("    样图1 实测亮度:", ", ".join(f"{k}={v:.3f}" for k, v in vals.items()))
    check("白点亮于门槛", vals["白点"] > 0.7)
    check("暗红块远暗于门槛", vals["暗红块"] < 0.2)
    check("亮红点介于二者之间", vals["暗红块"] < vals["亮红点"] < vals["白点"])


def run_headless() -> int:
    test_pattern_luma_values()
    test_qualification_luma_only()
    test_red_paint_never_glows()
    test_smoothstep_shape()
    test_two_layer_decay()
    test_zero_padding_boundary()
    test_zoom_identity()
    test_adjacent_sources_merge()
    print()
    if failures:
        print(f"失败 {len(failures)} 项: {failures}")
        return 1
    print("全部自检通过。")
    return 0


def _pump_wait(app, condition, timeout: float = 3.0, interval: float = 0.01) -> bool:
    """按墙钟时间排空事件循环直到 condition() 为真。

    offscreen QPA 下纯 processEvents 空转不会推进 QTimer，必须让出真实时间。
    """
    import time
    deadline = time.perf_counter() + timeout
    while time.perf_counter() < deadline:
        app.processEvents()
        if condition():
            return True
        time.sleep(interval)
    app.processEvents()
    return bool(condition())


def _pump(app, duration: float = 0.2) -> None:
    import time
    deadline = time.perf_counter() + duration
    while time.perf_counter() < deadline:
        app.processEvents()
        time.sleep(0.01)


def run_gui_smoke() -> int:
    """offscreen 模式启动窗口、切换模式、改参数、跑一次事件循环。"""
    import os
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    from PySide6.QtWidgets import QApplication
    from .ui import MainWindow, VIEW_MODES

    app = QApplication.instance() or QApplication([])
    win = MainWindow()
    win.show()
    if not _pump_wait(app, lambda: win.result is not None):
        print("[FAIL] GUI 首帧未完成")
        win.worker.shutdown()
        return 1
    print("[PASS] GUI 首帧渲染完成")
    first = win.result
    # set_value 按设计不触发 changed (避免程序化设置回环)；直接发一次渲染请求
    win.row_threshold.set_value(0.45)
    win.row_tail_sigma.set_value(80)
    win.combo_mode.setCurrentIndex(VIEW_MODES.index("辉光合成结果"))
    win._dispatch()
    if not _pump_wait(app, lambda: win.result is not first):
        print("[FAIL] 参数变更后未收到新帧")
        win.worker.shutdown()
        return 1
    print("[PASS] GUI 参数变更与模式切换")
    # 模拟真实滑杆交互路径：spin 信号 → changed → debounce → 渲染
    before = win.result
    win.row_threshold.spin.setValue(0.55)
    if not _pump_wait(app, lambda: win.result is not before, timeout=4.0):
        print("[FAIL] 滑杆交互路径未触发重渲染")
        win.worker.shutdown()
        return 1
    print("[PASS] 滑杆交互经防抖触发重渲染")
    win.refresh_views()
    win._move_zoom_center(30, 40)
    _pump(app, 0.15)
    rect = win._zoom_rect()
    ok_zoom = rect[2] <= 30 and rect[0] <= 40
    print(f"[{'PASS' if ok_zoom else 'FAIL'}] GUI 放大中心移动 {rect}")
    # 必须先停线程再让窗口/应用对象析构
    win.worker.shutdown()
    win.close()
    _pump(app, 0.1)
    return 0 if ok_zoom else 1


def main() -> int:
    ap = argparse.ArgumentParser(description="GlowLab 自检")
    ap.add_argument("--gui", action="store_true", help="附加 PySide6 offscreen 冒烟测试")
    args = ap.parse_args()
    code = run_headless()
    if args.gui:
        code = run_gui_smoke() or code
    return code


if __name__ == "__main__":
    sys.exit(main())
