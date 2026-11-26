"""本地可运行检查（无 GUI）：用已知偏色的合成小图核对校准效果。

运行方式（在仓库根目录）::

    python -I tests/check_calibration.py

检查内容：
1. 留出格子（未参与对色）修正后 ΔE 显著下降，并接近指定目标值；
2. 完整 3x3 修正优于仅白平衡对照；
3. 反光格子能被过曝/边框检查标出，停用后拟合仍可靠；
4. 色格颜色过于单一时，拟合应明确报错而不是给出不可信结果；
5. 预览/导出共用的裁剪规则不会改变可显示范围内的像素。
"""

from __future__ import annotations

import sys
from pathlib import Path

# 允许直接从仓库根目录运行（python -I tests/check_calibration.py）
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np

from colorcalib import calibration as calib
from colorcalib.sampleimage import GLARE_PATCH_INDEX, build_sample_image
from colorcalib.sampling import ROIRect, sample_all
from colorcalib.srgb import clip_srgb, delta_e, srgb_array_to_lab

# 留出：B1(红,idx4)、C4(青,idx11) 两块不参与拟合，专门检验泛化
HELD_OUT_IDS = {"B1", "C4"}
# 反光格 B3 停用
DISABLED_IDS = {"B3"}


def _fit_and_measure(rois: list[ROIRect], samples, refs, kind: str):
    measured, target, ids = [], [], []
    for roi in rois:
        s = samples[roi.patch_id]
        if not s.usable or not roi.enabled or roi.role != "fit":
            continue
        measured.append(s.median_rgb)
        target.append(np.asarray(refs[roi.patch_id].rgb, dtype=np.float64))
        ids.append(roi.patch_id)
    model = calib.fit_model(np.asarray(measured), np.asarray(target), ids, kind)

    held = []
    for roi in rois:
        if roi.role != "check":
            continue
        s = samples[roi.patch_id]
        ref = refs[roi.patch_id]
        corrected = model.apply_srgb(s.median_rgb.reshape(1, 1, 3)).reshape(3)
        lab_t = np.asarray(ref.lab).reshape(1, 3)
        before = float(delta_e(srgb_array_to_lab(s.median_rgb.reshape(1, 3)), lab_t)[0])
        after = float(delta_e(srgb_array_to_lab(corrected.reshape(1, 3)), lab_t)[0])
        held.append((roi.patch_id, before, after))
    return model, held


def main() -> int:
    failures: list[str] = []
    sample = build_sample_image()
    refs = {p.id: p for p in sample.references}

    rois = []
    for roi in sample.rois:
        role = "check" if roi.patch_id in HELD_OUT_IDS else "fit"
        enabled = roi.patch_id not in DISABLED_IDS
        rois.append(
            ROIRect(roi.patch_id, roi.x0, roi.y0, roi.x1, roi.y1, role, enabled)
        )

    samples = sample_all(sample.image, rois)

    # ---- 检查 1+2：留出格子改善，且完整修正优于白平衡 ----
    print("== 检查 1/2：留出格子的修正前后 ΔE ==")
    model_full, held_full = _fit_and_measure(rois, samples, refs, "full")
    model_wb, held_wb = _fit_and_measure(rois, samples, refs, "white_balance")
    print(f"完整矩阵条件数: {model_full.condition_number:.1f}（< {calib.COND_FAIL} 才可信）")
    full_after, wb_after = [], []
    for (pid, before, after), (_p2, _b2, after_wb) in zip(held_full, held_wb):
        print(f"  {pid}: 修正前 {before:6.2f} ΔE | 白平衡后 {after_wb:6.2f} | 完整修正后 {after:6.2f}")
        if not (after < before * 0.5 and after < 5.0):
            failures.append(f"{pid} 留出格修正后 ΔE={after:.2f} 未达标（修正前 {before:.2f}）")
        full_after.append(after)
        wb_after.append(after_wb)
    if np.mean(full_after) >= np.mean(wb_after):
        failures.append("完整修正没有优于仅白平衡对照")
    if model_full.condition_number >= calib.COND_FAIL:
        failures.append(f"条件数 {model_full.condition_number:.1f} 超出可信阈值")

    # ---- 检查 3：反光格质量标记 ----
    print("\n== 检查 3：反光/边框质量标记 ==")
    glare_id = sample.references[GLARE_PATCH_INDEX].id
    glare = samples[glare_id]
    print(
        f"  {glare_id}: 过曝={glare.overexposed}（比例 {glare.overexposed_ratio*100:.1f}%）"
        f" 边框风险={glare.border_risk} usable={glare.usable}"
    )
    if not (glare.overexposed or glare.border_risk):
        failures.append("反光格未被任何质量检查标出")
    normal = samples["A2"]
    if normal.overexposed or normal.border_risk:
        failures.append("正常格 A2 被误报为过曝/边框问题")

    # ---- 检查 4：颜色过于单一时必须报错 ----
    print("\n== 检查 4：退化输入的可靠性诊断 ==")
    gray = np.full((6, 3), 120.0)
    gray += np.array([[0.0, 0.0, 0.0], [0.3, 0.3, 0.3], [-0.2, -0.2, -0.2],
                      [0.1, 0.1, 0.1], [-0.1, -0.1, -0.1], [0.2, 0.2, 0.2]])
    target_gray = np.full((6, 3), 118.0)
    try:
        calib.fit_model(gray, target_gray, [f"g{i}" for i in range(6)], "full")
        failures.append("共线灰阶输入没有触发 CalibrationError")
        print("  未报错（错误）")
    except calib.CalibrationError as exc:
        print(f"  按预期拒绝拟合: {exc}")

    too_few = np.array([[100.0, 100, 100], [200.0, 50, 50]])
    try:
        calib.fit_model(too_few, too_few.copy(), ["x", "y"], "full")
        failures.append("仅 2 个色格时没有触发 CalibrationError")
    except calib.CalibrationError as exc:
        print(f"  按预期拒绝拟合: {exc}")

    # ---- 检查 5：导出/预览同一裁剪规则，范围内像素不被改动 ----
    print("\n== 检查 5：越界裁剪规则 ==")
    test = np.array([[[10.0, 128.0, 300.0], [-5.0, 50.0, 255.0]]])
    clipped, mask = clip_srgb(test)
    print(f"  输入 {test.tolist()} -> 裁剪后 {clipped.tolist()}，越界掩码 {mask.tolist()}")
    if not mask.tolist() == [[True, True]]:
        failures.append("越界掩码未正确标出超出 0-255 的像素")
    if clipped[0, 0, 1] != 128.0 or clipped[0, 1, 2] != 255.0:
        failures.append("范围内的像素被裁剪规则改动")

    # ---- 汇总 ----
    print("\n" + "=" * 60)
    if failures:
        print("检查失败：")
        for f in failures:
            print(f"  ✗ {f}")
        return 1
    print("全部检查通过：留出格在未参与对色的情况下显著接近目标值，")
    print("完整修正优于白平衡对照，退化输入被拒绝，裁剪规则一致。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
