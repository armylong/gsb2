"""色觉模拟矩阵与插值测试。"""
import unittest

import numpy as np

from colorcheck import cvd
from colorcheck.colorio import ciede2000


class TestSimulation(unittest.TestCase):
    def test_severity_zero_identity(self):
        for kind in (cvd.PROTAN, cvd.DEUTAN):
            np.testing.assert_allclose(
                cvd.simulation_matrix(kind, 0.0), np.eye(3), atol=1e-12)
            rgb = np.array([[12.0, 88.0, 240.0]])
            np.testing.assert_allclose(cvd.simulate(rgb, kind, 0.0), rgb)

    def test_interpolation_midpoint(self):
        m0 = cvd.simulation_matrix(cvd.PROTAN, 0.0)
        m1 = cvd.simulation_matrix(cvd.PROTAN, 0.1)
        m_mid = cvd.simulation_matrix(cvd.PROTAN, 0.05)
        np.testing.assert_allclose(m_mid, (m0 + m1) / 2.0)

    def test_severity_clamp(self):
        np.testing.assert_allclose(
            cvd.simulation_matrix(cvd.DEUTAN, 2.0),
            cvd.simulation_matrix(cvd.DEUTAN, 1.0))
        np.testing.assert_allclose(
            cvd.simulation_matrix(cvd.DEUTAN, -1.0),
            cvd.simulation_matrix(cvd.DEUTAN, 0.0))

    def test_red_green_collapse(self):
        """典型红绿对: 完全 protan 模拟下色差应显著小于普通视觉;
        deutan 在中等程度下混淆最严重 (Machado 模型的已知特性)。"""
        red = np.array([[229.0, 57.0, 53.0]])
        green = np.array([[67.0, 160.0, 71.0]])
        base = float(ciede2000(red, green)[0])
        sr = cvd.simulate(red, cvd.PROTAN, 1.0)
        sg = cvd.simulate(green, cvd.PROTAN, 1.0)
        self.assertLess(float(ciede2000(sr, sg)[0]), base * 0.6)

        deut_mid = float(ciede2000(
            cvd.simulate(red, cvd.DEUTAN, 0.5),
            cvd.simulate(green, cvd.DEUTAN, 0.5))[0])
        self.assertLess(deut_mid, base * 0.25)

    def test_blue_preserved_better_than_red(self):
        """蓝-白区分在红绿模拟中基本保留 (仅轻微下降)。"""
        blue = np.array([[30.0, 136.0, 229.0]])
        white = np.array([[255.0, 255.0, 255.0]])
        base = float(ciede2000(blue, white)[0])
        sim_b = cvd.simulate(blue, cvd.DEUTAN, 1.0)
        sim_w = cvd.simulate(white, cvd.DEUTAN, 1.0)
        sim_de = float(ciede2000(sim_b, sim_w)[0])
        self.assertGreater(sim_de, base * 0.7)
        # 对比之下红绿对的损失明显更大
        red = np.array([[229.0, 57.0, 53.0]])
        green = np.array([[67.0, 160.0, 71.0]])
        rg_base = float(ciede2000(red, green)[0])
        rg_sim = float(ciede2000(
            cvd.simulate(red, cvd.DEUTAN, 0.5),
            cvd.simulate(green, cvd.DEUTAN, 0.5))[0])
        self.assertLess(rg_sim / rg_base, sim_de / base)

    def test_output_range(self):
        rng = np.random.default_rng(2)
        rgb = rng.integers(0, 256, size=(100, 3)).astype(float)
        for kind in (cvd.PROTAN, cvd.DEUTAN):
            out = cvd.simulate(rgb, kind, 0.7)
            self.assertTrue((out >= 0).all() and (out <= 255).all())


if __name__ == "__main__":
    unittest.main()
