"""导出圈选段的时间与频率。

导出的真实秒数和 Hz 来自分析结果本身，缩放、平移、音名显示方式、
基准音高 A4 都不会修改它们。争议帧保留全部备选与可信程度。
"""

from __future__ import annotations

import csv
import math

from .analysis import AnalysisResult
from .notes import cents_from_nearest, freq_to_note_name

CSV_HEADER = [
    "time_sec",          # 真实秒，不受视图缩放影响
    "freq_hz",           # 客观频率，与 A4 无关；不可靠帧为空
    "freq_est_hz",       # 不确定帧的估计值（仍可能为空）
    "reliable",          # 1=可靠 0=不可靠
    "uncertain",         # 1=有估计但不确定
    "confidence",        # 主候选可信分 0..1
    "cents_vs_nearest",  # 按当前 A4 计算的音分偏差（仅显示参考列）
    "note_a4ref",        # 按当前 A4 得到的最近音名（仅显示参考列）
    "a4_hz",
    "uncertainty_reason",
    "candidates_hz",     # 全部备选频率，含八度假设
    "candidates_scores",
]


def export_segment_csv(path: str, result: AnalysisResult,
                       t0: float, t1: float, a4: float) -> int:
    """导出 [t0, t1] 内全部帧。返回写入帧数。"""
    t0, t1 = sorted((float(t0), float(t1)))
    n = 0
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(CSV_HEADER)
        for fr in result.frames:
            if not (t0 <= fr.t <= t1):
                continue
            n += 1
            f0 = "" if (not math.isfinite(fr.f0)) else f"{fr.f0:.4f}"
            est = "" if (not math.isfinite(fr.f0_est)) else f"{fr.f0_est:.4f}"
            ref_f = fr.f0 if math.isfinite(fr.f0) else fr.f0_est
            if math.isfinite(ref_f):
                cents = f"{float(cents_from_nearest(ref_f, a4)):+.2f}"
                note = freq_to_note_name(ref_f, a4)
            else:
                cents, note = "", "—"
            w.writerow([
                f"{fr.t:.6f}",
                f0,
                est,
                int(fr.reliable),
                int(fr.uncertain),
                f"{fr.confidence:.4f}",
                cents,
                note,
                f"{a4:.3f}",
                fr.reason,
                "|".join(f"{c.freq:.4f}" for c in fr.candidates),
                "|".join(f"{c.score:.4f}" for c in fr.candidates),
            ])
    return n
