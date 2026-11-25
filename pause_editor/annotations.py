"""标注 JSON 读写、重写, 以及位置对照文件导出。

标注文件格式 (UTF-8 JSON, 位置以**采样序号**为准, ``time_s`` 仅作人读校验)::

    {
      "sample_rate": 16000,
      "marks":   [{"label": "A", "sample": 1234, "time_s": 0.0772}],
      "regions": [{"start": 100, "end": 900, "keep_ms": 120,
                   "enabled": true, "note": "第一处停顿"}]
    }

加载时只给 ``time_s`` 也可以, 会按采样率换算成采样序号。
"""

from __future__ import annotations

import csv
import json
from dataclasses import dataclass
from typing import Any, Dict, List, Sequence, Tuple

from .model import EditEngine, EditRegion, RemappedMark, remap_marks


@dataclass
class AnnotationFile:
    sample_rate: int
    marks: List[Tuple[str, int]]          # (label, sample)
    regions: List[EditRegion]


def _resolve_sample(d: Dict[str, Any], key: str, sample_rate: int) -> int:
    if key in d and d[key] is not None:
        return int(d[key])
    tk = "time_s" if key in ("sample", "start", "end") else None
    if tk and tk in d and d[tk] is not None:
        return int(round(float(d[tk]) * sample_rate))
    raise KeyError(f"标注项缺少 {key} (也没有 time_s 可换算): {d}")


def load_annotations(path: str, sample_rate: int) -> AnnotationFile:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)

    sr = int(data.get("sample_rate", sample_rate))
    if sr != sample_rate:
        # WAV 是唯一的时间基准, 标注里写了别的采样率时明确提示
        raise ValueError(f"标注采样率 {sr} 与 WAV 采样率 {sample_rate} 不一致")

    marks: List[Tuple[str, int]] = []
    for i, m in enumerate(data.get("marks", [])):
        label = str(m.get("label", f"mark{i}"))
        if "sample" in m:
            sample = int(m["sample"])
        elif "time_s" in m:
            sample = int(round(float(m["time_s"]) * sr))
        else:
            raise KeyError(f"第 {i} 个标注点既无 sample 也无 time_s")
        marks.append((label, sample))

    regions: List[EditRegion] = []
    for r in data.get("regions", []):
        start = _resolve_sample(r, "start", sr)
        end = _resolve_sample(r, "end", sr)
        regions.append(
            EditRegion(
                start=start,
                end=end,
                keep_ms=float(r.get("keep_ms", 120.0)),
                enabled=bool(r.get("enabled", True)),
                note=str(r.get("note", "")),
            )
        )
    return AnnotationFile(sample_rate=sr, marks=marks, regions=regions)


def export_annotations(
    path: str,
    engine: EditEngine,
    marks: Sequence[Tuple[str, int]],
) -> List[RemappedMark]:
    """写出重写后的标注。被删点单列 ``deleted_marks`` 供核对, 邻近未删点照常重映射。"""
    remapped = remap_marks(engine, marks)
    sr = engine.sample_rate
    payload: Dict[str, Any] = {
        "sample_rate": sr,
        "marks": [
            {
                "label": m.label,
                "sample": m.dst_sample,
                "time_s": round(m.dst_sample / sr, 6),
                "src_sample": m.src_sample,
                "src_time_s": round(m.src_sample / sr, 6),
            }
            for m in remapped
            if not m.deleted
        ],
        "deleted_marks": [
            {
                "label": m.label,
                "src_sample": m.src_sample,
                "src_time_s": round(m.src_sample / sr, 6),
                "in_region_index": m.region_index,
            }
            for m in remapped
            if m.deleted
        ],
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    return remapped


def export_mapping(path: str, engine: EditEngine) -> None:
    """导出完整的原声<->成品位置对照 (账本)。"""
    sr = engine.sample_rate
    payload: Dict[str, Any] = {
        "sample_rate": sr,
        "src_n_samples": engine.n_src,
        "dst_n_samples": engine.n_dst,
        "deleted_total_samples": engine.deleted_count(),
        "total_removed_samples": engine.total_removed(),
        "kept_segments": [
            {
                "src_start": s.src_start,
                "src_end": s.src_end,
                "dst_start": s.dst_start,
                "dst_end": s.dst_end,
                "src_time_s": [round(s.src_start / sr, 6), round(s.src_end / sr, 6)],
                "dst_time_s": [round(s.dst_start / sr, 6), round(s.dst_end / sr, 6)],
            }
            for s in engine.segments
        ],
        "junctions": [
            {
                "dst_start": j.dst_start,
                "dst_end": j.dst_end,
                "dst_time_s": [round(j.dst_start / sr, 6), round(j.dst_end / sr, 6)],
                "fade_out_src": [j.src_a_start, j.src_a_end],
                "fade_in_src": [j.src_b_start, j.src_b_end],
                "region_index": j.region_index,
            }
            for j in engine.junctions
        ],
        "deleted_spans": [
            {
                "region_index": sp.region_index,
                "src_start": sp.src_start,
                "src_end": sp.src_end,
                "src_time_s": [round(sp.src_start / sr, 6), round(sp.src_end / sr, 6)],
                "n_samples": sp.src_end - sp.src_start,
                "dst_junction": [sp.dst_start, sp.dst_end],
            }
            for sp in engine.deleted
        ],
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def export_mapping_csv(path: str, engine: EditEngine) -> None:
    """位置对照的 CSV 版 (逐段, 方便拿表格软件核对)。"""
    sr = engine.sample_rate
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["kind", "src_start", "src_end", "dst_start", "dst_end",
                    "src_start_s", "src_end_s", "dst_start_s", "dst_end_s"])
        for s in engine.segments:
            w.writerow(["keep", s.src_start, s.src_end, s.dst_start, s.dst_end,
                        round(s.src_start / sr, 6), round(s.src_end / sr, 6),
                        round(s.dst_start / sr, 6), round(s.dst_end / sr, 6)])
        for j in engine.junctions:
            w.writerow(["crossfade", j.src_a_start, j.src_b_end,
                        j.dst_start, j.dst_end,
                        round(j.src_a_start / sr, 6), round(j.src_b_end / sr, 6),
                        round(j.dst_start / sr, 6), round(j.dst_end / sr, 6)])
        for sp in engine.deleted:
            w.writerow(["deleted", sp.src_start, sp.src_end,
                        sp.dst_start, sp.dst_end,
                        round(sp.src_start / sr, 6), round(sp.src_end / sr, 6),
                        round(sp.dst_start / sr, 6), round(sp.dst_end / sr, 6)])
