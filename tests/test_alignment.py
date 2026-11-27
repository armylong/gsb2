"""对齐与几何相关的单元测试(无头, 无需 GUI)。

运行: .venv/bin/python -m pytest tests/ -q
(没有 pytest 时也可直接 .venv/bin/python tests/test_alignment.py)
"""

from __future__ import annotations

import os
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from descan.alignment import (  # noqa: E402
    Alignment,
    coverage_mask,
    fit_transform,
    map_point,
    residuals,
    warp_back,
)
from descan.bleed import LocalPatch, build_strength_field  # noqa: E402


def _pair_of_points(transform_2x3, mirror, w, pts):
    """给定正面点, 按已知变换反推背面原图坐标。"""
    inv = np.linalg.inv(np.vstack([transform_2x3, [0, 0, 1]]))
    back_pts = []
    for fx, fy in pts:
        x, y, z = inv @ np.array([fx, fy, 1.0])
        mx, my = x / z, y / z
        back_pts.append((w - mx, my) if mirror else (mx, my))
    return back_pts


def make_alignment(shift=(14.0, -9.0), angle=0.6, method="similarity",
                   mirror=True, shape=(600, 800)):
    h, w = shape
    m = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
    m[0, 2] += shift[0]
    m[1, 2] += shift[1]
    front_pts = [(120, 120), (650, 110), (660, 480), (130, 470)]
    back_pts = _pair_of_points(m, mirror, w, front_pts)
    al = Alignment(
        front_shape=shape, back_shape=shape, mirror_back=mirror,
        method=method, front_pts=front_pts, back_pts=back_pts,
    )
    return fit_transform(al), m


def test_similarity_recovers_known_transform():
    al, m = make_alignment()
    assert residuals(al).max() < 0.5
    # full_matrix 是"背面原图 -> 正面", 真值要再叠上镜像矩阵
    truth = np.vstack([m, [0, 0, 1]]) @ al.mirror_matrix()
    # LMEDS 稳健估计带少量数值噪声, 用亚像素级容差比较
    assert np.allclose(al.full_matrix(), truth, atol=2e-3)


def test_translate_mode_ignores_rotation_need():
    al, _ = make_alignment(shift=(20.0, 5.0), angle=0.0, method="translate")
    assert residuals(al).max() < 0.5
    assert np.allclose(al.matrix[:2, :2], np.eye(2), atol=1e-9)


def test_single_point_pair_is_translation():
    shape = (400, 500)
    al = Alignment(shape, shape, front_pts=[(100.0, 100.0)],
                   back_pts=[(400.0, 120.0)], method="similarity")
    fit_transform(al)
    # 镜像后背面 x = 500-400=100, y=120; 正面 (100,100) -> 平移 (0,-20)
    mx, my = map_point(al, (400.0, 120.0))
    assert abs(mx - 100.0) < 1e-6 and abs(my - 100.0) < 1e-6


def test_warp_and_coverage_flags_missing_corners():
    shape = (600, 800)
    al, _ = make_alignment(shape=shape)
    back = np.full(shape, 255, np.uint8)
    cv2.rectangle(back, (60, 60), (740, 540), 40, -1)
    warped = warp_back(back, al)
    cov = coverage_mask(al)
    assert warped.shape == shape
    # 旋转+平移后至少有两个角落在背面数据范围外
    corners = [cov[0, 0], cov[0, -1], cov[-1, 0], cov[-1, -1]]
    assert sum(1 for c in corners if c == 0) >= 2
    # 覆盖区内部保留了暗内容, 且掩膜是二值的
    assert warped[300, 400] < 100
    assert set(np.unique(cov)).issubset({0, 255})
    # 缺数据面积占比在合理范围(不会整张全缺, 也不会完全无缺)
    frac = float((cov == 0).mean())
    assert 0.005 < frac < 0.2


def test_mirror_disabled_path():
    al, _ = make_alignment(mirror=False, shift=(8.0, 3.0), angle=0.0)
    assert residuals(al).max() < 0.5


def test_affine_needs_three_points():
    al = Alignment((100, 100), (100, 100), method="affine",
                   front_pts=[(1, 1), (2, 2)], back_pts=[(1, 1), (2, 2)])
    try:
        fit_transform(al)
    except ValueError:
        pass
    else:
        raise AssertionError("仿射不足 3 点对应报错")


def test_strength_field_zero_outside_coverage():
    shape = (400, 500)
    cov = np.zeros(shape, np.uint8)
    cov[50:350, 60:440] = 255
    patches = [LocalPatch(100, 100, 80, 80, 2.0),
               LocalPatch(-40, -40, 100, 100, 0.0)]  # 越界块不能炸
    field = build_strength_field(shape, 0.5, patches, cov)
    assert field.shape == shape
    assert np.all(field[cov == 0] == 0.0)
    # 块内增益生效
    assert field[140, 140] > 0.8
    # 块外仍是基准
    assert abs(float(field[300, 400]) - 0.5) < 1e-6


def test_originals_are_not_mutated():
    shape = (300, 400)
    al, _ = make_alignment(shape=shape)
    back = np.full(shape, 230, np.uint8)
    front = np.full(shape, 220, np.uint8)
    back_before = back.copy()
    front_before = front.copy()
    warped = warp_back(back, al)
    cov = coverage_mask(al)
    from descan.bleed import ProcessParams, process_front
    process_front(front, warped, cov, ProcessParams(base_strength=0.4))
    assert np.array_equal(back, back_before)
    assert np.array_equal(front, front_before)


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
