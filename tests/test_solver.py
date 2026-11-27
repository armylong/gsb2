"""已知表面上的求解正确性: 方向、反照率、阴影剔除、退化灯架."""
import numpy as np

from photostereo import encoding
from photostereo.geometry import ring_rig, spherical_to_dir
from photostereo.solver import (
    DARK_PIXEL,
    NEAR_PARALLEL,
    OK,
    UNDERDETERMINED,
    solve_photometric,
)
from photostereo.synthetic import render


def angular_deg(a: np.ndarray, b: np.ndarray, mask: np.ndarray) -> float:
    dot = np.clip(np.sum(a * b, axis=-1), -1, 1)
    ang = np.rad2deg(np.arccos(dot))
    return float(np.mean(ang[mask]))


def test_synthetic_normals_are_unit_and_front_facing(hemi):
    norms = np.linalg.norm(hemi.normals[hemi.mask], axis=1)
    assert np.allclose(norms, 1.0, atol=1e-10)
    # 相机在 +z 一侧, 所有表面法线都应朝向相机 (n_z > 0)
    assert np.all(hemi.normals[hemi.mask][:, 2] > 0.0)
    # 球顶法线应近似 (0,0,1) (偶数尺寸下球心不在像素中心, 留离散化余量)
    h, w = hemi.height.shape
    top = hemi.normals[h // 2, w // 2]
    assert np.allclose(top, [0, 0, 1], atol=2e-2)


def test_hemisphere_normal_reconstruction(rendered_hemi, hemi):
    r = rendered_hemi
    res = solve_photometric(r.images, r.directions, r.strengths, saturation=r.saturation)
    # 半球内部绝大多数像素应有效
    valid_rate = res.valid[hemi.mask].mean()
    assert valid_rate > 0.95
    # 中心区域方向误差应很小
    h, w = hemi.height.shape
    cy, cx = h // 2, w // 2
    core = np.zeros((h, w), bool)
    core[cy - 20 : cy + 20, cx - 20 : cx + 20] = True
    core &= hemi.mask & res.valid
    assert angular_deg(res.normals, hemi.normals, core) < 3.0
    # 整个半球平均误差也应在几度以内
    assert angular_deg(res.normals, hemi.normals, hemi.mask & res.valid) < 5.0


def test_hemisphere_normal_sign_and_axis(rendered_hemi, hemi):
    """符号/左右不能反: 球面右侧像素的估计法线 n_x 必须为正."""
    r = rendered_hemi
    res = solve_photometric(r.images, r.directions, r.strengths, saturation=r.saturation)
    h, w = hemi.height.shape
    cy, cx = h // 2, w // 2
    right = np.zeros((h, w), bool)
    right[cy - 8 : cy + 8, cx + 18 : cx + 30] = True
    right &= hemi.mask & res.valid
    left = np.zeros((h, w), bool)
    left[cy - 8 : cy + 8, cx - 30 : cx - 18] = True
    left &= hemi.mask & res.valid
    assert np.all(res.normals[right][:, 0] > 0.2)
    assert np.all(res.normals[left][:, 0] < -0.2)


def test_dark_sticker_does_not_become_bump(rendered_plate, plate):
    """暗色贴纸只改反照率不改几何: 贴纸上的法线仍应贴合真值, 反照率明显变暗."""
    r = rendered_plate
    res = solve_photometric(r.images, r.directions, r.strengths, saturation=r.saturation)
    h, w = plate.height.shape
    cy, cx = h // 2, w // 2
    # 平面上的暗贴纸中心 (make_bumpy_plate_scene 中 disc(6,40,10))
    y, x = cy + 40, cx + 6
    patch = np.zeros((h, w), bool)
    patch[y - 4 : y + 4, x - 4 : x + 4] = True
    patch &= res.valid
    assert patch.sum() > 20
    assert angular_deg(res.normals, plate.normals, patch) < 6.0
    # 反照率应接近贴纸真值 0.28, 而不是基板的 0.82
    assert np.mean(res.albedo[patch]) < 0.45
    # 基板材料区域 (真值反照率 0.82 处) 的反照率恢复误差应很小
    base = (plate.albedo > 0.8) & res.valid
    assert base.sum() > 100
    assert abs(np.mean(res.albedo[base]) - 0.82) < 0.08


def test_albedo_and_orientation_are_separate(rendered_hemi, hemi):
    """单一材料半球: 反照率图应基本为常数, 朝向变化被吸收进法线."""
    r = rendered_hemi
    res = solve_photometric(r.images, r.directions, r.strengths, saturation=r.saturation)
    inner = hemi.mask & res.valid
    vals = res.albedo[inner]
    assert vals.std() / vals.mean() < 0.1


def test_cast_shadows_are_rejected(rng, hemi):
    """低角度灯会在半球边缘投自遮挡: 被挡的灯不应进入该像素的有效集合."""
    low_dirs = ring_rig(8, elevation_deg=18.0, start_azimuth_deg=0.0)
    r = render(hemi, low_dirs, np.ones(8), rng=rng, saturation=1.01)
    assert r.shadows.any()  # 确实产生了阴影
    res = solve_photometric(r.images, r.directions, r.strengths, saturation=r.saturation)
    # 阴影位置上对应的灯不允许被当作有效观测
    conflict = res.used & r.shadows
    assert conflict.sum() == 0
    # 阴影像素里大部分仍能靠其余灯恢复 (8 盏灯冗余足够)
    shadow_pixels = r.shadows.any(axis=0) & hemi.mask
    assert res.valid[shadow_pixels].mean() > 0.8


def test_near_parallel_lights_flagged(rng, plate):
    dirs = np.stack(
        [
            spherical_to_dir(40, 45),
            spherical_to_dir(44, 45),
            spherical_to_dir(48, 45),
            spherical_to_dir(52, 45),
        ]
    )
    r = render(plate, dirs, np.ones(4), rng=rng, cast_shadows=False)
    res = solve_photometric(r.images, r.directions, r.strengths, saturation=r.saturation)
    assert np.isinf(res.condition).any() or (res.condition > 15).any()
    assert (res.status == NEAR_PARALLEL).any()
    # 低可信区域的置信度确实被压低
    assert res.confidence[res.status == NEAR_PARALLEL].max() < 0.5


def test_two_lights_underdetermined(rng, plate):
    dirs = np.stack([spherical_to_dir(0, 45), spherical_to_dir(120, 45)])
    r = render(plate, dirs, np.ones(2), rng=rng, cast_shadows=False)
    res = solve_photometric(r.images, r.directions, r.strengths, saturation=r.saturation)
    assert not res.valid.any()
    assert np.isin(res.status, [UNDERDETERMINED]).all()


def test_saturated_majority(rng, plate):
    dirs = ring_rig(4, elevation_deg=55.0)
    strengths = np.full(4, 3.0)  # 故意过强 -> 大面积过曝
    r = render(plate, dirs, strengths, rng=rng, saturation=0.95)
    assert r.saturated.any()
    res = solve_photometric(r.images, r.directions, r.strengths, saturation=r.saturation)
    # 过曝像素不能产出"有效"结果
    sat_pixels = r.saturated.sum(axis=0) >= 3
    assert not res.valid[sat_pixels].any()


def test_leave_one_light_out_recheck(rendered_hemi, hemi):
    """剔除一张图后重核: 结果仍有效且与全灯结果接近."""
    r = rendered_hemi
    full = solve_photometric(r.images, r.directions, r.strengths, saturation=r.saturation)
    enabled = np.ones(r.images.shape[0], bool)
    enabled[3] = False
    reduced = solve_photometric(
        r.images, r.directions, r.strengths, saturation=r.saturation, enabled=enabled
    )
    assert not reduced.used[3].any()
    common = full.valid & reduced.valid & hemi.mask
    # 半球边缘本身就是低角度灯的阴影区, 去掉边缘后大部分像素应仍然有效
    inner = hemi.mask.copy()
    inner[:12, :] = inner[-12:, :] = inner[:, :12] = inner[:, -12:] = False
    assert common[inner].mean() > 0.85
    assert angular_deg(full.normals, reduced.normals, common) < 4.0


def test_background_pixels_are_invalid(rendered_hemi, hemi):
    r = rendered_hemi
    res = solve_photometric(r.images, r.directions, r.strengths, saturation=r.saturation)
    assert not res.valid[~hemi.mask].any()
    assert (res.status[~hemi.mask] == DARK_PIXEL).all()
