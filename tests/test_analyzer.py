"""分析器测试：越界、重叠（含边接触误报排除）、拉伸、退化、缺 UV。"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from uvcheck.analyzer import analyze, _tri_area_2d, _jacobian_singular_values  # noqa: E402
from uvcheck.parser import parse_obj  # noqa: E402


def build_obj(verts, uvs, faces):
    """verts: [(x,y,z)...]；uvs: [(u,v)...] 或 None；faces: [(v_idx, uv_idx|None)...] 三角面。"""
    lines = [f"v {x} {y} {z}" for x, y, z in verts]
    if uvs is not None:
        lines += [f"vt {u} {v}" for u, v in uvs]
    for vis, uvis in faces:
        if uvis is None:
            lines.append("f " + " ".join(str(i + 1) for i in vis))
        else:
            lines.append("f " + " ".join(f"{v + 1}/{t + 1}" for v, t in zip(vis, uvis)))
    return parse_obj("\n".join(lines))


UNIT_SQUARE_TRIS = [
    ([0, 1, 2], [0, 1, 2]),
    ([0, 2, 3], [0, 2, 3]),
]


class TestOutOfRange(unittest.TestCase):
    def test_uv_beyond_unit_box(self):
        verts = [(0, 0, 0), (1, 0, 0), (1, 1, 0)]
        uvs = [(0.9, 0.2), (1.6, 0.2), (1.6, 0.9)]
        report = analyze(build_obj(verts, uvs, [([0, 1, 2], [0, 1, 2])]))
        kinds = [i["type"] for i in report["issues"]]
        self.assertIn("out_of_range", kinds)
        issue = next(i for i in report["issues"] if i["type"] == "out_of_range")
        self.assertEqual(issue["face_ids"], [0])

    def test_negative_uv_flagged(self):
        verts = [(0, 0, 0), (1, 0, 0), (1, 1, 0)]
        uvs = [(-0.2, 0.0), (0.5, 0.0), (0.5, 0.5)]
        report = analyze(build_obj(verts, uvs, [([0, 1, 2], [0, 1, 2])]))
        self.assertIn("out_of_range", [i["type"] for i in report["issues"]])

    def test_exact_boundary_not_flagged(self):
        verts = [(0, 0, 0), (1, 0, 0), (1, 1, 0)]
        uvs = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0)]
        report = analyze(build_obj(verts, uvs, [([0, 1, 2], [0, 1, 2])]))
        self.assertNotIn("out_of_range", [i["type"] for i in report["issues"]])


class TestOverlap(unittest.TestCase):
    def _two_triangles_same_uv(self):
        verts = [(0, 0, 0), (1, 0, 0), (1, 1, 0),
                 (0, 0, 1), (1, 0, 1), (1, 1, 1)]
        uvs = [(0.2, 0.2), (0.4, 0.2), (0.4, 0.4)]
        return build_obj(verts, uvs, [
            ([0, 1, 2], [0, 1, 2]),
            ([3, 4, 5], [0, 1, 2]),
        ])

    def test_identical_uv_overlap(self):
        report = analyze(self._two_triangles_same_uv())
        overlap = [i for i in report["issues"] if i["type"] == "overlap"]
        self.assertEqual(len(overlap), 1)
        self.assertEqual(overlap[0]["face_ids"], [0, 1])

    def test_partial_overlap_flagged(self):
        # 第二个 UV 三角与第一个相交一部分
        verts = [(0, 0, 0), (1, 0, 0), (1, 1, 0),
                 (0, 0, 1), (1, 0, 1), (1, 1, 1)]
        uvs = [(0.2, 0.2), (0.5, 0.2), (0.5, 0.5),
               (0.4, 0.3), (0.7, 0.3), (0.7, 0.6)]
        report = analyze(build_obj(verts, uvs, [
            ([0, 1, 2], [0, 1, 2]),
            ([3, 4, 5], [3, 4, 5]),
        ]))
        self.assertIn("overlap", [i["type"] for i in report["issues"]])

    def test_edge_touching_not_overlap(self):
        # 两三角仅共享一条边（UV 上左右拼接），不应报重叠
        verts = [(0, 0, 0), (1, 0, 0), (1, 1, 0),
                 (0, 0, 1), (1, 0, 1), (1, 1, 1)]
        uvs = [(0.0, 0.0), (0.5, 0.0), (0.5, 0.5),
               (0.5, 0.0), (1.0, 0.0), (1.0, 0.5)]
        report = analyze(build_obj(verts, uvs, [
            ([0, 1, 2], [0, 1, 2]),
            ([3, 4, 5], [3, 4, 5]),
        ]))
        self.assertNotIn("overlap", [i["type"] for i in report["issues"]])

    def test_disjoint_not_overlap(self):
        verts = [(0, 0, 0), (1, 0, 0), (1, 1, 0),
                 (0, 0, 1), (1, 0, 1), (1, 1, 1)]
        uvs = [(0.0, 0.0), (0.2, 0.0), (0.2, 0.2),
               (0.7, 0.7), (0.9, 0.7), (0.9, 0.9)]
        report = analyze(build_obj(verts, uvs, [
            ([0, 1, 2], [0, 1, 2]),
            ([3, 4, 5], [3, 4, 5]),
        ]))
        self.assertNotIn("overlap", [i["type"] for i in report["issues"]])

    def test_overlap_disabled(self):
        report = analyze(self._two_triangles_same_uv(), include_overlap=False)
        self.assertNotIn("overlap", [i["type"] for i in report["issues"]])


class TestStretch(unittest.TestCase):
    def test_isotropic_unit_mapping_no_stretch(self):
        # 直角边对齐的单位三维三角面 -> 同形单位 UV 三角面，雅可比为单位阵
        verts = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
        uvs = [(0.0, 0.0), (1.0, 0.0), (0.0, 1.0)]
        parsed = build_obj(verts, uvs, [([0, 1, 2], [0, 1, 2])])
        report = analyze(parsed)
        self.assertNotIn("stretch", [i["type"] for i in report["issues"]])
        aniso = report["triangle_metrics"]["0"]["anisotropy"]
        self.assertAlmostEqual(aniso, 1.0, places=6)

    def test_squished_v_direction_flags_stretch(self):
        # u 方向 UV 跨度 0.1、v 方向 0.02，三维两边等长 -> 各向异性 0.1/0.02 = 5
        verts = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
        uvs = [(0.7, 0.7), (0.8, 0.7), (0.7, 0.72)]
        report = analyze(build_obj(verts, uvs, [([0, 1, 2], [0, 1, 2])]),
                         stretch_threshold=3.0)
        self.assertIn("stretch", [i["type"] for i in report["issues"]])
        aniso = report["triangle_metrics"]["0"]["anisotropy"]
        self.assertAlmostEqual(aniso, 5.0, places=5)

    def test_threshold_respected(self):
        # 直角边对齐：u 方向 UV 跨度 1、v 方向 0.5 -> 恰为 2:1 各向异性
        verts = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
        uvs = [(0.0, 0.0), (1.0, 0.0), (0.0, 0.5)]
        parsed = build_obj(verts, uvs, [([0, 1, 2], [0, 1, 2])])
        self.assertNotIn("stretch", [i["type"] for i in analyze(parsed, 3.0)["issues"]])
        self.assertIn("stretch", [i["type"] for i in analyze(parsed, 1.5)["issues"]])


class TestDegenerateAndMissing(unittest.TestCase):
    def test_uv_degenerate_collinear(self):
        verts = [(0, 0, 0), (1, 0, 0), (1, 1, 0)]
        uvs = [(0.2, 0.8), (0.3, 0.8), (0.4, 0.8)]  # 共线
        report = analyze(build_obj(verts, uvs, [([0, 1, 2], [0, 1, 2])]))
        self.assertIn("uv_degenerate", [i["type"] for i in report["issues"]])
        self.assertEqual(report["triangle_metrics"]["0"]["area_uv"], 0.0)

    def test_mesh_degenerate_collinear(self):
        verts = [(0, 0, 0), (1, 0, 0), (2, 0, 0)]  # 三维共线
        uvs = [(0.0, 0.0), (0.5, 0.0), (1.0, 0.5)]
        report = analyze(build_obj(verts, uvs, [([0, 1, 2], [0, 1, 2])]))
        self.assertIn("mesh_degenerate", [i["type"] for i in report["issues"]])

    def test_missing_uv_issue(self):
        verts = [(0, 0, 0), (1, 0, 0), (1, 1, 0)]
        parsed = build_obj(verts, None, [([0, 1, 2], None)])
        report = analyze(parsed)
        self.assertIn("missing_uv", [i["type"] for i in report["issues"]])
        # 缺 UV 的面不参与重叠/拉伸，但几何指标仍在
        self.assertIsNone(report["triangle_metrics"]["0"]["area_uv"])

    def test_triangle_issue_index_consistency(self):
        verts = [(0, 0, 0), (1, 0, 0), (1, 1, 0)]
        uvs = [(1.5, 0.0), (2.0, 0.0), (2.0, 1.0)]
        report = analyze(build_obj(verts, uvs, [([0, 1, 2], [0, 1, 2])]))
        self.assertIn("out_of_range", report["triangle_issues"]["0"])
        self.assertEqual(report["counts"]["out_of_range"], 1)


class TestGeometryHelpers(unittest.TestCase):
    def test_tri_area_2d(self):
        self.assertAlmostEqual(_tri_area_2d([(0, 0), (1, 0), (1, 1)]), 0.5)
        self.assertEqual(_tri_area_2d([(0, 0), (1, 1), (2, 2)]), 0.0)

    def test_jacobian_singular_values_unit(self):
        # 直角边对齐、UV 与三维同形 -> 单位雅可比
        p0, p1, p2 = (0, 0, 0), (1, 0, 0), (0, 1, 0)
        uv0, uv1, uv2 = (0, 0), (1, 0), (0, 1)
        s_min, s_max, det = _jacobian_singular_values(p0, p1, p2, uv0, uv1, uv2)
        self.assertAlmostEqual(s_min, 1.0, places=6)
        self.assertAlmostEqual(s_max, 1.0, places=6)
        self.assertEqual(det, 1.0)

    def test_jacobian_2to1_anisotropy(self):
        # v 方向 UV 压缩一半 -> 奇异值 1 和 2，各向异性 2
        p0, p1, p2 = (0, 0, 0), (1, 0, 0), (0, 1, 0)
        uv0, uv1, uv2 = (0, 0), (1, 0), (0, 0.5)
        s_min, s_max, det = _jacobian_singular_values(p0, p1, p2, uv0, uv1, uv2)
        self.assertAlmostEqual(s_min, 1.0, places=6)
        self.assertAlmostEqual(s_max, 2.0, places=6)
        self.assertAlmostEqual(det, 0.5, places=6)

    def test_jacobian_degenerate_uv(self):
        p0, p1, p2 = (0, 0, 0), (1, 0, 0), (1, 1, 0)
        uv0, uv1, uv2 = (0, 0), (1, 0), (2, 0)
        s_min, s_max, det = _jacobian_singular_values(p0, p1, p2, uv0, uv1, uv2)
        self.assertEqual(det, 0.0)
        self.assertEqual((s_min, s_max), (0.0, 0.0))


if __name__ == "__main__":
    unittest.main()
