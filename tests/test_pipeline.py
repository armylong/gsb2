"""端到端验证（无 GUI 依赖，纯计算管线）。

覆盖需求点：
1. 内置样例含平坦块/细线/规律纹理，两种噪声模式、强度可控；
2. 两种算法共用同一套选区与参数；
3. 差值图与纹理抹除检测可输出；
4. 只处理选中部分：区外逐像素不变，羽化过渡带存在且平滑；
5. 干净参考下报告平坦区噪声下降与边缘保留；
6. 估计仅用带噪图；静态检查处理/估计模块源码不含 clean 引用；
7. 编辑顺序与算法切换顺序无关（同设置同输出），重叠优先级明确；
另外检查色度通道可单独取出。
"""
from __future__ import annotations

import inspect
from pathlib import Path

import numpy as np
import pytest

from denoise_lab.synthetic import (
    make_sample, default_estimation_rects, ZONES, IMG_H, IMG_W,
)
from denoise_lab import noise_estimation, processing, metrics
from denoise_lab.processing import (
    RegionParams, process, feather_alpha, diff_map, texture_erasure_mask,
    ALGO_SMOOTH, ALGO_EDGE,
)

PKG_DIR = Path(__file__).resolve().parents[1] / "denoise_lab"


# ---------- 1. 样例与噪声 ----------
def test_sample_contains_required_zones():
    for name in ("flat_dark", "flat_mid", "flat_bright", "lines",
                 "checker", "stripes", "dots", "chroma", "gradient"):
        assert name in ZONES


def test_two_noise_modes_and_strength_control():
    weak = make_sample("fixed", sigma_base=0.01, rng_seed=1)
    strong = make_sample("fixed", sigma_base=0.06, rng_seed=1)
    lum = make_sample("luminance", sigma_base=0.02, k_signal=0.08,
                      rng_seed=1)
    # 同种子：强度越大，带噪图与干净参考差异越大
    e_weak = np.mean((weak.noisy - weak.clean) ** 2)
    e_strong = np.mean((strong.noisy - strong.clean) ** 2)
    assert e_strong > e_weak * 5
    # 固定模式 sigma 图恒定；亮度相关模式随亮度上升
    assert np.std(weak.sigma_map) < 1e-6
    dark = ZONES["flat_dark"]
    bright = ZONES["flat_bright"]
    s_dark = lum.sigma_map[dark[0]:dark[1], dark[2]:dark[3]].mean()
    s_bright = lum.sigma_map[bright[0]:bright[1], bright[2]:bright[3]].mean()
    assert s_bright > s_dark
    # 数值合法
    for s in (weak, strong, lum):
        assert s.noisy.shape == (IMG_H, IMG_W, 3)
        assert 0.0 <= s.noisy.min() and s.noisy.max() <= 1.0


# ---------- 6. 估计仅用带噪图 + 源码隔离检查 ----------
def test_estimation_uses_noisy_only_and_recovers_levels():
    sample = make_sample("luminance", sigma_base=0.025, k_signal=0.06,
                         rng_seed=7)
    model = noise_estimation.fit_noise_model(
        sample.noisy, default_estimation_rects(), "luminance")
    assert len(model.levels) == 3
    lumas = [lv.median_luma for lv in model.levels]
    sigmas = [lv.sigma for lv in model.levels]
    # 逐级 sigma 随亮度单调上升（采样区本身就是三级亮度平坦块）
    order = np.argsort(lumas)
    assert sigmas[order[0]] < sigmas[order[-1]]
    # 拟合参数与真实参数同量级（估计本来就带统计误差，只做宽松校验）
    assert 0.0 < model.read_sigma < 0.08
    assert model.signal_k > 0.01

    fixed = make_sample("fixed", sigma_base=0.04, rng_seed=7)
    fm = noise_estimation.fit_noise_model(
        fixed.noisy, default_estimation_rects(), "fixed")
    # 噪声加在 RGB 三通道，估计在 luma 域；独立通道噪声经
    # Y'=0.299R+0.587G+0.114B 后 sigma 收缩 sqrt(0.299²+0.587²+0.114²)≈0.668
    expected_luma_sigma = 0.04 * np.sqrt(0.299 ** 2 + 0.587 ** 2 + 0.114 ** 2)
    assert abs(fm.sigma_fixed - expected_luma_sigma) < 0.006


def test_clean_reference_not_reachable_from_processing_modules():
    """处理与估计模块的 AST 中不得出现 clean 引用，也不得 import metrics。

    用语法树而非源码字符串检查：文档/注释里可以讨论干净参考，
    但真实的变量、参数、属性访问都不允许出现。
    """
    import ast

    class RefChecker(ast.NodeVisitor):
        def __init__(self):
            self.bad = []

        def visit_Name(self, node):
            if "clean" in node.id.lower():
                self.bad.append(("name", node.id))
            self.generic_visit(node)

        def visit_Attribute(self, node):
            if "clean" in node.attr.lower():
                self.bad.append(("attr", node.attr))
            self.generic_visit(node)

        def visit_arg(self, node):
            if node.arg and "clean" in node.arg.lower():
                self.bad.append(("arg", node.arg))
            self.generic_visit(node)

        def visit_Import(self, node):
            for alias in node.names:
                if alias.name.endswith("metrics"):
                    self.bad.append(("import", alias.name))
            self.generic_visit(node)

        def visit_ImportFrom(self, node):
            if node.module and node.module.endswith("metrics"):
                self.bad.append(("import", node.module))
            self.generic_visit(node)

    for mod in (noise_estimation, processing):
        path = PKG_DIR / f"{mod.__name__.split('.')[-1]}.py"
        checker = RefChecker()
        checker.visit(ast.parse(path.read_text()))
        assert not checker.bad, f"{mod.__name__} 出现干净参考引用: {checker.bad}"
        for name, fn in inspect.getmembers(mod, inspect.isfunction):
            if fn.__module__ != mod.__name__:
                continue
            assert "clean" not in inspect.signature(fn).parameters, (
                f"{mod.__name__}.{name} 的签名含 clean")
    # 反向确认：metrics 是唯一允许使用 clean 的模块
    assert "clean" in inspect.signature(metrics.evaluate).parameters


# ---------- 2/4. 同参数双算法、区外不修改、羽化过渡 ----------
def _two_regions():
    r1 = RegionParams((120, 260, 60, 300), strength=60, feather=14)
    r2 = RegionParams((220, 400, 240, 520), strength=80, feather=10)
    return [r1, r2]


def test_outside_region_unchanged_and_feather_visible():
    sample = make_sample(rng_seed=3)
    regions = _two_regions()
    out = process(sample.noisy, ALGO_EDGE, regions, winner=1)

    covered = np.zeros((IMG_H, IMG_W), bool)
    for r in regions:
        y0, y1, x0, x1 = r.rect
        covered[y0:y1, x0:x1] = True
    # 区外（含羽化半径外）逐像素不变
    outside = ~covered
    assert np.array_equal(out[outside], sample.noisy[outside])
    # 区内确实发生了修改
    inside = covered
    assert np.abs(out[inside] - sample.noisy[inside]).mean() > 1e-4

    # 羽化：alpha 在 0..1 之间连续过渡，存在中间值
    alpha = feather_alpha(regions[0].rect, regions[0].feather,
                          (IMG_H, IMG_W))
    assert alpha.min() == 0.0 and alpha.max() == 1.0
    mid = alpha[(alpha > 0.05) & (alpha < 0.95)]
    assert mid.size > 100
    # 硬边（feather=0）没有中间值
    hard = feather_alpha(regions[0].rect, 0, (IMG_H, IMG_W))
    assert not np.any((hard > 0.0) & (hard < 1.0))


def test_both_algorithms_share_same_regions():
    sample = make_sample(rng_seed=3)
    regions = _two_regions()
    out_s = process(sample.noisy, ALGO_SMOOTH, regions, winner=1)
    out_e = process(sample.noisy, ALGO_EDGE, regions, winner=1)
    # 输入参数完全相同（同一 regions 对象），结果不同说明算法有别，
    # 但区外都保持原样
    covered = np.zeros((IMG_H, IMG_W), bool)
    for r in regions:
        y0, y1, x0, x1 = r.rect
        covered[y0:y1, x0:x1] = True
    outside = ~covered
    assert np.array_equal(out_s[outside], sample.noisy[outside])
    assert np.array_equal(out_e[outside], sample.noisy[outside])
    assert not np.allclose(out_s, out_e)
    # 保边降噪在细线区的边缘保持应优于普通平滑（梯度能量更大）
    ly0, ly1, lx0, lx1 = ZONES["lines"]
    def grad_energy(img):
        gx = np.diff(img[ly0:ly1, lx0:lx1].mean(axis=2), axis=1)
        return float((gx ** 2).mean())
    assert grad_energy(out_e) > grad_energy(out_s)


# ---------- 7. 顺序无关性与重叠优先级 ----------
def test_order_independence_edit_vs_algorithm_switch():
    """模拟两条操作路径，最终设置相同 -> 输出逐像素一致。"""
    sample = make_sample(rng_seed=11)
    final_regions = _two_regions()

    # 路径 A：先用初始区域切到保边，再把区域改成最终设置
    init_regions = [RegionParams((0, 100, 0, 100), 40, 8),
                    RegionParams((400, 500, 400, 600), 40, 8)]
    _ = process(sample.noisy, ALGO_EDGE, init_regions, winner=1)
    out_a = process(sample.noisy, ALGO_EDGE, final_regions, winner=1)

    # 路径 B：先在普通平滑下把区域改成最终设置，再切保边
    _ = process(sample.noisy, ALGO_SMOOTH, final_regions, winner=1)
    out_b = process(sample.noisy, ALGO_EDGE, final_regions, winner=1)

    assert np.array_equal(out_a, out_b)
    # 纯函数确定性：再算一次也一致
    out_c = process(sample.noisy, ALGO_EDGE, final_regions, winner=1)
    assert np.array_equal(out_a, out_c)


def test_overlap_priority_is_explicit_and_effective():
    sample = make_sample(rng_seed=5)
    overlap_rect = (200, 320, 200, 420)
    r1 = RegionParams(overlap_rect, strength=90, feather=0)
    r2 = RegionParams(overlap_rect, strength=10, feather=0)
    win_r1 = process(sample.noisy, ALGO_EDGE, [r1, r2], winner=0)
    win_r2 = process(sample.noisy, ALGO_EDGE, [r1, r2], winner=1)
    # 完全重叠时，赢家通吃，两种优先级结果必须不同
    assert not np.allclose(win_r1, win_r2)
    solo_r1 = process(sample.noisy, ALGO_EDGE, [r1], winner=0)
    solo_r2 = process(sample.noisy, ALGO_EDGE, [r2], winner=0)
    y0, y1, x0, x1 = overlap_rect
    # R1 优先 ≈ 只有 R1 的效果；R2 优先 ≈ 只有 R2 的效果
    assert np.allclose(win_r1[y0:y1, x0:x1],
                       solo_r1[y0:y1, x0:x1], atol=1e-7)
    assert np.allclose(win_r2[y0:y1, x0:x1],
                       solo_r2[y0:y1, x0:x1], atol=1e-7)


def test_partial_selection_pipeline():
    """选区只处理一块：选区外不变，选区强度为 0 时整图不变。"""
    sample = make_sample(rng_seed=9)
    rect = ZONES["checker"]
    r = RegionParams(rect, strength=70, feather=0)
    out = process(sample.noisy, ALGO_SMOOTH, [r], winner=0)
    covered = np.zeros((IMG_H, IMG_W), bool)
    y0, y1, x0, x1 = rect
    covered[y0:y1, x0:x1] = True
    assert np.array_equal(out[~covered], sample.noisy[~covered])

    r_zero = RegionParams(rect, strength=0, feather=0)
    assert np.array_equal(
        process(sample.noisy, ALGO_SMOOTH, [r_zero], 0), sample.noisy)


# ---------- 3. 差值图与纹理抹除标记 ----------
def test_diff_and_texture_erasure_outputs():
    sample = make_sample(rng_seed=2)
    # 强高斯会抹掉棋盘纹理
    r = RegionParams((0, IMG_H, 0, IMG_W), strength=100, feather=0)
    out = process(sample.noisy, ALGO_SMOOTH, [r], winner=0)
    d = diff_map(sample.noisy, out)
    assert d.shape == sample.noisy.shape
    assert d.max() > 0.1
    heat = texture_erasure_mask(sample.noisy, out)
    # 纹理区（棋盘/条纹）应比暗平坦区出现更多疑似块
    qy0, qy1, qx0, qx1 = ZONES["checker"]
    fy0, fy1, fx0, fx1 = ZONES["flat_dark2"]
    assert heat[qy0:qy1, qx0:qx1].mean() > heat[fy0:fy1, fx0:fx1].mean()


def test_edge_preserving_triggers_fewer_erasure_flags():
    """同等强度下，保边降噪的疑似纹理抹除块应显著少于普通平滑。"""
    sample = make_sample(rng_seed=2)
    r = [RegionParams((0, IMG_H, 0, IMG_W), strength=100, feather=0)]
    out_s = process(sample.noisy, ALGO_SMOOTH, r, 0)
    out_e = process(sample.noisy, ALGO_EDGE, r, 0)
    heat_s = texture_erasure_mask(sample.noisy, out_s)
    heat_e = texture_erasure_mask(sample.noisy, out_e)
    blocks_s = np.count_nonzero(heat_s[::16, ::16])
    blocks_e = np.count_nonzero(heat_e[::16, ::16])
    # 强高斯抹掉大量纹理；双边在该强度下基本不触发
    assert blocks_s > 100
    assert blocks_e < blocks_s * 0.1


# ---------- 5. 干净参考评估 ----------
def test_evaluation_reports_noise_drop_and_edge_preservation():
    sample = make_sample(rng_seed=4)
    regions = [RegionParams((0, IMG_H, 0, IMG_W), strength=60, feather=0)]
    out_s = process(sample.noisy, ALGO_SMOOTH, regions, 0)
    out_e = process(sample.noisy, ALGO_EDGE, regions, 0)
    rep_s = metrics.evaluate(sample.clean, sample.noisy, out_s, sample.zones)
    rep_e = metrics.evaluate(sample.clean, sample.noisy, out_e, sample.zones)

    # 平坦区噪声确实下降（dB 为正）
    assert rep_s.flat_noise_drop_db > 3.0
    assert rep_e.flat_noise_drop_db > 3.0
    # 保边算法的边缘梯度相关与幅度保持均优于普通平滑
    assert rep_e.edge.grad_corr > rep_s.edge.grad_corr
    assert rep_e.edge.amplitude_keep > rep_s.edge.amplitude_keep
    # 强平滑会抹纹理：普通平滑的棋盘保持率明显低于保边
    tex_s = {t.zone: t.energy_keep for t in rep_s.textures}
    tex_e = {t.zone: t.energy_keep for t in rep_e.textures}
    assert tex_e["checker"] > tex_s["checker"]
    # 色度指标存在且为正
    assert rep_e.chroma.cr_keep > 0 and rep_e.chroma.cb_keep > 0


# ---------- 7b. 色度抽查通道 ----------
def test_chroma_channels_extractable():
    sample = make_sample(rng_seed=6)
    import cv2
    ycrcb = cv2.cvtColor(sample.noisy, cv2.COLOR_RGB2YCrCb)
    # 彩色细节区的 Cr/Cb 方差应高于暗平坦区（有可抽查的色度信号）
    ay0, ay1, ax0, ax1 = ZONES["chroma"]
    fy0, fy1, fx0, fx1 = ZONES["flat_dark2"]
    for idx in (1, 2):
        chroma_var = ycrcb[ay0:ay1, ax0:ax1, idx].var()
        flat_var = ycrcb[fy0:fy1, fx0:fx1, idx].var()
        assert chroma_var > flat_var


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v"]))
