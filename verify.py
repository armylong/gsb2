"""复验脚本: 整圈旋回 / 接缝穿越 / 天顶移动 / 地标映射 / 导出冒烟.

运行: python verify.py   (GUI 冒烟部分自动使用 offscreen 平台)
"""
import json
import os
import sys
import tempfile

import numpy as np

from pano_core import (dir_to_lonlat, equirect_grid, forward_map_points,
                       inverse_map_points, lonlat_to_dir, output_to_source_map,
                       reorient, rotation_matrix)
from sample_pano import make_sample

RESULTS = []


def check(name, ok, info=""):
    RESULTS.append((name, bool(ok)))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}  {info}")


def main():
    img = make_sample(1024)
    h, w = 512, 1024

    # ---------- 1. 整圈旋回 ----------
    out = reorient(img, 360.0, 0.0, 0.0)
    d = np.abs(out.astype(np.int16) - img.astype(np.int16)).max()
    check("整圈旋回: yaw=360° 输出等于原图", d <= 2, f"max|diff|={d}")

    R = rotation_matrix(37.0, -24.0, 61.0)
    check("整圈旋回: 旋转矩阵正交", np.allclose(R @ R.T, np.eye(3), atol=1e-12))
    lon, lat = equirect_grid(64, 128)
    dirs = lonlat_to_dir(lon, lat)
    back = (dirs @ R) @ R.T
    check("整圈旋回: 方向往返映射一致", np.allclose(back, dirs, atol=1e-10))

    # ---------- 2. 接缝穿越 ----------
    u, _ = output_to_source_map(100.0, 0.0, 0.0, h, w, h, w)
    step = (u[:, 0] - u[:, -1]) % w
    check("接缝穿越: 跨过左右边源横坐标恰好前进 1 像素",
          np.allclose(step, 1.0, atol=1e-6),
          f"step∈[{step.min():.6f}, {step.max():.6f}]")

    # 大角度组合下, 相邻行取样纬度不跳变(极区不会突然引用另一侧纬度)
    _, v2 = output_to_source_map(33.0, 65.0, 40.0, h, w, h, w)
    dv = np.abs(np.diff(v2, axis=0)).max()
    check("接缝穿越: 大角度下相邻行纬度不跳变", dv < 2.0, f"max|dv|={dv:.4f}px")
    check("接缝穿越: 源纵坐标不出界",
          v2.min() >= -0.5 - 1e-9 and v2.max() <= h - 0.5 + 1e-9,
          f"v∈[{v2.min():.3f}, {v2.max():.3f}]")

    # 连续图案: 输出接缝处的列差应与内部列差同量级
    yy, xx = np.mgrid[0:h, 0:w]
    wave = (127 + 127 * np.sin(xx * (2 * np.pi * 3 / w))).astype(np.uint8)
    smooth = np.dstack([wave, wave, wave])
    out = reorient(smooth, 77.7, 15.0, -20.0)
    seam = np.abs(out[:, 0].astype(int) - out[:, -1].astype(int)).max()
    interior = max(np.abs(out[:, i].astype(int) - out[:, i + 1].astype(int)).max()
                   for i in range(0, w - 1, 64))
    check("接缝穿越: 连续图案输出接缝与内部同样平滑",
          seam <= interior + 2, f"seam={seam}, interior={interior}")

    # 斜线样图: 接缝处突变行数不应多于内部列边界
    out = reorient(img, 77.7, 0.0, 0.0)

    def edges(a, b):
        return int((np.abs(a.astype(int) - b.astype(int)).max(axis=1) > 100).sum())

    seam_e = edges(out[:, -1], out[:, 0])
    inner_e = max(edges(out[:, i], out[:, i + 1]) for i in range(50, w - 50, 25))
    check("接缝穿越: 斜线样图接缝突变行数不多于内部",
          seam_e <= inner_e + 2, f"seam={seam_e}, interior={inner_e}")

    # ---------- 3. 天顶移动 ----------
    lons, lats = forward_map_points(np.array([0.0]), np.array([0.0]),
                                    0.0, 90.0, 0.0)
    check("天顶移动: 正前方地标经俯仰 90° 后到达天顶",
          abs(lats[0] - 90.0) < 1e-9, f"lat={lats[0]:.6f}°")

    out = reorient(img, 0.0, 90.0, 0.0)
    top = out[:8]
    green = (top[..., 1] > 150) & (top[..., 0] < 120) & (top[..., 2] < 120)
    check("天顶移动: 原正前方绿色圆盘出现在输出顶部",
          green.sum() > 50, f"green_px={int(green.sum())}")

    _, v3 = output_to_source_map(0.0, 90.0, 0.0, h, w, h, w)
    check("天顶移动: 越过天顶时取样纬度连续不绕回",
          np.abs(np.diff(v3, axis=0)).max() < 2.0,
          f"max|dv|={np.abs(np.diff(v3, axis=0)).max():.4f}px")

    # ---------- 4. 地标映射 ----------
    lo, la = forward_map_points(np.array([179.5]), np.array([10.0]),
                                90.0, 0.0, 0.0)
    expect = (179.5 + 90.0 + 180.0) % 360.0 - 180.0
    err = abs(((lo[0] - expect + 180.0) % 360.0) - 180.0)
    check("地标: 越过左右接缝经度正确", err < 1e-9,
          f"lon={lo[0]:.4f}° expect={expect:.4f}°")

    rng = np.random.default_rng(0)
    tl = np.append(rng.uniform(-180, 180, 200), [0.0, 10.0, -170.0])
    ta = np.append(rng.uniform(-89.5, 89.5, 200), [89.5, -89.5, 89.0])
    fo, fa = forward_map_points(tl, ta, 12.3, 45.6, -78.9)
    bo, ba = inverse_map_points(fo, fa, 12.3, 45.6, -78.9)
    d1 = lonlat_to_dir(np.deg2rad(tl), np.deg2rad(ta))
    d2 = lonlat_to_dir(np.deg2rad(bo), np.deg2rad(ba))
    ang = np.arccos(np.clip((d1 * d2).sum(axis=-1), -1.0, 1.0))
    check("地标: 含极区点往返映射可找回(角度误差)",
          ang.max() < 1e-4, f"max_err={np.rad2deg(ang.max()):.2e}°")

    # ---------- 5. 导出 / GUI 冒烟 ----------
    try:
        os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
        from PySide6.QtGui import QImage
        from PySide6.QtWidgets import QApplication
        from app import MainWindow
        app = QApplication.instance() or QApplication([])
        win = MainWindow()
        win.load_array(make_sample(512))
        win.set_angles(30.0, 45.0, 10.0)
        with tempfile.TemporaryDirectory() as td:
            p = os.path.join(td, "out.png")
            win.export_to(p)
            qi = QImage(p)
            meta = json.loads(
                open(p.replace(".png", ".pose.json"),
                     encoding="utf-8").read())
            ok = (not qi.isNull() and qi.width() == 512 and qi.height() == 256
                  and abs(meta["yaw"] - 30.0) < 1e-9
                  and abs(meta["pitch"] - 45.0) < 1e-9
                  and qi.text("pano_yaw") == "30.0")
        check("导出: 2:1 PNG + 朝向设置保留", ok)
    except Exception as e:  # noqa: BLE001
        check("导出: GUI 冒烟", False, repr(e))

    failed = [n for n, ok in RESULTS if not ok]
    print(f"\n{len(RESULTS) - len(failed)}/{len(RESULTS)} 项通过")
    if failed:
        print("未通过:", *failed, sep="\n  - ")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
