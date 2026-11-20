"""Build the self-generated demo material.

Everything here is produced from numpy arrays at runtime, so the tool has no
external image dependency.  The set covers what the requirements ask for:

* smooth gradients (a 4-way corner blend and a radial/vignette gradient),
* a small icon with flat colour regions (a heart and a diamond star),
* a colour image with a soft, partially transparent edge (a glowing disc),
* a fully transparent image, and one with hidden RGB under full transparency
  to prove hidden colours are ignored.

All images are at most 256x256 and are generated deterministically.
"""

from __future__ import annotations

import numpy as np

from .color import linear_to_srgb, srgb_to_linear

MAX_DIM = 256


def _check(arr: np.ndarray) -> np.ndarray:
    h, w = arr.shape[:2]
    if h > MAX_DIM or w > MAX_DIM:
        raise ValueError(f"generated image exceeds {MAX_DIM}px: {w}x{h}")
    return np.ascontiguousarray(arr, dtype=np.uint8)


def gradient_corners(size: int = 192, seed: int = 3) -> np.ndarray:
    """Four-corner bilinear blend in linear light with a soft highlight."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float64)
    yy /= size - 1
    xx /= size - 1
    corners = rng.uniform(0.05, 0.95, size=(2, 2, 3))
    top = corners[0, 0] * (1 - xx[..., None]) + corners[0, 1] * xx[..., None]
    bottom = corners[1, 0] * (1 - xx[..., None]) + corners[1, 1] * xx[..., None]
    rgb = top * (1 - yy[..., None]) + bottom * yy[..., None]
    # A gentle sine ripple keeps banding visible so dithering has something
    # to do without making the image noisy.
    ripple = 0.06 * np.sin(yy * np.pi * 3.0)[..., None] * np.sin(xx * np.pi * 2.0)[..., None]
    rgb = np.clip(srgb_to_linear(rgb) + ripple, 0.0, 1.0)
    srgb = np.round(linear_to_srgb(rgb) * 255.0).astype(np.uint8)
    alpha = np.full((size, size, 1), 255, dtype=np.uint8)
    return _check(np.concatenate([srgb, alpha], axis=2))


def gradient_radial(size: int = 160) -> np.ndarray:
    """Radial gradient, warm centre to cool rim."""
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float64)
    cy = cx = (size - 1) / 2.0
    r = np.hypot(yy - cy, xx - cx) / (size * 0.5)
    r = np.clip(r, 0.0, 1.0)
    centre = np.array([1.0, 0.83, 0.35])
    rim = np.array([0.09, 0.13, 0.42])
    rgb = centre[None, None, :] * (1 - r[..., None]) + rim[None, None, :] * r[..., None]
    band = 0.05 * np.sin(r * np.pi * 6.0)[..., None]
    rgb = np.clip(srgb_to_linear(rgb) + band, 0.0, 1.0)
    alpha = np.full((size, size, 1), 255, dtype=np.uint8)
    return _check(np.concatenate([np.round(linear_to_srgb(rgb) * 255).astype(np.uint8), alpha], axis=2))


def icon_heart(size: int = 64) -> np.ndarray:
    """Flat-colour heart icon with a hard outline (good for colour locking)."""
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float64)
    # Normalised coordinates in [-1.1, 1.1].
    x = (xx - (size - 1) / 2.0) / (size * 0.45)
    y = (yy - (size * 0.52)) / (size * 0.45)
    heart = (x * x + y * y - 1.0) ** 3 - x * x * y * y * y <= 0.0
    rgba = np.zeros((size, size, 4), dtype=np.uint8)
    rgba[heart, :3] = (226, 46, 84)
    rgba[heart, 3] = 255
    # A highlight blob and a darker base give at least two locked-worthy hues.
    highlight = heart & (y < -0.35) & (x < 0.1)
    rgba[highlight, :3] = (255, 168, 178)
    base = heart & (y > 0.55)
    rgba[base, :3] = (128, 20, 44)
    return _check(rgba)


def icon_star(size: int = 48) -> np.ndarray:
    """Flat diamond star on transparent background, crisp binary alpha."""
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float64)
    cx = cy = (size - 1) / 2.0
    dx = np.abs(xx - cx)
    dy = np.abs(yy - cy)
    star = dx + dy <= size * 0.42
    inner = dx + dy <= size * 0.18
    rgba = np.zeros((size, size, 4), dtype=np.uint8)
    rgba[star, :3] = (255, 196, 62)
    rgba[star, 3] = 255
    rgba[inner, :3] = (255, 252, 230)
    # Hidden RGB below the star: fully transparent pixel with a vivid colour.
    # It must not influence the palette or the error diffusion.
    hidden = ~star
    rgba[hidden, :3] = (0, 255, 0)
    rgba[hidden, 3] = 0
    return _check(rgba)


def edge_glow(size: int = 128) -> np.ndarray:
    """Coloured disc with a soft, semi-transparent edge.

    The alpha ramp exercises the threshold control.  Hidden RGB outside the
    disc is set to a saturated magenta so that ignoring it is observable.
    """
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float64)
    cx = cy = (size - 1) / 2.0
    r = np.hypot(yy - cy, xx - cx) / (size * 0.5)
    # Hue swirl around the disc, strongly coloured.
    angle = np.arctan2(yy - cy, xx - cx)
    hue = (angle + np.pi) / (2 * np.pi)
    rgb = np.stack(
        [
            0.5 + 0.5 * np.cos(2 * np.pi * (hue + 0.0)),
            0.5 + 0.5 * np.cos(2 * np.pi * (hue + 0.33)),
            0.5 + 0.5 * np.cos(2 * np.pi * (hue + 0.66)),
        ],
        axis=-1,
    )
    # Soft edge between r=0.72 and r=1.0.
    alpha = np.clip((1.02 - r) / 0.30, 0.0, 1.0)
    alpha = np.round(alpha * 255.0).astype(np.uint8)
    srgb = np.round(np.clip(rgb, 0, 1) * 255.0).astype(np.uint8)
    hidden = alpha == 0
    srgb[hidden] = (255, 0, 255)
    rgba = np.concatenate([srgb, alpha[..., None]], axis=2)
    return _check(rgba)


def fully_transparent(size: int = 64) -> np.ndarray:
    """Fully transparent image with vivid hidden RGB."""
    rgba = np.zeros((size, size, 4), dtype=np.uint8)
    rgba[..., :3] = (255, 0, 128)
    return _check(rgba)


DEMOS = {
    "gradient_corners": ("四角渐变", gradient_corners),
    "gradient_radial": ("径向渐变", gradient_radial),
    "icon_heart": ("心形图标", icon_heart),
    "icon_star": ("菱形星（透明边缘）", icon_star),
    "edge_glow": ("彩色透明边缘", edge_glow),
    "fully_transparent": ("全透明图", fully_transparent),
}


def demo_rgba(name: str) -> np.ndarray:
    if name not in DEMOS:
        raise KeyError(name)
    return DEMOS[name][1]()
