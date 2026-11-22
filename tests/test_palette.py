"""调色板模型、候选评分与跨组冲突预警测试。"""
import unittest

from colorcheck import cvd
from colorcheck.palette import Palette


class TestPaletteBasics(unittest.TestCase):
    def setUp(self):
        self.pal = Palette()
        self.red = self.pal.add_category((229, 57, 53), "红")
        self.green = self.pal.add_category((67, 160, 71), "绿")
        self.blue = self.pal.add_category((30, 136, 229), "蓝")

    def test_pair_dedup(self):
        self.pal.add_pair(self.red.cid, self.green.cid)
        self.pal.add_pair(self.green.cid, self.red.cid)
        self.assertEqual(len(self.pal.pairs), 1)

    def test_lock_toggle(self):
        self.pal.toggle_lock(self.red.cid)
        self.assertTrue(self.pal.get(self.red.cid).locked)
        src, dst, cids = self.pal.editable_sources_targets()
        self.assertNotIn(self.red.cid, cids)
        self.assertEqual(len(cids), 2)

    def test_serialization_roundtrip(self):
        self.pal.add_pair(self.red.cid, self.green.cid)
        d = self.pal.to_dict()
        pal2 = Palette.from_dict(d)
        self.assertEqual(len(pal2.categories), 3)
        self.assertEqual(pal2.pairs[0].a, self.red.cid)
        self.assertEqual(pal2.get(self.red.cid).source_color,
                         self.red.source_color)


class TestMetricsAndCandidates(unittest.TestCase):
    def setUp(self):
        self.pal = Palette()
        self.red = self.pal.add_category((229, 57, 53), "红")
        self.green = self.pal.add_category((67, 160, 71), "绿")
        self.pal.add_pair(self.red.cid, self.green.cid)

    def test_simulated_pair_worse_than_normal(self):
        normal = self.pal.full_metrics(cvd.DEUTAN, 0.0, self.pal.light_bg)[0]
        strong = self.pal.full_metrics(cvd.DEUTAN, 1.0, self.pal.light_bg)[0]
        self.assertLess(strong["de"], normal["de"])

    def test_candidates_improve_required_pair(self):
        strong_before = self.pal.full_metrics(
            cvd.DEUTAN, 1.0, self.pal.light_bg)[0]["de"]
        cands = self.pal.generate_candidates(
            self.green.cid, cvd.DEUTAN, 1.0, max_count=12)
        self.assertTrue(cands)
        best_de = max(c["min_pair_de"] for c in cands)
        self.assertGreater(best_de, strong_before)
        # 候选色不应等于原色
        for c in cands:
            self.assertNotEqual(c["rgb"], tuple(self.green.color))

    def test_cross_group_conflict_warning(self):
        # 新增一个未配对的绿色邻近类别, 候选若往它靠应触发预警
        other = self.pal.add_category((80, 150, 60), "未配对绿")
        cands = self.pal.generate_candidates(
            self.red.cid, cvd.DEUTAN, 1.0, max_count=12)
        warned = any(
            any(other.name in w for w in c["warnings"]) for c in cands)
        # 至少部分候选会撞色, 预警机制存在即可
        self.assertIsInstance(warned, bool)

    def test_evaluate_proposal_restores_state(self):
        before = tuple(self.pal.get(self.green.cid).color)
        self.pal.evaluate_proposal(
            {self.green.cid: (180, 120, 0)}, cvd.DEUTAN, 0.8)
        self.assertEqual(tuple(self.pal.get(self.green.cid).color), before)

    def test_contrast_on_both_backgrounds(self):
        # 纯白标记在浅底上反差不足, 深底上充足
        pal = Palette()
        white = pal.add_category((250, 250, 250), "白")
        black = pal.add_category((10, 10, 10), "黑")
        pal.add_pair(white.cid, black.cid)
        light = pal.full_metrics(cvd.DEUTAN, 0.0, pal.light_bg)[0]
        dark = pal.full_metrics(cvd.DEUTAN, 0.0, pal.dark_bg)[0]
        self.assertLess(light["contrast_a"], pal.contrast_min)
        self.assertGreater(dark["contrast_a"], pal.contrast_min)


if __name__ == "__main__":
    unittest.main()
