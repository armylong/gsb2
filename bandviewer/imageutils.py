"""numpy 数组与 QImage 之间的转换及显示辅助（仅 GUI 模块依赖 PySide6）。"""
from __future__ import annotations

import numpy as np
from PySide6.QtGui import QImage

from .levels import level_index_on_8bit


def gray_to_qimage(gray: np.ndarray, alpha: np.ndarray) -> QImage:
    """[0,1] 灰度+alpha 转 8-bit RGBA QImage（透明区保留为透明）。"""
    h, w = gray.shape
    g8 = np.clip(np.rint(gray * 255.0), 0, 255).astype(np.uint8)
    a8 = np.clip(np.rint(alpha * 255.0), 0, 255).astype(np.uint8)
    rgba = np.empty((h, w, 4), dtype=np.uint8)
    rgba[:, :, 0] = g8
    rgba[:, :, 1] = g8
    rgba[:, :, 2] = g8
    rgba[:, :, 3] = a8
    return qimage_from_rgba(rgba)


def rgb_to_qimage(rgb: np.ndarray, alpha: np.ndarray) -> QImage:
    """[0,1] RGB+alpha 转 8-bit RGBA QImage。"""
    h, w = rgb.shape[:2]
    rgb8 = np.clip(np.rint(rgb * 255.0), 0, 255).astype(np.uint8)
    a8 = np.clip(np.rint(alpha * 255.0), 0, 255).astype(np.uint8)
    rgba = np.empty((h, w, 4), dtype=np.uint8)
    rgba[:, :, :3] = rgb8
    rgba[:, :, 3] = a8
    return qimage_from_rgba(rgba)


def qimage_from_rgba(rgba: np.ndarray) -> QImage:
    """连续内存的 uint8 (H,W,4) -> QImage，拷贝一份以脱离 numpy 生命周期。"""
    if not rgba.flags["C_CONTIGUOUS"]:
        rgba = np.ascontiguousarray(rgba)
    h, w = rgba.shape[:2]
    img = QImage(rgba.data, w, h, w * 4, QImage.Format.Format_RGBA8888)
    return img.copy()


def boundary_overlay(shape: tuple[int, int], mask: np.ndarray) -> QImage:
    """把布尔边界掩膜渲染成半透明红色 RGBA 图。"""
    h, w = shape
    overlay = np.zeros((h, w, 4), dtype=np.uint8)
    overlay[mask] = (255, 40, 40, 220)
    return qimage_from_rgba(overlay)


def levels_swatch(levels: np.ndarray) -> list[tuple[float, int]]:
    """级别展示用：(0-1 值, 8-bit 值) 列表。"""
    return [(float(v), int(q)) for v, q in zip(levels, level_index_on_8bit(levels))]
