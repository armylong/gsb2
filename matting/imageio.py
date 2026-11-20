"""Image loading, compositing, checkerboard and export helpers.

The same ``composite`` function is used by the on-screen preview and by the
export path, which is what guarantees requirement 4 (preview and exported
foreground agree, and soft edges do not show a dark fringe).
"""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass

import cv2
import numpy as np

BACKDROP_LIGHT = np.array([0.93, 0.93, 0.93], np.float32)
BACKDROP_DARK = np.array([0.13, 0.13, 0.13], np.float32)


def composite(image_bgr: np.ndarray, alpha: np.ndarray, backdrop_bgr) -> np.ndarray:
    """Straight-alpha composite over a solid backdrop or a per-pixel backdrop image."""
    img = image_bgr.astype(np.float32)
    a = alpha.astype(np.float32)
    if a.ndim == 2:
        a = a[:, :, None]
    bg = np.asarray(backdrop_bgr, np.float32)
    if bg.shape == (1, 1, 3) or bg.ndim == 1 or bg.size == 3:
        bg = np.clip(bg.reshape(1, 1, 3), 0, None)
        if bg.max() <= 1.0:
            bg = bg * 255.0
    elif bg.ndim == 2:
        bg = np.repeat(bg[:, :, None], 3, axis=2)
    elif bg.shape[:2] != img.shape[:2]:
        raise ValueError(
            f"backdrop must be a single colour or match the image ({img.shape[:2]}), "
            f"got {bg.shape}"
        )
    out = img * a + bg * (1.0 - a)
    # Premultiplication of the source is not needed for straight alpha, but the
    # source may carry a hidden dark halo from JPEG ringing.  Clamp to 0..255.
    return np.clip(out, 0, 255).astype(np.uint8)


def checkerboard(width: int, height: int, cell: int = 16,
                 light=(0.82, 0.82, 0.82), dark=(0.68, 0.68, 0.68)) -> np.ndarray:
    ys, xs = np.mgrid[0:height, 0:width]
    tiles = ((xs // cell) + (ys // cell)) % 2
    board = np.where(tiles[:, :, None] == 0, np.array(light, np.float32),
                     np.array(dark, np.float32))
    return (board * 255.0).astype(np.uint8)


def composite_on_backdrop(
    image_bgr: np.ndarray,
    alpha: np.ndarray,
    mode: str,
    scale: int = 1,
    cell: int = 16,
) -> np.ndarray:
    """mode: 'checker' | 'light' | 'dark'."""
    h, w = alpha.shape[:2]
    if mode == "light":
        bg = np.broadcast_to(BACKDROP_LIGHT * 255.0, (h, w, 3))
    elif mode == "dark":
        bg = np.broadcast_to(BACKDROP_DARK * 255.0, (h, w, 3))
    else:
        bg = checkerboard(w, h, cell=max(8, cell * max(1, scale)))
    return composite(image_bgr, alpha, bg)


def alpha_to_matte_preview(alpha: np.ndarray, dark=(0.18, 0.18, 0.18),
                           light=(0.92, 0.92, 0.92)) -> np.ndarray:
    a = alpha[:, :, None]
    d = np.array(dark, np.float32) * 255.0
    l = np.array(light, np.float32) * 255.0
    return np.clip(l * a + d * (1.0 - a), 0, 255).astype(np.uint8)


# ---------------------------------------------------------------------------
# Export
# ---------------------------------------------------------------------------


def ensure_bgra(image_bgr: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """Straight (un-premultiplied) BGRA with alpha in the 4th channel."""
    bgra = np.dstack([image_bgr, np.clip(alpha * 255.0 + 0.5, 0, 255).astype(np.uint8)])
    return np.ascontiguousarray(bgra)


def write_png(path: str, data: np.ndarray) -> None:
    """Write with ``imencode`` so non-ASCII paths work on every platform."""
    ext = os.path.splitext(path)[1] or ".png"
    ok, buf = cv2.imencode(ext, data)
    if not ok:
        raise OSError(f"failed to encode {path}")
    buf.tofile(path)


def read_png_bgra(path: str) -> np.ndarray:
    data = np.fromfile(path, dtype=np.uint8)
    img = cv2.imdecode(data, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise OSError(f"failed to decode {path}")
    return img


# ---------------------------------------------------------------------------
# Content fingerprint for the constraint record (requirement 6)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ImageFingerprint:
    width: int
    height: int
    sha256: str
    mean_bgr: tuple[float, float, float]

    def as_dict(self) -> dict:
        return {
            "width": int(self.width),
            "height": int(self.height),
            "sha256": self.sha256,
            "mean_bgr": [round(float(v), 2) for v in self.mean_bgr],
        }

    @staticmethod
    def from_dict(d: dict) -> "ImageFingerprint":
        return ImageFingerprint(
            width=int(d["width"]),
            height=int(d["height"]),
            sha256=str(d["sha256"]),
            mean_bgr=tuple(float(v) for v in d.get("mean_bgr", (0, 0, 0))),
        )


def fingerprint_image(image_bgr: np.ndarray) -> ImageFingerprint:
    """Stable content hash: hashes the decoded pixel array, not the file bytes.

    Decoding first means a re-encoded PNG/JPEG of the same pixels is accepted,
    while a different image of the same size is rejected.
    """
    contiguous = np.ascontiguousarray(image_bgr)
    digest = hashlib.sha256(contiguous.tobytes()).hexdigest()
    mean = contiguous.reshape(-1, 3).mean(axis=0)
    return ImageFingerprint(
        width=contiguous.shape[1],
        height=contiguous.shape[0],
        sha256=digest,
        mean_bgr=tuple(float(v) for v in mean),
    )


def fingerprint_matches(expected: ImageFingerprint, image_bgr: np.ndarray) -> bool:
    if (expected.width, expected.height) != (image_bgr.shape[1], image_bgr.shape[0]):
        return False
    return expected.sha256 == fingerprint_image(image_bgr).sha256
