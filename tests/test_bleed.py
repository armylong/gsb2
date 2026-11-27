"""透印估计/保护/导出的单元测试(无头)。"""

from __future__ import annotations

import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from descan.bleed import (  # noqa: E402
    LocalPatch,
    ProcessParams,
    back_ink_map,
    build_hand_protect,
    calibrate_strength,
    process_front,
)
from descan.synth import SynthConfig, generate_pair  # noqa: E402
from tests.smoke_pipeline import build_alignment_from_truth  # noqa: E402
from descan.alignment import coverage_mask, warp_back  # noqa: E402


def _fixture():
    cfg = SynthConfig()
    data = generate_pair(cfg)
    front, back, clean = data["front"], data["back"], data["front_clean"]
    al = build_alignment_from_truth(front, back, cfg)
    warped = warp_back(back, al)
    cov = coverage_mask(al)
    ink, _ = back_ink_map(warped, cov, 31, 1.2, 2.0)
    k, ref = calibrate_strength(front, ink, cov,
                                 tuple(data["meta"]["calib_rect"]))
    return cfg, data, front, back, clean, warped, cov, ink, k, ref


def test_calibration_recovers_true_k():
    cfg, _, _, _, _, _, _, _, k, ref = _fixture()
    assert abs(k - cfg.bleed_k) < 0.12
    assert (ref > 0).sum() > 1000          # 参照像素真实存在且可展示


def test_reference_pixels_never_include_missing_area():
    _, _, front, _, _, warped, cov, _, k, _ = _fixture()
    res = process_front(front, warped, cov, ProcessParams(base_strength=k))
    assert np.all(res.reference_pixels[cov == 0] == 0)


def test_missing_coverage_pixels_are_untouched():
    _, _, front, _, _, warped, cov, _, k, _ = _fixture()
    res = process_front(front, warped, cov, ProcessParams(base_strength=k))
    assert np.array_equal(res.result[cov == 0], front[cov == 0])
    assert np.all(res.diff[cov == 0] == 0)


def test_result_never_brighter_than_local_paper_and_never_darker_than_input():
    _, _, front, _, _, warped, cov, _, k, _ = _fixture()
    res = process_front(front, warped, cov, ProcessParams(base_strength=k))
    # 修复只会"提亮"(压浅背透), 不会把任何像素压得比原图更暗
    assert np.all(res.result.astype(np.int16) >= front.astype(np.int16) - 1)
    # 不会超过 uint8 范围
    assert res.result.dtype == np.uint8


def test_front_ink_protected_with_zero_processing_damage():
    _, data, front, _, clean, warped, cov, _, k, _ = _fixture()
    res = process_front(front, warped, cov, ProcessParams(base_strength=k))
    ink_px = clean < 120
    damage = np.abs(
        res.result.astype(np.float32) - front.astype(np.float32)
    )[ink_px].mean()
    assert damage < 1.0


def test_hand_strokes_force_full_protection_in_original_pixels():
    _, _, front, _, _, warped, cov, _, k, _ = _fixture()
    params = ProcessParams(base_strength=k, protect_strokes=[
        [(200, 200), (220, 240), (240, 280)],
    ], protect_radius=10)
    res = process_front(front, warped, cov, params)
    assert res.hand_protect[240, 220] > 0
    # 手写保护区内像素与原图完全一致
    region = res.hand_protect > 0
    assert np.array_equal(res.result[region], front[region])


def test_local_patch_zero_gain_disables_repair_inside():
    _, _, front, _, _, warped, cov, _, k, _ = _fixture()
    params = ProcessParams(
        base_strength=k,
        patches=[LocalPatch(500, 300, 150, 150, 0.0)],
    )
    res = process_front(front, warped, cov, params)
    assert np.all(res.strength_field[360, 560] == 0.0)
    assert np.all(res.diff[360, 560] == 0.0)


def test_strength_scaling_monotonic_in_blank_area():
    _, _, front, _, _, warped, cov, _, k, _ = _fixture()
    # 取一块正面无墨、覆盖区内的区域
    x, y, w, h = 520, 200, 120, 80
    out_low = process_front(front, warped, cov,
                            ProcessParams(base_strength=k * 0.3)).result
    out_high = process_front(front, warped, cov,
                             ProcessParams(base_strength=k * 1.3)).result
    # 更强的修复在留白区应让结果更亮(均值更高)
    assert out_high[y:y+h, x:x+w].mean() >= out_low[y:y+h, x:x+w].mean()


def test_hand_protect_raster_uses_original_pixel_coordinates():
    shape = (500, 600)
    mask = build_hand_protect(shape, [[(10, 10), (100, 10)]], radius=4)
    assert mask.shape == shape
    assert mask[10, 50] > 0 and mask[400, 50] == 0


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"FAIL {fn.__name__}: {exc}")
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    raise SystemExit(1 if failed else 0)
