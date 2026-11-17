"""OBJ 解析器测试：正常语法、负索引、多边形、容错与缺 UV 标记。"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from uvcheck.parser import parse_obj, parse_obj_file  # noqa: E402


class TestParserBasic(unittest.TestCase):
    def test_triangle_with_uv(self):
        text = (
            "v 0 0 0\nv 1 0 0\nv 1 1 0\n"
            "vt 0 0\nvt 1 0\nvt 1 1\n"
            "f 1/1 2/2 3/3\n"
        )
        r = parse_obj(text, "t.obj")
        self.assertEqual(len(r.vertices), 3)
        self.assertEqual(len(r.uvs), 3)
        self.assertEqual(len(r.triangles), 1)
        tri = r.triangles[0]
        self.assertEqual(tri.verts, [0, 1, 2])
        self.assertEqual(tri.uvs, [0, 1, 2])
        self.assertEqual(tri.id, 0)
        self.assertEqual(r.error_count, 0)

    def test_four_vertex_formats(self):
        text = (
            "v 0 0 0\nv 1 0 0\nv 1 1 0\nvn 0 0 1\n"
            "vt 0 0\nvt 1 0\nvt 1 1\n"
            "f 1 2 3\n"
            "f 1/1 2/2 3/3\n"
            "f 1//1 2//1 3//1\n"
            "f 1/1/1 2/2/1 3/3/1\n"
        )
        r = parse_obj(text)
        self.assertEqual(len(r.triangles), 4)
        self.assertIsNone(r.triangles[0].uvs)            # v
        self.assertEqual(r.triangles[1].uvs, [0, 1, 2])  # v/vt
        self.assertIsNone(r.triangles[2].uvs)            # v//vn
        self.assertEqual(r.triangles[3].uvs, [0, 1, 2])  # v/vt/vn
        self.assertEqual(r.triangles[3].normals, [0, 0, 0])

    def test_negative_indices(self):
        text = (
            "v 0 0 0\nv 1 0 0\nv 1 1 0\n"
            "vt 0 0\nvt 1 0\nvt 1 1\n"
            "f -3/-3 -2/-2 -1/-1\n"
        )
        r = parse_obj(text)
        self.assertEqual(r.triangles[0].verts, [0, 1, 2])
        self.assertEqual(r.triangles[0].uvs, [0, 1, 2])

    def test_polygon_fan_triangulation(self):
        # 四边形扇形 -> 2 个三角形，编号连续且来源面相同
        text = (
            "v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\n"
            "vt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\n"
            "f 1/1 2/2 3/3 4/4\n"
        )
        r = parse_obj(text)
        self.assertEqual(len(r.triangles), 2)
        self.assertEqual(r.triangles[0].verts, [0, 1, 2])
        self.assertEqual(r.triangles[1].verts, [0, 2, 3])
        self.assertEqual(r.triangles[0].source_face, r.triangles[1].source_face)
        self.assertEqual([t.id for t in r.triangles], [0, 1])

    def test_continuation_line(self):
        # OBJ 续行：反斜杠把下一行拼接到当前逻辑行 -> 等价于 "v 1 0 0"
        text = "v 0 0 0\nv \\\n1 0 0\nv 1 1 0\nf 1 2 3\n"
        r = parse_obj(text)
        self.assertEqual(len(r.vertices), 3)
        self.assertEqual(r.vertices[1], (1.0, 0.0, 0.0))
        self.assertEqual(len(r.triangles), 1)


class TestParserErrors(unittest.TestCase):
    def test_bad_vertex_line_skipped(self):
        # 坏顶点被丢弃且记录错误；其后的好顶点、好面仍可正常解析
        text = ("v 0 0 0\nv 1 not_a_number 0\nv 1 1 0\nv 0 1 0\n"
                "f 1 2 3\n")
        r = parse_obj(text)
        self.assertEqual(len(r.vertices), 3)
        self.assertEqual(len(r.triangles), 1)
        self.assertEqual(r.triangles[0].verts, [0, 1, 2])
        self.assertTrue(any(m["level"] == "error" for m in r.messages))

    def test_nan_rejected(self):
        text = "v 0 0 0\nv inf 0 0\nv 1 1 0\nf 1 2 3\n"
        r = parse_obj(text)
        self.assertEqual(len(r.vertices), 2)

    def test_index_out_of_range_skips_face(self):
        text = (
            "v 0 0 0\nv 1 0 0\nv 1 1 0\n"
            "vt 0 0\nvt 1 0\nvt 1 1\n"
            "f 1/1 2/2 99/3\nf 1/1 2/2 3/3\n"
        )
        r = parse_obj(text)
        self.assertEqual(len(r.triangles), 1)  # 坏面跳过，好面保留
        self.assertEqual(r.triangles[0].verts, [0, 1, 2])

    def test_face_with_too_few_vertices(self):
        text = "v 0 0 0\nv 1 0 0\nv 1 1 0\nf 1 2\nf 1 2 3\n"
        r = parse_obj(text)
        self.assertEqual(len(r.triangles), 1)
        self.assertTrue(any("至少需要 3 个顶点" in m["message"] for m in r.messages))

    def test_missing_uv_marked_but_geometry_kept(self):
        text = "v 0 0 0\nv 1 0 0\nv 1 1 0\nf 1 2 3\n"
        r = parse_obj(text)
        self.assertEqual(len(r.triangles), 1)
        self.assertIsNone(r.triangles[0].uvs)
        self.assertEqual(r.faces_without_uv, [0])
        self.assertTrue(any(m["level"] == "warning" and "贴图坐标" in m["message"]
                            for m in r.messages))

    def test_partial_uv_on_face(self):
        text = (
            "v 0 0 0\nv 1 0 0\nv 1 1 0\n"
            "vt 0 0\nvt 1 0\nvt 1 1\n"
            "f 1/1 2 3/3\n"
        )
        r = parse_obj(text)
        self.assertEqual(len(r.triangles), 1)
        self.assertIsNone(r.triangles[0].uvs)

    def test_empty_file_messages(self):
        r = parse_obj("")
        self.assertTrue(any("没有任何有效顶点" in m["message"] for m in r.messages))
        self.assertTrue(any("没有任何有效三角面" in m["message"] for m in r.messages))

    def test_file_without_any_vt(self):
        text = "v 0 0 0\nv 1 0 0\nv 1 1 0\nf 1 2 3\n"
        r = parse_obj(text)
        self.assertTrue(any("没有任何贴图坐标" in m["message"] for m in r.messages))

    def test_missing_file_returns_messages(self):
        r = parse_obj_file("/nonexistent/path/definitely_missing.obj")
        self.assertEqual(len(r.triangles), 0)
        self.assertTrue(any(m["level"] == "error" and "无法读取" in m["message"]
                            for m in r.messages))

    def test_line_numbers_recorded(self):
        text = "v 0 0 0\nv bad x 0\nv 1 1 0\nf 1 2 3\n"
        r = parse_obj(text)
        err_lines = [m["line"] for m in r.messages if m["level"] == "error"]
        self.assertIn(2, err_lines)

    def test_payload_is_json_ready(self):
        text = (
            "v 0 0 0\nv 1 0 0\nv 1 1 0\n"
            "vt 0 0\nvt 1 0\nvt 1 1\nf 1/1 2/2 3/3\n"
        )
        import json
        payload = parse_obj(text).to_payload()
        again = json.loads(json.dumps(payload, ensure_ascii=False))
        self.assertEqual(again["stats"]["triangle_count"], 1)


if __name__ == "__main__":
    unittest.main()
