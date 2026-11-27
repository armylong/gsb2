"""无头端到端验证: 合成图 -> 对齐 -> 标定 -> 修复 -> 与真值底稿比对。

运行: .venv/bin/python tests/smoke_pipeline.py
不依赖 GUI, 在 CI / 无显示环境也能跑。
"""

from __future__ import annotations

import json
import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from descan.alignment import (  # noqa: E402
    Alignment,
    coverage_mask,
    fit_transform,
    residuals,
    warp_back,
)
from descan.bleed import (  # noqa: E402
    LocalPatch,
    ProcessParams,
    back_ink_map,
    calibrate_strength,
    process_front,
)
from descan.synth import SynthConfig, write_pair  # noqa: E402


def build_alignment_from_truth(front, back, cfg: SynthConfig) -> Alignment:
    """用合成时的已知错位反推 4 个点对(等价于用户手工点对)。"""
    h, w = front.shape
    m = cv2.getRotationMatrix2D((w / 2.0, h / 2.0), cfg.angle_deg, 1.0)
    m[0, 2] += cfg.shift[0]
    m[1, 2] += cfg.shift[1]
    full = np.vstack([m, [0.0, 0.0, 1.0]])
    inv = np.linalg.inv(full)

    front_pts = [(150, 150), (w - 200, 150), (w - 200, h - 200), (150, h - 200)]
    back_pts = []
    for fx, fy in front_pts:
        x, y, z = inv @ np.array([fx, fy, 1.0])
        bx, by = x / z, y / z          # 镜像后背面坐标
        back_pts.append((w - bx, by))  # 反镜像回背面原图坐标

    al = Alignment(
        front_shape=front.shape, back_shape=back.shape,
        method="similarity",
        front_pts=front_pts, back_pts=back_pts,
    )
    return fit_transform(al)


def main() -> int:
    out_dir = "demo_data/sample"
    cfg = SynthConfig()
    data = write_pair(out_dir, cfg)
    front, back, clean = data["front"], data["back"], data["front_clean"]
    meta = data["meta"]
    h, w = front.shape

    # --- 对齐 ---
    al = build_alignment_from_truth(front, back, cfg)
    rms = float(residuals(al).mean())
    warped = warp_back(back, al)
    cov = coverage_mask(al)
    cover_frac = float((cov > 0).mean())

    # --- 留白标定 ---
    ink, _ = back_ink_map(warped, cov, 31, 1.2, 2.0)
    k, ref_mask = calibrate_strength(front, ink, cov,
                                     tuple(meta["calib_rect"]))
    ref_count = int((ref_mask > 0).sum())

    # --- 修复 ---
    params = ProcessParams(base_strength=k)
    res = process_front(front, warped, cov, params)

    # 局部块: 在纯背透竖条区加大 30%, 验证局部强度只作用在块内
    params.patches = [LocalPatch(x=w - 140, y=80, w=90, h=h - 160, gain=1.3)]
    res_patch = process_front(front, warped, cov, params)

    # --- 量化校对 ---
    cal = meta["calib_rect"]
    x0, y0, bw, bh = cal
    def region(img):
        return img[y0:y0 + bh, x0:x0 + bw].astype(np.float32)

    blank_before = float(np.abs(region(front) - region(clean)).mean())
    blank_after = float(
        np.abs(region(res.result) - region(clean)).mean()
    )

    # 细线保留要区分两件事:
    # - processing_damage: 处理本身在正面真墨像素上造成的改动, 必须≈0
    #   (输入里物理透过来的背透不可逆, 不能算算法的错)
    # - residual_bleed: 输入原图相对真值底稿的背透量, 保护区里它会原样留下
    ink_px = clean < 120
    f32 = front.astype(np.float32)
    c32 = clean.astype(np.float32)
    processing_damage = float(np.abs(
        res.result.astype(np.float32) - f32
    )[ink_px].mean())
    input_bleed_on_ink = float(np.abs(f32 - c32)[ink_px].mean())

    # 碰撞区正面线: 处理损伤必须为 0(保护区完全不动)
    cx, cy, cw, ch = meta["collision_rect"]
    coll_clean = clean[cy:cy + ch, cx:cx + cw].astype(np.float32)
    coll_front = front[cy:cy + ch, cx:cx + cw].astype(np.float32)
    coll_out = res.result[cy:cy + ch, cx:cx + cw].astype(np.float32)
    coll_ink = coll_clean < 120
    coll_damage = float(np.abs(coll_out - coll_front)[coll_ink].mean())
    coll_residual_bleed = float(np.abs(coll_front - coll_clean)[coll_ink].mean())

    # 纯背透竖条(正面无字): 偏离纸白的量应大幅下降
    band = (slice(200, 1000), slice(792, 808))
    paper_target = 245.0
    band_before = float(np.abs(front[band].astype(np.float32) - paper_target).mean())
    band_after = float(
        np.abs(res.result[band].astype(np.float32) - paper_target).mean()
    )

    # 覆盖区外像素必须与原图逐像素相同
    outside_same = bool(np.array_equal(
        res.result[cov == 0], front[cov == 0]
    ))

    # 导出尺寸
    size_ok = res.result.shape == front.shape

    summary = {
        "align_rms_px": round(rms, 4),
        "coverage_fraction": round(cover_frac, 4),
        "calibrated_k": round(k, 3),
        "true_k": cfg.bleed_k,
        "reference_pixel_count": ref_count,
        "blank_mae_before": round(blank_before, 3),
        "blank_mae_after": round(blank_after, 3),
        "blank_cleanup_ratio": round(
            1.0 - blank_after / max(blank_before, 1e-9), 3
        ),
        "front_ink_processing_damage": round(processing_damage, 3),
        "front_ink_input_bleed_residual": round(input_bleed_on_ink, 3),
        "collision_processing_damage": round(coll_damage, 3),
        "collision_residual_bleed_irreversible": round(coll_residual_bleed, 3),
        "pure_bleed_band_before": round(band_before, 3),
        "pure_bleed_band_after": round(band_after, 3),
        "outside_coverage_unchanged": outside_same,
        "export_size_preserved": size_ok,
        "patch_field_max": float(res_patch.strength_field.max()),
    }
    print(json.dumps(summary, indent=2, ensure_ascii=False))

    cv2.imwrite(os.path.join(out_dir, "out_result.png"), res.result)
    cv2.imwrite(os.path.join(out_dir, "out_reference.png"), res.reference_pixels)
    cv2.imwrite(os.path.join(out_dir, "out_diff.png"), res.diff)
    cv2.imwrite(os.path.join(out_dir, "out_protect.png"),
                (res.protect_mask * 255).astype(np.uint8))
    cv2.imwrite(os.path.join(out_dir, "out_back_warped.png"), warped)
    cv2.imwrite(os.path.join(out_dir, "out_coverage.png"), cov)

    ok = (
        rms < 1.0
        and cover_frac < 0.98          # 角上确实缺参考
        and abs(k - cfg.bleed_k) < 0.12
        and blank_after < blank_before * 0.45      # 空白显著变干净
        and processing_damage < 1.0                # 正面细字零处理损伤
        and coll_damage < 1.0                      # 碰撞线完全保留
        and band_after < band_before * 0.4         # 纯背透区清理过半
        and outside_same
        and size_ok
    )
    print("SMOKE", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
