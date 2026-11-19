"""用小型已知数组核对误差指标与分块加权,不依赖任何编码器行为。"""

import math

import numpy as np
import pytest

from jpeg_analyzer import metrics


def test_known_array_channel_mae_and_psnr():
    """2x2 图, 只有 (0,0) 像素差 (10, 20, 30), 手工核对每个数。"""
    ref = np.zeros((2, 2, 3), dtype=np.uint8)
    dec = ref.copy()
    dec[0, 0] = (10, 20, 30)

    s = metrics.region_stats(ref, dec)
    assert s["pixels"] == 4
    # 每通道 4 个值, 只有一个非零
    assert s["mae_r"] == pytest.approx(10 / 4)
    assert s["mae_g"] == pytest.approx(20 / 4)
    assert s["mae_b"] == pytest.approx(30 / 4)
    # 总 MAE 覆盖 12 个通道值
    assert s["mae"] == pytest.approx(60 / 12)
    mse = (100 + 400 + 900) / 12
    assert s["mse"] == pytest.approx(mse)
    assert s["psnr"] == pytest.approx(20 * math.log10(255 / math.sqrt(mse)))
    assert not s["identical"]


def test_identical_arrays_explicit_no_error():
    """完全一致时: MAE 全 0, PSNR 为 inf, identical 为 True —— 不出 NaN。"""
    rng = np.random.default_rng(0)
    ref = rng.integers(0, 256, size=(7, 5, 3), dtype=np.uint8)
    s = metrics.region_stats(ref, ref.copy())
    assert s["identical"]
    assert s["mae"] == 0.0 and s["mae_r"] == 0.0
    assert math.isinf(s["psnr"])


def test_region_rect_selects_subarea():
    ref = np.zeros((4, 4, 3), dtype=np.uint8)
    dec = ref.copy()
    dec[1, 2] = (9, 9, 9)  # 只动一个像素
    s = metrics.region_stats(ref, dec, rect=(2, 1, 1, 1))
    assert s["pixels"] == 1
    assert s["mae"] == pytest.approx(9.0)
    # 不包含该像素的区域应完全无误差
    s2 = metrics.region_stats(ref, dec, rect=(0, 0, 2, 2))
    assert s2["identical"]


def test_grid_covers_edges_and_weighted_mae_matches_full():
    """10x7 图按 4px 切块: 边缘块 2 列/3 行不足一块也计入,
    各块按实际像素数加权后必须等于全图 MAE。"""
    rng = np.random.default_rng(42)
    ref = rng.integers(0, 256, size=(7, 10, 3), dtype=np.uint8)
    dec = rng.integers(0, 256, size=(7, 10, 3), dtype=np.uint8)

    rects = metrics.grid_rects(ref.shape, 4)
    # 3 列 (4,4,2) x 2 行 (4,3) = 6 块
    assert len(rects) == 6
    assert (8, 0, 2, 4) in rects   # 右边缘窄块
    assert (0, 4, 4, 3) in rects   # 下边缘矮块
    assert (8, 4, 2, 3) in rects   # 角上的小块
    assert sum(w * h for _, _, w, h in rects) == 70  # 不重不漏

    blocks = metrics.grid_stats(ref, dec, 4)
    full = metrics.region_stats(ref, dec)
    assert metrics.weighted_mae(blocks) == pytest.approx(full["mae"], abs=1e-12)


def test_error_map_is_channel_max():
    ref = np.zeros((1, 2, 3), dtype=np.uint8)
    dec = np.array([[(5, 250, 100), (0, 0, 7)]], dtype=np.uint8)
    em = metrics.error_map(ref, dec)
    assert em.shape == (1, 2)
    assert em[0, 0] == 250
    assert em[0, 1] == 7


def test_channel_order_rgb_not_bgr():
    """确认通道顺序按 RGB 统计: 只改第一通道应只影响 mae_r。"""
    ref = np.zeros((2, 2, 3), dtype=np.uint8)
    dec = ref.copy()
    dec[:, :, 0] = 8  # R 通道
    s = metrics.region_stats(ref, dec)
    assert s["mae_r"] == pytest.approx(8.0)
    assert s["mae_g"] == 0.0
    assert s["mae_b"] == 0.0
