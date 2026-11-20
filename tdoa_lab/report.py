"""报告生成与对齐音频导出（无 Qt 依赖）。"""

from __future__ import annotations

import json
import os
import re

import numpy as np

from .dsp import (
    estimate_delay,
    fractional_shift,
    read_wav,
    reference_interval,
    sliding_delay,
    write_wav,
)
from .models import DriftResult, Peak, TdoaResult
from .synth import Sample


def seconds_to_samples(sec: float, sr: int) -> int:
    return int(round(sec * sr))


def slice_sample(sample: Sample, start_s: float, dur_s: float) -> tuple[np.ndarray, np.ndarray, int, int]:
    sr = sample.sr
    n = len(sample.ch0)
    i0 = int(np.clip(seconds_to_samples(start_s, sr), 0, max(0, n - 8)))
    i1 = int(np.clip(i0 + seconds_to_samples(dur_s, sr), i0 + 8, n))
    return sample.ch0[i0:i1], sample.ch1[i0:i1], i0, i1


def analyze_selection(
    sample: Sample,
    start_s: float,
    dur_s: float,
    max_lag_ms: float = 50.0,
    top_k: int = 6,
    min_sep_ms: float = 3.0,
    window: str | None = "hann",
    force_polarity: int | None = None,
    drift_win_ms: float = 200.0,
    drift_hop_ms: float = 100.0,
    ref_blocks: int = 5,
    selected_lag: int | None = None,
) -> dict:
    """对给定片段做一次完整分析：候选、极性、时间变化、参考区间。"""
    ch0, ch1, i0, i1 = slice_sample(sample, start_s, dur_s)
    sr = sample.sr
    actual_dur = (i1 - i0) / sr
    max_lag = max(16, seconds_to_samples(max_lag_ms / 1000.0, sr))
    max_lag = min(max_lag, ch0.size - 1)

    result = estimate_delay(
        ch0, ch1, sr,
        max_lag=max_lag,
        top_k=top_k,
        window=window,
        min_sep_ms=min_sep_ms,
        force_polarity=force_polarity,
    )

    # 手动选择候选峰
    selected: Peak = result.main_peak
    if selected_lag is not None:
        p = result.pdf_peak_at(selected_lag)
        if p is not None:
            selected = p

    drift = sliding_delay(
        ch0, ch1, sr,
        win_s=max(0.05, drift_win_ms / 1000.0),
        hop_s=max(0.02, drift_hop_ms / 1000.0),
        max_lag=max_lag,
        polarity=result.polarity,
    )
    ref = reference_interval(
        ch0, ch1, sr,
        selected.refined_lag,
        polarity=result.polarity,
        blocks=ref_blocks,
        block_s=max(0.05, actual_dur / ref_blocks),
        max_lag=max_lag,
    )

    return {
        "ch0": ch0,
        "ch1": ch1,
        "i0": i0,
        "i1": i1,
        "sr": sr,
        "start_s": i0 / sr,
        "duration_s": actual_dur,
        "max_lag": max_lag,
        "result": result,
        "selected": selected,
        "drift": drift,
        "ref_interval": ref,
        "params": {
            "max_lag_ms": max_lag_ms,
            "top_k": top_k,
            "min_sep_ms": min_sep_ms,
            "window": window or "none",
            "force_polarity": force_polarity,
            "drift_win_ms": drift_win_ms,
            "drift_hop_ms": drift_hop_ms,
        },
    }


def build_report(
    sample: Sample,
    analysis: dict,
    align_amount: float,
    truth: float | None,
    source: str = "内置样例",
) -> dict:
    result: TdoaResult = analysis["result"]
    sel: Peak = analysis["selected"]
    drift: DriftResult = analysis["drift"]
    ref_mean, ref_lo, ref_hi, blocks = analysis["ref_interval"]

    error = None if truth is None else sel.refined_lag - float(truth)
    in_interval = None
    if truth is not None:
        in_interval = bool(ref_lo <= float(truth) <= ref_hi)

    warnings: list[str] = []
    if result.polarity < 0:
        warnings.append(
            f"通道反相：ch1 与 ch0 极性相反，已按 -1 补偿（同相/反相相关差 {result.polarity_margin:.0%}）"
        )
    if any(p.ambiguous for p in result.peaks[1:]):
        warnings.append("存在近似等高的候选峰：单段互相关无法唯一确定，请在候选中手动确认")
    if drift.changed:
        warnings.append(
            f"时差随时间变化：{drift.note}。建议缩小片段或分段查看，单一数值仅作近似。"
        )
    if truth is not None and in_interval is False:
        if drift.changed:
            warnings.append(
                "参考真值不在 95% 参考区间内：本片段已判定为时变，单一常数值不可能同时匹配整段，"
                "区间仅描述中段附近；请缩短片段分段查看"
            )
        else:
            warnings.append(
                "参考真值不在 95% 参考区间内：可能是回声/增益差等系统偏差，或所选候选峰不对"
            )

    return {
        "source": source,
        "sample": sample.name,
        "description": sample.description,
        "sr": sample.sr,
        "selection": {
            "start_s": round(analysis["start_s"], 6),
            "duration_s": round(analysis["duration_s"], 6),
            "start_sample": int(analysis["i0"]),
            "samples": int(analysis["ch0"].size),
        },
        "detected": {
            "lag": int(sel.lag),
            "refined": round(float(sel.refined_lag), 6),
            "seconds": round(float(sel.refined_lag) / sample.sr, 9),
            "ms": round(float(sel.refined_lag) / sample.sr * 1000.0, 6),
            "confidence": round(float(sel.confidence), 4),
            "confidence_label": confidence_label(sel.confidence),
            "label": sel.label,
            "is_main": sel is result.main_peak,
        },
        "align_amount": round(float(align_amount), 6),
        "manual_offset": round(float(align_amount) - float(sel.refined_lag), 6),
        "polarity": {
            "value": int(result.polarity),
            "label": "反相" if result.polarity < 0 else "同相",
            "margin": round(float(result.polarity_margin), 4),
        },
        "candidates": [p.as_dict for p in result.peaks],
        "truth": {
            "known": truth is not None,
            "value": None if truth is None else float(truth),
            "error_samples": None if error is None else round(float(error), 6),
            "error_us": None if error is None else round(float(error) / sample.sr * 1e6, 3),
            "in_reference_interval": in_interval,
        },
        "reference_interval": {
            "mean": round(float(ref_mean), 6),
            "lo": round(float(ref_lo), 6),
            "hi": round(float(ref_hi), 6),
            "half_width": round((float(ref_hi) - float(ref_lo)) / 2.0, 6),
            "blocks": [round(float(b), 6) for b in blocks],
        },
        "drift": {
            "changed": bool(drift.changed),
            "slope_per_s": round(float(drift.slope_per_s), 6),
            "drift_samples": round(float(drift.drift_samples), 6),
            "note": drift.note,
            "windows": int(drift.delays.size),
        },
        "notes": list(result.notes),
        "warnings": warnings,
        "params": analysis["params"],
    }


def confidence_label(conf: float) -> str:
    if conf >= 0.7:
        return "高"
    if conf >= 0.45:
        return "中"
    return "低"


def format_report_text(rep: dict) -> str:
    d = rep["detected"]
    sr = rep["sr"]
    sel = rep["selection"]
    lines: list[str] = []
    lines.append("■ 片段")
    lines.append(f"  {rep['sample']} · {sel['duration_s'] * 1000:.0f} ms"
                 f"（起点 {sel['start_s']:.3f} s，{sel['samples']} 采样 @ {sr} Hz）")
    if rep.get("description"):
        lines.append(f"  {rep['description']}")
    lines.append("")
    lines.append("■ 检测结果")
    lines.append(f"  时差（已选候选）  {d['refined']:+.3f} 采样   {d['ms']:+.4f} ms")
    lines.append(f"  整采样峰值 lag    {d['lag']:+d}（小数修正 {d['refined'] - d['lag']:+.3f}）")
    conf = d["confidence"]
    lines.append(f"  置信程度          {d['confidence_label']}（{conf:.2f}）· 候选 {len(rep['candidates'])} 个")
    lines.append(f"  极性              {rep['polarity']['label']}"
                 f"（同相/反相相关差 {rep['polarity']['margin']:.0%}）")
    manual = rep["manual_offset"]
    lines.append(f"  预览对齐量        {rep['align_amount']:+.3f} 采样"
                 + (f"（手调 {manual:+.3f}）" if abs(manual) > 1e-9 else "（= 检测值）"))
    lines.append("")
    lines.append("■ 误差与 95% 参考区间（分块重估）")
    ti = rep["truth"]
    if ti["known"]:
        lines.append(f"  参考真值          {ti['value']:+.3f} 采样")
        lines.append(f"  检测误差          {ti['error_samples']:+.3f} 采样"
                     f"（{ti['error_us']:+.1f} µs）")
    else:
        lines.append("  参考真值          未提供（导入音频时可手动填写）")
    ri = rep["reference_interval"]
    lines.append(f"  95% 参考区间      [{ri['lo']:+.3f}, {ri['hi']:+.3f}] 采样"
                 f"  ±{ri['half_width']:.3f}")
    if ti["known"]:
        inside = ti["in_reference_interval"]
        lines.append("  真值是否落在区间  " + ("是" if inside else "否"))
    lines.append(f"  备注：参考区间来自 {len(ri['blocks'])} 个分块的重估离散度，不是物理真值的概率保证。")
    lines.append("")
    lines.append("■ 候选峰")
    for i, p in enumerate(rep["candidates"], 1):
        mark = " ← 已选" if abs(p["refined"] - d["refined"]) < 1e-9 and p["lag"] == d["lag"] else ""
        am = " · 与主峰近似等高" if p["ambiguous"] else ""
        lines.append(
            f"  #{i} lag={p['lag']:+6d}  小数={p['refined']:+9.3f}"
            f"  相关={p['score']:.3f}  置信={p['confidence']:.2f}  {p['label']}{am}{mark}"
        )
    lines.append("")
    lines.append("■ 时间变化")
    dr = rep["drift"]
    lines.append(f"  {'发现时变' if dr['changed'] else '未发现明显时变'}"
                 f"（拟合 {dr['slope_per_s']:+.2f} 采样/秒，{dr['windows']} 个窗口）")
    lines.append(f"  {dr['note']}")
    if rep["warnings"]:
        lines.append("")
        lines.append("■ 需要注意")
        for w in rep["warnings"]:
            lines.append(f"  ! {w}")
    return "\n".join(lines)


def sanitize(name: str) -> str:
    cleaned = re.sub(r"[^\w\-一-鿿]+", "_", name, flags=re.UNICODE).strip("_")
    return cleaned or "tdoa"


def export_alignment(
    out_dir: str,
    stem: str,
    ch0: np.ndarray,
    ch1: np.ndarray,
    sr: int,
    align_amount: float,
    polarity: int,
    report: dict | None = None,
    write_json: bool = True,
) -> dict[str, str]:
    """导出对齐后的双通道短音频、残差音频与报告 JSON，返回文件路径。"""
    os.makedirs(out_dir, exist_ok=True)
    safe = sanitize(stem)
    aligned = np.asarray(ch1, dtype=np.float64) * (1 if polarity >= 0 else -1)
    aligned = fractional_shift(aligned, -float(align_amount))
    a = np.asarray(ch0, dtype=np.float64)
    n = min(a.size, aligned.size)
    a, aligned = a[:n], aligned[:n]
    residual = a - aligned

    paths = {
        "aligned_wav": os.path.join(out_dir, f"{safe}_aligned.wav"),
        "residual_wav": os.path.join(out_dir, f"{safe}_residual.wav"),
    }
    write_wav(paths["aligned_wav"], np.stack([a, aligned], axis=1), sr)
    write_wav(paths["residual_wav"], residual, sr)

    if report is not None and write_json:
        rep = dict(report)
        rep["export"] = {k: os.path.abspath(v) for k, v in paths.items()}
        paths["report_json"] = os.path.join(out_dir, f"{safe}_report.json")
        with open(paths["report_json"], "w", encoding="utf-8") as f:
            json.dump(rep, f, ensure_ascii=False, indent=2)
    return paths


def verify_aligned_wav(path: str, sr_expected: int | None = None, max_lag: int = 64) -> dict:
    """读回导出的对齐音频，确认两通道再次估计的时差接近 0 且同相。"""
    data, sr = read_wav(path)
    if data.shape[1] < 2:
        raise ValueError("对齐音频应为双通道")
    r = estimate_delay(data[:, 0], data[:, 1], sr, max_lag=max_lag, top_k=2, window=None)
    return {
        "sr": sr,
        "channels": int(data.shape[1]),
        "samples": int(data.shape[0]),
        "lag": float(r.main_peak.refined_lag),
        "polarity": int(r.polarity),
        "score": float(r.main_peak.score),
        "sr_ok": sr_expected is None or sr == sr_expected,
    }
