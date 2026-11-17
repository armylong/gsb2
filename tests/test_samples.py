"""程序化样例测试：生成结果可被解析、缺陷类型齐全、PNG 文件合法。"""

import os
import struct
import sys
import tempfile
import unittest
import zlib

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from uvcheck.analyzer import analyze  # noqa: E402
from uvcheck.parser import parse_obj_file  # noqa: E402
from uvcheck.samples import generate_samples, build_box_obj, build_broken_obj  # noqa: E402


class TestSamples(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="uvcheck_samples_")
        cls.paths = generate_samples(cls.tmp)

    def test_all_files_created(self):
        for name, path in self.paths.items():
            self.assertTrue(os.path.isfile(path), name)
            self.assertGreater(os.path.getsize(path), 0)

    def test_box_sample_contains_every_defect(self):
        parsed = parse_obj_file(self.paths["sample_box.obj"])
        self.assertGreaterEqual(len(parsed.triangles), 12)  # 立方体 12 个 + 演示面
        self.assertEqual(parsed.error_count, 0)
        report = analyze(parsed)
        kinds = {i["type"] for i in report["issues"]}
        # 样例刻意覆盖：越界、重叠、拉伸、UV 退化、缺 UV
        self.assertIn("out_of_range", kinds)
        self.assertIn("overlap", kinds)
        self.assertIn("stretch", kinds)
        self.assertIn("uv_degenerate", kinds)
        self.assertIn("missing_uv", kinds)

    def test_box_cube_faces_are_clean(self):
        # 前 12 个三角面是规则立方体，不应有任何问题（防止样例本身误报）
        parsed = parse_obj_file(self.paths["sample_box.obj"])
        report = analyze(parsed)
        bad = set()
        for issue in report["issues"]:
            bad.update(f for f in issue["face_ids"] if f < 12)
        self.assertEqual(bad, set(), f"立方体部分不应有问题，实际涉及面 {sorted(bad)}")

    def test_broken_sample_partially_recoverable(self):
        parsed = parse_obj_file(self.paths["sample_broken.obj"])
        # 坏数据被报告
        self.assertGreater(parsed.error_count, 0)
        # 但好面仍然保留并可检查
        self.assertGreaterEqual(len(parsed.triangles), 2)
        report = analyze(parsed)
        self.assertIn("missing_uv", [i["type"] for i in report["issues"]])
        # 每条消息都带行号或文件级标记
        for m in parsed.messages:
            self.assertIn("level", m)
            self.assertIsInstance(m["line"], int)

    def test_in_memory_builders(self):
        self.assertIn("v ", build_box_obj())
        self.assertIn("not_a_number", build_broken_obj())

    def test_png_is_valid(self):
        with open(self.paths["sample_texture.png"], "rb") as fh:
            data = fh.read()
        # PNG 魔数
        self.assertEqual(data[:8], b"\x89PNG\r\n\x1a\n")
        # IHDR
        length = struct.unpack(">I", data[8:12])[0]
        self.assertEqual(data[12:16], b"IHDR")
        width, height, bit, color = struct.unpack(">IIBB", data[16:26])
        self.assertEqual((width, height), (256, 256))
        self.assertEqual(bit, 8)
        self.assertEqual(color, 6)  # RGBA
        # IEND 存在且所有 chunk CRC 合法
        self.assertIn(b"IEND", data)
        offset = 8
        while offset < len(data):
            length = struct.unpack(">I", data[offset:offset + 4])[0]
            tag = data[offset + 4:offset + 8]
            chunk = data[offset + 4:offset + 8 + length]
            crc = struct.unpack(">I", data[offset + 8 + length:offset + 12 + length])[0]
            self.assertEqual(zlib.crc32(chunk) & 0xFFFFFFFF, crc, tag)
            offset += 12 + length


if __name__ == "__main__":
    unittest.main()
