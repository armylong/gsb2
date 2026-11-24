"""核心算法测试：全部用已知参数的合成图，不依赖 GUI。

运行：.venv/bin/python -m pytest tests/ -v
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from descreen.core import (
    Notch, NotchGroup, build_mask, compute_spectrum, descreen, find_peaks,
    freq_grid, signed_diff, to_gray,
)
from descreen.synth import make_halftone_test, make_parallel_lines_test


def test_synth_shapes_and_dtypes():
    for img in (make_halftone_test(256), make_parallel_lines_test(256)):
        assert img.dtype == np.uint8
        assert img.shape == (256, 256)


def test_spectrum_freq_grid_centered():
    img = make_halftone_test(256)
    spec = compute_spectrum(img)
    assert spec.display.shape == (256, 256)
    assert spec.display.min() >= 0.0 and spec.display.max() <= 1.0
    # 零频在正中心
    assert spec.u[128, 128] == pytest.approx(0.0, abs=1e-12)
    assert spec.v[128, 128] == pytest.approx(0.0, abs=1e-12)


def test_peaks_find_known_halftone_frequency():
    # 合成参数：period=8, angle=45° -> 两个频率轴 (u,v) = ±(f,f)/sqrt2
    period = 8.0
    img = make_halftone_test(512, period=period, angle_deg=45.0)
    spec = compute_spectrum(img)
    peaks = find_peaks(spec, relative_threshold=0.02)
    assert peaks, "应当检测到网纹周期峰"

    f_expect = 1.0 / period
    u_expect = f_expect / math.sqrt(2.0)

    matched = [
        p for p in peaks
        if abs(abs(p.u) - u_expect) < 0.02 and abs(abs(p.v) - u_expect) < 0.02
    ]
    assert matched, f"未找到已知频率 ±({u_expect:.4f},{u_expect:.4f})"
    # 周期估计误差应在 1 像素以内
    assert all(abs(p.period_px - period) < 1.0 for p in matched)
    # 真实信号必须出现共轭对
    assert any(p.paired for p in peaks)


def test_peak_angle_reports_stripe_orientation():
    img = make_halftone_test(512, period=8.0, angle_deg=45.0)
    spec = compute_spectrum(img)
    peaks = find_peaks(spec)
    # 45° 旋转网点对应条纹方向约 45°（两轴各报 45° / 135° 附近）
    angles = sorted(p.angle_deg % 180 for p in peaks[:4])
    assert any(abs(a - 45.0) < 8 for a in angles)


def test_mask_has_feathered_edge_no_hard_cut():
    h = w = 256
    n = Notch(u=0.05, v=0.0, ru=0.01, rv=0.01, kind="point")
    grp = NotchGroup(name="g", notches=[n])
    mask = build_mask(h, w, [grp], feather_cpp=0.004)

    assert mask.shape == (h, w)
    # 直流永远保留（亮度不被抹掉）
    cy, cx = h // 2, w // 2
    assert mask[cy, cx] == pytest.approx(1.0)
    # 陷波中心被压制
    x, y = int((n.u + 0.5) * w), int((n.v + 0.5) * h)
    assert mask[y, x] == pytest.approx(0.0, abs=1e-6)
    # 边缘是渐变而非硬切：沿径向应同时出现 0.2..0.8 的中间值
    row = mask[cy, cx:x]
    assert row.min() < 0.05
    assert np.any((row > 0.2) & (row < 0.8))
    # 过渡带宽度随 feather 变大
    mask_wide = build_mask(h, w, [grp], feather_cpp=0.012)
    mid_narrow = np.sum((row > 0.05) & (row < 0.95))
    row_wide = mask_wide[cy, cx:x]
    mid_wide = np.sum((row_wide > 0.05) & (row_wide < 0.95))
    assert mid_wide > mid_narrow


def test_mask_conjugate_and_group_toggle():
    h = w = 200
    n = Notch(u=0.08, v=-0.04, ru=0.008, rv=0.008)
    grp = NotchGroup(name="g", notches=[n], enabled=True)
    mask_on = build_mask(h, w, [grp], 0.002)
    x1, y1 = int((n.u + 0.5) * w), int((n.v + 0.5) * h)
    x2, y2 = int((-n.u + 0.5) * w), int((-n.v + 0.5) * h)
    assert mask_on[y1, x1] < 0.05
    assert mask_on[y2, x2] < 0.05          # 自动共轭配对

    grp.enabled = False
    mask_off = build_mask(h, w, [grp], 0.002)
    assert mask_off.max() == pytest.approx(1.0)
    assert mask_off.min() == pytest.approx(1.0)   # 关闭后等于不过滤


def test_descreen_reduces_known_periodic_power():
    img = make_halftone_test(512, period=8.0, angle_deg=45.0)
    spec_before = compute_spectrum(img)

    # 取检测到的最强峰做陷波
    peaks = find_peaks(spec_before)
    top = peaks[0]
    notch = Notch(u=top.u, v=top.v, ru=0.006, rv=0.006)
    groups = [NotchGroup(name="halftone", notches=[notch])]

    out = descreen(img, groups, feather_cpp=0.003)
    assert out.shape == img.shape and out.dtype == np.uint8

    spec_after = compute_spectrum(out)
    x, y = spec_before.to_pixel(top.u, top.v)
    xi, yi = int(round(x)), int(round(y))
    # 目标频率能量显著下降，而直流能量基本保留
    assert spec_after.magnitude[yi, xi] < 0.35 * spec_before.magnitude[yi, xi]
    dc0 = spec_before.magnitude[spec_before.h // 2, spec_before.w // 2]
    dc1 = spec_after.magnitude[spec_after.h // 2, spec_after.w // 2]
    assert abs(dc1 - dc0) / dc0 < 0.02


def test_descreen_is_idempotent_from_original():
    # 同样参数处理两次（各自从原图算）结果必须一致 —— 不允许迭代累积
    img = make_halftone_test(300)
    spec = compute_spectrum(img)
    top = find_peaks(spec)[0]
    groups = [NotchGroup(name="g", notches=[
        Notch(u=top.u, v=top.v, ru=0.006, rv=0.006)])]
    a = descreen(img, groups)
    b = descreen(img, groups)
    assert np.array_equal(a, b)


def test_no_edge_wraparound_artifact():
    # 反射填充后，画面四边不应出现比中心更强的处理残留（循环卷积折回伪影）
    img = make_halftone_test(256, period=8.0)
    spec = compute_spectrum(img)
    top = find_peaks(spec)[0]
    groups = [NotchGroup(name="g", notches=[
        Notch(u=top.u, v=top.v, ru=0.006, rv=0.006)])]
    out = descreen(img, groups)
    residual = np.abs(out.astype(int) - img.astype(int))
    border = np.concatenate([
        residual[:8, :].ravel(), residual[-8:, :].ravel(),
        residual[:, :8].ravel(), residual[:, -8:].ravel()])
    interior = residual[32:-32, 32:-32].ravel()
    # 边缘平均改动量不应显著高于中心（允许 20% 容差）
    assert border.mean() < interior.mean() * 1.2


def test_descreen_no_groups_returns_copy():
    img = make_halftone_test(128)
    out = descreen(img, [])
    assert np.array_equal(out, img)
    assert out is not img


def test_rgb_and_grayscale_paths():
    rgb = np.repeat(make_halftone_test(128)[..., None], 3, axis=2)
    groups = [NotchGroup(name="g", notches=[
        Notch(u=0.08, v=0.08, ru=0.01, rv=0.01)])]
    out_rgb = descreen(rgb, groups)
    out_gray = descreen(rgb[..., 0], groups)
    assert out_rgb.shape == rgb.shape
    assert out_gray.shape == rgb[..., 0].shape


def test_tiny_image_runs():
    # 小图也要有可用结果，不能崩溃
    img = make_halftone_test(32)
    groups = [NotchGroup(name="g", notches=[
        Notch(u=0.1, v=0.1, ru=0.03, rv=0.03)])]
    out = descreen(img, groups)
    assert out.shape == img.shape


def test_signed_diff_neutral_when_identical():
    img = make_halftone_test(128)
    d = signed_diff(img, img)
    assert np.all(np.abs(d.astype(int) - 128) <= 1)


def test_parallel_lines_fundamental_distinct_from_halftone():
    # 两张测试图的基频应明显不同，方便人眼/脚本区分误伤
    ht = compute_spectrum(make_halftone_test(512, period=8.0))
    ln = compute_spectrum(make_parallel_lines_test(512, spacing=5.0,
                                                   angle_deg=20.0))
    f_ht = max(p.freq for p in find_peaks(ht))
    f_ln = max(p.freq for p in find_peaks(ln, relative_threshold=0.01))
    assert abs(f_ht - f_ln) > 0.02


def test_wide_notch_hurts_real_lines_more_than_tight_notch():
    # 误伤演示：宽陷波把细线基频周围更大范围压掉，频谱邻域残留应更低
    # （差图上也对应更宽范围的能量被改动）——这正是"选宽了会伤细节"的量化依据
    img = make_parallel_lines_test(512, spacing=5.0, angle_deg=20.0)
    spec = compute_spectrum(img)
    peaks = find_peaks(spec, relative_threshold=0.01)
    # 方波状细线含多次谐波，基频功率最大，按功率选目标峰
    target = max(peaks, key=lambda p: p.power)

    tight = [NotchGroup(name="t", notches=[
        Notch(u=target.u, v=target.v, ru=0.002, rv=0.002)])]
    wide = [NotchGroup(name="w", notches=[
        Notch(u=target.u, v=target.v, ru=0.02, rv=0.02)])]

    def residual_power(out):
        s = compute_spectrum(out)
        x, y = s.to_pixel(target.u, target.v)
        xi, yi = int(round(x)), int(round(y))
        r = 12
        patch = s.magnitude[max(0, yi-r):yi+r, max(0, xi-r):xi+r]
        return float(patch.sum())

    p_tight = residual_power(descreen(img, tight))
    p_wide = residual_power(descreen(img, wide))
    # 宽陷波在该频率邻域压掉的能量至少比窄陷波多 30%
    assert p_wide < 0.7 * p_tight
    # 同时窄陷波本身也应确实起作用（低于原图残留）
    assert p_tight < residual_power(img)


def test_freq_grid_matches_fftshift_layout():
    U, V = freq_grid(4, 6)
    # fftfreq(6) 移位后为 [-3/6,-2/6,-1/6,0,1/6,2/6]
    assert U[0, 0] == pytest.approx(-0.5)
    assert U[0, -1] == pytest.approx(1 / 3, abs=1e-9)
    assert V[0, 0] == pytest.approx(-0.5)


def test_to_gray_weights():
    rgb = np.zeros((2, 2, 3), dtype=np.uint8)
    rgb[..., 0] = 255
    g = to_gray(rgb)
    assert g[0, 0] == pytest.approx(255 * 0.299)
