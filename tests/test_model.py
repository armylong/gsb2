"""区域模型测试：邻接、碎块合并、保护岛、撤销重做。"""

import unittest

import numpy as np
from PIL import Image

from colorbook.model import RegionModel
from colorbook.sample import (
    BLUE,
    GREEN,
    RED,
    WHITE,
    YELLOW,
    build_sample_image,
)


def _model_from_grid(grid, palette):
    h, w = len(grid), len(grid[0])
    arr = np.zeros((h, w, 3), dtype=np.uint8)
    for y, row in enumerate(grid):
        for x, idx in enumerate(row):
            arr[y, x] = palette[idx]
    return RegionModel(Image.fromarray(arr, mode="RGB"))


class TestModel(unittest.TestCase):
    def setUp(self):
        self.model = RegionModel(build_sample_image())

    def test_sample_structure(self):
        m = self.model
        # 背景 + 蓝环 + 黄孔 + 红桥接块 + 红孤岛 + 绿碎块x2 + 紫带 + 蓝碎片 = 9
        self.assertEqual(len(m.regions), 9)
        # 同色断块共享编号
        red_ids = m.regions_of_color(RED)
        self.assertEqual(len(red_ids), 2)
        numbers = {m.color_number(lid) for lid in red_ids}
        self.assertEqual(numbers, {m.color_number(red_ids[0])})
        # 两个红块不相邻
        a, b = red_ids
        self.assertNotIn(b, m.neighbors_of(a))

    def test_hole_is_separate_region(self):
        m = self.model
        yellow = m.regions_of_color(YELLOW)
        blue = m.regions_of_color(BLUE)
        self.assertEqual(len(yellow), 1)
        self.assertGreaterEqual(len(blue), 2)  # 圆环 + 蓝色小碎片
        hole_id = yellow[0]
        ring_id = next(lid for lid in blue if m.regions[lid].area > 10000)
        # 孔与环相邻
        self.assertIn(ring_id, m.neighbors_of(hole_id))

    def test_bridge_keeps_single_region(self):
        m = self.model
        red_ids = m.regions_of_color(RED)
        bridge_region = max(red_ids, key=lambda lid: m.regions[lid].area)
        # 桥接后的红块包含左右两大块 + 桥，面积远超单个块
        self.assertGreater(m.regions[bridge_region].area, 120 * 120)

    def test_merge_small_regions(self):
        m = self.model
        before = len(m.regions)
        small_green = min(
            m.regions_of_color(GREEN), key=lambda lid: m.regions[lid].area
        )
        self.assertLess(m.regions[small_green].area, 1500)
        merged = m.merge_small_regions(1500)
        merged_ids = {small for small, _ in merged}
        self.assertIn(small_green, merged_ids)
        self.assertNotIn(small_green, m.regions)
        self.assertEqual(len(m.regions), before - len(merged))
        # 标签图里不应再出现被合并的 id
        self.assertTrue(np.all(m.labels != small_green))
        # 邻接关系里也应清除
        for neighbors in m.adjacency.values():
            self.assertNotIn(small_green, neighbors)

    def test_protected_island_survives_merge(self):
        m = self.model
        small_green = min(
            m.regions_of_color(GREEN), key=lambda lid: m.regions[lid].area
        )
        m.set_protected(small_green, True)
        merged = m.merge_small_regions(1500)
        merged_ids = {small for small, _ in merged}
        self.assertNotIn(small_green, merged_ids)
        self.assertIn(small_green, m.regions)
        self.assertTrue(m.regions[small_green].protected)

    def test_undo_redo_restores_everything(self):
        m = self.model
        before = len(m.regions)
        labels_before = m.labels.copy()
        m.merge_small_regions(1500)
        self.assertLess(len(m.regions), before)
        self.assertTrue(m.undo())
        self.assertEqual(len(m.regions), before)
        self.assertTrue(np.array_equal(m.labels, labels_before))
        # 撤销后颜色编号仍可正常计算
        for lid in m.regions:
            self.assertIsInstance(m.color_number(lid), int)
        self.assertTrue(m.redo())
        self.assertLess(len(m.regions), before)

    def test_manual_merge_target_must_be_neighbor(self):
        m = self.model
        ids = m.region_ids()
        # 两个不相邻的区域不能直接合并
        non_neighbors = [
            (a, b)
            for a in ids
            for b in ids
            if a < b and b not in m.neighbors_of(a)
        ]
        a, b = non_neighbors[0]
        self.assertFalse(m.merge_into(a, b))

    def test_background_not_treated_as_fragment(self):
        # 即使阈值很大，背景本身也不会被合并
        m = self.model
        bg = m.background_id
        before = len(m.regions)
        m.merge_small_regions(10 ** 9)
        self.assertIn(bg, m.regions)
        self.assertEqual(m.region_at(0, 0), bg)
        self.assertLess(len(m.regions), before)

    def test_merge_prefers_color_neighbor_over_background(self):
        # 构造：彩色小块同时贴着背景和另一个彩色大块，应并入彩色大块
        palette = [(255, 255, 255), (200, 0, 0), (0, 0, 200)]
        grid = [
            [0, 0, 0, 0, 0],
            [0, 2, 2, 1, 0],
            [0, 2, 2, 1, 0],
            [0, 2, 2, 1, 0],
            [0, 0, 0, 0, 0],
        ]
        m = _model_from_grid(grid, palette)
        small_red = next(
            lid for lid, r in m.regions.items() if r.color == (200, 0, 0)
        )
        big_blue = next(
            lid for lid, r in m.regions.items() if r.color == (0, 0, 200)
        )
        # 阈值只够吞掉 3 像素的红条，吞不掉 6 像素的蓝块
        m.merge_small_regions(4)
        self.assertNotIn(small_red, m.regions)
        self.assertIn(big_blue, m.regions)

    def test_background_region_exists(self):
        m = self.model
        bg = m.region_at(0, 0)
        self.assertIsNotNone(bg)
        self.assertEqual(m.regions[bg].color, WHITE)

    def test_background_has_no_color_number(self):
        m = self.model
        # 背景不参与颜色编号
        self.assertEqual(m.color_number(m.background_id), 0)
        numbers = m.color_number_map()
        self.assertNotIn(WHITE, numbers)
        # 非背景区域都有正编号
        for lid, region in m.regions.items():
            if lid != m.background_id:
                self.assertGreater(m.color_number(lid), 0)

    def test_color_numbers_stay_contiguous_after_merge(self):
        m = self.model
        m.merge_small_regions(1500)
        numbers = sorted(set(m.color_number_map().values()))
        # 合并后编号仍从 1 开始连续，无跳号
        self.assertEqual(numbers, list(range(1, len(numbers) + 1)))

    def test_same_color_disconnected_share_number(self):
        m = self.model
        red_ids = m.regions_of_color(RED)
        self.assertEqual(len(red_ids), 2)
        self.assertEqual(
            m.color_number(red_ids[0]), m.color_number(red_ids[1])
        )


if __name__ == "__main__":
    unittest.main()
