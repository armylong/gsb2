"""RGBA -> GIF palette conversion.

GIF stores one byte per pixel indexing a color table of at most 256 RGB
entries plus at most one *fully* transparent index; there is no per-pixel
alpha.  The conversion rules applied here are fixed and shown to the user
before export:

* **Semi-transparency:** every source pixel is classified by an alpha
  threshold (:data::ALPHA_THRESHOLD).  ``alpha >= 128`` becomes a fully opaque
  palette color; ``alpha < 128`` becomes fully transparent.  Anti-aliased
  edges therefore snap to one of the two states — partial alpha cannot be
  represented and is not preserved.
* **Transparent background disabled:** the image is first composited over a
  solid matte (white by default), so every pixel is opaque and no
  transparency is written.
* **Transparent index safety:** when transparency is enabled one palette slot
  is reserved *before* quantization.  Visible colors are quantized to at most
  ``colors - 1`` entries and the reserved slot is filled with a sentinel RGB
  triplet guaranteed not to collide with any quantized color, so the
  transparent index can never alias a visible color (which would cause
  flickering or missing colors across frames).
* No dithering is applied, making the conversion deterministic and stable
  between the preview and the actual export.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from PIL import Image

ALPHA_THRESHOLD = 128
DEFAULT_MATTE = (255, 255, 255)


@dataclass
class QuantizedFrame:
    """Result of converting one RGBA frame to GIF-ready index data."""

    indices: np.ndarray  # uint8 (h, w)
    palette: np.ndarray  # uint8 (n, 3), n is a power of two <= 256
    transparent_index: int | None
    alpha_mask: np.ndarray  # bool (h, w); True where the source became transparent


def _flatten_over_matte(rgba: np.ndarray, matte: tuple[int, int, int]) -> np.ndarray:
    rgb = rgba[..., :3].astype(np.float32)
    alpha = (rgba[..., 3:4].astype(np.float32)) / 255.0
    matte_arr = np.asarray(matte, dtype=np.float32)
    flat = rgb * alpha + matte_arr * (1.0 - alpha)
    out = np.empty_like(rgba)
    out[..., :3] = np.round(flat).astype(np.uint8)
    out[..., 3] = 255
    return out


def _quantize_rgb(rgb: np.ndarray, max_colors: int) -> tuple[np.ndarray, np.ndarray]:
    """Quantize an RGB array to at most ``max_colors`` opaque colors.

    Returns ``(indices, palette)`` where palette has power-of-two length.
    """
    image = Image.fromarray(rgb, "RGB")
    # Pillow's median cut; no dithering for determinism.
    quantized = image.quantize(
        colors=max_colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE
    )
    indices = np.asarray(quantized)
    raw_palette = np.asarray(quantized.getpalette()[: 256 * 3], dtype=np.uint8)
    used = int(indices.max()) + 1 if indices.size else 1
    palette = raw_palette[: used * 3].reshape(used, 3).copy()
    return indices.astype(np.uint8), palette


def _power_of_two_size(n: int) -> int:
    size = 2
    while size < n:
        size <<= 1
    return min(size, 256)


def _sentinel_color(palette: np.ndarray) -> tuple[int, int, int]:
    """Pick an RGB triplet not present in the visible palette."""
    existing = {tuple(color) for color in palette.tolist()}
    for candidate in (
        (255, 0, 255),
        (0, 255, 255),
        (255, 255, 0),
        (1, 2, 3),
    ):
        if candidate not in existing:
            return candidate
    # Exhaustively search (palettes are small).
    for r in range(256):
        for g in range(256):
            for b in range(256):
                candidate = (r, g, b)
                if candidate not in existing:
                    return candidate
    msg = "could not allocate a sentinel color"
    raise RuntimeError(msg)


def quantize_frame(
    rgba: np.ndarray,
    colors: int = 256,
    transparent_background: bool = True,
    matte: tuple[int, int, int] = DEFAULT_MATTE,
) -> QuantizedFrame:
    """Convert one full-canvas RGBA frame into palette-index data."""
    if not 2 <= colors <= 256:
        msg = "colors must be between 2 and 256"
        raise ValueError(msg)
    rgba = np.ascontiguousarray(rgba, dtype=np.uint8)
    if rgba.ndim != 3 or rgba.shape[2] != 4:
        msg = "expected an HxWx4 RGBA array"
        raise ValueError(msg)

    alpha_mask = rgba[..., 3] < ALPHA_THRESHOLD

    if not transparent_background:
        flattened = _flatten_over_matte(rgba, matte)
        indices, palette = _quantize_rgb(flattened[..., :3], colors)
        size = _power_of_two_size(len(palette))
        padded = np.zeros((size, 3), dtype=np.uint8)
        padded[: len(palette)] = palette
        return QuantizedFrame(indices, padded, None, np.zeros_like(alpha_mask))

    if not alpha_mask.any():
        # Fully opaque source: still reserve nothing, use all color slots.
        indices, palette = _quantize_rgb(rgba[..., :3], colors)
        size = _power_of_two_size(len(palette))
        padded = np.zeros((size, 3), dtype=np.uint8)
        padded[: len(palette)] = palette
        return QuantizedFrame(indices, padded, None, alpha_mask)

    # Reserve one slot for transparency; quantize only the opaque pixels.
    indices, palette = _quantize_rgb(rgba[..., :3], colors - 1)
    sentinel = _sentinel_color(palette)
    transparent_index = len(palette)
    palette = np.vstack([palette, np.asarray(sentinel, dtype=np.uint8)])
    indices[alpha_mask] = transparent_index

    size = _power_of_two_size(len(palette))
    padded = np.zeros((size, 3), dtype=np.uint8)
    padded[: len(palette)] = palette
    return QuantizedFrame(indices, padded, transparent_index, alpha_mask)


def quantize_frames(
    frames: list[np.ndarray],
    colors: int = 256,
    transparent_background: bool = True,
    matte: tuple[int, int, int] = DEFAULT_MATTE,
) -> list[QuantizedFrame]:
    return [
        quantize_frame(frame, colors, transparent_background, matte)
        for frame in frames
    ]


def quantized_to_rgba(frame: QuantizedFrame) -> np.ndarray:
    """Render a quantized frame back to RGBA — used for the export preview."""
    h, w = frame.indices.shape
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    rgba[..., :3] = frame.palette[frame.indices]
    rgba[..., 3] = 255
    if frame.transparent_index is not None:
        rgba[frame.indices == frame.transparent_index, 3] = 0
    return rgba
