"""导出: 公共有效区的完整分辨率结果 PNG + 来源编号图 PNG + 设置 JSON。

结果图与来源图使用完全相同的裁切(公共有效区外接矩形)。
"""
from __future__ import annotations

import json
from dataclasses import asdict
from pathlib import Path

import cv2
import numpy as np

from .alignment import AlignParams
from .fusion import FusionParams
from .pipeline import SOURCE_COLORS_BGR, Results, Stroke

APP_VERSION = "0.1.0"


def colorize_label(label: np.ndarray, n: int) -> np.ndarray:
    """来源编号图着色; 255(无有效来源)显示为深灰。"""
    out = np.full(label.shape + (3,), (40, 40, 40), dtype=np.uint8)
    for i in range(n):
        out[label == i] = SOURCE_COLORS_BGR[i % len(SOURCE_COLORS_BGR)]
    return out


def export_all(
    outdir: str | Path,
    names: list[str],
    ref: int,
    aligns: list[AlignParams],
    params: FusionParams,
    strokes: list[Stroke],
    results: Results,
) -> dict[str, Path]:
    out = Path(outdir)
    out.mkdir(parents=True, exist_ok=True)
    x, y, w, h = results.crop

    result = results.img_final[y : y + h, x : x + w]
    label = results.label_final[y : y + h, x : x + w]
    source_map = colorize_label(label, len(names))

    p_result = out / "result.png"
    p_source = out / "source_map.png"
    p_settings = out / "settings.json"
    cv2.imwrite(str(p_result), result)
    cv2.imwrite(str(p_source), source_map)

    settings = {
        "app": "focusstack",
        "version": APP_VERSION,
        "images": list(names),
        "reference": ref,
        "align": [asdict(a) for a in aligns],
        "fusion": asdict(params),
        "crop": {"x": x, "y": y, "w": w, "h": h},
        "strokes": [
            {
                "source": st.source,
                "radius": st.radius,
                "points": [[round(px, 2), round(py, 2)] for px, py in st.points],
            }
            for st in strokes
        ],
    }
    p_settings.write_text(json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"result": p_result, "source_map": p_source, "settings": p_settings}


def strokes_from_settings(data: dict) -> list[Stroke]:
    return [
        Stroke(
            points=[(float(px), float(py)) for px, py in s["points"]],
            radius=float(s["radius"]),
            source=int(s["source"]),
        )
        for s in data.get("strokes", [])
    ]
