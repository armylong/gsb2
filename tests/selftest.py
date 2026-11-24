"""无界面自测: 合成弯曲书页 -> 引导点 -> 展平 -> 验证行被拉直 + 格纸核对。

运行: python -m tests.selftest
"""
import os
import tempfile

import numpy as np
import cv2

from pageflattener.core import FlattenField, sample_curve
from pageflattener.gridcheck import run_grid_check

W, H = 1200, 900


def make_curved_page():
    """白底 + 若干条水平文字行, 整体施加竖向弯曲位移(模拟书脊卷曲)。"""
    img = np.full((H, W, 3), 255, np.uint8)
    line_ys = list(range(120, 860, 80))

    def bend(x, y):
        # 靠近书脊(左侧)上翘的位移场
        t = x / W
        return 70 * (1 - t) ** 2 * np.sin(np.pi * y / H)

    for y0 in line_ys:
        pts = []
        for x in range(0, W, 8):
            pts.append((x, int(y0 + bend(x, y0))))
        cv2.polylines(img, [np.array(pts, np.int32)], False, (30, 30, 30), 3)
    return img, line_ys, bend


def main():
    img, line_ys, bend = make_curved_page()
    quad = [(0, 0), (W - 1, 0), (W - 1, H - 1), (0, H - 1)]

    # 沿其中 4 条弯行取引导点(模拟用户点击)
    guide_rows = [0, 3, 6, 9]
    curves = []
    for gi in guide_rows:
        y0 = line_ys[gi]
        pts = [(x, y0 + bend(x, y0)) for x in range(60, W - 40, 160)]
        curves.append(pts)

    out_w, out_h = 1000, 800
    field = FlattenField(quad, curves, out_w, out_h)
    flat = field.flatten(img)

    # 验证1: 被引导的行在输出中应接近水平直线
    # 引导曲线 i 的源行 y0 应映射到 field.dst_ys[i]
    print("目标行:", np.round(field.dst_ys, 1))
    ok = True
    for k, gi in enumerate(guide_rows):
        y0 = line_ys[gi]
        # 取源行上若干点, 正映射后 y 应都等于 dst_ys[k]
        xs = np.arange(80, W - 60, 100)
        src_pts = np.array([[x, y0 + bend(x, y0)] for x in xs])
        out = field.map_src_to_out(src_pts)
        spread = out[:, 1].max() - out[:, 1].min()
        err = abs(out[:, 1].mean() - field.dst_ys[k])
        print(f"  引导{k + 1}: 映射后行高散布 {spread:.2f}px, 与目标差 {err:.2f}px")
        if spread > 3 or err > 3:
            ok = False

    # 验证2: 展平图中引导线位置的暗像素应集中在水平带上
    gray = cv2.cvtColor(flat, cv2.COLOR_BGR2GRAY)
    for k, gi in enumerate(guide_rows):
        y = int(round(field.dst_ys[k]))
        band = gray[max(0, y - 6):y + 7]
        dark_ratio = (band < 128).mean()
        print(f"  输出目标行 {y}: 暗像素占比 {dark_ratio:.3f}")
        if dark_ratio < 0.15:
            ok = False

    # 验证3: 往返一致性
    q = np.array([[500.0, 400.0], [100.0, 100.0], [900.0, 700.0]])
    back = field.map_src_to_out(field.map_out_to_src(q))
    rt = np.hypot(back[:, 0] - q[:, 0], back[:, 1] - q[:, 1]).max()
    print(f"往返误差(引导线间区域): {rt:.3f}px")
    if rt > 2:
        ok = False

    # 验证4: 相交检测 —— 故意画两条交叉曲线
    c1 = [(100, 100), (600, 400), (1100, 100)]
    c2 = [(100, 400), (600, 100), (1100, 400)]
    f2 = FlattenField(quad, [c1, c2], out_w, out_h)
    crossings = f2.find_crossings()
    kinds = {c[4] for c in crossings}
    print("交叉检测结果:", [(round(c[0]), c[4]) for c in crossings])
    if "cross" not in kinds:
        ok = False

    # 验证5: 格纸核对流程能跑通
    with tempfile.TemporaryDirectory() as td:
        report = run_grid_check(field, img.shape, td)
        files = sorted(os.listdir(td))
        print("格纸输出:", files)
        assert "grid_straight.png" in files and "grid_report.txt" in files
        print(report)

    print("\n自测", "通过 ✓" if ok else "失败 ✗")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
