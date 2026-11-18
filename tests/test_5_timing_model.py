"""验证 5: TimingModel 的场/帧时间映射纯逻辑。

确保定位全部基于实测 pts, 且双倍视图的输出帧与场时间一一对应。
"""
from __future__ import annotations

import unittest

from deinterlace_lab.timing import TimingModel


class TestTimingModel(unittest.TestCase):
    def setUp(self):
        # 25fps 输入, 4 帧, 真实 pts 等间隔 0.04。
        self.pts = [0.0, 0.04, 0.08, 0.12]

    def test_tff_field_times(self):
        m = TimingModel(self.pts, "tff")
        fields = m.all_fields()
        self.assertEqual(len(fields), 8)
        self.assertEqual(fields[0].field_kind, "top")
        self.assertAlmostEqual(fields[0].time, 0.0)
        self.assertEqual(fields[1].field_kind, "bottom")
        self.assertAlmostEqual(fields[1].time, 0.02)
        # 第二输入帧的顶场在 0.04。
        self.assertEqual(fields[2].input_frame, 1)
        self.assertAlmostEqual(fields[2].time, 0.04)

    def test_bff_swaps_field_kind_but_keeps_time_grid(self):
        m = TimingModel(self.pts, "bff")
        fields = m.all_fields()
        self.assertEqual(fields[0].field_kind, "bottom")
        self.assertEqual(fields[1].field_kind, "top")
        # 时间网格不变, 只是空间场归属互换。
        self.assertAlmostEqual(fields[0].time, 0.0)
        self.assertAlmostEqual(fields[1].time, 0.02)

    def test_output_counts(self):
        m = TimingModel(self.pts, "tff")
        self.assertEqual(m.output_count("raw"), 4)
        self.assertEqual(m.output_count("single"), 4)
        self.assertEqual(m.output_count("double"), 8)

    def test_field_alignment_across_views(self):
        m = TimingModel(self.pts, "tff")
        # 双倍第 3 帧 (场 index 3) 应映射回单倍第 2 个输入帧 (3//2=1)。
        self.assertEqual(m.output_index_at_field("single", 3), 1)
        self.assertEqual(m.output_index_at_field("double", 3), 3)
        # 反向: 单倍输出帧 1 覆盖场 2、3。
        self.assertEqual(m.field_index_for_output("single", 1), 2)

    def test_nearest_by_real_time_not_frame_multiply(self):
        m = TimingModel(self.pts, "tff")
        # 双倍场时间网格为 0, .02, .04, .06 ...; 定位直接比较真实 pts 距离。
        idx = m.nearest_output_index("double", 0.049)
        self.assertEqual(idx, 2)
        self.assertAlmostEqual(m.output_frame_time("double", idx), 0.04)
        # 越过中点后吸附到 0.06 (场 index 3)。
        idx2 = m.nearest_output_index("double", 0.058)
        self.assertEqual(idx2, 3)
        self.assertAlmostEqual(m.output_frame_time("double", idx2), 0.06)

    def test_irregular_pts_are_used_directly(self):
        # 非严格等间隔也以真实 pts 为准 (CFR 校验在 GUI 层, 模型只负责映射)。
        pts = [0.0, 0.05, 0.09, 0.12]
        m = TimingModel(pts, "tff")
        self.assertAlmostEqual(m.output_frame_time("single", 1), 0.05)
        self.assertAlmostEqual(m.all_fields()[2].time, 0.05)


if __name__ == "__main__":
    unittest.main()
