"""图片读写与导出(PNG 单块 + 参数 JSON + 保护掩码)。"""
from __future__ import annotations

import json
import os

import cv2
import numpy as np

from .core import validate_image


def load_image(path: str) -> np.ndarray:
    """读取 png/jpeg,按普通不透明 sRGB 处理(丢弃 alpha),返回 RGB uint8。"""
    bgr = cv2.imread(path, cv2.IMREAD_COLOR)  # 丢弃 alpha,按不透明处理
    if bgr is None:
        from .core import ImageValidationError
        raise ImageValidationError(f"无法读取图片: {path}")
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    return validate_image(rgb)


def save_png(path: str, rgb: np.ndarray) -> None:
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    if not cv2.imwrite(path, bgr):
        raise IOError(f"写入失败: {path}")


def save_mask_png(path: str, mask: np.ndarray) -> None:
    if not cv2.imwrite(path, (mask.astype(np.uint8) * 255)):
        raise IOError(f"写入失败: {path}")


def export_tile(base_path: str, tile: np.ndarray, mask: np.ndarray,
                params: dict) -> dict:
    """导出单块 PNG、参数 JSON、保护掩码 PNG。

    base_path 可带或不带 .png 后缀。返回实际写出的三个路径。
    PNG 无损,重新读入平铺与当前预览逐像素一致。
    """
    if base_path.lower().endswith(".png"):
        base_path = base_path[:-4]
    png_path = base_path + ".png"
    json_path = base_path + ".params.json"
    mask_path = base_path + ".mask.png"
    save_png(png_path, tile)
    save_mask_png(mask_path, mask)
    params = dict(params)
    params.setdefault("files", {})
    params["files"].update({
        "tile": os.path.basename(png_path),
        "mask": os.path.basename(mask_path),
    })
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(params, f, ensure_ascii=False, indent=2)
    return {"tile": png_path, "params": json_path, "mask": mask_path}
