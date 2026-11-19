"""Small numpy helpers used by the UI for scaling images for display."""

from __future__ import annotations

import cv2
import numpy as np


def resize_rgba(rgba: np.ndarray, width: int, height: int) -> np.ndarray:
    """Resize an RGBA uint8 overlay, interpolating colour and alpha separately.

    Premultiplying avoids dark halos at the edges of a transparent overlay.
    """
    if rgba.shape[1] == width and rgba.shape[0] == height:
        return rgba
    src = rgba.astype(np.float32) / 255.0
    alpha = src[..., 3]
    premult = src[..., :3] * alpha[..., None]
    size = (max(1, width), max(1, height))
    interp = cv2.INTER_AREA if width < rgba.shape[1] else cv2.INTER_LINEAR
    rgb = cv2.resize(premult, size, interpolation=interp)
    a = cv2.resize(alpha, size, interpolation=interp)
    out = np.empty((size[1], size[0], 4), dtype=np.float32)
    safe = np.maximum(a, 1e-6)
    out[..., :3] = np.clip(rgb / safe[..., None], 0.0, 1.0)
    out[..., 3] = np.clip(a, 0.0, 1.0)
    return np.clip(np.rint(out * 255.0), 0, 255).astype(np.uint8)


def resize_rgb8(rgb: np.ndarray, width: int, height: int) -> np.ndarray:
    if rgb.shape[1] == width and rgb.shape[0] == height:
        return rgb
    interp = cv2.INTER_AREA if width < rgb.shape[1] else cv2.INTER_LINEAR
    return cv2.resize(rgb, (max(1, width), max(1, height)), interpolation=interp)


def detail_to_rgb8(
    detail: np.ndarray,
    scale: float,
    bias: float = 0.5,
) -> np.ndarray:
    """Map a signed detail image to a displayable grey-biased RGB image.

    The value range is visualised with a grey bias (``bias``) and a gain
    (``scale``); neither the bias nor the gain ever enters the blend or the
    export calculation.  ``detail`` may be 2-D (single channel) or H×W×C.
    """
    if detail.ndim == 2:
        preview = np.repeat(detail[..., None], 3, axis=2)
    else:
        preview = detail
    display = np.clip(bias + preview * scale, 0.0, 1.0)
    return np.clip(np.rint(display * 255.0), 0, 255).astype(np.uint8)


def gray_to_rgb8(gray: np.ndarray) -> np.ndarray:
    g = np.clip(gray, 0.0, 1.0)
    scaled = np.clip(np.rint(g * 255.0), 0, 255).astype(np.uint8)
    return np.repeat(scaled[..., None], 3, axis=2)
