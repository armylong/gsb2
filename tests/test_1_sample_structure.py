"""验证 1: 样例是真交错 (真实场标记 + 帧数减半), 且逐行参考被保留。"""
from __future__ import annotations

from ._base import SampleTestCase, probe_media


class TestSampleIsReallyInterlaced(SampleTestCase):
    def test_progressive_reference_is_50p(self):
        info = probe_media(self.paths["progressive"])
        self.assertEqual(info.nb_frames, self.spec.n_fields)
        self.assertEqual(int(info.frame_rate), self.spec.field_rate)
        self.assertFalse(info.interlaced)
        self.assertEqual(info.field_order, "progressive")

    def test_tff_sample_has_real_field_flags(self):
        info = probe_media(self.paths["tff"])
        # 50 个场编织成 25 个交错帧。
        self.assertEqual(info.nb_frames, self.spec.n_fields // 2)
        self.assertEqual(int(info.frame_rate), self.spec.interlaced_fps)
        self.assertTrue(info.interlaced, "样例必须包含被标记为交错的帧")
        self.assertEqual(info.field_order, "tt")

    def test_bff_sample_marked_bottom_first(self):
        info = probe_media(self.paths["bff"])
        self.assertTrue(info.interlaced)
        self.assertEqual(info.field_order, "bb")
        self.assertEqual(info.nb_frames, self.spec.n_fields // 2)

    def test_samples_carry_audio(self):
        self.assertTrue(probe_media(self.paths["tff"]).has_audio)
        self.assertTrue(probe_media(self.paths["bff"]).has_audio)
