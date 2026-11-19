"""几何核心测试: 四角映射、无效四边形拒绝、区内判定。"""
import numpy as np
import pytest

from rectifier import geometry as geo

CORNERS = [(100.0, 80.0), (500.0, 60.0), (520.0, 400.0), (90.0, 420.0)]


def test_corner_mapping_exact():
    """四角必须精确映射到输出图像素中心角点, 顺序 TL,TR,BR,BL。"""
    W, H = 300, 200
    Hm = geo.homography(CORNERS, W, H)
    mapped = geo.map_points(Hm, CORNERS)
    expected = geo.dst_rect(W, H)
    assert np.allclose(mapped, expected, atol=1e-6)
    # 左上角 -> (0,0), 右下角 -> (W-1, H-1)
    assert mapped[0] == pytest.approx([0.0, 0.0], abs=1e-6)
    assert mapped[2] == pytest.approx([W - 1, H - 1], abs=1e-6)


def test_roundtrip_inverse():
    """正反映射互逆: 源点 -> 校正 -> 源点。"""
    W, H = 300, 200
    Hm = geo.homography(CORNERS, W, H)
    pts = [(150.0, 150.0), (480.0, 90.0), (200.0, 380.0)]
    back = geo.map_points(geo.invert(Hm), geo.map_points(Hm, pts))
    assert np.allclose(back, pts, atol=1e-6)


def test_valid_quad_accepted():
    ok, msg = geo.validate_quad(CORNERS)
    assert ok, msg


def test_self_intersecting_rejected():
    bowtie = [(0.0, 0.0), (100.0, 100.0), (0.0, 100.0), (100.0, 0.0)]
    ok, msg = geo.validate_quad(bowtie)
    assert not ok and "自交叉" in msg


def test_near_collinear_rejected():
    # 前三个角几乎共线
    pts = [(0.0, 0.0), (200.0, 0.05), (400.0, 0.0), (200.0, 300.0)]
    ok, msg = geo.validate_quad(pts)
    assert not ok


def test_tiny_area_rejected():
    pts = [(10.0, 10.0), (12.0, 10.0), (12.0, 12.0), (10.0, 12.0)]
    ok, msg = geo.validate_quad(pts)
    assert not ok and "面积" in msg


def test_inside_quad():
    assert geo.inside_quad(CORNERS, (300.0, 200.0))
    assert not geo.inside_quad(CORNERS, (10.0, 10.0))
    # 边界上的点算区内
    edge_mid = ((CORNERS[0][0] + CORNERS[1][0]) / 2, (CORNERS[0][1] + CORNERS[1][1]) / 2)
    assert geo.inside_quad(CORNERS, edge_mid)


def test_warp_output_size_exact():
    """输出像素范围与约定一致: 恰好 W 列 H 行。"""
    img = np.zeros((500, 600, 3), np.uint8)
    for (W, H) in [(300, 200), (1, 1), (1600, 7)]:
        out = geo.warp(img, CORNERS, W, H)
        assert out.shape == (H, W, 3)
