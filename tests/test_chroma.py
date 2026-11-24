import numpy as np
import pytest

from chroma_inspector.chroma import (
    ChromaSite,
    is_supported,
    luma_to_chroma_weights,
    unsupported_reason,
    upsample_chroma,
    virtual_point,
)


def test_virtual_points_420():
    # left: 色度样本 (1,2) 虚拟位置 (2,4)
    p = virtual_point(ChromaSite.LEFT, 1, 2, 2, 2)
    assert (p.x, p.y) == (2.0, 4.0)
    # center: 半像素偏移 (2.5, 4.5)
    p = virtual_point(ChromaSite.CENTER, 1, 2, 2, 2)
    assert (p.x, p.y) == (2.5, 4.5)
    # top: 水平半像素、垂直整数
    p = virtual_point(ChromaSite.TOP, 1, 2, 2, 2)
    assert (p.x, p.y) == (2.5, 4.0)


def test_virtual_points_422():
    p = virtual_point(ChromaSite.LEFT, 3, 5, 2, 1)
    assert (p.x, p.y) == (6.0, 5.0)
    p = virtual_point(ChromaSite.CENTER, 3, 5, 2, 1)
    assert (p.x, p.y) == (6.5, 5.0)


def test_444_is_co_sited():
    p = virtual_point(ChromaSite.LEFT, 7, 8, 1, 1)
    assert (p.x, p.y) == (7.0, 8.0)
    assert is_supported(ChromaSite.BOTTOM, 1, 1)


def test_support_matrix():
    assert is_supported(ChromaSite.LEFT, 2, 2)
    assert is_supported(ChromaSite.CENTER, 2, 2)
    assert not is_supported(ChromaSite.BOTTOM, 2, 2)
    assert "外推" in unsupported_reason(ChromaSite.BOTTOM)
    # 4:2:2 只有水平歧义，top 在该结构下不提供
    assert not is_supported(ChromaSite.TOP, 2, 1)


def test_upsample_constant_is_constant_every_site():
    """中性灰保证：恒定色度在任意解释、任意像素上都不偏色。"""
    plane = np.full((4, 4), 128, np.uint8)
    for site in (ChromaSite.LEFT, ChromaSite.CENTER, ChromaSite.TOP,
                 ChromaSite.TOP_LEFT):
        out = upsample_chroma(plane, site, 2, 2, 8, 8)
        assert out.shape == (8, 8)
        np.testing.assert_array_equal(out, np.full((8, 8), 128.0))


def test_upsample_422_constant():
    plane = np.full((3, 4), 200, np.uint8)
    out = upsample_chroma(plane, ChromaSite.CENTER, 2, 1, 3, 8)
    np.testing.assert_array_equal(out, np.full((3, 8), 200.0))


def test_half_pixel_phase_difference_horizontal():
    """垂直色边：left 与 center 的边沿在亮度网格上相差半像素。

    色度样本 cx 虚拟位置：left=2cx，center=2cx+0.5；样本在 cx=3/4 间阶跃。
    """
    plane = np.zeros((4, 8), np.uint8)
    plane[:, 4:] = 100
    left = upsample_chroma(plane, ChromaSite.LEFT, 2, 2, 8, 16)
    center = upsample_chroma(plane, ChromaSite.CENTER, 2, 2, 8, 16)
    # left: 样本 cx=4 虚拟 x=8；亮度 x=8 与新样本同位取 100，
    # x=7 是 cx=3/4 的 50/50 混合
    assert left[0, 8] == 100.0
    assert left[0, 7] == pytest.approx(50.0)
    # center: 样本 cx=4 虚拟 x=8.5；同样的 50% 过渡点从亮度 x=7
    # 推迟到 x=8 —— 整段边沿横向平移半像素
    assert center[0, 7] == pytest.approx(25.0)
    assert center[0, 8] == pytest.approx(75.0)
    assert not np.array_equal(left, center)


def test_vertical_phase_difference():
    """水平色边：top 与 center 的纵向边沿相差半像素。

    色度样本 cy=2：top 虚拟 y=4，center 虚拟 y=4.5。
    """
    plane = np.zeros((4, 4), np.uint8)
    plane[2:, :] = 80
    top = upsample_chroma(plane, ChromaSite.TOP, 2, 2, 8, 8)
    center = upsample_chroma(plane, ChromaSite.CENTER, 2, 2, 8, 8)
    # top: 色度行 cy=2 虚拟 y=4；亮度 y=4 取 80，y=3 为 50% 混合
    assert top[4, 0] == 80.0
    assert top[3, 0] == pytest.approx(40.0)
    # center: cy=2 虚拟 y=4.5；50% 点下移到 y=4，纵向边沿晚半像素
    assert center[4, 0] == pytest.approx(60.0)
    assert center[3, 0] == pytest.approx(20.0)


def test_upsample_preserves_sample_values_at_virtual_positions():
    rng = np.random.default_rng(0)
    plane = rng.integers(0, 256, size=(4, 4), dtype=np.uint8)
    out = upsample_chroma(plane, ChromaSite.LEFT, 2, 2, 8, 8)
    # left 下亮度偶数坐标与色度样本同位
    for cy in range(4):
        for cx in range(4):
            assert out[2 * cy, 2 * cx] == pytest.approx(float(plane[cy, cx]))


def test_weights_match_upsample_including_clamp():
    rng = np.random.default_rng(1)
    plane = rng.integers(0, 256, size=(3, 5), dtype=np.uint8).astype(np.float64)
    out = upsample_chroma(plane, ChromaSite.CENTER, 2, 2, 6, 10)
    for y in range(6):
        for x in range(10):
            weights = luma_to_chroma_weights(
                x, y, ChromaSite.CENTER, 2, 2, 5, 3
            )
            value = sum(plane[cy, cx] * w for cx, cy, w in weights)
            assert value == pytest.approx(out[y, x], abs=1e-10)


def test_edge_clamp_weights():
    # center 解释下亮度 (0,0) 反向映射到色度 (-0.25,-0.25)：
    # 四个钳位邻点塌缩到同一样本 (0,0)，权重合并为 1.0，
    # 与上采样在角落直接取角样本的行为一致
    weights = luma_to_chroma_weights(0, 0, ChromaSite.CENTER, 2, 2, 4, 4)
    assert weights == [(0, 0, 1.0)]
    plane = np.arange(16, dtype=np.uint8).reshape(4, 4)
    out = upsample_chroma(plane, ChromaSite.CENTER, 2, 2, 8, 8)
    value = sum(plane[cy, cx] * w for cx, cy, w in weights)
    assert value == pytest.approx(out[0, 0], abs=1e-12)
