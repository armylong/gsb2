"""离线验证套件(可在无 GUI 环境运行):

1. 已知 sigma 的合成斜边, 实测 MTF50 应随模糊单调下降并贴近理论值;
2. 调换黑白方向(invert)读数基本一致;
3. 较陡与较平两种角度读数一致;
4. 改拟合范围结果稳定;
5. 低对比 / 振铃 / 双轮廓 / 贴边等场景给出对应可信度提示。

用法: .venv/bin/python -m slanted_edge_mtf.selftest
"""

from __future__ import annotations

import dataclasses

import numpy as np

from . import analysis, synthetic


@dataclasses.dataclass
class Check:
    name: str
    passed: bool
    detail: str


def _roi(shape, margin=0.22):
    h, w = shape
    x0 = int(w * margin)
    y0 = int(h * margin)
    return (x0, y0, w - 2 * x0, h - 2 * y0)


def run_all() -> list[Check]:
    checks: list[Check] = []

    # ---- 1+2+3: 两种角度 × 多个模糊程度, 含反相 ----
    for angle in (synthetic.STEEP_ANGLE, synthetic.SHALLOW_ANGLE):
        readings: list[tuple[float, float, float, float]] = []
        for sigma in synthetic.BLUR_SIGMAS:
            img = synthetic.slanted_edge(angle_deg=angle, sigma_px=sigma,
                                         noise_sigma=0.004)
            roi = _roi(img.shape)
            r = analysis.analyze(img, roi)
            r_inv = analysis.measure(img, roi, r.edge, r.fit_half_width,
                                     inverted=True)
            theory = synthetic.gaussian_mtf50(sigma)
            assert r.mtf50 is not None and r_inv.mtf50 is not None
            readings.append((sigma, r.mtf50, r_inv.mtf50, theory))

        label = f"角度{angle:>4.0f}°"
        # 单调下降
        mtf50s = [x[1] for x in readings]
        mono = all(a > b for a, b in zip(mtf50s, mtf50s[1:]))
        checks.append(Check(
            f"[{label}] 越模糊 MTF50 越低",
            mono,
            "sigma=" + ", ".join(f"{s}:{v:.3f}" for s, v, _, _ in readings),
        ))
        # 与理论值偏差(最锐的一档受 Nyquist 与锐度估计影响, 放宽)
        rel = [abs(meas - th) / th for _, meas, _, th in readings]
        ok = all(e < (0.20 if i == 0 else 0.15) for i, e in enumerate(rel))
        checks.append(Check(
            f"[{label}] MTF50 贴近理论高斯值",
            ok,
            "相对偏差 " + ", ".join(f"{e * 100:.0f}%" for e in rel),
        ))
        # 反相一致
        inv_err = [abs(a - b) / max(a, 1e-9)
                   for _, a, b, _ in readings]
        checks.append(Check(
            f"[{label}] 黑白反相读数一致",
            max(inv_err) < 0.05,
            "相对偏差 " + ", ".join(f"{e * 100:.1f}%" for e in inv_err),
        ))

    # ---- 3b: 两角度互比 ----
    def angle_mean(angle):
        return np.mean([
            analysis.analyze(
                synthetic.slanted_edge(angle_deg=angle, sigma_px=s,
                                       noise_sigma=0.004),
                _roi((180, 220))).mtf50
            for s in synthetic.BLUR_SIGMAS])
    m10, m35 = angle_mean(synthetic.STEEP_ANGLE), angle_mean(synthetic.SHALLOW_ANGLE)
    checks.append(Check(
        "陡边与平边读数一致(角度不变性)",
        abs(m10 - m35) / max(m10, m35) < 0.10,
        f"均值 MTF50: 陡={m10:.3f} 平={m35:.3f}",
    ))

    # ---- 4: 拟合范围稳定性 ----
    img = synthetic.slanted_edge(angle_deg=12, sigma_px=1.5,
                                 noise_sigma=0.004)
    roi = _roi(img.shape)
    base = analysis.analyze(img, roi)
    vals = []
    for rw in (base.fit_half_width * 0.6, base.fit_half_width * 0.85,
               base.fit_half_width * 1.25):
        vals.append(analysis.measure(img, roi, base.edge, rw).mtf50)
    spread = (max(vals) - min(vals)) / base.mtf50
    checks.append(Check(
        "改拟合范围 MTF50 稳定",
        spread < 0.08,
        f"不同范围读数={[round(v, 3) for v in vals]}, 极差 {spread * 100:.1f}%",
    ))

    # ---- 5a: 低对比 ----
    low = synthetic.slanted_edge(sigma_px=1.5, contrast=0.04,
                                 noise_sigma=0.006)
    r = analysis.analyze(low, _roi(low.shape))
    codes = {f.code for f in r.flags}
    checks.append(Check(
        "低对比样例给出 low_contrast 提示",
        "low_contrast" in codes,
        f"对比={abs(r.contrast):.3f} 噪声={r.noise_est:.4f}",
    ))

    # ---- 5b: 过锐振铃 ----
    ring = synthetic.slanted_edge(sigma_px=1.2, ringing=1.2,
                                  noise_sigma=0.003)
    r = analysis.analyze(ring, _roi(ring.shape))
    codes = {f.code for f in r.flags}
    # 过锐会把 MTF50 从同 sigma 未锐化的 0.13 附近抬高
    plain = analysis.analyze(
        synthetic.slanted_edge(sigma_px=1.2, noise_sigma=0.003),
        _roi(ring.shape))
    checks.append(Check(
        "过锐振铃样例给出 ringing 提示且 MTF50 被抬高",
        "ringing" in codes and r.mtf50 > plain.mtf50 * 1.3,
        f"负瓣={r.ringing_pct:.1f}% 过冲={r.overshoot_pct:.1f}% "
        f"MTF50={r.mtf50:.3f}(未锐化 {plain.mtf50:.3f})",
    ))

    # ---- 5c: 两条轮廓混在一起 ----
    dbl = synthetic.double_edges()
    r = analysis.analyze(dbl, _roi(dbl.shape))
    codes = {f.code for f in r.flags}
    checks.append(Check(
        "双轮廓样例给出 mixed_edges/edge_not_straight 提示",
        bool(codes & {"mixed_edges", "edge_not_straight"}),
        "触发标志=" + (",".join(sorted(codes)) or "无"),
    ))

    # ---- 5d: 边缘贴选区边界 ----
    near, roi = synthetic.edge_near_border()
    r = analysis.analyze(near, roi)
    codes = {f.code for f in r.flags}
    checks.append(Check(
        "贴边样例给出 edge_near_border 提示",
        "edge_near_border" in codes,
        f"两侧平台占比: 黑={np.mean(r.sample_dist < -r.fit_half_width / 2):.2f} "
        f"白={np.mean(r.sample_dist > r.fit_half_width / 2):.2f}",
    ))

    # ---- 5e: 无边缘纯色块 -> 应明确报错而非静默出错 ----
    blank = np.full((120, 140), 0.5)
    try:
        analysis.analyze(blank, _roi(blank.shape))
        checks.append(Check("纯色块应拒绝分析", False, "未抛出异常"))
    except ValueError as exc:
        checks.append(Check("纯色块应拒绝分析", True, str(exc)))

    return checks


def main() -> int:
    results = run_all()
    width = max(len(c.name) for c in results)
    n_pass = 0
    for c in results:
        mark = "PASS" if c.passed else "FAIL"
        print(f"[{mark}] {c.name.ljust(width)}  {c.detail}")
        n_pass += c.passed
    print(f"\n{n_pass}/{len(results)} 项通过")
    return 0 if n_pass == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
