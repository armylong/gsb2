"""搭接几何算法的单元测试, 只用标准库 unittest + numpy。

运行: .venv/bin/python -m unittest discover -s tests -v
"""

import sys
import unittest
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from trap_studio.geometry import (  # noqa: E402
    boundary_4,
    compute_trap,
    edt,
    nearest_pixel,
    shift_mask,
)
from trap_studio.sample import build_sample  # noqa: E402


def rect(h, w, y0, x0, hh, ww):
    m = np.zeros((h, w), dtype=bool)
    m[y0:y0 + hh, x0:x0 + ww] = True
    return m


class TestEDT(unittest.TestCase):
    def test_zero_on_true(self):
        m = np.zeros((30, 40), dtype=bool)
        m[10, 20] = True
        d = edt(m)
        self.assertEqual(d[10, 20], 0.0)

    def test_known_distances(self):
        m = np.zeros((20, 20), dtype=bool)
        m[0, 0] = True
        d = edt(m)
        self.assertAlmostEqual(d[3, 4], 5.0)        # 3-4-5
        self.assertAlmostEqual(d[10, 0], 10.0)
        self.assertAlmostEqual(d[0, 7], 7.0)

    def test_all_true_is_zero(self):
        d = edt(np.ones((15, 15), dtype=bool))
        self.assertTrue(np.all(d == 0.0))

    def test_matches_bruteforce(self):
        rng = np.random.default_rng(7)
        m = rng.random((40, 50)) < 0.3
        d = edt(m)
        ys, xs = np.nonzero(m)
        yy, xx = np.mgrid[:40, :50]
        # 抽样暴力比对, 避免全量 2000 次循环太慢
        for y, x in [(0, 0), (39, 49), (17, 23), (5, 44), (33, 3)]:
            brute = np.sqrt(((ys - y) ** 2 + (xs - x) ** 2).min())
            self.assertAlmostEqual(d[y, x], brute, places=6)


class TestComputeTrap(unittest.TestCase):
    def test_width_zero_returns_originals(self):
        a = rect(40, 40, 5, 5, 10, 10)
        b = rect(40, 40, 5, 20, 10, 10)
        oa, ob, added = compute_trap(a, b, 0.0, "A")
        self.assertTrue(np.array_equal(oa, a))
        self.assertTrue(np.array_equal(ob, b))
        self.assertEqual(added.sum(), 0)

    def test_gap_fills_only_between_plates(self):
        # A 与 B 之间有 4px 空白缝 (x=15..18)
        a = rect(40, 40, 10, 5, 20, 10)
        b = rect(40, 40, 10, 19, 20, 10)
        oa, ob, added = compute_trap(a, b, 3.0, "A")
        # 扩展只加在 A 上, B 一字节不动
        self.assertTrue(np.array_equal(ob, b))
        self.assertTrue(np.all(added <= ~a))
        # 搭接带只在两版之间的缝里, 不进任一版本体
        self.assertTrue(np.all(added & (a | b) == False))
        # 缝内离两版都 <=3 的像素被填上; 外边缘空白不填
        self.assertGreater(added.sum(), 0)
        self.assertTrue(added[:, :5].sum() == 0)          # 画布外边
        self.assertTrue(added[:, 30:].sum() == 0)
        # 缝正中央 x=16,17 距最近版 1~2px, 宽度 3 应覆盖
        self.assertTrue(added[15:25, 16:18].all())

    def test_outer_edge_never_grows(self):
        a = rect(50, 50, 5, 5, 15, 15)
        b = rect(50, 50, 30, 30, 15, 15)  # 斜对角, 只有角部接近
        for w in (1.0, 3.0, 8.0):
            _, _, added = compute_trap(a, b, w, "A")
            # 新增像素必须同时距离两版 <= w, 画布四角永远不满足
            self.assertFalse(added[0, 0])
            self.assertFalse(added[49, 49])
            self.assertFalse(added[0, 49])

    def test_inner_hole_protected(self):
        # A 是实心方块, 中间有一个 16×16 的内洞; B 完全在洞外
        a = rect(60, 60, 5, 5, 50, 50)
        a[22:38, 22:38] = False
        b = np.zeros((60, 60), dtype=bool)
        b[0, :] = True  # B 只贴画布顶边, 离内洞很远
        _, _, added = compute_trap(a, b, 5.0, "A")
        # 洞里没有任何 B 的墨迹, 搭接不得进洞
        self.assertEqual(added[22:38, 22:38].sum(), 0)

    def test_touching_edges_do_not_grow(self):
        # 两版共享边界 x=20, 之间没有空白像素
        a = rect(40, 40, 5, 5, 30, 15)
        b = rect(40, 40, 5, 20, 30, 15)
        before_a = a.copy()
        before_b = b.copy()
        for _ in range(5):  # 反复计算也不累积
            oa, ob, added = compute_trap(a, b, 3.0, "A")
            a, b = oa, ob
        self.assertTrue(np.array_equal(a, before_a))
        self.assertTrue(np.array_equal(b, before_b))
        self.assertEqual(added.sum(), 0)

    def test_outside_corner_not_trapped(self):
        # 两版共享竖直边, 但上端错开: 缺口上方的外角像素离两版都近,
        # 却并不夹在两版之间, 不应被填。
        a = rect(40, 40, 10, 5, 25, 15)   # y 10..34
        b = rect(40, 40, 5, 20, 25, 15)   # y 5..29, 共享边 x=20
        _, _, added = compute_trap(a, b, 6.0, "A")
        # 外角区域 (y<10, x>=20) 一字节不加
        self.assertEqual(added[:10, 20:].sum(), 0)
        # 两版本体也不动
        self.assertEqual(added.sum(), 0)

    def test_idempotent_from_originals(self):
        # 应用始终从原始墨版重算: 同参数算两次结果完全一致, 不累积
        a0 = rect(50, 50, 10, 5, 20, 15)
        b0 = rect(50, 50, 10, 25, 20, 15)  # 5px 缝
        oa1, ob1, add1 = compute_trap(a0, b0, 4.0, "A")
        oa2, ob2, add2 = compute_trap(a0, b0, 4.0, "A")
        self.assertTrue(np.array_equal(oa1, oa2))
        self.assertTrue(np.array_equal(ob1, ob2))
        self.assertTrue(np.array_equal(add1, add2))
        # 新增像素距原版边界不超过设定宽度
        d = edt(a0)
        self.assertTrue(np.all(d[add1] <= 4.0 + 1e-9))

    def test_spread_b_extends_b_only(self):
        a = rect(40, 40, 10, 5, 20, 10)
        b = rect(40, 40, 10, 19, 20, 10)
        oa, ob, added = compute_trap(a, b, 3.0, "B")
        self.assertTrue(np.array_equal(oa, a))
        self.assertTrue(np.all(ob >= b))
        self.assertTrue(np.all(added <= ob))

    def test_width_monotonic_but_bounded(self):
        a = rect(60, 60, 10, 5, 30, 15)
        b = rect(60, 60, 10, 30, 30, 15)  # 10px 缝 (x=20..29)
        counts = []
        for w in (0.5, 1.5, 3.0, 5.0, 8.0, 12.0):
            _, _, added = compute_trap(a, b, w, "A")
            counts.append(int(added.sum()))
        self.assertEqual(counts[0], 0)  # 0.5px 阈值在整数格点上盖不到缝
        self.assertTrue(all(x <= y for x, y in zip(counts, counts[1:])))
        # 即使宽度超过缝宽, 也不能填到两版本体或外边
        oa, _, added = compute_trap(a, b, 12.0, "A")
        self.assertTrue(np.all(added & (a | b) == False))
        self.assertGreaterEqual(int((oa & b).sum()), 0)

    def test_shape_mismatch_raises(self):
        with self.assertRaises(ValueError):
            compute_trap(np.ones((5, 5), bool), np.ones((6, 6), bool), 2.0, "A")


class TestShift(unittest.TestCase):
    def test_round_trip_offsets(self):
        m = rect(30, 30, 10, 10, 8, 8)
        self.assertTrue(np.array_equal(shift_mask(m, 0, 0), m))
        s = shift_mask(m, 3, -2)
        # 原 (10,10) 的点平移到 (y=8, x=13)
        self.assertTrue(s[8, 13])
        self.assertFalse(s[10, 10])
        self.assertEqual(s.sum(), m.sum())

    def test_shift_off_canvas_drops(self):
        m = rect(10, 10, 0, 0, 5, 5)
        s = shift_mask(m, -8, 0)  # 几乎全移出左边
        self.assertLess(s.sum(), m.sum())
        self.assertEqual(shift_mask(m, 100, 100).sum(), 0)


class TestNearestPixel(unittest.TestCase):
    def test_on_pixel(self):
        m = rect(20, 20, 5, 5, 5, 5)
        (y, x), d = nearest_pixel(m, 7, 7)
        self.assertEqual((y, x, d), (7, 7, 0.0))

    def test_nearest_outside(self):
        m = rect(20, 20, 5, 5, 5, 5)  # 覆盖 y,x ∈ [5,9]
        (y, x), d = nearest_pixel(m, 12, 7)
        self.assertEqual((y, x), (9, 7))
        self.assertAlmostEqual(d, 3.0)

    def test_none_in_radius(self):
        m = rect(20, 20, 0, 0, 2, 2)
        self.assertIsNone(nearest_pixel(m, 19, 19, max_radius=5))


class TestBoundary(unittest.TestCase):
    def test_solid_block_boundary(self):
        m = rect(10, 10, 2, 2, 6, 6)
        b = boundary_4(m)
        # 内部点 (5,5) 四邻都是墨, 不是轮廓
        self.assertFalse(b[5, 5])
        # 边上的点是轮廓
        self.assertTrue(b[2, 5])
        self.assertTrue(b[7, 5])


class TestSample(unittest.TestCase):
    def test_sample_shapes_and_features(self):
        a, b = build_sample()
        self.assertEqual(a.shape, b.shape)
        self.assertTrue(a.dtype == bool)
        # 两版都有内容, 且存在空白缝
        self.assertGreater(a.sum(), 100)
        self.assertGreater(b.sum(), 100)
        self.assertGreater((~(a | b)).sum(), 100)
        # 圆环内洞确实是空白
        self.assertFalse(a[110, 310])
        # 共享边界处无空白: 两版在 x=260 直接相接
        self.assertTrue(a[60, 259] and b[60, 260])

    def test_sample_trap_respects_hole_and_outside(self):
        a, b = build_sample()
        oa, _, added = compute_trap(a, b, 3.0, "A")
        # 圆环内洞中心区域不被填 (洞半径 60, 距 B 环 >50px)
        self.assertEqual(added[100:121, 300:321].sum(), 0)
        # 画布最外圈不动
        self.assertEqual(added[0, :].sum() + added[-1, :].sum(), 0)
        # 搭接后两版在 L 拐角缝处不再露白(偏移为 0 时)
        gap_before = ~(a | b)
        gap_after = ~(oa | b)
        self.assertLess(gap_after.sum(), gap_before.sum())


if __name__ == "__main__":
    unittest.main(verbosity=2)
