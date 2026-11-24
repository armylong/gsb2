"""导出包的时间/尺寸/指纹可核对性测试（不依赖 Qt）。"""
from __future__ import annotations

import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

from rolling_shutter.export import export_clip, verify_export, write_png, _read_png
from rolling_shutter.model import MODE_ROLLING, render_clip
from rolling_shutter.presets import PRESET_FLASH, get_preset

import numpy as np


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.out = Path(self.tmp.name) / "clip.zip"
        self.clip = render_clip(get_preset(PRESET_FLASH), MODE_ROLLING)

    def tearDown(self):
        self.tmp.cleanup()

    def test_png_roundtrip_dimensions(self):
        png = write_png(self.clip.frames[0])
        w, h = _read_png(io.BytesIO(png))
        self.assertEqual((w, h),
                         (self.clip.params.width, self.clip.params.height))

    def test_export_and_verify_all_checks_pass(self):
        export_clip(self.clip, self.out)
        report = verify_export(self.out)
        self.assertTrue(report["ok"], msg=json.dumps(report, ensure_ascii=False))
        with zipfile.ZipFile(self.out) as zf:
            manifest = json.loads(zf.read("manifest.json"))
            self.assertEqual(manifest["image"]["width_px"],
                             self.clip.params.width)
            self.assertEqual(manifest["image"]["height_px"],
                             self.clip.params.height)
            self.assertEqual(manifest["image"]["n_png_frames"],
                             self.clip.n_frames)
            # 时间可核对：帧周期、总时长、曝光
            t = manifest["timing"]
            self.assertAlmostEqual(t["frame_period_s"],
                                   1 / self.clip.params.fps)
            self.assertAlmostEqual(
                t["clip_duration_s"],
                self.clip.n_frames / self.clip.params.fps)
            self.assertEqual(len(t["frame_start_times_s"]),
                             self.clip.n_frames)
            # 每行曝光窗写在 csv 里，行数 = 帧数 * 行高
            csv_lines = zf.read("row_windows.csv").decode().splitlines()
            self.assertEqual(len(csv_lines) - 1,
                             self.clip.n_frames * self.clip.params.height)

    def test_verify_detects_tampered_manifest(self):
        export_clip(self.clip, self.out)
        # 篡改 manifest 中的尺寸字段 -> 校验必须失败
        import shutil
        bad = Path(self.tmp.name) / "bad.zip"
        with zipfile.ZipFile(self.out) as zin, zipfile.ZipFile(
                bad, "w", zipfile.ZIP_DEFLATED) as zout:
            for item in zin.infolist():
                data = zin.read(item.filename)
                if item.filename == "manifest.json":
                    m = json.loads(data)
                    m["image"]["width_px"] += 1
                    data = json.dumps(m).encode()
                zout.writestr(item, data)
        report = verify_export(bad)
        self.assertFalse(report["ok"])

    def test_presets_are_reproducible(self):
        a = render_clip(get_preset(PRESET_FLASH), MODE_ROLLING)
        b = render_clip(get_preset(PRESET_FLASH), MODE_ROLLING)
        np.testing.assert_array_equal(a.frames, b.frames)
        self.assertEqual(a.signature, b.signature)


if __name__ == "__main__":
    unittest.main()
