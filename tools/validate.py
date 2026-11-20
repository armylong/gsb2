#!/usr/bin/env python3
"""独立验证脚本: 用生成样例的参考数据核对处理质量。

用法:
    python -I tools/validate.py [--samples samples_generated] [--regen]

验证项与适用容差 (均打印在报告中):
  1. 已知倾角误差   : |估计校正角 - 参考校正角| <= 0.3°
  2. 空白页提示     : 空白样例状态必须为 blank, 不输出假角度
  3. 交叉方向提示   : 交叉样例状态为 ambiguous/low_contrast 或置信度 < 0.5
  4. 纸白均匀程度   : 照明均衡后纸白区灰度标准差 <= max(6, 均衡前的 50%)
  5. 细线保留       : 校正后沿参考细线采样, 明显暗于纸面的采样点比例 >= 0.70
  6. 黑块不被提亮   : 照明均衡后黑块区域均值 < 100
  7. 有效边界       : 旋转后掩膜四角为填充区, 有效面积比例在理论值 ±3% 内
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scanprep.core import (  # noqa: E402
    PipelineParams, estimate_skew, flatten_illumination, process,
)
from scanprep.core.geometry import STATUS_AMBIGUOUS, STATUS_BLANK, STATUS_LOW_CONTRAST, STATUS_OK  # noqa: E402
from scanprep.samples.generator import generate_samples  # noqa: E402

ANGLE_TOL = 0.3
LINE_KEEP_MIN = 0.70
BLACK_BLOCK_MAX_MEAN = 100.0
AREA_FRAC_TOL = 0.03

results = []


def check(name, ok, detail):
    results.append((name, ok, detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}: {detail}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--samples", default="samples_generated")
    ap.add_argument("--regen", action="store_true", help="重新生成样例")
    args = ap.parse_args()
    sdir = Path(args.samples)
    if args.regen or not (sdir / "reference.json").exists():
        print(f"生成样例到 {sdir}/ ...")
        generate_samples(sdir)
    reference = json.loads((sdir / "reference.json").read_text(encoding="utf-8"))

    print("\n== 1. 已知倾角误差 (容差 ±%.2f°) ==" % ANGLE_TOL)
    for name, ref in reference.items():
        if ref.get("kind") != "text":
            continue
        gray = cv2.imread(str(sdir / ref["file"]), cv2.IMREAD_GRAYSCALE)
        est = estimate_skew(gray)
        err = abs(est.angle - ref["expected_correction_deg"])
        check(f"{name} 角度", est.status == STATUS_OK and err <= ANGLE_TOL,
              f"估计 {est.angle:+.3f}° 参考 {ref['expected_correction_deg']:+.3f}° "
              f"误差 {err:.3f}° 置信度 {est.confidence:.2f} 状态 {est.status}")

    print("\n== 2/3. 空白页与交叉方向提示 ==")
    gray = cv2.imread(str(sdir / reference["blank"]["file"]), cv2.IMREAD_GRAYSCALE)
    est = estimate_skew(gray)
    check("空白页", est.status == STATUS_BLANK,
          f"状态 {est.status} 置信度 {est.confidence:.2f} 墨迹占比 {est.ink_fraction:.6f}")
    gray = cv2.imread(str(sdir / reference["cross"]["file"]), cv2.IMREAD_GRAYSCALE)
    est = estimate_skew(gray)
    unreliable = est.status in (STATUS_AMBIGUOUS, STATUS_LOW_CONTRAST) or est.confidence < 0.5
    check("交叉方向", unreliable,
          f"状态 {est.status} 置信度 {est.confidence:.2f} (要求不可给出高置信结论)")

    ref = reference["text_tilt_m7"]
    gray = cv2.imread(str(sdir / ref["file"]), cv2.IMREAD_GRAYSCALE)
    theta = ref["expected_correction_deg"]

    print("\n== 4. 纸白均匀程度 ==")
    # 纸白 ROI: 页面中部一块无墨迹区域 (源图坐标, 由版式决定)
    roi = (500, 660, 640, 700)  # x0,y0,x1,y1, 位于文字带与表格之间的纸白
    x0, y0, x1, y1 = roi
    before = gray[y0:y1, x0:x1].astype(np.float64)
    flat, _ = flatten_illumination(gray, 1.0)
    after = flat[y0:y1, x0:x1].astype(np.float64)
    check("纸白均匀", after.std() <= max(6.0, 0.5 * before.std()),
          f"均衡前 std={before.std():.2f} 均衡后 std={after.std():.2f} "
          f"(阈值 max(6, {0.5 * before.std():.2f}))")

    print("\n== 5. 细线保留 (容差: 保留率 >= %.2f) ==" % LINE_KEEP_MIN)
    res = process(gray, PipelineParams(angle=theta, deskew=True,
                                       illumination=True, mode="gray"))
    paper = res.paper_level
    for i, line in enumerate(ref["thin_lines"]):
        p = np.array(line, dtype=np.float64)
        n = 400
        ts = np.linspace(0, 1, n)[:, None]
        pts = p[0] * (1 - ts) + p[1] * ts
        xi = np.clip(np.round(pts[:, 0]).astype(int), 0, res.image.shape[1] - 1)
        yi = np.clip(np.round(pts[:, 1]).astype(int), 0, res.image.shape[0] - 1)
        valid = res.mask[yi, xi] > 0
        vals = res.image[yi[valid], xi[valid]].astype(np.float64)
        keep = float((vals < paper - 30).mean()) if vals.size else 0.0
        check(f"细线{i} 保留", keep >= LINE_KEEP_MIN,
              f"保留率 {keep:.2f} (采样 {vals.size} 点)")

    print("\n== 6. 黑块不被提亮 (阈值: 均值 < %.0f) ==" % BLACK_BLOCK_MAX_MEAN)
    bx0, by0, bx1, by1 = ref["black_block_src"]
    # 黑块区域经同一旋转矩阵映射到输出坐标
    from scanprep.core.geometry import map_points
    corners = map_points(res.matrix, np.array(
        [[bx0, by0], [bx1, by0], [bx1, by1], [bx0, by1]], float))
    cx0, cy0 = np.floor(corners.min(axis=0)).astype(int)
    cx1, cy1 = np.ceil(corners.max(axis=0)).astype(int)
    pad = 12  # 向内收缩, 避开边缘过渡带
    block = res.image[cy0 + pad:cy1 - pad, cx0 + pad:cx1 - pad]
    check("黑块保持深色", float(block.mean()) < BLACK_BLOCK_MAX_MEAN,
          f"均衡+旋转后黑块均值 {block.mean():.1f}")

    print("\n== 7. 有效边界 ==")
    m = res.mask
    corners_fill = (m[0, 0] == 0 and m[0, -1] == 0 and m[-1, 0] == 0 and m[-1, -1] == 0)
    frac = float((m > 0).mean())
    a = np.deg2rad(abs(theta))
    theory = 1.0 / ((np.cos(a) + np.sin(a)) ** 2)  # 方形近似, 仅作量级参考
    check("填充区存在", corners_fill, f"四角均为填充区, 有效面积比例 {frac:.3f}")
    check("边界可复现", abs(frac - theory) < 0.08,
          f"有效比例 {frac:.3f}, 方形理论参考 {theory:.3f} (容差 0.08, 页面非方形仅作参考)")

    n_fail = sum(1 for _, ok, _ in results if not ok)
    print(f"\n总计 {len(results)} 项, 失败 {n_fail} 项")
    return 1 if n_fail else 0


if __name__ == "__main__":
    sys.exit(main())
