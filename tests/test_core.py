"""核心逻辑测试: 引擎、统计、ROI、往返、导出。"""

from __future__ import annotations

import math

import numpy as np
import pytest
from PIL import Image

from pixel_rot.core import (
    EXPAND,
    FIXED,
    FORWARD_NN,
    INVERSE_NN,
    SSAA,
    TRANSPARENT,
    PaletteImage,
    label_components,
    load_png,
    point_in_polygon,
    preset_center,
    rotate,
    rotate_points,
    roundtrip_check,
    save_png,
    to_rgba_array,
)
from pixel_rot.exporting import (
    compare_transparent_and_border,
    export_batch,
    load_manifest,
    load_entry,
)
from pixel_rot.sample import build_sample


@pytest.fixture
def sample():
    img, rois = build_sample()
    return img, rois


ALL_METHODS = [FORWARD_NN, INVERSE_NN, SSAA]


# --------------------------------------------------------------------------
# 图样与基础统计
# --------------------------------------------------------------------------


def test_sample_contents(sample):
    img, rois = sample
    assert img.size == (18, 18)
    assert len(img.palette) == 4
    assert int(img.opaque_mask().sum()) == 57
    # 两个 1x1 孔
    stats = rotate(FORWARD_NN, img, (0.0, 0.0), 0, FIXED, img.size).stats
    assert len(stats.holes) == 2
    assert sorted(h.size for h in stats.holes) == [1, 1]
    # 三个孤立像素 + 其余结构 => 连通块数量
    assert stats.components >= 4
    assert len(rois) == 3


def test_label_components():
    mask = np.array(
        [
            [1, 1, 0, 1],
            [1, 0, 0, 1],
            [0, 0, 0, 0],
            [0, 1, 1, 0],
        ],
        dtype=bool,
    )
    labels, n = label_components(mask)
    assert n == 3
    assert labels[0, 0] == labels[1, 0]
    assert labels[0, 3] == labels[1, 3]
    assert labels[3, 1] == labels[3, 2]
    assert labels[0, 0] != labels[0, 3]


def test_point_in_polygon():
    poly = np.array([(1.0, 1.0), (4.0, 1.0), (4.0, 4.0), (1.0, 4.0)])
    pts = np.array([(2.5, 2.5), (0.5, 0.5), (3.9, 3.9)])
    assert point_in_polygon(pts, poly).tolist() == [True, False, True]


# --------------------------------------------------------------------------
# 旋转几何
# --------------------------------------------------------------------------


def test_rotation_orientation_clockwise():
    # 点 (1.5, 0.5) 绕 (0.5, 0.5) 顺时针 90° 应到 (0.5, 1.5)
    out = rotate_points(np.array([(1.5, 0.5)]), (0.5, 0.5), 90)[0]
    assert out == pytest.approx((0.5, 1.5), abs=1e-9)


def test_180_simple_pixel_grid():
    # 3x3 单像素, 绕像素中心 180° 后位置对称且不新增颜色
    idx = np.full((3, 3), TRANSPARENT, dtype=np.int16)
    idx[0, 0] = 0
    img = PaletteImage(idx, [(255, 0, 0, 255)])
    res = rotate(SSAA, img, (1.5, 1.5), 180, FIXED, (3, 3))
    assert res.image.indices[2, 2] == 0
    assert res.stats.pixel_count == 1


@pytest.mark.parametrize("method", ALL_METHODS)
def test_no_new_colors_any_angle(sample, method):
    img, rois = sample
    for ang in (1, 17.3, 45, 90, 137.7, 271):
        res = rotate(method, img, (9.0, 9.0), ang, EXPAND, rois=rois)
        assert set(res.stats.colors_used).issubset(set(range(len(img.palette))))
        rgba = to_rgba_array(res.image)
        present = {tuple(c) for c in rgba[rgba[..., 3] != 0][:, :4]}
        assert present.issubset(set(img.palette))


@pytest.mark.parametrize("method", ALL_METHODS)
def test_90_rotation_exact_fixed(sample, method):
    img, rois = sample
    res = rotate(method, img, (9.0, 9.0), 90, FIXED, img.size, rois)
    # 像素数、孔数守恒, 无丢失无碰撞
    assert res.stats.pixel_count == 57
    assert len(res.stats.holes) == 2
    assert res.outside_pixels == 0
    # 90° 时关注区不应报告变化
    assert all(not r.changed for r in res.roi_results)


@pytest.mark.parametrize("method", ALL_METHODS)
@pytest.mark.parametrize("kind", ["corner", "pixel_center"])
def test_roundtrip_90(sample, method, kind):
    img, _ = sample
    center = preset_center(img, kind)
    rep = roundtrip_check(img, method, center)
    assert rep.ok, rep.detail
    assert rep.center_error < 1e-9
    assert rep.pixel_diffs == 0


@pytest.mark.parametrize("method", ALL_METHODS)
def test_roundtrip_180_step(sample, method):
    img, _ = sample
    rep = roundtrip_check(img, method, preset_center(img, "corner"), step=180)
    assert rep.ok, rep.detail


def test_half_turn_360_is_identity(sample):
    img, _ = sample
    # 任意角度转 360 不会逐格一致(重采样), 但 90° 系列必须精确回到起点
    rep = roundtrip_check(img, SSAA, (9.5, 9.5), step=90)
    assert rep.ok


# --------------------------------------------------------------------------
# 画布模式与边界
# --------------------------------------------------------------------------


def test_expand_contains_everything(sample):
    img, rois = sample
    # 扩画布下任何引擎都不产生越界裁切
    for method in (FORWARD_NN, INVERSE_NN, SSAA):
        r = rotate(method, img, (9.0, 9.0), 30, EXPAND)
        assert r.outside_pixels == 0
        assert r.image.width >= img.width
        assert r.image.height >= img.height
    # 正向法逐源像素搬运, 像素数不增(碰撞会减少)
    fwd = rotate(FORWARD_NN, img, (9.0, 9.0), 30, EXPAND)
    assert fwd.collisions > 0
    assert fwd.stats.pixel_count <= 57
    # 反向法逐目标格采样, 允许像素数变多, 但颜色仍受原色板约束
    inv = rotate(INVERSE_NN, img, (9.0, 9.0), 30, EXPAND)
    assert set(inv.stats.colors_used).issubset(set(range(4)))


def test_fixed_canvas_clips_and_flags_border(sample):
    img, rois = sample
    res = rotate(SSAA, img, (9.0, 9.0), 30, FIXED, img.size, rois)
    assert res.outside_pixels > 0
    # 样例本身有贴边像素, 旋转后仍应能标出贴边
    assert res.stats.border_contacts
    assert res.border_mask.any()


def test_small_object_touching_edge(sample):
    img, _ = sample
    # 样例里 (0,14)/(17,6)/(8,17) 三个贴边像素; 0° 固定画布全部保留
    res = rotate(INVERSE_NN, img, (9.0, 9.0), 0, FIXED, img.size)
    assert res.image.indices[0, 14] == img.indices[0, 14]
    assert res.image.indices[17, 6] == img.indices[17, 6]
    assert res.image.indices[8, 17] == img.indices[8, 17]
    assert set(res.stats.border_contacts) == {"top", "bottom", "right"}


def test_center_between_pixels_no_grid_shift(sample):
    """绕像素之间的角点旋转, 中心必须仍在格点上, 不能平移半格。"""
    img, _ = sample
    center = (9.0, 9.0)  # 整数格点
    res = rotate(FORWARD_NN, img, center, 90, FIXED, img.size)
    assert res.center_out[0] == pytest.approx(9.0)
    assert res.center_out[1] == pytest.approx(9.0)
    # 45° 也一样: 中心坐标在输出格网里保持原位(固定画布原点 0,0)
    res45 = rotate(FORWARD_NN, img, center, 45, FIXED, img.size)
    assert res45.center_out == pytest.approx((9.0, 9.0))


def test_center_on_pixel_center_kept(sample):
    img, _ = sample
    center = (9.5, 9.5)
    res = rotate(SSAA, img, center, 90, FIXED, img.size)
    assert res.center_out == pytest.approx((9.5, 9.5))


def test_outside_frame_overlay_expand(sample):
    img, rois = sample
    # 绕左上角点转 45°, 扩画布后旋转图像与原画框只有部分重叠
    res = rotate(INVERSE_NN, img, (0.0, 0.0), 45, EXPAND)
    assert res.outside_frame_mask.any()
    # 同时也应有仍在原画框内的像素
    assert (~res.outside_frame_mask & res.image.opaque_mask()).any()


# --------------------------------------------------------------------------
# ROI 与断线/孔洞
# --------------------------------------------------------------------------


def test_roi_detects_split_at_45(sample):
    img, rois = sample
    res = rotate(SSAA, img, (9.0, 9.0), 45, EXPAND, rois=rois)
    corner = next(r for r in res.roi_results if r.name == "斜线拐角")
    # 45° 超采样下一格线可能被判定为分裂或像素减少
    assert corner.changed


def test_roi_unchanged_at_90(sample):
    img, rois = sample
    for method in ALL_METHODS:
        res = rotate(method, img, (9.0, 9.0), 90, FIXED, img.size, rois)
        for r in res.roi_results:
            assert not r.changed, (method, r.name, r.note)


def test_roi_hole_count(sample):
    img, rois = sample
    res = rotate(FORWARD_NN, img, (9.0, 9.0), 0, FIXED, img.size, rois)
    block = next(r for r in res.roi_results if r.name == "蓝块双孔")
    assert block.holes == 2
    assert block.hole_sizes == [1, 1]


# --------------------------------------------------------------------------
# 引擎差异: 正向碰撞 vs 反向采样
# --------------------------------------------------------------------------


def test_forward_collisions_counted(sample):
    img, _ = sample
    res = rotate(FORWARD_NN, img, (9.0, 9.0), 45, EXPAND)
    # 45° 时多个源像素挤进同一格是正向法的典型现象
    assert res.collisions > 0


def test_inverse_has_no_collisions(sample):
    img, _ = sample
    res = rotate(INVERSE_NN, img, (9.0, 9.0), 45, EXPAND)
    assert res.collisions == 0


def test_methods_differ_on_diagonal(sample):
    img, rois = sample
    counts = {}
    for method in ALL_METHODS:
        res = rotate(method, img, (9.0, 9.0), 45, EXPAND, rois=rois)
        counts[method] = res.stats.pixel_count
    # 三种策略在斜线上的像素取舍应体现差异(至少两个不同结果)
    assert len(set(counts.values())) >= 2


# --------------------------------------------------------------------------
# PNG 往返与批量导出
# --------------------------------------------------------------------------


def test_png_roundtrip_rgba_preserved(tmp_path, sample):
    img, _ = sample
    p = tmp_path / "s.png"
    save_png(p, img)
    reloaded = load_png(p)
    assert np.array_equal(to_rgba_array(reloaded), to_rgba_array(img))
    # 透明格仍然透明
    assert (reloaded.indices == TRANSPARENT).sum() == (
        img.indices == TRANSPARENT
    ).sum()


def test_import_rgba_png(tmp_path, sample):
    img, _ = sample
    p = tmp_path / "rgba.png"
    Image.fromarray(to_rgba_array(img), "RGBA").save(p)
    reloaded = load_png(p)
    assert np.array_equal(to_rgba_array(reloaded), to_rgba_array(img))


def test_export_batch_and_review(tmp_path, sample):
    img, rois = sample
    out = tmp_path / "batch"
    manifest = export_batch(
        img, out, [0, 45, 90], methods=ALL_METHODS,
        center=(9.0, 9.0), rois=rois,
    )
    assert len(manifest["entries"]) == 9
    assert (out / "manifest.json").exists()
    assert (out / "original.png").exists()
    bundle = load_manifest(out)
    for entry in manifest["entries"]:
        exported = load_entry(bundle, entry)
        cmp_ = compare_transparent_and_border(
            bundle["original"], exported, entry
        )
        assert cmp_["exported_opaque"] >= 0
        if entry["angle"] == 0:
            assert cmp_["same_size"]
            assert cmp_["center_on_grid_corner"]
    # 0° 导出与原图逐格一致
    e0 = next(e for e in manifest["entries"] if e["angle"] == 0)
    exported0 = load_entry(bundle, e0)
    assert np.array_equal(
        to_rgba_array(exported0), to_rgba_array(img)
    )


def test_manifest_contains_center_and_frame(tmp_path, sample):
    img, rois = sample
    out = tmp_path / "b2"
    manifest = export_batch(
        img, out, [30], methods=[SSAA], center=(9.5, 9.5), rois=rois,
    )
    e = manifest["entries"][0]
    assert len(e["center_out"]) == 2
    assert len(e["frame_quad"]) == 4
    assert "stats" in e and "holes" in e["stats"]
    # 像素中心型中心在导出信息里可识别
    assert math.isclose(e["center_out"][0] - 0.5, round(e["center_out"][0] - 0.5))


def test_ssaa_threshold_changes_density(sample):
    img, _ = sample
    low = rotate(SSAA, img, (9.0, 9.0), 45, EXPAND, coverage_threshold=0.2)
    high = rotate(SSAA, img, (9.0, 9.0), 45, EXPAND, coverage_threshold=0.8)
    assert low.stats.pixel_count > high.stats.pixel_count
