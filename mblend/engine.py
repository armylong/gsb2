"""Blending engine: per-pixel and multi-resolution blending on linear light.

Everything here works on linear-light float32 RGB in [0, 1].  The mask is a
float32 H×W array (1 = take A, 0 = take B).  Conversions to sRGB happen only
at the display/export boundary (see :mod:`mblend.color`).

The A/B Laplacian pyramids are cached per level count; changing the mask only
rebuilds the mask pyramid and the reconstruction, which keeps the interactive
canvas responsive.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .color import rgb8_to_linear
from .pyramid import Pyramid, blend_pyramids, build_pyramid, max_levels

MODE_NAIVE = "naive"
MODE_PYRAMID = "pyramid"


@dataclass(frozen=True)
class BlendConfig:
    mode: str = MODE_PYRAMID
    levels: int = 4

    def validate(self, height: int, width: int) -> "BlendConfig":
        if self.mode not in (MODE_NAIVE, MODE_PYRAMID):
            raise ValueError(f"unknown blend mode: {self.mode}")
        limit = max_levels(height, width)
        if self.mode == MODE_PYRAMID:
            if limit < 1:
                raise ValueError("图像尺寸过小，无法进行多分辨率分解")
            if not 2 <= self.levels <= min(6, limit):
                raise ValueError(
                    f"{width}×{height} 支持 2–{min(6, limit)} 层，请求了 {self.levels} 层"
                )
        return self


class BlendEngine:
    """Holds a fixed image pair and computes both blend flavours."""

    def __init__(self, image_a_rgb8: np.ndarray, image_b_rgb8: np.ndarray) -> None:
        if image_a_rgb8.shape != image_b_rgb8.shape:
            raise ValueError("image sizes differ")
        if image_a_rgb8.ndim != 3 or image_a_rgb8.shape[2] != 3:
            raise ValueError("expected H×W×3 RGB data")
        self.a_rgb8 = np.ascontiguousarray(image_a_rgb8, dtype=np.uint8)
        self.b_rgb8 = np.ascontiguousarray(image_b_rgb8, dtype=np.uint8)
        self.height, self.width = self.a_rgb8.shape[:2]
        self.a_linear = rgb8_to_linear(self.a_rgb8)
        self.b_linear = rgb8_to_linear(self.b_rgb8)
        self.max_levels = max_levels(self.height, self.width)
        self._cache_levels: int | None = None
        self._pyramid_a: Pyramid | None = None
        self._pyramid_b: Pyramid | None = None
        self._revision = 0

    # -- pyramids --------------------------------------------------------
    def _pyramids(self, levels: int) -> tuple[Pyramid, Pyramid]:
        if self._cache_levels != levels:
            self._pyramid_a = build_pyramid(self.a_linear, levels)
            self._pyramid_b = build_pyramid(self.b_linear, levels)
            self._cache_levels = levels
        assert self._pyramid_a is not None and self._pyramid_b is not None
        return self._pyramid_a, self._pyramid_b

    def mask_pyramid(self, mask: np.ndarray, levels: int) -> Pyramid:
        if mask.shape != (self.height, self.width):
            raise ValueError("mask size does not match images")
        return build_pyramid(mask[..., None].astype(np.float32), levels)

    # -- blending --------------------------------------------------------
    def naive_result(self, mask: np.ndarray) -> np.ndarray:
        m = mask[..., None].astype(np.float32)
        return np.ascontiguousarray(m * self.a_linear + (1.0 - m) * self.b_linear)

    def pyramid_result(self, mask: np.ndarray, levels: int) -> np.ndarray:
        pyramid_a, pyramid_b = self._pyramids(levels)
        mask_pyramid = self.mask_pyramid(mask, levels)
        return blend_pyramids(pyramid_a, pyramid_b, mask_pyramid)

    def result(self, mask: np.ndarray, config: BlendConfig) -> np.ndarray:
        config.validate(self.height, self.width)
        self._revision += 1
        if config.mode == MODE_NAIVE:
            return self.naive_result(mask)
        return self.pyramid_result(mask, config.levels)

    def reference(self, mask: np.ndarray, config: BlendConfig) -> np.ndarray:
        """The other blend flavour for the same mask, for the comparison tab."""
        if config.mode == MODE_NAIVE and self.max_levels >= 2:
            return self.pyramid_result(mask, config.levels)
        return self.naive_result(mask)

    # -- per-level inspection -------------------------------------------
    def level_views(self, mask: np.ndarray, levels: int) -> list[dict]:
        """Data for the level inspector, finest first.

        Each entry holds the low-pass image and signed detail band of both
        inputs plus the low-pass mask at that level, all at the level size.
        The display of details may add a grey bias; the values returned here
        are the raw signed values used by the computation.
        """
        pyramid_a, pyramid_b = self._pyramids(levels)
        mask_pyramid = self.mask_pyramid(mask, levels)
        out: list[dict] = []
        for index in range(levels):
            detail_a = pyramid_a.details[index]
            detail_b = pyramid_b.details[index]
            out.append(
                {
                    "index": index,
                    "size": pyramid_a.sizes[index],
                    "low_a": pyramid_a.gaussians[index],
                    "low_b": pyramid_b.gaussians[index],
                    "detail_a": detail_a,
                    "detail_b": detail_b,
                    "mask": mask_pyramid.gaussians[index][..., 0],
                    "detail_a_range": (
                        float(detail_a.min()),
                        float(detail_a.max()),
                    ),
                    "detail_b_range": (
                        float(detail_b.min()),
                        float(detail_b.max()),
                    ),
                }
            )
        return out

    def residual_view(self, levels: int) -> dict:
        pyramid_a, pyramid_b = self._pyramids(levels)
        return {
            "size": pyramid_a.residual.shape[:2],
            "low_a": pyramid_a.residual,
            "low_b": pyramid_b.residual,
        }
