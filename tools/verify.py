"""可复现校验: 用生成样例检查合成流水线的关键行为。

检查项(允许误差见各 TOL 常量):
1. 已知区域清晰度改善: 各纹理区合成结果的 Tenengrad ≥ 最佳单张输入的 85%
2. 来源选择正确: 各区域 ≥70% 像素的自动来源编号 = 真值最清晰来源
3. 无效区排除: 导出裁切 = 公共有效区外接矩形, 裁切内无无效像素
4. 低纹理防抖: 低纹理带来源边界像素占比 < 8%
5. 人工来源覆盖: 笔迹指定来源生效(像素级), 擦除后恢复自动
6. 无效覆盖拒绝: 目标来源在图外的笔迹像素被拒绝且不计入
7. 导出一致性: 结果图/来源图尺寸 = 裁切, 设置可复现同样的结果

运行: python -m tools.verify [--samples samples]
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path

import cv2
import numpy as np

from focusstack.alignment import AlignParams
from focusstack.export import export_all, strokes_from_settings
from focusstack.fusion import FusionParams
from focusstack.pipeline import Stroke, compute_all
from tools import make_sample

TOL_SHARP = 0.85      # 清晰度改善下限(相对最佳单张)
TOL_LABEL = 0.70      # 区域内来源编号正确率下限
TOL_LOWTEX_EDGE = 0.08  # 低纹理带来源边界像素占比上限
TOL_OVR_LABEL = 0.95  # 人工覆盖区来源编号命中率下限
TOL_OVR_PIX = 2.0     # 人工覆盖区像素与指定来源的平均绝对差上限
TOL_ERASE = 0.97      # 擦除后与自动结果的一致率下限


def tenengrad(img: np.ndarray, mask: np.ndarray) -> float:
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
    gx = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)
    e = gx * gx + gy * gy
    return float(e[mask].mean())


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--samples", default="samples", help="样例目录(不存在则自动生成)")
    args = ap.parse_args()
    sdir = Path(args.samples)
    if not (sdir / "ground_truth.json").exists():
        print(f"样例不存在, 生成到 {sdir} ...")
        make_sample.generate(sdir)

    gt = json.loads((sdir / "ground_truth.json").read_text(encoding="utf-8"))
    labels = cv2.imread(str(sdir / "gt_labels.png"), cv2.IMREAD_GRAYSCALE)
    images = [cv2.imread(str(sdir / n), cv2.IMREAD_COLOR) for n in gt["images"]]
    assert all(i is not None for i in images), "样例图片读取失败"
    ref = gt["reference"]
    aligns = [AlignParams(**a) for a in gt["align"]]
    params = FusionParams()

    checks: list[tuple[str, bool, str]] = []

    def check(name: str, ok: bool, detail: str):
        checks.append((name, ok, detail))

    # ---------- 自动合成 ----------
    res = compute_all(images, ref, aligns, params)
    common = res.common
    x, y, w, h = res.crop

    # 1+2. 区域清晰度与来源正确性
    er = np.ones((9, 9), np.uint8)
    for name, reg in gt["regions"].items():
        mask = (labels == reg["label"]) & common
        mask = cv2.erode(mask.view(np.uint8), er).astype(bool) & common
        t_res = tenengrad(res.img_auto, mask)
        t_best = max(tenengrad(res.warped[i], mask) for i in range(len(images)))
        check(
            f"清晰度改善[{name}]",
            t_res >= TOL_SHARP * t_best,
            f"结果 {t_res:.0f} vs 最佳单张 {t_best:.0f} (要求 ≥{TOL_SHARP:.0%})",
        )
        lab = res.label_auto[mask]
        frac = float((lab == reg["expected_sharpest"]).mean())
        check(
            f"来源正确[{name}]",
            frac >= TOL_LABEL,
            f"来源{reg['expected_sharpest'] + 1} 占比 {frac:.1%} (要求 ≥{TOL_LABEL:.0%})",
        )

    # 3. 无效区排除
    ys, xs = np.nonzero(common)
    bbox = (int(xs.min()), int(ys.min()), int(xs.max()) + 1 - int(xs.min()), int(ys.max()) + 1 - int(ys.min()))
    check("裁切=公共有效区外接矩形", res.crop == bbox, f"crop={res.crop} bbox={bbox}")
    inside = np.zeros(common.shape, bool)
    inside[y : y + h, x : x + w] = True
    check(
        "裁切内全部来源有效",
        bool(common[inside].all()) and bool((res.label_final[inside] != 255).all()),
        f"裁切 {w}x{h} 内 common 全覆盖: {common[inside].all()}",
    )

    # 4. 低纹理防抖
    low = (labels == gt["lowtex_label"]) & common
    lab = res.label_auto
    edge = np.zeros(lab.shape, bool)
    edge[:, 1:] |= lab[:, 1:] != lab[:, :-1]
    edge[1:, :] |= lab[1:, :] != lab[:-1, :]
    frac_edge = float(edge[low].mean())
    check(
        "低纹理防抖",
        frac_edge < TOL_LOWTEX_EDGE,
        f"低纹理带来源边界像素占比 {frac_edge:.2%} (要求 <{TOL_LOWTEX_EDGE:.0%})",
    )

    # 5. 人工来源覆盖
    mid_mask = (labels == gt["regions"]["mid"]["label"]) & common
    mys, mxs = np.nonzero(mid_mask)
    cx, cy = float(mxs.mean()), float(mys.mean())
    stroke = Stroke(points=[(cx, cy)], radius=40, source=0)
    res2 = compute_all(images, ref, aligns, params, strokes=[stroke])
    yy, xx = np.mgrid[0 : lab.shape[0], 0 : lab.shape[1]]
    core = (xx - cx) ** 2 + (yy - cy) ** 2 <= 30**2
    hit = float((res2.label_final[core] == 0).mean())
    pix = float(np.abs(res2.img_final[core].astype(int) - res2.warped[0][core].astype(int)).mean())
    check(
        "人工覆盖生效",
        hit >= TOL_OVR_LABEL and pix <= TOL_OVR_PIX,
        f"来源命中率 {hit:.1%} (≥{TOL_OVR_LABEL:.0%}), 与来源1像素差 {pix:.2f} (≤{TOL_OVR_PIX})",
    )
    erase = Stroke(points=[(cx, cy)], radius=45, source=-1)
    res3 = compute_all(images, ref, aligns, params, strokes=[stroke, erase])
    same = float((res3.label_final[core] == res.label_auto[core]).mean())
    check("擦除恢复自动", same >= TOL_ERASE, f"与自动来源一致率 {same:.1%} (≥{TOL_ERASE:.0%})")

    # 6. 无效覆盖拒绝: 找一个 来源3无效但参考图有效 的位置
    bad = (~res.valids[2]) & res.valids[0]
    assert bad.any(), "样例应存在来源3无效区域"
    by, bx = int(np.nonzero(bad)[0][0]), int(np.nonzero(bad)[1][0])
    res4 = compute_all(
        images, ref, aligns, params, strokes=[Stroke([(float(bx), float(by))], 8, 2)]
    )
    check(
        "无效覆盖被拒绝",
        res4.rejected > 0 and int(res4.override[by, bx]) == -1,
        f"被拒绝像素 {res4.rejected}, 该处 override={int(res4.override[by, bx])} (应=-1)",
    )

    # 7. 导出一致性
    with tempfile.TemporaryDirectory() as td:
        paths = export_all(td, gt["images"], ref, aligns, params, [stroke], res2)
        out_img = cv2.imread(str(paths["result"]), cv2.IMREAD_COLOR)
        out_map = cv2.imread(str(paths["source_map"]), cv2.IMREAD_COLOR)
        settings = json.loads(paths["settings"].read_text(encoding="utf-8"))
        size_ok = out_img.shape[:2] == (h, w) and out_map.shape[:2] == (h, w)
        crop_ok = settings["crop"] == {"x": x, "y": y, "w": w, "h": h}
        check("导出尺寸与裁切一致", size_ok and crop_ok, f"结果 {out_img.shape[:2]}, 裁切 {(h, w)}")

        aligns2 = [AlignParams(**a) for a in settings["align"]]
        params2 = FusionParams(**settings["fusion"])
        strokes2 = strokes_from_settings(settings)
        res5 = compute_all(images, settings["reference"], aligns2, params2, strokes2)
        repro = np.array_equal(res5.img_final, res2.img_final) and np.array_equal(
            res5.label_final, res2.label_final
        )
        check("设置可复现结果", repro, "按 settings.json 重算, 结果与来源图逐像素一致")

    # ---------- 汇总 ----------
    width = max(len(n) for n, _, _ in checks)
    all_ok = True
    for name, ok, detail in checks:
        all_ok &= ok
        print(f"[{'PASS' if ok else 'FAIL'}] {name.ljust(width)}  {detail}")
    print(f"\n{'全部通过' if all_ok else '存在失败项'} ({sum(ok for _, ok, _ in checks)}/{len(checks)})")
    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
