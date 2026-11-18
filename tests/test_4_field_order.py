"""验证 4: 场序选错会产生可观察的运动差异, 且音频被保留。

同一个 TFF 样例分别按 tff / bff 去隔行, 在移动细线区域, 两种场序给出的
像素结果应当不同 (选错时两个场的时间先后被颠倒, 运动边缘方向相反)。
"""
from __future__ import annotations

from pathlib import Path

from ._base import SampleTestCase, probe_media
from deinterlace_lab.ffmpeg_tools import export_deinterlaced


class TestFieldOrderAndAudio(SampleTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.correct = Path(cls.tmp) / "parity_tff.mp4"
        cls.wrong = Path(cls.tmp) / "parity_bff.mp4"
        export_deinterlaced(cls.paths["tff"], cls.correct, "double", "tff")
        export_deinterlaced(cls.paths["tff"], cls.wrong, "double", "bff")

    def test_wrong_parity_changes_pixels(self):
        from tests.tests_helpers import frame_diff
        diff = frame_diff(self.correct, self.wrong, frame_index=2,
                          band=(60, self.spec.height - 60))
        # 选错场序在运动区域必须产生显著差异, 而不是几乎相同的画面。
        self.assertGreater(diff, 6.0,
                           "切换场序后运动区域没有可观察差异")

    def test_correct_parity_matches_reference_better(self):
        from tests.tests_helpers import frame_diff
        # 正确场序与逐行参考的运动位置应比错误场序更接近。
        d_correct = frame_diff(self.correct, self.paths["progressive"],
                               frame_index=4, band=(60, self.spec.height - 60))
        d_wrong = frame_diff(self.wrong, self.paths["progressive"],
                             frame_index=4, band=(60, self.spec.height - 60))
        self.assertLess(d_correct, d_wrong)

    def test_audio_stream_preserved(self):
        self.assertTrue(probe_media(self.correct).has_audio)
        self.assertTrue(probe_media(self.wrong).has_audio)
        self.assertEqual(probe_media(self.correct).audio_codec, "aac")
