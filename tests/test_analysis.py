"""无界面自测: 合成数据 -> 拟合 -> 方向/掩码/角度校验/导出."""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from polanalyzer.physics import fit_stack, check_angles, Thresholds, render_direction, render_quality
from polanalyzer.synthetic import SyntheticConfig, generate_synthetic
from polanalyzer.io_utils import save_rgb, load_stack, save_mask, export_fit_csv, export_probe_csv

ANGLES = [0.0, 45.0, 90.0, 135.0]
FAILURES: list[str] = []


def check(name: str, cond: bool, detail: str = ""):
    print(f"[{'PASS' if cond else 'FAIL'}] {name} {detail}")
    if not cond:
        FAILURES.append(name)


def angular_distance(a: float, b: float) -> float:
    d = abs(a - b) % 180.0
    return min(d, 180.0 - d)


def main() -> int:
    cfg = SyntheticConfig()
    stack = generate_synthetic(cfg, ANGLES)
    check("合成栈形状", stack.shape == (4, cfg.height, cfg.width, 3), str(stack.shape))

    fit = fit_stack(stack, ANGLES)
    check("无角度告警", fit.problems == [], str(fit.problems))

    # 亮斑中心: 方向应恢复到 blob_phi
    cy = int(cfg.blob_center[1] * cfg.height)
    cx = int(cfg.blob_center[0] * cfg.width)
    err_blob = angular_distance(fit.phi[cy, cx], cfg.blob_phi_deg)
    check("亮斑方向恢复 (<5°)", err_blob < 5.0, f"err={err_blob:.2f}° φ={fit.phi[cy, cx]:.1f}")
    check("亮斑偏振度接近设定", abs(fit.rho[cy, cx] - cfg.blob_rho) < 0.12,
          f"rho={fit.rho[cy, cx]:.3f} vs {cfg.blob_rho}")
    check("亮斑可信", fit.trustworthy[cy, cx])

    # 普通斑块
    py = int(cfg.patch_center[1] * cfg.height)
    px = int(cfg.patch_center[0] * cfg.width)
    err_patch = angular_distance(fit.phi[py, px], cfg.patch_phi_deg)
    check("普通斑块方向恢复 (<8°)", err_patch < 8.0, f"err={err_patch:.2f}°")

    # 注入的极暗/过曝区域被标出
    dark_block = fit.mask_dark[int(cfg.height * 0.08):int(cfg.height * 0.18),
                                int(cfg.width * 0.08):int(cfg.width * 0.14)]
    sat_block = fit.mask_saturated[int(cfg.height * 0.08):int(cfg.height * 0.18),
                                    int(cfg.width * 0.86):int(cfg.width * 0.92)]
    check("极暗方块被标记", dark_block.mean() > 0.9, f"{dark_block.mean():.2f}")
    check("过曝方块被标记", sat_block.mean() > 0.9, f"{sat_block.mean():.2f}")
    check("过曝像素不可信", not fit.trustworthy[int(cfg.height * 0.1), int(cfg.width * 0.89)])

    # 马吕斯极值: phi 方向最亮, phi+90 最暗
    y_max = fit.simulate_luminance(fit.phi[cy, cx])[cy, cx]
    y_min = fit.simulate_luminance((fit.phi[cy, cx] + 90) % 180)[cy, cx]
    check("模拟极值方向正确", y_max > y_min, f"{y_max:.3f} vs {y_min:.3f}")

    # 实测四点与拟合值偏差 (可信像素, 噪声量级内)
    pred = np.stack([fit.simulate_luminance(a) for a in ANGLES], axis=0)
    resid = np.abs(pred - fit.lum)[fit.trustworthy[None].repeat(4, axis=0)]
    check("整体拟合残差小", np.median(resid) < cfg.noise_sigma * 1.5,
          f"median={np.median(resid):.4f}")

    # 渲染不报错且为 uint8
    d = render_direction(fit)
    q = render_quality(fit)
    check("方向图渲染", d.dtype == np.uint8 and d.shape == (cfg.height, cfg.width, 3))
    check("质量图渲染", q.dtype == np.uint8)

    # 角度校验
    check("重复角度被拒", any("重复" in p for p in check_angles([0.0, 45.0, 0.0, 90.0])))
    check("少于3角度被拒", len(check_angles([0.0, 90.0])) > 0)
    check("180° 与 0° 视为重复", any("重复" in p for p in check_angles([0.0, 45.0, 180.0])))
    check("正常角度通过", check_angles(ANGLES) == [])

    # 3 帧情形: 残差掩码关闭, 仍可拟合
    fit3 = fit_stack(stack[:3], ANGLES[:3])
    check("3帧可拟合", fit3.residual_dof == 0 and not fit3.mask_residual.any())
    check("3帧亮斑方向仍可恢复", angular_distance(fit3.phi[cy, cx], cfg.blob_phi_deg) < 8.0)

    # 导出与尺寸不一致校验
    with tempfile.TemporaryDirectory() as td:
        td = Path(td)
        for i, im in enumerate(stack):
            save_rgb(im, td / f"f{i}.png")
        reloaded, problems = load_stack([str(td / f"f{i}.png") for i in range(4)])
        check("PNG 往返一致", np.array_equal(reloaded, stack), f"problems={problems}")

        # 造一张尺寸不同的图
        save_rgb(stack[0, :100, :100], td / "small.png")
        _, problems2 = load_stack([str(td / "f0.png"), str(td / "small.png")])
        check("尺寸不一致被报告", len(problems2) == 1 and "尺寸" in problems2[0])

        p1 = save_mask(fit.trustworthy, td / "mask.png")
        p2 = export_fit_csv(fit, td / "params.csv", step=8)
        p3 = export_probe_csv(fit, cx, cy, np.arange(0, 181, 5.0), td / "curve.csv")
        for p in (p1, p2, p3):
            check(f"导出存在 {p.name}", p.exists() and p.stat().st_size > 0)
        csv_head = p3.read_text(encoding="utf-8").splitlines()
        check("曲线 CSV 含实测行", any(line.startswith("measured") for line in csv_head))
        check("曲线 CSV 含拟合行", any(line.startswith("fit") for line in csv_head))

    print(f"\n{len(FAILURES)} 项失败" if FAILURES else "\n全部通过")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    raise SystemExit(main())
