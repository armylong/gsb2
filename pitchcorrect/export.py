"""导出: 单声道 wav 与有效参考区间表(CSV)。

区间表覆盖整条时间轴, 每一段都标明状态 —— 包括头/尾没有参考的部分,
避免出现"不知道这段是怎么处理的"盲区。
"""
from __future__ import annotations

import csv

import numpy as np

from .dsp import ReferenceAnalysis, Gap
from .wavio import write_wav_mono


STATE_NOTES = {
    "reference_valid": "参考有效, 已按偏差校正",
    "short_gap_bridged": "参考短暂丢失, 已平滑跨过",
    "short_gap_uncorrected": "参考短暂丢失, 按设置保留未校正",
    "long_gap_uncorrected": "参考缺失过长, 不插值、原样保留",
    "edge_uncorrected": "头/尾无参考, 不校正(原样保留)",
    "edge_held": "头/尾无参考, 保持最近一个有效偏差",
}


def build_interval_rows(an: ReferenceAnalysis, gaps: list[Gap],
                        duration_s: float, *, bridge_short: bool,
                        edge_mode: str) -> list[dict]:
    """把整条时间轴切成带状态标签的连续区间。"""
    t = an.frame_time
    half = an.frame_len / an.sr / 2.0
    state = np.full(t.size, "reference_valid", dtype=object)

    for g in gaps:
        m = (t >= g.start - 1e-9) & (t <= g.end + 1e-9)
        if g.kind == "short":
            state[m] = ("short_gap_bridged" if bridge_short
                        else "short_gap_uncorrected")
        else:
            state[m] = "long_gap_uncorrected"

    # 帧覆盖不到的头尾(曲线为 nan 的边缘)
    edge_state = "edge_held" if edge_mode == "hold" else "edge_uncorrected"
    curve_nan = np.isnan(an.deviation)
    head_nan = curve_nan & ~np.isin(state, [
        "short_gap_bridged", "short_gap_uncorrected", "long_gap_uncorrected"])
    state[head_nan] = edge_state

    # 帧边界 -> 实际时间边界, 再压缩连续同状态段
    bounds = np.concatenate(([0.0], (t[:-1] + t[1:]) / 2.0, [duration_s]))
    rows: list[dict] = []
    run_s = 0
    for i in range(1, len(state) + 1):
        if i == len(state) or state[i] != state[run_s]:
            t0, t1 = bounds[run_s], bounds[i]
            if t1 - t0 > 1e-6:
                key = str(state[run_s])
                rows.append({
                    "start_s": round(float(t0), 4),
                    "end_s": round(float(t1), 4),
                    "duration_s": round(float(t1 - t0), 4),
                    "state": key,
                    "note": STATE_NOTES[key],
                })
            run_s = i
    return rows


def write_intervals_csv(path: str, rows: list[dict]) -> None:
    fields = ["start_s", "end_s", "duration_s", "state", "note"]
    with open(path, "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)


def export_corrected_wav(path: str, mono: np.ndarray, sr: int) -> None:
    write_wav_mono(path, mono, sr)
