"""用样图理论值核对核心算法:骨架 → 图 → 路径 → 长度。"""
import math

import cv2
import numpy as np
import pytest

from fiber_measure.core.maskops import MaskParams, make_mask
from fiber_measure.core.skeleton import skeletonize
from fiber_measure.core.graph import build_graph
from fiber_measure.core.paths import build_paths, pairing_options
from fiber_measure.core.measure import polyline_length, path_length
from fiber_measure.core import samples

TOL = 0.04  # 骨架中心线与理论几何长度允许 4% 误差


def analyze(img_bgr, roi=None):
    gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    p = MaskParams(threshold=128, dark_object=True, min_size=8, roi=roi)
    mask = make_mask(gray, p)
    skel = skeletonize(mask)
    g = build_graph(skel)
    return g, build_paths(g)


def lengths(paths):
    return sorted(path_length(p.points) for p in paths)


def test_horizontal_line():
    img, meta = samples.sample_lines()
    g, paths = analyze(img, roi=(40, 40, 240, 50))  # 只圈 L1
    assert len(paths) == 1
    assert paths[0].kind == "open"
    assert path_length(paths[0].points) == pytest.approx(200.0, rel=TOL)


def test_diagonal_vs_staircase_same_endpoints():
    img, meta = samples.sample_lines()
    # L2 斜线
    _, paths_d = analyze(img, roi=(40, 120, 240, 140))
    assert len(paths_d) == 1
    len_d = path_length(paths_d[0].points)
    assert len_d == pytest.approx(math.hypot(200, 100), rel=TOL)
    # L3 折弯线
    _, paths_s = analyze(img, roi=(300, 120, 240, 140))
    assert len(paths_s) == 1
    len_s = path_length(paths_s[0].points)
    assert len_s == pytest.approx(300.0, rel=TOL)
    # 同样起终位移,折弯线明显更长,且各按各的实际路径
    assert len_s > len_d * 1.2


def test_closed_loop_has_no_endpoints_but_measurable():
    img, meta = samples.sample_loop()
    g, paths = analyze(img, roi=(0, 0, 400, 360))
    assert not [n for n in g.nodes.values() if n.kind == "endpoint"]
    assert len(paths) == 1
    assert paths[0].kind == "closed"
    assert path_length(paths[0].points) == pytest.approx(2 * math.pi * 80, rel=TOL)


def test_crossing_and_branch():
    img, meta = samples.sample_crossing()
    g, paths = analyze(img, roi=(0, 0, 560, 300))
    crossings = g.crossings()
    branches = [n for n in g.nodes.values() if n.kind == "branch"]
    assert len(crossings) == 1, "X 应识别为一个疑似交叉"
    assert len(branches) == 1, "T 应识别为一个真分叉"
    # 默认按最直配对:两条对角线 + T 的三条支
    ls = lengths(paths)
    assert len(paths) == 5
    diag = math.hypot(200, 200)
    assert ls[0] == pytest.approx(100.0, rel=TOL)
    assert ls[1] == pytest.approx(100.0, rel=TOL)
    assert ls[2] == pytest.approx(100.0, rel=TOL)
    assert ls[3] == pytest.approx(diag, rel=TOL)
    assert ls[4] == pytest.approx(diag, rel=TOL)


def test_crossing_pairing_override_changes_paths():
    """不对称四臂交叉:三种配对给出三组不同的路径长度。"""
    img = np.full((300, 300, 3), 255, np.uint8)
    # 四臂各不相同:左100 右120 上80 下90,中心 (140,140)
    cv2.line(img, (40, 140), (260, 140), (0, 0, 0), 3)   # 横臂 100+120
    cv2.line(img, (140, 60), (140, 230), (0, 0, 0), 3)   # 纵臂 80+90
    g, _ = analyze(img)
    crossings = g.crossings()
    assert len(crossings) == 1
    nid = crossings[0].id
    opts = pairing_options(g, nid)
    assert len(opts) == 3
    results = set
    seen = []
    for idx in range(3):
        paths = build_paths(g, {nid: idx})
        ls = tuple(round(v, 1) for v in lengths(paths))
        assert len(paths) == 2
        seen.append(ls)
    # 三种配对结果互不相同
    assert len(set(seen)) == 3
    # 期望的三组长度(容差取整到 5 px 内比较)
    expected = [
        sorted([220.0, 170.0]),  # 直配:横 100+120,纵 80+90
        sorted([180.0, 210.0]),  # 弯配1:100+80, 120+90
        sorted([190.0, 200.0]),  # 弯配2:100+90, 120+80
    ]
    for ls in seen:
        assert any(
            all(abs(a - b) < 8 for a, b in zip(ls, exp)) for exp in expected
        ), f"配对结果 {ls} 不在理论值中"


def test_anisotropic_scale():
    """横竖不同刻度:斜线长度用各自方向的真实步长。"""
    pts = [(0, 0), (200, 100)]
    assert polyline_length(pts, 1.0, 1.0) == pytest.approx(math.hypot(200, 100))
    assert polyline_length(pts, 0.5, 1.0) == pytest.approx(math.hypot(100, 100))
    assert polyline_length(pts, 2.0, 0.5) == pytest.approx(math.hypot(400, 50))


def test_mask_cleanup_and_roi():
    img, _ = samples.sample_lines()
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    # ROI 只留 L1 区域,且比例尺文字被排除
    p = MaskParams(threshold=128, dark_object=True, min_size=8, roi=(40, 40, 240, 50))
    mask = make_mask(gray, p)
    assert mask.sum() > 0
    assert mask[390, 60] == 0  # 比例尺在 ROI 外
    # 小孤立点去除
    noisy = gray.copy()
    noisy[10, 500] = 0  # 单个暗点
    p2 = MaskParams(threshold=128, dark_object=True, min_size=8, roi=(0, 0, 560, 360))
    mask2 = make_mask(noisy, p2)
    assert mask2[10, 500] == 0


def test_binary_mask_input_ignores_threshold():
    gray = np.zeros((50, 50), np.uint8)
    cv2.line(gray, (5, 25), (45, 25), 1, 1)
    p = MaskParams(threshold=200, dark_object=False, min_size=0, binary_input=True)
    mask = make_mask(gray, p)
    assert mask.sum() == 41
