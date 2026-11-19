"""导出与载入: 透明 PNG、距离场数值 (.npy)、参数记录 (.json)。

PNG 只含重建结果本身 (RGBA, 透明背景), 不带任何辅助线;
导出尺寸 = round(N * scale), 与预览使用完全相同的映射与参数。
.npy + .json 可重新载入并复现同一轮廓。
"""
from __future__ import annotations

import json
import os

import numpy as np
from PySide6.QtGui import QImage


def save_png_rgba(path: str, rgba: np.ndarray) -> None:
    """rgba: (H, W, 4) uint8。"""
    h, w = rgba.shape[:2]
    buf = np.ascontiguousarray(rgba)
    img = QImage(buf.data, w, h, 4 * w, QImage.Format.Format_RGBA8888).copy()
    if not img.save(path, "PNG"):
        raise IOError(f"无法写出 PNG: {path}")


def read_png_rgba(path: str) -> np.ndarray:
    img = QImage(path).convertToFormat(QImage.Format.Format_RGBA8888)
    if img.isNull():
        raise IOError(f"无法读取 PNG: {path}")
    w, h = img.width(), img.height()
    ptr = img.bits()
    arr = np.frombuffer(ptr, dtype=np.uint8, count=h * img.bytesPerLine())
    arr = arr.reshape(h, img.bytesPerLine())[:, : 4 * w].reshape(h, w, 4)
    return arr.copy()


def save_sdf_bundle(base_path: str, sdf: np.ndarray, params: dict) -> dict:
    """写出 <base>_sdf.npy 与 <base>_params.json, 返回实际路径。"""
    npy_path = base_path + "_sdf.npy"
    json_path = base_path + "_params.json"
    np.save(npy_path, sdf.astype(np.float32))
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(params, f, ensure_ascii=False, indent=2)
    return {"npy": npy_path, "json": json_path}


def load_sdf_bundle(npy_path: str):
    """载入距离场与参数记录。返回 (sdf float32, params dict)。"""
    sdf = np.load(npy_path).astype(np.float32)
    base = npy_path[:-4] if npy_path.endswith(".npy") else npy_path
    if base.endswith("_sdf"):
        base = base[:-4]
    json_path = base + "_params.json"
    params = {}
    if os.path.exists(json_path):
        with open(json_path, "r", encoding="utf-8") as f:
            params = json.load(f)
    return sdf, params
