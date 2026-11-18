"""验证 2: 成品的真实逐帧 pts / 帧数 / 时长 / 逐行标记。

直接 ffprobe 读导出文件, 而不是只检查 ffmpeg 返回码。
关键约束:
  - 单倍输出帧数 = 源帧数, 节奏不变;
  - 双倍输出帧数 ≈ 2x 源帧数, 但内容时长保持源速度 (不加速/慢放);
  - 两者时长与源片差距各不超过一个输出帧周期;
  - 成品被标记为逐行。
"""
from __future__ import annotations

from pathlib import Path

from ._base import SampleTestCase, probe_media, read_exported_pts
from deinterlace_lab.ffmpeg_tools import export_deinterlaced


class TestExportTiming(SampleTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.src = probe_media(cls.paths["tff"])
        cls.single = Path(cls.tmp) / "timing_single.mp4"
        cls.double = Path(cls.tmp) / "timing_double.mp4"
        export_deinterlaced(cls.paths["tff"], cls.single, "single", "tff")
        export_deinterlaced(cls.paths["tff"], cls.double, "double", "tff")

    def test_single_frame_count_and_progressive_flag(self):
        pts, interlaced, n = read_exported_pts(self.single)
        self.assertEqual(n, self.src.nb_frames)
        self.assertFalse(interlaced, "成品必须标记为逐行")
        self.assertEqual(probe_media(self.single).field_order, "progressive")

    def test_double_frame_count_is_double(self):
        pts, interlaced, n = read_exported_pts(self.double)
        # 双倍模式每场一帧: 约为源帧的 2 倍 (允许首尾场差 1)。
        self.assertAlmostEqual(n, 2 * self.src.nb_frames, delta=1)
        self.assertFalse(interlaced)

    def test_double_keeps_source_speed_not_sped_up(self):
        pts_d, _, n_d = read_exported_pts(self.double)
        pts_s, _, n_s = read_exported_pts(self.single)
        # 帧更密但时间轴不压缩: 双倍最后一帧时间应接近单倍/源的末尾,
        # 而不是只有一半时长 (若被加速 2 倍会在这里暴露)。
        self.assertAlmostEqual(pts_d[-1], pts_s[-1], delta=1 / self.spec.interlaced_fps)
        # 双倍相邻帧间隔 ≈ 一个场间隔。
        field_period = 1.0 / self.spec.field_rate
        gaps = [pts_d[i + 1] - pts_d[i] for i in range(min(8, len(pts_d) - 1))]
        for g in gaps:
            self.assertAlmostEqual(g, field_period, delta=field_period * 0.15)

    def test_duration_within_one_output_frame(self):
        src_duration = self.src.duration
        for path, mode in ((self.single, "single"), (self.double, "double")):
            info = probe_media(path)
            out_period = 1.0 / float(info.frame_rate)
            self.assertLessEqual(
                abs(info.duration - src_duration),
                out_period + 1e-6,
                f"{mode} 时长超出一个输出帧周期",
            )

    def test_dimensions_preserved(self):
        for path in (self.single, self.double):
            info = probe_media(path)
            self.assertEqual((info.width, info.height),
                             (self.src.width, self.src.height))
