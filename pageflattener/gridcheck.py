"""弯曲格纸生成与恢复核对。

流程: 直格纸(输出空间) --正映射--> 弯曲格纸(源图空间) --展平--> 恢复格纸。
比较恢复格纸与原始直格纸, 分左半(书脊侧)/右半(页面外侧)统计偏差,
用于检查引导线之间与外推区域的插值质量。
"""
from __future__ import annotations

import os
import numpy as np
import cv2

from .core import FlattenField


def straight_grid(w, h, step=80, thick=2):
    img = np.full((h, w), 255, np.uint8)
    for x in range(0, w, step):
        cv2.line(img, (x, 0), (x, h - 1), 0, thick)
    for y in range(0, h, step):
        cv2.line(img, (0, y), (w - 1, y), 0, thick)
    cv2.rectangle(img, (0, 0), (w - 1, h - 1), 0, 2)
    return img


def _forward_maps(field: FlattenField, src_w, src_h):
    """源图每个像素 -> 输出图坐标 (map_x, map_y)。"""
    xs, ys = np.meshgrid(np.arange(src_w), np.arange(src_h))
    pts = np.stack([xs, ys], axis=-1).reshape(-1, 1, 2).astype(np.float32)
    work = cv2.perspectiveTransform(pts, field.M).reshape(-1, 2).astype(np.float64)
    out = field.map_work_to_out(work)
    return (out[:, 0].reshape(src_h, src_w).astype(np.float32),
            out[:, 1].reshape(src_h, src_w).astype(np.float32))


def make_curved_grid(field: FlattenField, src_shape, max_dim=1600):
    """把直格纸按当前位移场"卷"回源图空间, 得到弯曲格纸。"""
    hs, ws = src_shape[:2]
    scale = min(1.0, max_dim / max(ws, hs))
    sw, sh = max(1, int(ws * scale)), max(1, int(hs * scale))
    grid = straight_grid(field.out_w, field.out_h)
    mx, my = _forward_maps(field, sw, sh)
    curved = cv2.remap(grid, mx, my, cv2.INTER_LINEAR,
                       borderMode=cv2.BORDER_CONSTANT, borderValue=255)
    return curved, scale


def roundtrip_error(field: FlattenField, step=8):
    """输出像素 q -> 源 -> 输出 的往返位移误差, 返回 (err_map, xs, ys)。"""
    W, H = field.out_w, field.out_h
    xs = np.arange(0, W, step)
    ys = np.arange(0, H, step)
    gx, gy = np.meshgrid(xs, ys)
    q = np.stack([gx.ravel(), gy.ravel()], axis=1)
    back = field.map_src_to_out(field.map_out_to_src(q))
    err = np.hypot(back[:, 0] - q[:, 0], back[:, 1] - q[:, 1])
    return err.reshape(gx.shape), xs, ys


def run_grid_check(field: FlattenField, src_shape, out_dir, prefix="grid"):
    """生成格纸四件套 + 偏差报告, 返回报告文本。"""
    os.makedirs(out_dir, exist_ok=True)
    grid = straight_grid(field.out_w, field.out_h)
    curved, scale = make_curved_grid(field, src_shape)
    inv_mx, inv_my = field.inverse_maps()
    recovered = cv2.remap(curved, inv_mx, inv_my, cv2.INTER_LINEAR,
                          borderMode=cv2.BORDER_CONSTANT, borderValue=255)
    diff = cv2.absdiff(recovered, grid)

    H, W = grid.shape
    mid = W // 2
    def stats(region):
        return (float(region.mean()), float(np.percentile(region, 95)),
                float(region.max()))
    l_mean, l_p95, l_max = stats(diff[:, :mid])
    r_mean, r_p95, r_max = stats(diff[:, mid:])

    err, exs, eys = roundtrip_error(field)
    half = err.shape[1] // 2
    el, er = err[:, :half], err[:, half:]

    y0, y1 = field.extrapolated_rows()
    lines = [
        "格纸核对报告",
        f"输出尺寸: {W}x{H}, 引导曲线: {field.n_curves} 条",
        f"外推区域: 行 0~{y0:.0f} 与 {y1:.0f}~{H} (这些区域偏差大属预期)",
        "",
        "恢复格纸 vs 原始直格纸 灰度差 (0-255):",
        f"  左半(书脊侧): 均值 {l_mean:.2f}, 95分位 {l_p95:.1f}, 最大 {l_max:.0f}",
        f"  右半(外侧)  : 均值 {r_mean:.2f}, 95分位 {r_p95:.1f}, 最大 {r_max:.0f}",
        "",
        "往返映射位移误差 (像素):",
        f"  左半(书脊侧): 均值 {el.mean():.3f}, 最大 {el.max():.2f}",
        f"  右半(外侧)  : 均值 {er.mean():.3f}, 最大 {er.max():.2f}",
        "",
        "文件: grid_straight.png 原始直格纸 / grid_curved.png 弯曲格纸 /",
        "      grid_recovered.png 展平恢复 / grid_diff.png 差异图",
    ]
    report = "\n".join(lines)

    cv2.imwrite(os.path.join(out_dir, f"{prefix}_straight.png"), grid)
    cv2.imwrite(os.path.join(out_dir, f"{prefix}_curved.png"), curved)
    cv2.imwrite(os.path.join(out_dir, f"{prefix}_recovered.png"), recovered)
    cv2.imwrite(os.path.join(out_dir, f"{prefix}_diff.png"), diff)
    with open(os.path.join(out_dir, f"{prefix}_report.txt"), "w", encoding="utf-8") as f:
        f.write(report + "\n")
    return report
