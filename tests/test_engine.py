"""引擎核心验证：尺寸、保护硬约束、坐标对应、不可行停止、取消、幂等。"""

import numpy as np
import pytest

from content_aware import demos
from content_aware.engine import (
    CarveInfeasible,
    compute_energy,
    carve_width,
)


# --------------------------------------------------------------------------- #
# 1. 输出宽高
# --------------------------------------------------------------------------- #
def test_output_dimensions_and_height_preserved(carve_normal, scene):
    image = scene["image"]
    h, w = image.shape[:2]
    target = int(round(w * 0.75))
    out = carve_normal

    assert out.height == h
    assert out.result.shape == (h, target, 3)
    assert out.source_index.shape == (h, target)
    assert out.width == target and out.completed and out.remaining == 0
    assert len(out.removed_seams) == w - target
    # 每条接缝每行恰好删 1 个像素
    assert len(out.removed_source_points) == (w - target) * h


# --------------------------------------------------------------------------- #
# 2. 坐标对应：输出像素逐一对回源图，且值完全相等
# --------------------------------------------------------------------------- #
def test_source_mapping_pixel_identity(carve_normal, scene):
    image = scene["image"]
    out = carve_normal
    h = out.height

    rows = np.arange(h)[:, None]
    mapped = image[rows, out.source_index]          # (H, W', 3)
    assert np.array_equal(mapped, out.result)        # 结果就是源像素的重排，无插值

    # 每行：保留列 + 删除列 = 全部源列，且保留列保持原有左右顺序
    removed_per_row = out.removed_source_cols_per_row()
    for r in range(h):
        kept = out.source_index[r]
        assert np.all(np.diff(kept) > 0)             # 顺序不颠倒
        union = np.sort(np.concatenate([kept, removed_per_row[r]]))
        assert np.array_equal(union, np.arange(out.source_width))


def test_marker_colors_survive_and_map_back(carve_normal, scene):
    """用演示图自带的独立颜色标记核对：保留下来的标记颜色与源位置一致。"""
    image = scene["image"]
    markers = scene["markers"]
    out = carve_normal

    for x, y, size, bgr in markers:
        center = (x + size // 2, y + size // 2)
        # 取标记中心 2x2，找到源图中这些列在输出里的位置
        src_cols = [center[0]]
        for sc in src_cols:
            hit = np.where(out.source_index[center[1]] == sc)[0]
            if hit.size:  # 该标记这一行没被删
                rx = int(hit[0])
                assert tuple(int(v) for v in out.result[center[1], rx]) == bgr
                assert tuple(int(v) for v in image[center[1], sc]) == bgr


# --------------------------------------------------------------------------- #
# 3. 保护硬约束：被保护的源像素一个都不能被删
# --------------------------------------------------------------------------- #
def test_protected_source_pixels_never_removed(scene):
    image = scene["image"]
    h, w = image.shape[:2]
    rng = np.random.default_rng(7)
    mask = np.zeros((h, w), dtype=bool)
    # 散布若干不连通的小块，且每块都不贯穿整行
    for _ in range(12):
        cx, cy = rng.integers(20, w - 20), rng.integers(20, h - 20)
        mask[cy - 6:cy + 6, cx - 6:cx + 6] = True

    out = carve_width(image, mask, int(w * 0.78))
    protected_points = {
        (int(px), int(py)) for py, px in np.argwhere(mask)
    }  # 集合元素为 (x=列, y=行)
    removed = {(x, y) for y, x in out.removed_source_points}
    assert removed.isdisjoint(protected_points)

    # 全部保护像素都还在输出的 source_index 里
    for r in range(h):
        kept = set(out.source_index[r].tolist())
        prot_cols = np.where(mask[r])[0].tolist()
        assert all(c in kept for c in prot_cols)


# --------------------------------------------------------------------------- #
# 4. 不可行：全宽保护带阻断所有路径，停在原宽、删除 0 条
# --------------------------------------------------------------------------- #
def test_full_width_protected_band_is_immediately_infeasible(scene):
    image = scene["image"]
    h, w = image.shape[:2]
    mask = demos.make_blocked_mask(h, w)
    out = carve_width(image, mask, int(w * 0.8))

    assert out.stopped_infeasible and not out.completed
    assert out.width == w
    assert len(out.removed_seams) == 0
    assert np.array_equal(out.result, image)
    assert out.remaining == w - int(w * 0.8)


# --------------------------------------------------------------------------- #
# 5. 部分保护带：删到上限即停，停在“最后有效尺寸”，保护仍零删除
# --------------------------------------------------------------------------- #
def test_partial_band_stops_at_last_valid_size(scene):
    image = scene["image"]
    h, w = image.shape[:2]
    mask = demos.make_partial_band_mask(h, w)
    band_rows = np.where(mask.any(axis=1))[0]
    prot_count = int(mask[band_rows[0]].sum())
    max_removable = w - prot_count
    last_valid_width = prot_count            # 每行至少保留全部保护列

    # 目标低于理论极限：应停在最后有效尺寸，而不是放松保护硬撑
    out = carve_width(image, mask, last_valid_width - 20)
    assert out.stopped_infeasible and not out.completed
    assert out.width == last_valid_width                # 精确停在理论极限宽度
    assert len(out.removed_seams) == max_removable      # 已删数量 = 理论上限

    removed = {(x, y) for y, x in out.removed_source_points}
    protected_points = {
        (int(px), int(py))
        for py, px in np.argwhere(mask)       # argwhere 给出 (row=y, col=x)
    }
    assert removed.isdisjoint(protected_points)

    # 目标在极限以内：正常完成，宽度恰好等于目标
    ok = carve_width(image, mask, last_valid_width + 20)
    assert not ok.stopped_infeasible and ok.completed
    assert ok.width == last_valid_width + 20


# --------------------------------------------------------------------------- #
# 6. 取消：停在最后有效尺寸，标记 cancelled，映射记录仍然自洽
# --------------------------------------------------------------------------- #
def test_cancel_keeps_consistent_partial_result(scene):
    image = scene["image"]
    h, w = image.shape[:2]
    calls = {"n": 0}

    def cancel_after_three():
        calls["n"] += 1
        return calls["n"] > 3

    out = carve_width(image, np.zeros((h, w), bool), int(w * 0.75),
                      should_cancel=cancel_after_three)
    assert out.cancelled and not out.completed
    assert len(out.removed_seams) == 3
    assert out.result.shape[1] == w - 3
    # 半成品映射同样满足像素恒等
    rows = np.arange(h)[:, None]
    assert np.array_equal(image[rows, out.source_index], out.result)


# --------------------------------------------------------------------------- #
# 7. 同参数重复运行：以原图为起点，结果完全一致（不在成品上累计）
# --------------------------------------------------------------------------- #
def test_repeated_runs_are_identical_and_not_cumulative(scene):
    image = scene["image"]
    h, w = image.shape[:2]
    mask = np.zeros((h, w), dtype=bool)
    mask[60:120, 90:170] = True
    target = int(w * 0.82)

    first = carve_width(image, mask, target)
    # 用上一次的成品再“跑一遍”是被禁止的使用方式；这里始终传原图与同一掩码
    second = carve_width(image, mask, target)
    assert np.array_equal(first.result, second.result)
    assert first.width == second.width == target
    assert first.removed_source_points == second.removed_source_points
    assert np.array_equal(first.source_index, second.source_index)


# --------------------------------------------------------------------------- #
# 8. 参数校验与能量稳定性
# --------------------------------------------------------------------------- #
def test_invalid_target_raises(scene):
    image = scene["image"]
    h, w = image.shape[:2]
    with pytest.raises(CarveInfeasible):
        carve_width(image, np.zeros((h, w), bool), w + 10)


def test_energy_high_on_edges_low_on_smooth_texture(scene):
    image = scene["image"]
    energy = compute_energy(image)
    assert energy.shape == image.shape[:2]
    # 底部深色条带与标记的边界是强边缘，能量应明显高于左上角平滑背景
    h, w = image.shape[:2]
    edge_region = energy[h - 40:h - 30, 60:120].mean()
    smooth_region = energy[10:40, 10:80].mean()
    assert edge_region > smooth_region * 1.5
