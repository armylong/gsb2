"""图像读取与显示辅助。"""
from __future__ import annotations

import cv2
import numpy as np

MAX_LONG_EDGE = 1600


class ImageLoadError(RuntimeError):
    pass


def _to_gray(img: np.ndarray) -> np.ndarray:
    if img.ndim == 2:
        return img
    if img.ndim != 3:
        raise ImageLoadError("不支持的图像维度")
    if img.shape[2] == 4:
        img = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)
    if img.shape[2] == 3:
        return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    raise ImageLoadError("不支持的通道数")


def fit_long_edge(img: np.ndarray, max_long: int = MAX_LONG_EDGE) -> np.ndarray:
    """长边超过 max_long 时按面积插值缩小；长边以内原样返回。"""
    h, w = img.shape[:2]
    if max(h, w) <= max_long:
        return img
    scale = max_long / max(h, w)
    return cv2.resize(img, (max(1, int(round(w * scale))), max(1, int(round(h * scale)))),
                      interpolation=cv2.INTER_AREA)


def load_image(path: str) -> tuple[np.ndarray, np.ndarray, dict]:
    """按原尺寸读取图片，返回 (原图, 灰度图, 信息)。

    - 支持 png/jpeg/bmp/tif 的灰度或彩色图；带 alpha 的 png 先合成到白底。
    - **不缩放**：像素坐标、面积与导出的标签图都对应文件的原始分辨率，
      因此“导出原尺寸”成立。长边超过 1600 时在 info["over_limit"] 中提示，
      但依旧按原尺寸处理（工具保证支持的输入范围是长边 ≤ 1600）。
    """
    try:
        raw = np.fromfile(path, dtype=np.uint8)
    except OSError as exc:
        raise ImageLoadError(f"无法读取文件：{exc}") from exc
    if raw.size == 0:
        raise ImageLoadError("文件为空")
    img = cv2.imdecode(raw, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise ImageLoadError("不是可识别的 png/jpeg/bmp/tif 图像")
    if img.dtype != np.uint8:
        raise ImageLoadError(f"仅支持 8 位图像，当前为 {img.dtype}")
    if img.ndim == 3 and img.shape[2] == 4:
        alpha = img[:, :, 3:4].astype(np.float32) / 255.0
        bgr = img[:, :, :3].astype(np.float32)
        img = np.clip(bgr * alpha + 255.0 * (1.0 - alpha), 0, 255).astype(np.uint8)
    elif img.ndim == 3 and img.shape[2] not in (1, 3):
        raise ImageLoadError(f"不支持的通道数：{img.shape[2]}")
    if img.ndim == 3 and img.shape[2] == 1:
        img = img[:, :, 0]
    h, w = img.shape[:2]
    gray = _to_gray(img)
    info = {
        "path": path,
        "original_size": (w, h),
        "size": (w, h),
        "resized": False,
        "color": bool(img.ndim == 3),
        "scale": 1.0,
        "over_limit": max(h, w) > MAX_LONG_EDGE,
    }
    return img, gray, info


def make_thumbnail(gray: np.ndarray, size: tuple[int, int] | None = None) -> np.ndarray:
    h, w = gray.shape[:2]
    if size is None:
        scale = min(1.0, 240.0 / max(h, w))
        size = (max(1, int(w * scale)), max(1, int(h * scale)))
    return cv2.resize(gray, size, interpolation=cv2.INTER_AREA)
