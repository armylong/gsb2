"""验收脚本: 验证同一对颜色 / 同一个半透明像素, 在浅底与深底上的读数确实不同。

直接在终端运行 (无需 GUI):
    .venv/bin/python -m samples.verify_readings
"""
from __future__ import annotations

import os

import numpy as np

from colorcheck import cvd
from colorcheck.analysis import pair_pixel_metrics, pixel_color
from colorcheck.pngio import read_png
from samples.make_samples import MARKERS, make_all

LIGHT_BG = (245, 245, 245)
DARK_BG = (30, 30, 30)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    data_dir = os.path.join(here, "data")
    sheet_path, singles = make_all(data_dir)
    rgba = read_png(sheet_path)

    print("=" * 72)
    print("1) 同一个半透明边缘像素在两种底色上的实际显示色")
    print("=" * 72)
    edge_pts = np.argwhere((rgba[..., 3] > 20) & (rgba[..., 3] < 240))
    y, x = edge_pts[len(edge_pts) // 2]
    for label, bg in (("浅底", LIGHT_BG), ("深底", DARK_BG)):
        info = pixel_color(rgba, int(y), int(x), bg)
        print(f"  {label}: 源 RGBA={info['src_rgb']} "
              f"alpha={info['alpha']:.2f} -> 显示色 {info['shown_hex']}")

    print()
    print("=" * 72)
    print("2) 必须区分的两对标色, 在不同底色 / 模拟下的配对读数")
    print("=" * 72)
    pairs = [(MARKERS[0][1], MARKERS[1][1], "红 ↔ 绿"),
             (MARKERS[2][1], MARKERS[3][1], "橙 ↔ 黄绿")]
    for ca, cb, label in pairs:
        print(f"\n  [{label}]")
        for bg_label, bg in (("浅底", LIGHT_BG), ("深底", DARK_BG)):
            for kind_label, kind, sev in (
                    ("普通视觉", cvd.DEUTAN, 0.0),
                    ("protan 100%", cvd.PROTAN, 1.0),
                    ("deutan 50%", cvd.DEUTAN, 0.5)):
                m = pair_pixel_metrics(rgba, ca, cb, bg, kind, sev)
                print(f"    {bg_label} | {kind_label:12s} "
                      f"ΔE均值={m['de_mean']:6.2f}  ΔE最小="
                      f"{m['de_min']:6.2f}  反差A={m['contrast_a']:5.2f}"
                      f"  反差B={m['contrast_b']:5.2f}")

    print()
    print("=" * 72)
    print("3) 验收结论")
    print("=" * 72)
    ok = True
    for ca, cb, label in pairs:
        ml = pair_pixel_metrics(rgba, ca, cb, LIGHT_BG, cvd.DEUTAN, 1.0)
        md = pair_pixel_metrics(rgba, ca, cb, DARK_BG, cvd.DEUTAN, 1.0)
        different = (not np.isclose(ml["contrast_a"], md["contrast_a"])
                     and not np.isclose(ml["contrast_b"], md["contrast_b"]))
        print(f"  {label}: 浅/深底反差读数不同 = {different}")
        ok &= different
    print("\n  结果:", "PASS ✓ 同一对颜色在两种底色下读数确实不同"
          if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
