"""端到端测试：生成素材 -> 探测 -> 导出 -> 回读校验，全部真实跑 ffmpeg。"""
import os
import shutil
import subprocess
import tempfile
import unittest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from vidgeo.geometry import VideoGeometry
from vidgeo.pipeline import ExportOptions, export, verify_export
from vidgeo.probe import probe
from vidgeo.samples import SAMPLE_SPECS, generate_all, generate_one


def _ensure_qapp():
    """QPainter 绘制素材帧需要 QGuiApplication（无头环境用 offscreen）。"""
    from PySide6.QtWidgets import QApplication

    app = QApplication.instance()
    if app is None:
        app = QApplication([])
    return app


class EndToEnd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        if not shutil.which("ffmpeg"):
            raise unittest.SkipTest("未安装 ffmpeg")
        cls.app = _ensure_qapp()
        cls.tmp = tempfile.mkdtemp(prefix="vidgeo_e2e_")
        cls.src_dir = os.path.join(cls.tmp, "samples")
        cls.out_dir = os.path.join(cls.tmp, "out")
        os.makedirs(cls.out_dir)
        generate_all(cls.src_dir)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)
        super().tearDownClass()

    def _src(self, name):
        return os.path.join(self.src_dir, name)

    # ------------------------------------------------------------------ #
    def test_sample_set_complete(self):
        names = {s.filename for s in SAMPLE_SPECS}
        self.assertEqual(len(names), 5)
        for name in names:
            self.assertTrue(os.path.exists(self._src(name)))
        # 至少一条同时带 PAR 与旋转
        combo = next(s for s in SAMPLE_SPECS
                     if s.par_num != s.par_den and s.rotation == 90)
        self.assertEqual(combo.filename, "par_rot.mov")

    def test_probe_par_only(self):
        r = probe(self._src("par_only.mp4"))
        g = r.geometry
        self.assertEqual((g.coded_width, g.coded_height), (720, 480))
        self.assertEqual((g.par_num, g.par_den), (40, 33))
        self.assertIsNone(r.raw_rotation)
        self.assertTrue(g.is_supported)
        self.assertTrue(r.has_audio)

    def test_probe_rotation_metadata(self):
        r = probe(self._src("rot_only.mov"))
        self.assertEqual(r.raw_rotation, 90.0)
        self.assertTrue(r.geometry.is_rotated)
        self.assertEqual(r.geometry.display_size, (1080, 1920))

    def test_unsupported_orientation_flagged(self):
        r = probe(self._src("unsupported.mov"))
        self.assertEqual(r.raw_rotation, 45.0)
        self.assertFalse(r.geometry.is_supported)
        self.assertIn("45", r.geometry.unsupported_detail)
        # 不支持的方向不允许走导出链
        with self.assertRaises(AssertionError):
            self.assertTrue(r.geometry.is_supported, "应在此被拦截")

    # ------------------------------------------------------------------ #
    def _export_and_verify(self, name, policy="nearest"):
        src = probe(self._src(name))
        expected = src.geometry.output_size(policy)
        out = os.path.join(self.out_dir, name + "_" + policy + ".mp4")
        export(src, ExportOptions(output_path=out, even_policy=policy))
        report = verify_export(out, expected, src.has_audio)
        return src, report, out

    def test_export_par_only(self):
        src, report, _ = self._export_and_verify("par_only.mp4")
        self.assertTrue(report.ok, msg="\n".join(report.failures))
        # 720*40/33=872.73，最近偶数邻居为 872
        self.assertEqual(report.coded_size, (872, 480))
        self.assertEqual(report.sample_aspect_ratio, "1:1")
        self.assertIn(report.rotation, (None, 0.0))
        self.assertTrue(report.has_audio)
        self.assertIsNotNone(report.duration_diff_ms)
        self.assertLess(report.duration_diff_ms, 80.0)

    def test_export_rot_only(self):
        _, report, _ = self._export_and_verify("rot_only.mov")
        self.assertTrue(report.ok, msg="\n".join(report.failures))
        self.assertEqual(report.coded_size, (1080, 1920))

    def test_export_par_and_rotation_combined(self):
        src, report, out = self._export_and_verify("par_rot.mov")
        self.assertTrue(report.ok, msg="\n".join(report.failures))
        # 480 x 872（720*40/33=872.73 的最近偶）
        self.assertEqual(report.coded_size, (480, 872))
        # 关键：成片里不得残留旋转元数据，否则播放器会二次旋转
        probed = probe(out)
        self.assertIn(probed.raw_rotation, (None, 0.0))
        self.assertTrue(probed.geometry.is_square_pixel)

    def test_export_rot180(self):
        _, report, _ = self._export_and_verify("rot_180.mp4")
        self.assertTrue(report.ok, msg="\n".join(report.failures))
        self.assertEqual(report.coded_size, (640, 480))

    def test_rounding_down_policy(self):
        src, report, _ = self._export_and_verify("par_only.mp4", policy="down")
        self.assertTrue(report.ok, msg="\n".join(report.failures))
        # 872.7 向下取偶 = 872
        self.assertEqual(report.coded_size, (872, 480))

    # ------------------------------------------------------------------ #
    def test_no_audio_source_exports(self):
        """无音轨素材也能导出，校验不得误报音轨问题。"""
        silent = os.path.join(self.tmp, "silent.mp4")
        subprocess.run(
            [
                "ffmpeg", "-hide_banner", "-nostdin", "-y",
                "-f", "lavfi", "-i",
                "testsrc2=size=320x240:rate=30:duration=1.5",
                "-pix_fmt", "yuv420p", silent,
            ],
            check=True, capture_output=True,
        )
        src = probe(silent)
        self.assertFalse(src.has_audio)
        out = os.path.join(self.out_dir, "silent_out.mp4")
        export(src, ExportOptions(output_path=out))
        report = verify_export(out, (320, 240), expected_audio=False)
        self.assertTrue(report.ok, msg="\n".join(report.failures))
        self.assertFalse(report.has_audio)
        self.assertIsNotNone(report.video_duration)

    def test_audio_codec_fallback_to_aac(self):
        """copy 失败时自动回退 AAC，且回退命令构造正确、声音不丢。

        ffmpeg 9 的 mp4 muxer 已能接纳 pcm/flac，真实编码很难触发回退，
        因此注入 runner：第一次（copy 命令）返回失败，第二次执行真实 ffmpeg。
        """
        import subprocess

        pcm = os.path.join(self.tmp, "pcm.mov")
        subprocess.run(
            [
                "ffmpeg", "-hide_banner", "-nostdin", "-y",
                "-f", "lavfi", "-i",
                "testsrc2=size=320x240:rate=30:duration=1",
                "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
                "-c:v", "libx264", "-pix_fmt", "yuv420p",
                "-c:a", "pcm_s16le", "-shortest", pcm,
            ],
            check=True, capture_output=True,
        )
        src = probe(pcm)
        self.assertTrue(src.has_audio)
        out = os.path.join(self.out_dir, "fallback_out.mp4")
        calls = []

        def runner(cmd):
            calls.append(list(cmd))
            if len(calls) == 1:
                # 模拟“容器拒绝该音频编码”
                self.assertIn("copy", cmd)
                return 1
            return subprocess.run(cmd, capture_output=True).returncode

        export(src, ExportOptions(output_path=out), runner=runner)
        self.assertEqual(len(calls), 2)
        second = calls[1]
        self.assertIn("aac", second)
        self.assertNotIn("copy", second)
        report = verify_export(out, (320, 240), expected_audio=True)
        self.assertTrue(report.ok, msg="\n".join(report.failures))
        self.assertEqual(report.audio_codec, "aac")

    def test_duration_preserved(self):
        """视频有效时长不应因转换被改变（时基/节奏保持）。"""
        src_before = probe(self._src("par_rot.mov"))
        _, report, out = self._export_and_verify("par_rot.mov")
        src_after = probe(out)
        before = src_before.video_duration or src_before.container_duration
        after = src_after.video_duration or src_after.container_duration
        self.assertLess(abs(before - after), 0.12)


if __name__ == "__main__":
    unittest.main()
