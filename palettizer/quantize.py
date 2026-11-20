"""Deterministic quantisation of a binary-alpha RGBA image to a palette.

Two rules drive the implementation:

* A pixel is either fully visible or fully transparent, decided by the
  user-controlled alpha threshold.  Fully transparent pixels are *never*
  read: their hidden RGB does not contribute to palette selection, does not
  receive error, and does not pass error on to their neighbours.
* Every visible output pixel is exactly one of the visible palette colours
  (plus the dedicated transparent index for transparent pixels).

Dither patterns are functions of the source image coordinates only.  The
quantiser has no notion of zoom, pan or scroll offset, so changing the view
can never change the pixels.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .color import srgb_u8_to_lab
from .palette import Palette

MODE_NONE = "none"
MODE_ORDERED = "ordered"
MODE_DIFFUSION = "diffusion"

MODE_LABELS = {
    MODE_NONE: "不抖动",
    MODE_ORDERED: "有序抖动",
    MODE_DIFFUSION: "误差扩散",
}
ALL_MODES = (MODE_NONE, MODE_ORDERED, MODE_DIFFUSION)

# 8x8 Bayer matrix.  The values are fixed in image coordinates: entry
# (y % 8, x % 8), never in screen coordinates.
BAYER8 = np.array(
    [
        [0, 32, 8, 40, 2, 34, 10, 42],
        [48, 16, 56, 24, 50, 18, 58, 26],
        [12, 44, 4, 36, 14, 46, 6, 38],
        [60, 28, 52, 20, 62, 30, 54, 22],
        [3, 35, 11, 43, 1, 33, 9, 41],
        [51, 19, 59, 27, 49, 17, 57, 25],
        [15, 47, 7, 39, 13, 45, 5, 37],
        [63, 31, 55, 23, 61, 29, 53, 21],
    ],
    dtype=np.float64,
)
BAYER8 = (BAYER8 + 0.5) / 64.0


@dataclass(frozen=True)
class Settings:
    mode: str = MODE_NONE
    strength: float = 0.5
    alpha_threshold: int = 128

    def __post_init__(self):
        if self.mode not in ALL_MODES:
            raise ValueError(f"unknown dither mode: {self.mode}")
        if not (0.0 <= self.strength <= 1.0):
            raise ValueError("strength must be in 0..1")
        if not (1 <= self.alpha_threshold <= 255):
            raise ValueError("alpha_threshold must be in 1..255")


@dataclass
class Quantized:
    mode: str
    indices: np.ndarray          # (H, W) uint8; visible 0..n-1, transparent = n
    transparent_index: int
    transparent_mask: np.ndarray  # (H, W) bool - pixels actually written with the transparent index
    visible_mask: np.ndarray      # (H, W) bool - alpha mask before the empty-palette override
    counts: np.ndarray            # (n,) int64, visible palette usage
    transparent_count: int
    palette_colors: np.ndarray    # (n, 3) uint8

    @property
    def visible_color_count(self) -> int:
        return int(self.palette_colors.shape[0])

    @property
    def used_visible_colors(self) -> int:
        return int(np.count_nonzero(self.counts))


def visible_mask_for(alpha: np.ndarray, alpha_threshold: int) -> np.ndarray:
    """Binary alpha after thresholding.  alpha == 0 is always transparent."""
    if not (1 <= alpha_threshold <= 255):
        raise ValueError("alpha_threshold must be in 1..255")
    alpha = np.asarray(alpha)
    return (alpha >= alpha_threshold) & (alpha > 0)


class Quantizer:
    """Holds the source in a form that makes repeated recomputes cheap.

    `lab` is computed once for the source image.  Palette lookups are
    recomputed when the palette changes; the expensive k-nearest work is
    always over the fixed source colours.
    """

    def __init__(self, rgba: np.ndarray):
        rgba = np.asarray(rgba, dtype=np.uint8)
        if rgba.ndim != 3 or rgba.shape[2] != 4:
            raise ValueError("rgba must be (H, W, 4)")
        self.rgba = rgba
        self.height, self.width = rgba.shape[:2]
        # Lab is computed for every pixel, but only visible pixels are ever
        # indexed, so hidden RGB has no effect on any result.
        self.lab = srgb_u8_to_lab(rgba[..., :3]).astype(np.float64)

    # ------------------------------------------------------------------
    def result(self, palette: Palette, settings: Settings) -> Quantized:
        colors = palette.as_array()
        n = int(colors.shape[0])
        trans_idx = n
        alpha_visible = visible_mask_for(self.rgba[..., 3], settings.alpha_threshold)
        visible = alpha_visible
        if n == 0:
            # With no visible colours there is nothing that can be painted:
            # every pixel must resolve to the transparent index, including
            # pixels whose alpha is opaque.  This keeps the preview, the
            # statistics and the exported index map mutually consistent.
            visible = np.zeros_like(visible)
        indices = np.full((self.height, self.width), trans_idx, dtype=np.uint8)
        if n == 0:
            vis_idx = np.zeros((0,), dtype=np.uint8)
        else:
            pal_lab = srgb_u8_to_lab(colors)
            if settings.mode == MODE_NONE:
                vis_idx = self._nearest(self.lab[visible], pal_lab)
            elif settings.mode == MODE_ORDERED:
                vis_idx = self._ordered(self.lab, visible, pal_lab, float(settings.strength))
            elif settings.mode == MODE_DIFFUSION:
                vis_idx = self._diffusion(self.lab, visible, pal_lab, float(settings.strength))
            else:  # pragma: no cover - guarded by Settings
                raise ValueError(settings.mode)
        if vis_idx.size:
            indices[visible] = vis_idx.astype(np.uint8)
        trans_mask = ~visible
        counts = (
            np.bincount(vis_idx.astype(np.int64), minlength=n)
            if vis_idx.size
            else np.zeros((n,), dtype=np.int64)
        )
        return Quantized(
            mode=settings.mode,
            indices=indices,
            transparent_index=trans_idx,
            transparent_mask=trans_mask,
            visible_mask=alpha_visible,
            counts=counts.astype(np.int64),
            transparent_count=int(np.count_nonzero(trans_mask)),
            palette_colors=colors,
        )

    # ------------------------------------------------------------------
    @staticmethod
    def _nearest(lab_pixels: np.ndarray, pal_lab: np.ndarray) -> np.ndarray:
        if lab_pixels.shape[0] == 0:
            return np.zeros((0,), dtype=np.int64)
        d = np.sum((lab_pixels[:, None, :] - pal_lab[None, :, :]) ** 2, axis=2)
        return np.argmin(d, axis=1).astype(np.int64)

    @staticmethod
    def _ordered(
        lab_full: np.ndarray, visible: np.ndarray, pal_lab: np.ndarray, strength: float
    ) -> np.ndarray:
        """Ordered dithering between the two nearest palette colours.

        The Bayer threshold is sampled at the *image* coordinate of the
        pixel, so the pattern is anchored to the image and survives panning
        and zooming unchanged.
        """
        pixels = lab_full[visible]
        if pixels.shape[0] == 0:
            return np.zeros((0,), dtype=np.int64)
        if pal_lab.shape[0] == 1 or strength <= 0.0:
            return Quantizer._nearest(pixels, pal_lab)
        d = np.sum((pixels[:, None, :] - pal_lab[None, :, :]) ** 2, axis=2)
        idx1 = np.argmin(d, axis=1)
        if pal_lab.shape[0] >= 2:
            order = np.argpartition(d, 1, axis=1)
            idx2 = order[:, 1]
            c1 = pal_lab[idx1]
            c2 = pal_lab[idx2]
            seg = c2 - c1
            denom = np.einsum("ij,ij->i", seg, seg)
            # Fraction along the c1->c2 segment where the pixel sits.  This
            # is the mixing ratio the Bayer threshold compares against.
            frac = np.einsum("ij,ij->i", pixels - c1, seg) / np.maximum(denom, 1e-12)
            frac = np.clip(frac, 0.0, 1.0)
            ys, xs = np.nonzero(visible)
            threshold = BAYER8[ys % 8, xs % 8]
            take_second = threshold < (frac * strength)
            out = np.where(take_second, idx2, idx1)
        else:  # pragma: no cover - handled above
            out = idx1
        return out.astype(np.int64)

    @staticmethod
    def _diffusion(
        lab_full: np.ndarray, visible: np.ndarray, pal_lab: np.ndarray, strength: float
    ) -> np.ndarray:
        """Floyd-Steinberg error diffusion with transparent-pixel isolation."""
        h, w = visible.shape
        out = np.zeros((h, w), dtype=np.int64)
        if not visible.any():
            return out[visible]
        if pal_lab.shape[0] == 1:
            out[visible] = 0
            return out[visible]
        err = np.zeros((h, w, 3), dtype=np.float64)
        # Fixed raster order keeps results deterministic and the pattern in
        # image coordinates.  The error buffer is only ever touched at
        # visible positions, so a transparent pixel neither accumulates nor
        # forwards error.
        for y in range(h):
            row_visible = visible[y]
            for x in range(w):
                if not row_visible[x]:
                    continue
                target = lab_full[y, x] + err[y, x] * strength
                diff = pal_lab - target
                idx = int(np.argmin(np.einsum("ij,ij->i", diff, diff)))
                out[y, x] = idx
                e = target - pal_lab[idx]
                # Floyd-Steinberg weights.
                if x + 1 < w and visible[y, x + 1]:
                    err[y, x + 1] += e * (7.0 / 16.0)
                if y + 1 < h:
                    if x > 0 and visible[y + 1, x - 1]:
                        err[y + 1, x - 1] += e * (3.0 / 16.0)
                    if visible[y + 1, x]:
                        err[y + 1, x] += e * (5.0 / 16.0)
                    if x + 1 < w and visible[y + 1, x + 1]:
                        err[y + 1, x + 1] += e * (1.0 / 16.0)
        return out[visible]


def render_rgba(result: Quantized) -> np.ndarray:
    """Render a Quantized result to an (H, W, 4) uint8 preview array.

    Transparent pixels are (0, 0, 0, 0); visible pixels carry the exact
    palette colour.  Checkerboard is a UI concern, not part of the result.
    """
    h, w = result.indices.shape
    rgba = np.zeros((h, w, 4), dtype=np.uint8)
    visible = ~result.transparent_mask
    if result.palette_colors.shape[0]:
        rgba[visible, :3] = result.palette_colors[result.indices[visible]]
    rgba[visible, 3] = 255
    return rgba
