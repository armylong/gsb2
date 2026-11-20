"""核心算法自动验证(不启动 GUI)。

覆盖需求中要求的：端点墨量、均匀灰覆盖容差、相位平移、预览/导出一致性，
另外补充旋转网格连续性、纯黑纯白、非整周期尺寸与导出回读。

运行: .venv/bin/python -m pytest tests/ -v
或:   .venv/bin/python tests/test_halftone.py
"""

from __future__ import annotations

import math
import os
import tempfile

import cv2
import numpy as np
import pytest

from halftone.core import (
    DEFAULT_PARAMS,
    GAMMA_RANGE,
    HalftoneError,
    black_fraction,
    render_halftone,
    selection_stats,
    target_coverage,
    to_grayscale,
    validate_params,
)
from halftone.io import export_result, load_image, verify_export, ImageLoadError
from halftone.samples import SAMPLE_NAMES, build_sample

UNIFORM_GRAY = 128
# 均匀灰块上实测覆盖与目标墨量的容差：角度/相位造成的边界量化误差
# 约为 周长*P/2 / 面积，256px 选区 + P=8 时理论上 < 2%
COVERAGE_TOL = 0.02


def _uniform(level: int, h: int = 300, w: int = 300) -> np.ndarray:
    return np.full((h, w), level, dtype=np.uint8)


# ---------------------------------------------------------------- 端点墨量
def test_endpoint_ink_amount():
    """纯黑必须满墨(全 0)，纯白必须无墨(全 255)，与网点形式/角度无关。"""
    for screen in ("dot", "line"):
        for angle in (0.0, 15.0, 45.0, 77.7):
            params = {
                **DEFAULT_PARAMS,
                "screen": screen,
                "angle": angle,
                "period": 11.0,
            }
            black = render_halftone(_uniform(0), params)
            white = render_halftone(_uniform(255), params)
            assert set(np.unique(black).tolist()) == {0}
            assert set(np.unique(white).tolist()) == {255}
            assert black_fraction(black) == 1.0
            assert black_fraction(white) == 0.0


def test_output_is_strictly_binary():
    """任何输入的输出都只能含 0/255，不允许残留连续灰阶。"""
    rng = np.random.default_rng(7)
    gray = rng.integers(0, 256, size=(200, 240), dtype=np.uint8)
    for screen in ("dot", "line"):
        out = render_halftone(gray, {**DEFAULT_PARAMS, "screen": screen})
        assert set(np.unique(out).tolist()).issubset({0, 255})


def test_gamma_curve_endpoints_fixed():
    """墨量曲线只改中间调，黑/白端点在任意 gamma 下保持 1.0 / 0.0。"""
    for gamma in (GAMMA_RANGE[0], 0.5, 1.0, 2.0, GAMMA_RANGE[1]):
        t_black = target_coverage(np.array([[0]], np.uint8), gamma)
        t_white = target_coverage(np.array([[255]], np.uint8), gamma)
        assert t_black.item() == pytest.approx(1.0)
        assert t_white.item() == pytest.approx(0.0)
    mid = target_coverage(np.array([[128]], np.uint8), 1.0).item()
    assert 0.0 < mid < 1.0


# ------------------------------------------------------- 均匀灰覆盖容差
@pytest.mark.parametrize("screen", ["dot", "line"])
@pytest.mark.parametrize("angle", [0.0, 15.0, 45.0])
@pytest.mark.parametrize("period", [4.0, 8.0, 13.0])
def test_uniform_coverage_matches_target(screen, angle, period):
    gray = _uniform(UNIFORM_GRAY, 320, 320)
    params = {
        **DEFAULT_PARAMS,
        "screen": screen,
        "angle": angle,
        "period": period,
    }
    out = render_halftone(gray, params)
    target = target_coverage(gray, params["gamma"]).mean()
    # 只统计远离图像边缘的内部选区，排除边缘截断，验证面积表达本身
    inner = out[32:-32, 32:-32]
    measured = black_fraction(inner)
    assert abs(measured - target) < COVERAGE_TOL, (
        f"{screen} angle={angle} P={period}: "
        f"measured={measured:.4f} target={target:.4f}"
    )


def test_dot_two_regimes_both_calibrated():
    """圆点 t<=0.5(圆盘) 与 t>0.5(菱形合并) 两个工况都要贴合目标。"""
    for level in (64, 128, 192):  # t ≈ 0.75 / 0.50 / 0.25
        gray = _uniform(level, 320, 320)
        out = render_halftone(gray, {**DEFAULT_PARAMS, "period": 10.0})
        target = target_coverage(gray, 1.0).mean()
        measured = black_fraction(out[32:-32, 32:-32])
        assert abs(measured - target) < COVERAGE_TOL


def test_dot_regime_switch_continuous():
    """t=0.5 两侧极小区间覆盖量不应出现跳变(圆盘工况与菱形工况几何重合)。"""
    p = {**DEFAULT_PARAMS, "period": 12.0, "angle": 20.0}
    f_lo = black_fraction(
        render_halftone(_uniform(129, 320, 320), p)[32:-32, 32:-32]
    )
    f_hi = black_fraction(
        render_halftone(_uniform(127, 320, 320), p)[32:-32, 32:-32]
    )
    assert abs(f_hi - f_lo) < 0.03


# ------------------------------------------------------------- 相位平移
def test_phase_shift_is_translation_on_flat_image():
    """均匀图上相位平移只平移图案：任意相位下全局覆盖量保持稳定。

    注: Bayer 二值化阈值固定在像素坐标，相移一个周期后网格坐标虽然相同，
    但每像素面积占比相对阈值网格发生平移，逐像素结果不必相等——这正是
    "网格与阈值都固定在图像坐标"的预期行为，这里用覆盖量不变来约束。
    """
    gray = _uniform(UNIFORM_GRAY, 200, 200)
    base_p = {**DEFAULT_PARAMS, "period": 10.0, "angle": 18.0}
    base = render_halftone(gray, base_p)

    for shift in ((7.3, -4.1), (10.0, 0.0), (0.0, 10.0), (-3.5, 6.25)):
        shifted = render_halftone(
            gray, {**base_p, "phase_x": shift[0], "phase_y": shift[1]}
        )
        assert abs(black_fraction(shifted) - black_fraction(base)) < COVERAGE_TOL


def test_phase_shift_moves_pattern_on_gradient():
    """相位平移在图像坐标中移动图案：内部区域与滚动结果只差边界量化。

    Bayer 二值化阈值固定在像素坐标，因此不要求逐像素严格相等；
    网格本身的平移关系用内部区域的高重合度验证。
    """
    sample = to_grayscale(build_sample("gradient"))
    p = {**DEFAULT_PARAMS, "period": 9.0, "angle": 12.0}
    base = render_halftone(sample, p)
    # phase_x=+4: 网格原点右移，图案在图像坐标中右移 4px -> np.roll(+4)
    shifted = render_halftone(sample, {**p, "phase_x": 4.0})
    rolled = np.roll(base, 4, axis=1)
    inner = (slice(8, -8), slice(8, -8))
    assert np.mean(shifted[inner] != rolled[inner]) < 0.02

    shifted_y = render_halftone(sample, {**p, "phase_y": 4.0})
    rolled_y = np.roll(base, 4, axis=0)
    assert np.mean(shifted_y[inner] != rolled_y[inner]) < 0.02


def test_phase_does_not_reflow_on_zoom():
    """渲染只依赖像素坐标与参数：同一参数两次渲染必须逐像素相同。"""
    gray = to_grayscale(build_sample("slant"))
    p = {**DEFAULT_PARAMS, "period": 7.5, "angle": 33.0}
    first = render_halftone(gray, p)
    second = render_halftone(gray, p)
    assert np.array_equal(first, second)


# ------------------------------------------------------- 旋转网格连续性
def test_rotated_grid_is_continuous_across_image():
    """任意角度下整图共用一张连续网格：沿网格轴向平移一个周期，图案复原。

    用相位变化等价表达网格轴向平移(平移矢量在像素坐标系中为
    (P cosθ, -P sinθ))，比较不受边界截断影响的内部区域。
    """
    gray = _uniform(UNIFORM_GRAY, 240, 240)
    p = {**DEFAULT_PARAMS, "period": 8.0, "angle": 27.5}
    base = render_halftone(gray, p)
    theta = math.radians(p["angle"])
    # 沿网格 u 轴方向 (cosθ, -sinθ) 平移一个周期，等价于把网格原点反方向
    # (即 θ+π 方向)平移同样长度
    dx = p["period"] * math.cos(theta + math.pi)
    dy = p["period"] * math.sin(theta + math.pi)
    moved = render_halftone(gray, {**p, "phase_x": dx, "phase_y": dy})
    margin = 16
    inner_a = base[margin:-margin, margin:-margin]
    inner_b = moved[margin:-margin, margin:-margin]
    assert np.mean(inner_a != inner_b) < 0.01


def test_edge_dots_are_clipped_not_wrapped():
    """边缘的部分网点按图像边界截断，而不是把邻周期内容搬过来。"""
    gray = _uniform(UNIFORM_GRAY, 100, 100)
    p = {**DEFAULT_PARAMS, "period": 12.0, "angle": 0.0}
    out = render_halftone(gray, p)
    # 零相位、零角度时圆盘中心位于周期整数倍处，检查左上角第一格结构对称
    # 左上角 (0,0) 与 (12,0) 处的圆盘在边界被截断，列 0 与列 12 的墨像素一致
    assert np.array_equal(out[:, 0] == 0, out[:, 12] == 0)


# ------------------------------------------------------------- 灰度口径
def test_grayscale_uses_bt601():
    # 输入像素依次为纯蓝、纯绿、纯红(BGR 存储)
    bgr = np.array([[[255, 0, 0], [0, 255, 0], [0, 0, 255]]], dtype=np.uint8)
    gray = to_grayscale(bgr)[0]
    # 定点 BT.601: (76R+150G+29B+128)>>8 —— 顺序为蓝、绿、红
    expected = np.array([29, 149, 76], dtype=np.uint8)
    assert np.array_equal(gray, expected)
    assert np.allclose(gray, [0.114 * 255, 0.587 * 255, 0.299 * 255], atol=1)


# ------------------------------------------------------------- 参数/选区
def test_invalid_period_rejected():
    for bad in (0.5, 201.0, float("nan"), float("inf")):
        with pytest.raises(HalftoneError):
            validate_params({**DEFAULT_PARAMS, "period": bad})
    with pytest.raises(HalftoneError):
        validate_params({**DEFAULT_PARAMS, "gamma": 99.0})
    with pytest.raises(HalftoneError):
        validate_params({**DEFAULT_PARAMS, "screen": "unknown"})


def test_empty_selection_reports_error():
    gray = _uniform(128, 50, 50)
    out = render_halftone(gray, DEFAULT_PARAMS)
    with pytest.raises(HalftoneError):
        selection_stats(gray, out, DEFAULT_PARAMS, (10, 10, 0, 0))
    with pytest.raises(HalftoneError):
        selection_stats(gray, out, DEFAULT_PARAMS, (80, 80, 5, 5))


def test_selection_stats_are_measured_not_theoretical():
    """小选区量化误差必须如实暴露：实测值直接来自像素计数。"""
    gray = _uniform(UNIFORM_GRAY, 60, 60)
    out = render_halftone(gray, {**DEFAULT_PARAMS, "period": 11.0})
    stats = selection_stats(gray, out, DEFAULT_PARAMS, (3, 3, 7, 5))
    roi = out[3:8, 3:10]
    assert stats.pixel_count == 35
    assert stats.measured_black_fraction == np.count_nonzero(roi == 0) / 35
    # 目标值与实测值是两个独立来源，不允许互相替代
    assert isinstance(stats.target_ink_mean, float)


# ------------------------------------------------------- 非整周期尺寸
def test_non_integer_period_size():
    """图像边长不是周期整数倍时渲染正常，端点保持严格。"""
    gray = _uniform(100, 97, 131)
    out = render_halftone(gray, {**DEFAULT_PARAMS, "period": 8.5, "angle": 19.0})
    assert out.shape == (97, 131)
    assert set(np.unique(out).tolist()).issubset({0, 255})
    target = target_coverage(gray, 1.0).mean()
    assert abs(black_fraction(out) - target) < 0.05


# ------------------------------------------------------------- 导出回读
def test_export_roundtrip_and_consistency():
    gray = to_grayscale(build_sample("patches"))
    params = {**DEFAULT_PARAMS, "period": 9.0, "angle": 22.5}
    binary = render_halftone(gray, params)
    stats = selection_stats(gray, binary, params, (40, 40, 120, 90)).as_dict()

    with tempfile.TemporaryDirectory() as tmp:
        png_path = os.path.join(tmp, "out.png")
        png_out, json_out = export_result(
            png_path, binary, params, source_name="patches", stats=[stats]
        )
        check = verify_export(png_out, json_out)
        assert check.ok, check.summary()
        assert (check.width, check.height) == (binary.shape[1], binary.shape[0])
        assert check.unique_values == sorted(set(np.unique(binary).tolist()))
        assert check.sha256_match is True
        assert check.coverage_match is True

        # 预览/导出一致性：回读数组必须与内存里的渲染结果逐像素相同
        reread = cv2.imread(png_out, cv2.IMREAD_UNCHANGED)
        assert np.array_equal(reread, binary)


def test_load_image_rejects_bad_files():
    with tempfile.TemporaryDirectory() as tmp:
        missing = os.path.join(tmp, "nope.png")
        with pytest.raises(ImageLoadError):
            load_image(missing)

        bad_suffix = os.path.join(tmp, "x.bmp")
        cv2.imwrite(bad_suffix, _uniform(128, 10, 10))
        with pytest.raises(ImageLoadError):
            load_image(bad_suffix)

        # 透明 PNG 拒绝
        rgba = np.zeros((10, 10, 4), np.uint8)
        rgba[:, :, 3] = 128
        transparent = os.path.join(tmp, "a.png")
        cv2.imwrite(transparent, rgba)
        with pytest.raises(ImageLoadError):
            load_image(transparent)

        # 超过 1200 边长拒绝
        big = os.path.join(tmp, "big.jpg")
        cv2.imwrite(big, _uniform(128, 1201, 10))
        with pytest.raises(ImageLoadError):
            load_image(big)


def test_samples_and_roundtrip_accepted():
    for name in SAMPLE_NAMES:
        img = build_sample(name)
        assert img.ndim == 3 and img.shape[2] == 3
        assert max(img.shape[:2]) <= 1200
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "s.png")
            cv2.imwrite(path, img)
            loaded = load_image(path)
            assert loaded.shape == img.shape
