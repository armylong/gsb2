"""端到端测试: 实际 FFV1 产物 + 实际像素断言 (需要本机 ffmpeg)。"""

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import numpy as np

from chromasubsample import ffmpeg_tools as ff
from chromasubsample.analysis import measure_region, extract_profile
from chromasubsample.color import MODES, PIXEL_FORMATS, plane_dims
from chromasubsample.pipeline import generate_synthetic, build_from_input

FFMPEG_AVAILABLE = shutil.which("ffmpeg") is not None and shutil.which("ffprobe") is not None


@unittest.skipUnless(FFMPEG_AVAILABLE, "未安装 ffmpeg/ffprobe")
class TestSyntheticPipeline(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="chromatest_"))
        cls.project = generate_synthetic(workdir=cls.tmp, width=320, height=240,
                                         frame_count=15, fps=30)

    def test_probe_actual_pixel_formats(self):
        for mode in MODES:
            v = self.project.variants[mode]
            self.assertEqual(v.probe.actual["pix_fmt"], PIXEL_FORMATS[mode],
                             msg=f"{mode} 实际格式与预期不符: {v.probe.warnings}")
            self.assertEqual(v.probe.actual["codec_name"], "ffv1")
            self.assertEqual(v.probe.actual["color_range"], "tv")
            self.assertEqual(v.probe.actual["color_space"], "bt709")
            self.assertTrue(v.probe.ok, msg=str(v.probe.warnings))

    def test_actual_plane_sizes_match_mode(self):
        p = self.project
        for mode in MODES:
            cw, ch = plane_dims(mode, p.width, p.height)
            v = p.variants[mode]
            self.assertEqual((v.chroma_width, v.chroma_height), (cw, ch))
            # 从实际回读文件取一帧, 形状必须与声明一致
            y, cb, cr = p.get_planes(0, mode)
            self.assertEqual(y.shape, (p.height, p.width))
            self.assertEqual(cb.shape, (ch, cw))
            self.assertEqual(cr.shape, (ch, cw))

    def test_verified_raw_byte_identical_to_generated(self):
        for mode in MODES:
            v = self.project.variants[mode]
            self.assertEqual(v.raw_path.read_bytes(),
                             v.verified_raw_path.read_bytes())

    def test_luma_identical_across_modes(self):
        p = self.project
        ref_y, _, _ = p.get_planes(0, "444")
        for mode in ("422", "420"):
            y, _, _ = p.get_planes(0, mode)
            np.testing.assert_array_equal(y, ref_y)

    def test_422_horizontal_only_reduction(self):
        """4:2:2 色度只在水平方向取偶数列, 竖直方向逐行保留。"""
        p = self.project
        _, cb_ref, _ = p.get_planes(0, "444")
        _, cb422, _ = p.get_planes(0, "422")
        self.assertEqual(cb422.shape[0], p.height)            # 行数不变
        self.assertEqual(cb422.shape[1], p.width // 2)
        np.testing.assert_array_equal(cb422, cb_ref[:, 0::2])

    def test_420_reduces_both_directions(self):
        """4:2:0 色度两个方向都取偶数样本, 且重建后相邻行/列共享。"""
        p = self.project
        _, cb_ref, _ = p.get_planes(0, "444")
        _, cb420, _ = p.get_planes(0, "420")
        self.assertEqual(cb420.shape, (p.height // 2, p.width // 2))
        np.testing.assert_array_equal(cb420, cb_ref[0::2, 0::2])
        # 4:2:2 与 4:2:0 的色度平面不能是同一张缩略图换标签
        _, cb422, _ = p.get_planes(0, "422")
        self.assertNotEqual(cb420.shape, cb422.shape)

    def test_chroma_error_zero_in_neutral_region_and_nonzero_on_color_lines(self):
        from chromasubsample.pattern import neutral_patch_rect
        p = self.project
        # 受保护的纯中性基准块: 所有模式色度误差为 0
        x0, y0, x1, y1 = neutral_patch_rect(p.width, p.height)
        stats = measure_region(p, 0, "420", x0, y0, x1, y1)
        self.assertEqual(stats.cb_mae, 0.0)
        self.assertEqual(stats.cr_mae, 0.0)
        self.assertTrue(stats.y_identical)

        # 运动品红线扫过区域的整条宽度上, 420/422 必然出现非零色度误差
        found_422 = found_420 = False
        for f in range(p.frame_count):
            s22 = measure_region(p, f, "422", 0, 20, p.width, 24)
            s20 = measure_region(p, f, "420", 0, 20, p.width, 24)
            found_422 |= s22.cb_mae + s22.cr_mae > 0
            found_420 |= s20.cb_mae + s20.cr_mae > 0
        self.assertTrue(found_422)
        self.assertTrue(found_420)
        # 4:4:4 对自己的误差恒为 0
        s444 = measure_region(p, 0, "444", 0, 0, p.width, p.height)
        self.assertEqual(s444.cb_mae, 0.0)
        self.assertEqual(s444.cr_mae, 0.0)

    def test_profile_uses_full_resolution_and_reports_error(self):
        p = self.project
        prof = extract_profile(p, 0, "h", 30)
        self.assertEqual(len(prof.axis), p.width)              # 重建后同尺寸
        np.testing.assert_array_equal(prof.data["444"]["Cb_err"],
                                      np.zeros(p.width, dtype=np.int16))
        self.assertEqual(prof.data["420"]["Cb_err"].shape, (p.width,))

    def test_frame_count_and_timing_consistent(self):
        p = self.project
        self.assertEqual(len(p.frame_times), p.frame_count)
        np.testing.assert_allclose(p.frame_times,
                                   np.arange(p.frame_count) / p.fps)
        for mode in MODES:
            meta = ff.ffprobe_json(p.variants[mode].video_path, count_frames=True)
            st = ff.first_video_stream(meta)
            self.assertEqual(int(st.get("nb_frames") or st.get("nb_read_frames")),
                             p.frame_count)

    def test_export_and_reverify(self):
        out = self.tmp / "export"
        paths = self.project.export(out)
        self.assertEqual(set(paths), set(MODES))
        for mode, path in paths.items():
            res = ff.verify_export(
                path, mode, p_width := self.project.width, self.project.height,
                self.project.frame_count, self.project.fps_fraction,
                self.project.duration(),
            )
            self.assertTrue(res.ok, msg=str(res.warnings))


@unittest.skipUnless(FFMPEG_AVAILABLE, "未安装 ffmpeg/ffprobe")
class TestExternalInput(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix="chromain_"))

    def _make(self, name: str, size: str, duration: float, fps: int = 30,
              pix_fmt: str = "yuv420p") -> Path:
        out = self.tmp / name
        subprocess.run([
            "ffmpeg", "-nostdin", "-y", "-v", "error",
            "-f", "lavfi", "-i", f"testsrc2=size={size}:rate={fps}:duration={duration}",
            "-pix_fmt", pix_fmt, "-c:v", "ffv1", str(out),
        ], check=True)
        return out

    def test_valid_input_builds_three_variants(self):
        src = self._make("ok.mkv", "640x480", 2.0)
        proj = build_from_input(src, workdir=self.tmp / "proj_ok")
        self.assertEqual(proj.frame_count, 60)
        for mode in MODES:
            self.assertTrue(proj.variants[mode].probe.ok)

    def test_odd_dimensions_cropped_to_even(self):
        src = self._make("odd.mkv", "641x479", 1.0)
        info = ff.validate_input(src)
        self.assertEqual((info.even_width, info.even_height), (640, 478))
        proj = build_from_input(src, workdir=self.tmp / "proj_odd")
        self.assertEqual((proj.width, proj.height), (640, 478))

    def test_too_long_rejected(self):
        src = self._make("long.mkv", "320x240", 6.0)
        with self.assertRaises(ff.FFmpegError):
            ff.validate_input(src)

    def test_too_tall_rejected(self):
        src = self._make("tall.mkv", "1280x720", 1.0)
        # 720p 本身允许
        self.assertTrue(ff.validate_input(src).height == 720)
        big = self._make("big.mkv", "1920x1080", 1.0)
        with self.assertRaises(ff.FFmpegError):
            ff.validate_input(big)

    def test_10bit_rejected(self):
        src = self._make("10bit.mkv", "320x240", 1.0, pix_fmt="yuv420p10le")
        with self.assertRaises(ff.FFmpegError):
            ff.validate_input(src)


if __name__ == "__main__":
    unittest.main()
