"""小型已知掩码的精确测试：面积、质心、边界、孔洞、邻接与编号。"""
from __future__ import annotations

import numpy as np
import pytest

from ccstats.demos import DEMO_ORDER, expected_for, expected_for_params, get_demo
from ccstats.models import (
    Connectivity, FilterCriteria, FilterReason, Polarity, SegmentParams,
    ThresholdMode, ThresholdParams,
)
from ccstats.segment import (
    complementary_connectivity, disk_area, hit_region, reevaluate, segment,
    threshold_mask,
)


def _mask_to_gray(mask: np.ndarray) -> np.ndarray:
    return np.where(mask > 0, 40, 235).astype(np.uint8)


def _seg(mask: np.ndarray, conn=Connectivity.EIGHT, **kw) -> "SegmentationResult":
    params = SegmentParams(
        threshold=ThresholdParams(polarity=Polarity.DARK, fixed_value=128),
        connectivity=conn,
        **kw,
    )
    return segment(_mask_to_gray(mask), params)


def _single(mask: np.ndarray, conn=Connectivity.EIGHT):
    r = _seg(mask, conn)
    assert r.total_count == 1, [x.stats for x in r.regions]
    return r.regions[0].stats


# --------------------------------------------------------------- 阈值
def test_fixed_threshold_strict_and_polarity_inversion():
    gray = np.array([[127, 128, 129]], dtype=np.uint8)
    dark = threshold_mask(gray, ThresholdParams(polarity=Polarity.DARK, fixed_value=128))
    bright = threshold_mask(gray, ThresholdParams(polarity=Polarity.BRIGHT, fixed_value=128))
    assert dark.tolist() == [[1, 0, 0]]      # 严格 < 128，128 本身不算前景
    assert bright.tolist() == [[0, 0, 1]]    # 严格 > 128
    # 同一条命令的明暗反转应得到互补结果（此处 128 两边都不算）
    assert np.all(dark + bright <= 1)


def test_fixed_threshold_boundaries_zero_and_255():
    gray = np.array([[0, 255]], dtype=np.uint8)
    assert threshold_mask(gray, ThresholdParams(polarity=Polarity.DARK, fixed_value=0)).tolist() == [[0, 0]]
    assert threshold_mask(gray, ThresholdParams(polarity=Polarity.BRIGHT, fixed_value=255)).tolist() == [[0, 0]]
    assert threshold_mask(gray, ThresholdParams(polarity=Polarity.DARK, fixed_value=255)).tolist() == [[1, 0]]


def test_local_threshold_constant_image_empty_and_dark_spot_found():
    flat = np.full((40, 40), 100, dtype=np.uint8)
    p = ThresholdParams(mode=ThresholdMode.LOCAL, polarity=Polarity.DARK, local_radius=5, local_offset=10)
    assert threshold_mask(flat, p).sum() == 0
    spot = flat.copy()
    spot[20, 20] = 0                     # 比局部均值低 100，远超 offset=10
    m = threshold_mask(spot, p)
    assert m[20, 20] == 1 and m.sum() == 1
    # 亮目标同样可用局部阈值检出
    bright = flat.copy()
    bright[10, 10] = 250
    p_bright = ThresholdParams(mode=ThresholdMode.LOCAL, polarity=Polarity.BRIGHT,
                               local_radius=5, local_offset=10)
    mb = threshold_mask(bright, p_bright)
    assert mb[10, 10] == 1 and mb.sum() == 1


def test_polarity_reversal_on_synthetic_demo():
    img = np.array([[20, 20, 230, 230]], dtype=np.uint8)
    dark = segment(img, SegmentParams(threshold=ThresholdParams(polarity=Polarity.DARK, fixed_value=128)))
    bright = segment(img, SegmentParams(threshold=ThresholdParams(polarity=Polarity.BRIGHT, fixed_value=128)))
    assert dark.total_count == 1 and dark.regions[0].stats.area == 2
    assert bright.total_count == 1 and bright.regions[0].stats.area == 2
    assert dark.regions[0].stats.bbox == (0, 0, 2, 1)
    assert bright.regions[0].stats.bbox == (2, 0, 2, 1)


# --------------------------------------------------------------- 邻接
def test_diagonal_contact_differs_between_4_and_8():
    mask = np.zeros((10, 10), np.uint8)
    mask[2, 2] = mask[3, 3] = 1           # 只在对角接触
    r4 = _seg(mask, Connectivity.FOUR)
    r8 = _seg(mask, Connectivity.EIGHT)
    assert r4.total_count == 2
    assert sorted(x.stats.area for x in r4.regions) == [1, 1]
    assert r8.total_count == 1
    assert r8.regions[0].stats.area == 2


def test_hole_uses_complementary_connectivity():
    # 8 邻接前景在这张 3×3 掩码里连成一块，并把中心围成孔洞；
    # 4 邻接前景断成两块，且 8 邻接背景可以从对角漏出去，因此没有孔洞。
    mask = np.array([
        [1, 1, 0],
        [1, 0, 1],
        [0, 1, 1],
    ], np.uint8)
    assert complementary_connectivity(Connectivity.EIGHT) == 4
    assert complementary_connectivity(Connectivity.FOUR) == 8
    r8 = _seg(mask, Connectivity.EIGHT)
    r4 = _seg(mask, Connectivity.FOUR)
    assert r8.total_count == 1
    s8 = r8.regions[0].stats
    assert s8.area == 6
    assert s8.hole_count == 1 and s8.hole_area == 1
    assert s8.touches_border
    assert r4.total_count == 2
    assert sorted(x.stats.area for x in r4.regions) == [3, 3]
    assert all(x.stats.hole_count == 0 for x in r4.regions)


def test_diagonal_ring_hole_8conn_only():
    mask = np.array([
        [0, 0, 1, 0, 0],
        [0, 1, 0, 1, 0],
        [1, 0, 0, 0, 1],
        [0, 1, 0, 1, 0],
        [0, 0, 1, 0, 0],
    ], np.uint8)
    r8 = _seg(mask, Connectivity.EIGHT)
    assert r8.total_count == 1
    s = r8.regions[0].stats
    # 8 邻接前景连成一圈；孔洞按 4 邻接，中心与其四个边中点共 5 px 属同一孔洞
    assert s.area == 8 and s.hole_count == 1 and s.hole_area == 5
    # 整圈贴满图像四边，故判定触边；孔洞像素不进面积
    assert s.touches_border
    r4 = _seg(mask, Connectivity.FOUR)
    assert r4.total_count == 8
    assert all(x.stats.area == 1 and x.stats.hole_count == 0 for x in r4.regions)


# --------------------------------------------------------------- 面积/质心/触边
def test_single_pixel_area_centroid_bbox_and_border():
    mask = np.zeros((5, 6), np.uint8)
    mask[0, 0] = 1
    s = _single(mask)
    assert s.area == 1
    assert (s.centroid_x, s.centroid_y) == (0.5, 0.5)   # 像素中心，不是整数坐标
    assert s.bbox == (0, 0, 1, 1)
    assert s.touches_border
    assert s.hole_count == 0


def test_one_pixel_thin_line_not_undercounted():
    mask = np.zeros((7, 11), np.uint8)
    mask[3, 2:9] = 1                                    # 一行 7 个像素
    s = _single(mask)
    assert s.area == 7
    assert s.bbox == (2, 3, 7, 1)
    assert (s.centroid_x, s.centroid_y) == (5.5, 3.5)   # 像素中心 2.5..8.5 的均值
    assert not s.touches_border


def test_every_border_pixel_counted():
    mask = np.zeros((6, 8), np.uint8)
    mask[5, 1:8] = 1      # 一行 7 个像素，全部在底边
    s = _single(mask)
    assert s.area == 7
    assert s.bbox == (1, 5, 7, 1)
    assert s.touches_border
    assert (s.centroid_x, s.centroid_y) == (4.5, 5.5)

    # 贴住上边与左边的 L 形，共 10+10-1=19 个像素，一个也不应少计
    lshape = np.zeros((10, 10), np.uint8)
    lshape[0, :] = 1
    lshape[:, 0] = 1
    s2 = _single(lshape, Connectivity.FOUR)
    assert s2.area == 19
    assert s2.touches_border
    assert s2.bbox == (0, 0, 10, 10)


def test_centroid_uses_pixel_centers_not_corner_coordinates():
    mask = np.zeros((6, 6), np.uint8)
    mask[1:3, 1:3] = 1    # 2×2 方块，像素中心 1.5/2.5
    s = _single(mask)
    assert s.area == 4
    assert (s.centroid_x, s.centroid_y) == (2.0, 2.0)


# --------------------------------------------------------------- 编号顺序
def test_numbering_topmost_then_leftmost():
    mask = np.zeros((10, 12), np.uint8)
    mask[2, 8] = 1        # 最上方 y=2, x=8 -> 1
    mask[2, 3] = 1        # 同一行更左 -> 2
    mask[5, 1] = 1        # 更靠下 -> 3
    mask[1, 9] = 1        # 最上方 y=1 -> 0 号? 应为 1，因为 y 最小
    r = _seg(mask, Connectivity.FOUR)
    assert [(x.stats.label_id, x.stats.bbox[0], x.stats.bbox[1]) for x in r.regions] == [
        (1, 9, 1), (2, 3, 2), (3, 8, 2), (4, 1, 5)
    ]
    # 重复计算编号一致
    r2 = _seg(mask, Connectivity.FOUR)
    assert [x.stats.label_id for x in r2.regions] == [1, 2, 3, 4]
    assert np.array_equal(r.labels, r2.labels)


# --------------------------------------------------------------- 去噪/填隙
def test_despeckle_removes_small_components_only():
    mask = np.zeros((12, 12), np.uint8)
    mask[1, 1] = 1                       # 1 px
    mask[3, 3:8] = 1                     # 5 px
    mask[3, 3:9] = 1                     # 6 px
    mask[5:9, 5:9] = 1                   # 16 px
    base = _seg(mask)
    assert sorted(x.stats.area for x in base.regions) == [1, 6, 16]
    # disk_area(1)=5：只删除 1 px 和 5 px 的连通域
    trimmed = _seg(mask, despeckle_radius=1)
    assert sorted(x.stats.area for x in trimmed.regions) == [6, 16]
    # 去噪后标签里不再有 1 px 区域，但二值处理范围仍有原像素
    assert int(trimmed.base_mask.sum()) == 1 + 6 + 16
    assert int(trimmed.mask.sum()) == 6 + 16


def test_despeckle_disk_area_exact():
    assert [disk_area(r) for r in (0, 1, 2, 3)] == [0, 5, 13, 29]


def test_fill_small_holes_threshold_and_area_semantics():
    mask = np.zeros((9, 9), np.uint8)
    mask[2:7, 2:7] = 1
    mask[4, 4] = 0                        # 1 px 孔洞
    s0 = _single(mask)
    assert s0.area == 24 and s0.hole_count == 1 and s0.hole_area == 1
    # 填隙半径 1 对应 ≤5 px：孔被填上，不再是孔洞，面积变为 25
    r = _seg(mask, fill_radius=1)
    assert r.total_count == 1
    s1 = r.regions[0].stats
    assert s1.area == 25 and s1.hole_count == 0
    # 不填时，面积始终不包含孔洞
    assert _seg(mask).regions[0].stats.area == 24


def test_background_open_to_image_edge_is_not_a_hole():
    # 左上角 5×5 方块，缺掉 (0,0)：缺口连到图像边界，不是孔洞，也不会被填
    edge = np.zeros((9, 9), np.uint8)
    edge[0:5, 0:5] = 1
    edge[0, 0] = 0
    r_edge = _seg(edge, fill_radius=5)
    s = r_edge.regions[0].stats
    assert s.hole_count == 0 and s.hole_area == 0
    assert s.area == 24
    assert s.touches_border
    # 同一方块若把缺口改在内部，才算孔洞并可被填
    inner = np.zeros((9, 9), np.uint8)
    inner[0:5, 0:5] = 1
    inner[2, 2] = 0
    s_inner = _seg(inner, fill_radius=1).regions[0].stats
    assert s_inner.area == 25 and s_inner.hole_count == 0


# --------------------------------------------------------------- 筛选
def _three_region_result():
    mask = np.zeros((20, 30), np.uint8)
    mask[1:3, 1:3] = 1        # area 4, top y=1
    mask[5:8, 5:8] = 1        # area 9
    mask[10:14, 10:14] = 1    # area 16
    return _seg(mask, Connectivity.FOUR)


def test_area_filter_keeps_region_but_marks_excluded():
    r = _three_region_result()
    criteria = FilterCriteria(min_area=5, max_area=10)
    reevaluate(r, criteria)
    assert r.total_count == 3
    assert r.included_count == 1
    assert r.included_area == 9
    assert [x.included for x in r.regions] == [False, True, False]
    assert [x.reason for x in r.regions] == [FilterReason.SMALL, FilterReason.KEPT, FilterReason.LARGE]
    # 被筛掉的区域不从二值图/标签图中消失
    assert int(r.mask.sum()) == 29
    assert set(np.unique(r.labels).tolist()) == {0, 1, 2, 3}
    assert int((r.labels > 0).sum()) == 29


def test_exclude_border_and_manual_ignore_reasons():
    mask = np.zeros((20, 30), np.uint8)
    mask[0:4, 0:4] = 1        # 触边，area 16
    mask[8:12, 8:12] = 1      # 内部，area 16
    mask[15:18, 20:23] = 1    # 内部，area 9
    r = _seg(mask, Connectivity.FOUR)
    criteria = FilterCriteria(min_area=0, max_area=0, exclude_border=True)
    reevaluate(r, criteria, manual_ignored={2})
    assert [x.reason for x in r.regions] == [FilterReason.BORDER, FilterReason.MANUAL, FilterReason.KEPT]
    assert r.included_count == 1
    assert r.included_area == 9
    # 人工忽略优先于面积/触边原因
    criteria2 = FilterCriteria(min_area=100)
    reevaluate(r, criteria2, manual_ignored={1})
    assert r.regions[0].reason is FilterReason.MANUAL


def test_manual_ignore_does_not_change_geometry():
    r = _three_region_result()
    labels_before = r.labels.copy()
    mask_before = r.mask.copy()
    reevaluate(r, FilterCriteria(), manual_ignored={2})
    assert r.total_count == 3 and r.included_count == 2
    assert r.included_area == 4 + 16
    assert np.array_equal(r.labels, labels_before)
    assert np.array_equal(r.mask, mask_before)


def test_empty_result():
    r = segment(np.full((30, 40), 235, dtype=np.uint8),
                SegmentParams(threshold=ThresholdParams(polarity=Polarity.DARK, fixed_value=128)))
    assert r.total_count == 0
    assert r.included_count == 0
    assert r.included_area == 0
    assert int(r.mask.sum()) == 0
    assert not r.labels.any()
    assert not r.hole_mask.any()
    assert hit_region(r, 10, 10) is None


def test_hit_test_requires_foreground_pixel_not_nearest():
    big = np.zeros((30, 30), np.uint8)
    big[5:8, 5:8] = 1
    r = _seg(big)
    assert hit_region(r, 5, 5) == 1
    assert hit_region(r, 4, 4) is None        # 紧挨着物体但属于背景
    assert hit_region(r, 7, 7) == 1
    assert hit_region(r, 0, 0) is None
    assert hit_region(r, -1, 3) is None
    assert hit_region(r, 30, 3) is None
    assert hit_region(None, 1, 1) is None
    # 孔洞点击不算命中
    ring = np.zeros((9, 9), np.uint8)
    ring[2:7, 2:7] = 1
    ring[4, 4] = 0
    rr = _seg(ring)
    assert hit_region(rr, 4, 4) is None
    assert hit_region(rr, 2, 2) == 1


# --------------------------------------------------------------- 演示数据
@pytest.mark.parametrize("key", DEMO_ORDER)
def test_demo_expected_values_exact(key):
    demo = get_demo(key)
    for conn in (Connectivity.FOUR, Connectivity.EIGHT):
        exp = expected_for(demo, conn.value)
        r = segment(demo.image, SegmentParams(
            threshold=ThresholdParams(polarity=Polarity.DARK, fixed_value=128),
            connectivity=conn,
        ))
        assert r.total_count == exp["total"], key
        assert sorted(x.stats.area for x in r.regions) == sorted(exp["areas"]), key
        if exp.get("holes"):
            assert sorted(x.stats.hole_count for x in r.regions) == sorted(exp["holes"]), key
        assert r.included_area == exp["included_area"]


def test_demo_filters_for_documented_examples():
    border = get_demo("border")
    r = segment(border.image, SegmentParams(
        threshold=ThresholdParams(polarity=Polarity.DARK, fixed_value=128),
        connectivity=Connectivity.EIGHT,
    ))
    reevaluate(r, FilterCriteria(exclude_border=True))
    assert r.total_count == 4 and r.included_count == 1
    assert r.included_area == 317

    noise = get_demo("noise")
    base = segment(noise.image, SegmentParams(
        threshold=ThresholdParams(polarity=Polarity.DARK, fixed_value=128),
        connectivity=Connectivity.EIGHT,
    ))
    assert base.total_count == 6
    trimmed = segment(noise.image, SegmentParams(
        threshold=ThresholdParams(polarity=Polarity.DARK, fixed_value=128),
        connectivity=Connectivity.EIGHT,
        despeckle_radius=2,
    ))
    assert trimmed.total_count == 2
    assert sorted(x.stats.area for x in trimmed.regions) == [96, 1564]
    filled = segment(noise.image, SegmentParams(
        threshold=ThresholdParams(polarity=Polarity.DARK, fixed_value=128),
        connectivity=Connectivity.EIGHT,
        despeckle_radius=2,
        fill_radius=2,
    ))
    # 2×2 孔（4 px）被补，6×6 孔（36 px）仍保留
    assert sorted(x.stats.area for x in filled.regions) == [100, 1564]
    assert sorted(x.stats.hole_count for x in filled.regions) == [0, 1]
    assert sorted(x.stats.hole_area for x in filled.regions) == [0, 36]


@pytest.mark.parametrize("conn", [Connectivity.FOUR, Connectivity.EIGHT])
@pytest.mark.parametrize("despeckle,fill", [(0, 0), (2, 0), (2, 2), (4, 0), (4, 4)])
def test_noise_demo_after_filtering_matches_written_expectations(conn, despeckle, fill):
    demo = get_demo("noise")
    exp = expected_for_params(demo, conn.value, despeckle, fill)
    assert exp is not None
    r = segment(demo.image, SegmentParams(
        threshold=ThresholdParams(polarity=Polarity.DARK, fixed_value=128),
        connectivity=conn, despeckle_radius=despeckle, fill_radius=fill,
    ))
    assert r.total_count == exp["total"]
    assert sorted(x.stats.area for x in r.regions) == sorted(exp["areas"])
    assert sorted(x.stats.hole_count for x in r.regions) == sorted(exp["holes"])


def test_expected_for_params_refuses_unknown_combinations():
    assert expected_for_params(get_demo("diagonal"), 8, 3, 0) is None
    assert expected_for_params(get_demo("noise"), 8, 7, 7) is None
    assert expected_for_params(get_demo("diagonal"), 8, 0, 0) is not None
