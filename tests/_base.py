"""测试共享工具: 在临时目录生成小尺寸样例并提供图像/几何分析。"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from PySide6.QtGui import QGuiApplication, QImage  # noqa: E402

_SRC = Path(__file__).resolve().parents[1] / "src"
if str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

from deinterlace_lab.ffmpeg_tools import (  # noqa: E402
    export_deinterlaced,
    probe_media,
    read_exported_pts,
)
from deinterlace_lab.sample_maker import SampleSpec, generate_sample  # noqa: E402

# 这些名字被各测试模块通过 `from ._base import ...` 复用, 显式声明为再导出。
__all__ = [
    "SampleTestCase", "SampleSpec", "generate_sample",
    "export_deinterlaced", "probe_media", "read_exported_pts",
]

_APP = QGuiApplication.instance() or QGuiApplication([])


def small_spec() -> SampleSpec:
    # 1 秒、50 个场 -> 25 个交错输入帧, 跑得很快但足以验证节奏。
    return SampleSpec(width=320, height=240, field_rate=50, duration=1.0,
                      line_speed_px_per_field=4.0, line_width=3)


class SampleTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="dlab_test_")
        cls.paths = generate_sample(cls.tmp, small_spec(), log=lambda *_: None)
        cls.spec = small_spec()

    # ---- 图像分析 ----
    @staticmethod
    def load(path: str | Path) -> QImage:
        img = QImage(str(path))
        assert not img.isNull(), f"无法加载 {path}"
        return img.convertToFormat(QImage.Format.Format_RGB888)

    @staticmethod
    def yellow_line_x(img: QImage, y: int | None = None) -> float:
        """返回黄色移动竖线的平均 x 坐标 (按亮黄像素)。

        阈值对 H.264 压缩 + yadif 后的颜色漂移留有余量: 强红黄、强绿、
        且蓝明显低于红。
        """
        if y is None:
            y = img.height() // 2
        xs = []
        for x in range(img.width()):
            c = img.pixelColor(x, y)
            if c.red() > 180 and c.green() > 150 and c.blue() < c.red() - 35:
                xs.append(x)
        if not xs:
            raise AssertionError("该行未找到黄色细线")
        return sum(xs) / len(xs)

    @staticmethod
    def row_is_interlaced(img: QImage) -> bool:
        """检测相邻行是否呈现交错梳齿 (亮度行间差异显著)。"""
        gray = img.convertToFormat(QImage.Format.Format_Grayscale8)
        diffs = []
        y = gray.height() // 2
        for row in (y, y + 1, y + 2):
            vals = [gray.pixelColor(x, row).red() for x in range(0, gray.width(), 5)]
            diffs.append(sum(vals) / len(vals))
        return max(diffs) - min(diffs) > 8

    def export(self, mode: str, parity: str) -> Path:
        src = self.paths["tff"]
        dst = Path(self.tmp) / f"out_{mode}_{parity}.mp4"
        export_deinterlaced(src, dst, mode, parity)
        return dst
