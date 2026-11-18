"""验证 3: 读取真实导出帧的像素, 核对运动位置与双倍节奏。

双倍去隔行必须保留两个场各自的运动瞬间, 相邻输出帧的细线位置应按场速度
推进; 若只是把单倍输出帧复制一遍, 相邻帧位置会停滞, 本测试会失败。
"""
from __future__ import annotations

import subprocess
from pathlib import Path

from ._base import SampleTestCase
from deinterlace_lab.ffmpeg_tools import export_deinterlaced, find_executable


def extract_pngs(video: Path, out_dir: Path) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    pat = out_dir / "f_%03d.png"
    cmd = [
        find_executable("ffmpeg"), "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(video), "-fps_mode", "passthrough", str(pat),
    ]
    subprocess.run(cmd, check=True, capture_output=True, text=True)
    return sorted(out_dir.glob("f_*.png"))


class TestMotionAndFieldContent(SampleTestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.single_dst = Path(cls.tmp) / "motion_single.mp4"
        cls.double_dst = Path(cls.tmp) / "motion_double.mp4"
        export_deinterlaced(cls.paths["tff"], cls.single_dst, "single", "tff")
        export_deinterlaced(cls.paths["tff"], cls.double_dst, "double", "tff")
        cls.single_frames = extract_pngs(cls.single_dst, Path(cls.tmp) / "s")
        cls.double_frames = extract_pngs(cls.double_dst, Path(cls.tmp) / "d")

    def test_double_has_twice_as_many_real_frames(self):
        self.assertEqual(len(self.single_frames), self.spec.n_fields // 2)
        self.assertAlmostEqual(
            len(self.double_frames), self.spec.n_fields, delta=1
        )

    def test_double_frames_advance_every_field(self):
        # 双倍前若干帧: 细线 x 应随场时间单调推进 (绕回前), 不会两两停滞。
        xs = [self.yellow_line_x(self.load(f)) for f in self.double_frames[:10]]
        moves = [xs[i + 1] - xs[i] for i in range(len(xs) - 1)]
        # 样例线速度 4px/场, 容差给像素量化误差。
        positive = [m for m in moves if m > 0]
        self.assertGreater(len(positive), len(moves) * 0.8)
        for m in positive:
            self.assertAlmostEqual(m, self.spec.line_speed_px_per_field, delta=1.5)
        # 关键反例: 不允许连续两帧位置完全相同 (那是复制单倍帧的特征)。
        self.assertFalse(any(abs(m) < 0.01 for m in moves))

    def test_double_motion_matches_field_timeline(self):
        # 双倍第 k 帧对应第 k 个场, 其线位置应与逐行参考同一时间点一致。
        ref_frames = extract_pngs(self.paths["progressive"],
                                  Path(self.tmp) / "ref")
        for k in (1, 3, 5):
            ref_x = self.yellow_line_x(self.load(ref_frames[k]))
            out_x = self.yellow_line_x(self.load(self.double_frames[k]))
            self.assertAlmostEqual(ref_x, out_x, delta=2.0,
                                   msg=f"场 {k} 运动位置与逐行参考不符")

    def test_deinterlaced_frames_have_no_comb(self):
        # 去隔行后相邻行不应再出现明显行间梳齿。
        img = self.load(self.single_frames[3])
        self.assertFalse(self.row_is_interlaced(img),
                         "单倍成品仍检测到梳齿")
