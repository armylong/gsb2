"""回归测试：条码往返、时间轴换算、截取偏差、验证入口。

运行：
    python -m unittest discover -s tests -v
"""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from cutlab import barcode, cut, media, sample, timemap  # noqa: E402


class BarcodeTest(unittest.TestCase):
    def test_bit_layout_roundtrip(self):
        for idx in (0, 1, 29, 30, 75, 239, 1023, barcode.MAX_FRAME):
            bits = barcode.encode_bits(idx)
            self.assertEqual(bits[:4], [1, 0, 1, 0])
            self.assertEqual(len(bits), barcode.N_CELLS)
            data = 0
            for bit in bits[4:16]:
                data = (data << 1) | bit
            self.assertEqual(data, idx)

    def test_checksum_catches_bit_flip(self):
        self.assertNotEqual(barcode.checksum(75), barcode.checksum(75 ^ 1))

    def test_rejects_out_of_range(self):
        with self.assertRaises(ValueError):
            barcode.encode_bits(barcode.MAX_FRAME + 1)


class SampleTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._dir = tempfile.TemporaryDirectory(prefix="cutlab-test-")
        cls.workdir = Path(cls._dir.name)
        cls.manifest = sample.ensure_sample(cls.workdir)
        cls.offset_manifest = sample.ensure_sample(
            cls.workdir, offset=12.5, audio_lead=0.5)
        cls.info = media.probe(cls.manifest["path"])
        cls.offset_info = media.probe(cls.offset_manifest["path"])

    @classmethod
    def tearDownClass(cls):
        cls._dir.cleanup()

    def test_keyframes_are_regular(self):
        self.assertEqual(self.info.fps_exact, True)
        frames = [kf.frame_index for kf in self.info.keyframes]
        self.assertEqual(frames, [i * 30 for i in range(8)])
        for kf in self.info.keyframes[1:]:
            self.assertEqual(kf.gop_frames, 30)
            self.assertAlmostEqual(kf.gop_seconds, 1.0, places=3)

    def test_keyframe_time_matches_real_pts(self):
        for kf in self.info.keyframes:
            self.assertAlmostEqual(kf.pts, kf.content_time, places=4)
            self.assertAlmostEqual(kf.content_time, kf.frame_index / self.info.fps,
                                   places=3)

    def test_offset_file_origin(self):
        self.assertGreater(self.offset_info.content_origin, 10.0)
        self.assertAlmostEqual(self.offset_info.content_origin, 12.5, places=3)
        self.assertLess(self.offset_info.format_start, self.offset_info.content_origin)
        # 音轨比画面提前约 0.5s
        lead = self.offset_info.video_start - (self.offset_info.audio_start or 0)
        self.assertGreater(lead, 0.4)

    def test_frame_time_and_key_flag(self):
        self.assertAlmostEqual(self.info.frame_time(75), 2.5, places=3)
        self.assertFalse(self.info.frame_is_key(75))
        self.assertTrue(self.info.frame_is_key(90))


class CutTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._dir = tempfile.TemporaryDirectory(prefix="cutlab-cut-")
        cls.workdir = Path(cls._dir.name)
        cls.manifest = sample.ensure_sample(cls.workdir)
        cls.info = media.probe(cls.manifest["path"])

    @classmethod
    def tearDownClass(cls):
        cls._dir.cleanup()

    def _run(self, reencode: bool, container: str = "mp4"):
        req = cut.CutRequest(source=self.info, start=2.5, end=4.0,
                             container=container, reencode=reencode)
        suffix = "reenc" if reencode else "copy"
        out = cut.run_cut(req, self.workdir / f"{suffix}.{container}")
        return cut.predict(req), out

    def test_reencode_lands_on_requested_frame(self):
        pred, out = self._run(True)
        self.assertEqual(out.first_frame_index, pred.start_frame_index)
        self.assertAlmostEqual(out.video.duration, 1.5, places=2)
        self.assertEqual(out.video.frames, 45)
        self.assertTrue(out.video.first_key)

    def test_copy_starts_at_requested_frame_in_mp4(self):
        pred, out = self._run(False)
        self.assertEqual(out.first_frame_index, pred.start_frame_index)

    def test_copy_mp4_carries_extra_declared_frames(self):
        pred, out = self._run(False)
        self.assertGreater(out.video.frames, pred.expected_frames)
        report = cut.compare(pred, out, None)
        labels = {d.label: d for d in report}
        self.assertIn("直接截取 · 视频帧数", labels)
        self.assertEqual(labels["直接截取 · 视频帧数"].severity, "warn")

    def test_copy_mkv_falls_back_to_previous_keyframe(self):
        pred, out = self._run(False, "mkv")
        self.assertLess(out.first_frame_index, pred.start_frame_index)
        report = cut.compare(pred, out, None)
        labels = {d.label: d for d in report}
        self.assertEqual(labels["直接截取 · 首帧身份"].severity, "bad")

    def test_copy_at_keyframe_is_exact(self):
        req = cut.CutRequest(source=self.info, start=2.0, end=3.0,
                             container="mp4", reencode=False)
        out = cut.run_cut(req, self.workdir / "exact.mp4")
        self.assertEqual(out.first_frame_index, 60)


class TimeMapTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._dir = tempfile.TemporaryDirectory(prefix="cutlab-time-")
        cls.workdir = Path(cls._dir.name)
        manifest = sample.ensure_sample(cls.workdir, offset=12.5, audio_lead=0.5)
        cls.info = media.probe(manifest["path"])

    @classmethod
    def tearDownClass(cls):
        cls._dir.cleanup()

    def test_absolute_seek_hits_expected_frame(self):
        report = timemap.demonstrate(self.info, 2.0, self.workdir / "tm")
        self.assertTrue(report.absolute.ok)
        self.assertEqual(report.absolute.first_frame, report.expected_frame)

    def test_relative_seek_drifts_on_nonzero_origin(self):
        report = timemap.demonstrate(self.info, 2.0, self.workdir / "tm")
        self.assertTrue(report.naive_is_wrong)
        self.assertNotEqual(report.naive.first_frame, report.expected_frame)


class VerifyTest(unittest.TestCase):
    def test_verify_passes(self):
        from cutlab import verify
        with tempfile.TemporaryDirectory(prefix="cutlab-verify-test-") as tmp:
            report = verify.run(tmp)
            failed = [c.name for c in report.checks if not c.ok]
            self.assertTrue(report.ok, f"失败项: {failed}")


if __name__ == "__main__":
    unittest.main()
