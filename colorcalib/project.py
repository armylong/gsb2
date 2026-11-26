"""可重开的色格取样设置（JSON 本地文件）。

设置文件只保存取样布局与角色分工，不保存图像像素本身；
重新打开时按路径加载原图与参考数据，再恢复所有 ROI。
调参考数据期间原图不会被修改。
"""

from __future__ import annotations

import json
from dataclasses import asdict

from .sampling import ROIRect

_SETTINGS_VERSION = 1


def save_project(
    path: str,
    image_path: str,
    reference_path: str,
    rois: list[ROIRect],
    model_kind: str,
) -> None:
    data = {
        "version": _SETTINGS_VERSION,
        "image_path": image_path,
        "reference_path": reference_path,
        "model_kind": model_kind,
        "rois": [asdict(r) for r in rois],
    }
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def load_project(path: str) -> dict:
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict) or data.get("version") != _SETTINGS_VERSION:
        raise ValueError("设置文件版本不支持或文件已损坏")
    rois = []
    for item in data.get("rois", []):
        missing = {"patch_id", "x0", "y0", "x1", "y1"} - set(item)
        if missing:
            raise ValueError(f"ROI 记录缺少字段: {sorted(missing)}")
        rois.append(
            ROIRect(
                patch_id=str(item["patch_id"]),
                x0=int(item["x0"]),
                y0=int(item["y0"]),
                x1=int(item["x1"]),
                y1=int(item["y1"]),
                role=str(item.get("role", "fit")),
                enabled=bool(item.get("enabled", True)),
            )
        )
    return {
        "image_path": data.get("image_path", ""),
        "reference_path": data.get("reference_path", ""),
        "model_kind": data.get("model_kind", "full"),
        "rois": rois,
    }
