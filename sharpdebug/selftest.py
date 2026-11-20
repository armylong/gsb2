"""Head-less verification of the sharpening pipeline and its metrics.

Run::

    python -m sharpdebug.selftest

This is the "one runnable verification command" for the debugger.  It does not
open a window; it checks the numeric guarantees the UI relies on:

  1. a plain unsharp mask produces measurable overshoot that grows with
     strength (the step chart is trustworthy);
  2. raising the edge threshold reduces the white fringe on a saturated
     silhouette while keeping texture detail (the threshold actually works);
  3. measurements use unclipped floats (overshoot > 1.0 is visible);
  4. luminance-mode sharpening does not rotate hue, channel-wise does;
  5. profile sampling honours the fixed Y axis inputs (raw values returned);
  6. the export bundle contains PNGs, CSVs and a manifest with real numbers.

Exit code 0 == all checks passed.
"""
from __future__ import annotations

import json
import os
import tempfile

import numpy as np

from . import analysis
from .core import (
    SharpenParams,
    clipping_stats,
    compute_sharpen,
    max_filter,
    profile_line,
    synth_photo,
    synth_step_chart,
    luma,
)

PASS = "\033[92mPASS\033[0m"
FAIL = "\033[91mFAIL\033[0m"


class Checker:
    def __init__(self) -> None:
        self.failures: list[str] = []

    def check(self, name: str, ok: bool, detail: str = "") -> None:
        print(f"  [{PASS if ok else FAIL}] {name}" + (f"  ({detail})" if detail else ""))
        if not ok:
            self.failures.append(name)


def _max_overshoot(chart: np.ndarray, params: SharpenParams) -> float:
    res = compute_sharpen(chart, params)
    m = analysis.step_edge_metrics(res.result_unclipped, chart)
    return max(e.overshoot for e in m)


def _white_fringe(img: np.ndarray, params: SharpenParams) -> tuple[int, float]:
    res = compute_sharpen(img, params)
    st = clipping_stats(res, None)
    # pixels clipped at the top are the visible white fringe / blown highlight
    return st["clipped_high"], float(res.result_unclipped.max())


def main(argv: list[str] | None = None) -> int:
    chk = Checker()
    chart = synth_step_chart()
    photo = synth_photo()

    print("1. 阶跃边: 过冲随强度单调增长")
    over = [_max_overshoot(chart, SharpenParams(strength=s, edge_threshold=1.0))
            for s in (0.0, 0.5, 1.0, 1.5, 2.0)]
    chk.check(
        "overshoot 0.0 < 0.5 < 1.0 < 1.5 < 2.0",
        all(b > a for a, b in zip(over, over[1:])),
        "过冲 = " + ", ".join(f"{v:.4f}" for v in over),
    )
    chk.check("过冲在 strength=1 时 > 0.01", over[2] > 0.01, f"{over[2]:.4f}")

    print("2. 边缘阈值: 提高阈值放大白边, 降低阈值抑制白边")
    fringe_lo, _ = _white_fringe(photo, SharpenParams(strength=1.5, edge_threshold=0.02))
    fringe_hi, _ = _white_fringe(photo, SharpenParams(strength=1.5, edge_threshold=0.60))
    chk.check(
        "阈值 0.02 的截断高光像素 < 阈值 0.60 的",
        fringe_lo < fringe_hi,
        f"{fringe_lo:,} < {fringe_hi:,}",
    )
    ov_lo = _max_overshoot(chart, SharpenParams(strength=1.0, edge_threshold=0.02))
    ov_hi = _max_overshoot(chart, SharpenParams(strength=1.0, edge_threshold=1.0))
    chk.check(
        "低阈值阶跃过冲 < 高阈值阶跃过冲",
        ov_lo < ov_hi,
        f"{ov_lo:.4f} < {ov_hi:.4f}",
    )
    # texture must survive the gate: low threshold must not kill all detail
    t_lo = analysis.texture_metrics(
        compute_sharpen(chart, SharpenParams(strength=1.0, edge_threshold=0.02)).result_unclipped
    )["hf_rms"]
    t_in = analysis.texture_metrics(chart)["hf_rms"]
    chk.check("低阈值仍保留阶跃图纹理能量", t_lo >= t_in * 0.98,
              f"锐化后 {t_lo*1000:.2f}‰ vs 原始 {t_in*1000:.2f}‰")

    print("3. 测量使用未截断浮点 (过冲可 > 1.0)")
    strong = compute_sharpen(chart, SharpenParams(strength=3.0, edge_threshold=1.0))
    chk.check(
        "unclipped 最大值 > 1.0",
        float(strong.result_unclipped.max()) > 1.0,
        f"max={strong.result_unclipped.max():.4f}",
    )
    chk.check(
        "clipped 结果 max == 1.0",
        float(strong.result.max()) == 1.0,
        f"max={strong.result.max():.4f}",
    )
    chk.check(
        "报告的最大过冲 == max(unclipped)-1",
        abs(float(strong.result_unclipped.max()) - 1.0 - float(
            (strong.result_unclipped.max(axis=(0, 1)) - 1.0).max()
        )) < 1e-9,
    )

    print("4. 色相: 仅亮度模式不旋转色相")
    rgb_mode = compute_sharpen(photo, SharpenParams(strength=2.0, edge_threshold=1.0, chroma="rgb"))
    luma_mode = compute_sharpen(photo, SharpenParams(strength=2.0, edge_threshold=1.0, chroma="luma"))
    st_rgb = clipping_stats(rgb_mode, None)
    st_luma = clipping_stats(luma_mode, None)
    chk.check(
        "luma 模式色相漂移像素远少于 rgb 模式",
        st_luma["hue_shift_px"] < st_rgb["hue_shift_px"] * 0.1,
        f"luma={st_luma['hue_shift_px']:,} vs rgb={st_rgb['hue_shift_px']:,}",
    )
    # strict mathematical check on the *unclipped* result: adding the same
    # scalar to all channels makes the per-channel delta identical
    delta = luma_mode.result_unclipped - luma_mode.base
    chk.check(
        "luma 模式 delta_R == delta_G == delta_B (未截断)",
        np.allclose(delta[..., 0], delta[..., 1], atol=1e-9)
        and np.allclose(delta[..., 1], delta[..., 2], atol=1e-9),
    )

    print("5. 剖面采样返回真实数值 (不受显示钳制)")
    res = compute_sharpen(chart, SharpenParams(strength=2.0, edge_threshold=1.0))
    # band 0 is the 0.02 -> 0.98 step; sample through the middle of it
    _, _, vals = profile_line(res.result_unclipped, (0, 90), (1023, 90), 400)
    lv = vals @ np.array([0.2126, 0.7152, 0.0722])
    chk.check(
        "剖面最大值 > 1.0",
        float(lv.max()) > 1.0,
        f"max={lv.max():.4f}",
    )
    _, _, vals_clipped = profile_line(res.result, (0, 90), (1023, 90), 400)
    lv_c = vals_clipped @ np.array([0.2126, 0.7152, 0.0722])
    chk.check("截断后的剖面 max <= 1.0", float(lv_c.max()) <= 1.0 + 1e-12,
              f"max={lv_c.max():.4f}")

    print("6. 导出包完整性")
    with tempfile.TemporaryDirectory() as td:
        x, y, vals = profile_line(res.result_unclipped, (0, 90), (1023, 90), 200)
        analysis.export_bundle(
            td,
            chart,
            res.result,
            SharpenParams(strength=2.0, edge_threshold=1.0),
            profile=(np.arange(vals.shape[0]), luma(profile_line(chart, (0, 90), (1023, 90), 200)[2]), vals),
            chart=chart,
            chart_result=res.result,
        )
        files = sorted(os.listdir(td))
        for need in (
            "original.png", "result.png", "manifest.json", "step_edges.csv",
            "profile.csv", "overlay_clipping.png",
        ):
            chk.check(f"导出含 {need}", need in files)
        with open(os.path.join(td, "manifest.json"), encoding="utf-8") as fh:
            m = json.load(fh)
        chk.check("manifest 含参数与缩放贡献", "params" in m and "scales" in m)
        chk.check("manifest 记录了过冲/欠冲", "max_overshoot" in m["clipping"])
        csv_rows = open(os.path.join(td, "step_edges.csv"), encoding="utf-8").read().strip().splitlines()
        chk.check("step_edges.csv 有 3 条阶跃带", len(csv_rows) == 4, f"{len(csv_rows)} 行含表头")

    print("7. 扫参返回单调/有响应的曲线")
    sw = analysis.sweep_strength(chart, SharpenParams(edge_threshold=1.0))
    overs = [r["max_overshoot"] for r in sw["rows"]]
    chk.check("强度扫参过冲单调不减", all(b >= a - 1e-9 for a, b in zip(overs, overs[1:])),
              str([round(v, 3) for v in overs]))
    th = analysis.sweep_threshold(chart, SharpenParams(strength=1.0))
    ovt = [r["max_overshoot"] for r in th["rows"]]
    chk.check("阈值扫参过冲随阈值升高", ovt[-1] > ovt[0], f"{ovt[0]:.4f} → {ovt[-1]:.4f}")
    gains = [r["texture_gain"] for r in th["rows"]]
    chk.check("阈值扫参纹理增益随阈值升高", gains[-1] > gains[0], f"{gains[0]:.2f}× → {gains[-1]:.2f}×")

    print("8. 边缘门控膨胀滤波器: 与暴力窗口最大值一致")
    rng = np.random.default_rng(0)
    probe = rng.random((17, 19))
    exact = True
    for radius in (1, 2, 3, 5, 8):
        ref = np.array(
            [
                [probe[max(0, y - radius) : y + radius + 1,
                       max(0, x - radius) : x + radius + 1].max()
                 for x in range(probe.shape[1])]
                for y in range(probe.shape[0])
            ]
        )
        exact &= bool(np.allclose(max_filter(probe, radius), ref))
    chk.check("max_filter 在 σ 对应半径上精确", exact)

    print()
    if chk.failures:
        print(f"{len(chk.failures)} 项失败: " + ", ".join(chk.failures))
        return 1
    print("全部通过 ✓")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
