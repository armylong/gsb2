"""标签落位测试：内部落位、狭长区域外部引线、手动锚点。"""

import unittest

import numpy as np

from colorbook.labels import chamfer_distance, plan_region_label
from colorbook.model import RegionModel
from colorbook.sample import PURPLE, build_sample_image


class TestChamfer(unittest.TestCase):
    def test_distance_values(self):
        mask = np.zeros((5, 5), dtype=bool)
        mask[1:4, 1:4] = True  # 3x3 实心块
        dist = chamfer_distance(mask)
        # 背景为 0
        self.assertEqual(dist[0, 0], 0)
        # 中心点离边界最远
        self.assertEqual(dist[2, 2], dist.max())
        # 边缘前景像素距离为 3（一个水平/垂直步长）
        self.assertEqual(dist[2, 1], 3)

    def test_hole_has_zero_distance(self):
        mask = np.ones((7, 7), dtype=bool)
        mask[3, 3] = False  # 单点孔
        dist = chamfer_distance(mask)
        self.assertEqual(dist[3, 3], 0)
        # 孔四周距离很小
        self.assertLessEqual(dist[3, 2], 4)


class TestLabelPlacement(unittest.TestCase):
    def setUp(self):
        self.model = RegionModel(build_sample_image())
        # 最大区域通常是背景；测试需要的是最大的"图形"区域（蓝环）
        background = self.model.region_at(0, 0)
        self.big_region = max(
            (lid for lid in self.model.region_ids() if lid != background),
            key=lambda lid: self.model.regions[lid].area,
        )

    def _plan(self, region_id, box_w, box_h, manual=None):
        return plan_region_label(
            self.model.labels, region_id, "1", box_w, box_h, manual
        )

    def test_large_region_label_inside(self):
        m = self.model
        ring = self.big_region
        plan = self._plan(ring, 20, 14)
        self.assertTrue(plan.fits)
        self.assertTrue(plan.inside)
        # 文字框整块在区域内
        x, y = plan.anchor
        patch = m.labels[y : y + 14, x : x + 20]
        self.assertTrue(np.all(patch == ring))

    def test_narrow_sliver_uses_leader_line(self):
        m = self.model
        sliver = next(
            lid
            for lid, r in m.regions.items()
            if r.color == PURPLE
        )
        # 文字框高度 14，而带状区域只有 10px 高，内部必然放不下
        plan = self._plan(sliver, 24, 14)
        self.assertTrue(plan.fits)
        self.assertFalse(plan.inside)
        self.assertIsNotNone(plan.leader_to)
        # 引线落点确实在区域内
        lx, ly = plan.leader_to
        self.assertEqual(int(m.labels[ly, lx]), sliver)
        # 文字框完整在画布内
        x, y = plan.anchor
        self.assertGreaterEqual(x, 0)
        self.assertGreaterEqual(y, 0)
        self.assertLessEqual(x + 24, m.width)
        self.assertLessEqual(y + 14, m.height)

    def test_manual_anchor_honored_when_valid(self):
        m = self.model
        ring = self.big_region
        ys, xs = np.nonzero(m.labels == ring)
        # 环的质心落在孔里，取上半部分（环实体）的质心作为手动锚点
        top_mask = ys < (ys.min() + ys.max()) / 2
        cx, cy = int(xs[top_mask].mean()), int(ys[top_mask].mean())
        self.assertEqual(int(m.labels[cy, cx]), ring)
        plan = self._plan(ring, 10, 10, manual=(cx, cy))
        self.assertTrue(plan.inside)
        # 锚点以点击位置为框中心
        self.assertAlmostEqual(plan.anchor[0] + 5, cx, delta=1)

    def test_manual_anchor_outside_falls_back(self):
        ring = self.big_region
        # 给一个背景里的点，手动方案失效后应自动找回内部落位
        plan = self._plan(ring, 10, 10, manual=(0, 0))
        self.assertTrue(plan.fits)
        self.assertTrue(plan.inside)

    def test_tiny_box_always_fits_in_big_region(self):
        ring = self.big_region
        plan = self._plan(ring, 4, 4)
        self.assertTrue(plan.fits and plan.inside)

    def test_compact_small_island_uses_overflow_inside(self):
        # 19x19 绿岛配 21px 高的框：紧凑小块应覆盖落位而不是外部引线
        m = self.model
        from colorbook.sample import GREEN
        green = min(
            m.regions_of_color(GREEN), key=lambda lid: m.regions[lid].area
        )
        plan = self._plan(green, 18, 21)
        self.assertTrue(plan.fits)
        self.assertTrue(plan.inside)
        self.assertTrue(plan.overflow)

    def test_resolve_overlaps_separates_external_labels(self):
        from colorbook.labels import LabelPlan, resolve_label_overlaps
        # 两个外部标签框故意重叠，消解后应不再相交
        plans = {
            1: LabelPlan(1, "1", (10, 10), (20, 20), inside=True, fits=True),
            2: LabelPlan(
                2, "2", (15, 40), (20, 20),
                inside=False, fits=True, leader_to=(20, 100),
            ),
        }
        resolve_label_overlaps(plans, (200, 200))
        p1, p2 = plans[1], plans[2]
        # 内部标签不动
        self.assertEqual(p1.anchor, (10, 10))
        # 外部标签被推离，两框不再相交
        def overlap(a, b):
            ax, ay, aw, ah = a.anchor + a.box_size
            bx, by, bw, bh = b.anchor + b.box_size
            return not (
                ax + aw <= bx or bx + bw <= ax or ay + ah <= by or by + bh <= ay
            )
        self.assertFalse(overlap(p1, p2))


if __name__ == "__main__":
    unittest.main()
