"""导出: 干净校正图、带编号检查图、坐标 JSON。纯函数, 不依赖 GUI。"""
from __future__ import annotations

import json
from pathlib import Path

import cv2
import numpy as np

from . import geometry as geo


def _round2(v, nd=3):
    return [round(float(v[0]), nd), round(float(v[1]), nd)]


def build_payload(source_image: str, corners, width: int, height: int, records) -> dict:
    """records: [{"id", "source":[x,y], "rectified":[u,v]|None, "in_region":bool}]"""
    pts = []
    for rec in records:
        pts.append(
            {
                "id": int(rec["id"]),
                "source": _round2(rec["source"]),
                "rectified": None if rec["rectified"] is None else _round2(rec["rectified"]),
                "in_region": bool(rec["in_region"]),
            }
        )
    return {
        "source_image": source_image,
        "coordinate_origin": "top-left pixel center",
        "corners": {
            name: _round2(c) for name, c in zip(geo.CORNER_NAMES, corners)
        },
        "output": {"width": int(width), "height": int(height)},
        "points": pts,
    }


def draw_check_image(warped_bgr: np.ndarray, records) -> np.ndarray:
    """在校正图副本上绘制区内标注点编号; 区外的点不画。"""
    img = warped_bgr.copy()
    h, w = img.shape[:2]
    r = max(4, min(w, h) // 120)
    font_scale = max(0.45, r / 9.0)
    for rec in records:
        if not rec["in_region"] or rec["rectified"] is None:
            continue
        u, v = rec["rectified"]
        if not geo.inside_output(u, v, w, h):
            continue
        cx, cy = int(round(u)), int(round(v))
        cv2.circle(img, (cx, cy), r, (0, 0, 255), 2, cv2.LINE_AA)
        cv2.putText(
            img, str(rec["id"]), (cx + r + 2, cy - r - 2),
            cv2.FONT_HERSHEY_SIMPLEX, font_scale, (0, 0, 255), 2, cv2.LINE_AA,
        )
    return img


def export_all(out_dir, warped_bgr, records, corners, size, source_image) -> dict:
    """写出 rectified.png / check.png / coords.json, 返回路径字典。"""
    d = Path(out_dir)
    d.mkdir(parents=True, exist_ok=True)
    w, h = int(size[0]), int(size[1])
    assert warped_bgr.shape[0] == h and warped_bgr.shape[1] == w, "校正图尺寸与约定不符"

    rect_path = d / "rectified.png"
    check_path = d / "check.png"
    json_path = d / "coords.json"

    cv2.imwrite(str(rect_path), warped_bgr)
    cv2.imwrite(str(check_path), draw_check_image(warped_bgr, records))
    payload = build_payload(source_image, corners, w, h, records)
    json_path.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8"
    )
    return {"rectified": rect_path, "check": check_path, "json": json_path}
