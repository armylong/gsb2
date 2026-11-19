"""Laplacian pyramid with exact, odd-size reconstruction.

The pyramid has ``L`` detail levels and one extra coarse residual layer.
Level ``i`` (0 = finest) stores a low-pass image ``gaussians[i]`` at its own
size and a signed detail band

    details[i] = gaussians[i] - expand(gaussians[i + 1])

for every one of the ``L`` levels, so the level inspector always has a
low-pass image, a detail image and a mask for every level.  The coarsest
Gaussian (``gaussians[L]``) is kept as the residual used for reconstruction.

Sizes are ``ceil(size / 2)`` at every coarser level.  Expansion is phase
aware: even output positions and odd output positions use separately
normalised tap sets.  Therefore a constant image stays constant, a
reconstruction has exactly the input width and height (no half-pixel shift,
no dropped row/column) and there is no darkening at the borders.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

# Analysis Gaussian in fine-pixel units (5 taps, sigma = 1 px).
_ANALYSIS_KERNEL = np.array([0.0545, 0.2442, 0.4026, 0.2442, 0.0545], dtype=np.float32)
_ANALYSIS_KERNEL /= _ANALYSIS_KERNEL.sum()

# Synthesis Gaussian sampled at fine-pixel distances 0, 1, 2, 3, 4.
_SYNTH_SIGMA = 1.0
_SYNTH_TAPS = np.exp(
    -(np.arange(5, dtype=np.float32) ** 2) / (2.0 * _SYNTH_SIGMA**2)
).astype(np.float32)
# even fine position: coarse offsets -2,-1,0,+1,+2 -> distances 4,2,0,2,4
_EVEN_WEIGHTS = np.array(
    [_SYNTH_TAPS[4], _SYNTH_TAPS[2], _SYNTH_TAPS[0], _SYNTH_TAPS[2], _SYNTH_TAPS[4]],
    dtype=np.float32,
)
_EVEN_WEIGHTS /= _EVEN_WEIGHTS.sum()
# odd fine position: coarse offsets -1,0,+1,+2 -> distances 3,1,1,3
_ODD_WEIGHTS = np.array(
    [_SYNTH_TAPS[3], _SYNTH_TAPS[1], _SYNTH_TAPS[1], _SYNTH_TAPS[3]],
    dtype=np.float32,
)
_ODD_WEIGHTS /= _ODD_WEIGHTS.sum()

_PAD = 2


def reduce_size(height: int, width: int) -> tuple[int, int]:
    return (height + 1) // 2, (width + 1) // 2


def max_levels(height: int, width: int, cap: int = 6) -> int:
    """Number of detail levels this size can hold.

    Every level halves the size (rounding up).  A residual of at least one
    pixel is required, so e.g. 2×2 supports one level and anything smaller
    supports none (only per-pixel blending).
    """
    if height < 1 or width < 1:
        return 0
    levels = 0
    current_h, current_w = height, width
    while levels < cap and (current_h > 1 or current_w > 1):
        current_h, current_w = reduce_size(current_h, current_w)
        levels += 1
    return levels


def downsample(image: np.ndarray) -> np.ndarray:
    """Blur then sample on even coordinates -> ceil(h/2) × ceil(w/2)."""
    image = np.asarray(image, dtype=np.float32)
    if image.ndim == 3 and image.shape[2] == 1:
        blurred = cv2.sepFilter2D(
            image[..., 0],
            cv2.CV_32F,
            _ANALYSIS_KERNEL,
            _ANALYSIS_KERNEL,
            borderType=cv2.BORDER_REFLECT_101,
        )[..., None]
    else:
        blurred = cv2.sepFilter2D(
            image,
            cv2.CV_32F,
            _ANALYSIS_KERNEL,
            _ANALYSIS_KERNEL,
            borderType=cv2.BORDER_REFLECT_101,
        )
    return np.ascontiguousarray(blurred[0::2, 0::2])


def _pad_axis(image: np.ndarray, axis: int, before: int, after: int) -> np.ndarray:
    widths = [(0, 0)] * image.ndim
    widths[axis] = (before, after)
    return np.pad(image, widths, mode="symmetric")


def _expand_axis(image: np.ndarray, axis: int, target_len: int) -> np.ndarray:
    padded = _pad_axis(image, axis, _PAD, _PAD)

    coarse_len = image.shape[axis]
    n_even = coarse_len
    n_odd = target_len - n_even
    if n_odd != target_len // 2:
        raise ValueError("coarse length does not match target length")

    def take(start: int, stop: int) -> np.ndarray:
        index = [slice(None)] * image.ndim
        index[axis] = slice(start, stop)
        return padded[tuple(index)]

    out_shape = list(image.shape)
    out_shape[axis] = target_len
    out = np.empty(out_shape, dtype=np.float32)

    even = np.zeros(
        [n_even if i == axis else s for i, s in enumerate(image.shape)],
        dtype=np.float32,
    )
    for tap, weight in enumerate(_EVEN_WEIGHTS):
        even += weight * take(tap, tap + n_even)
    index = [slice(None)] * image.ndim
    index[axis] = slice(0, None, 2)
    out[tuple(index)] = even

    if n_odd:
        odd = np.zeros(
            [n_odd if i == axis else s for i, s in enumerate(image.shape)],
            dtype=np.float32,
        )
        for tap, weight in enumerate(_ODD_WEIGHTS):
            odd += weight * take(_PAD - 1 + tap, _PAD - 1 + tap + n_odd)
        index[axis] = slice(1, None, 2)
        out[tuple(index)] = odd
    return out


def upsample_to(image: np.ndarray, target_height: int, target_width: int) -> np.ndarray:
    """Expand a coarse layer onto an exact ``target_height × target_width`` grid."""
    image = np.asarray(image, dtype=np.float32)
    coarse_h, coarse_w = image.shape[:2]
    if (coarse_h, coarse_w) != reduce_size(target_height, target_width):
        raise ValueError(
            f"coarse layer {coarse_w}×{coarse_h} does not match "
            f"target {target_width}×{target_height}"
        )
    horizontal = _expand_axis(image, 1, target_width)
    vertical = _expand_axis(horizontal, 0, target_height)
    return np.ascontiguousarray(vertical)


@dataclass(frozen=True)
class Pyramid:
    """Decomposition with ``levels`` detail levels plus a residual layer.

    ``details[i]`` has the full size of level ``i`` (``sizes[i]``), and
    ``gaussians[i]`` is the low-pass image at the same size.
    ``gaussians[levels]`` is the coarse residual.
    """

    levels: int
    sizes: tuple[tuple[int, int], ...]
    gaussians: tuple[np.ndarray, ...]
    details: tuple[np.ndarray, ...]
    residual: np.ndarray

    @property
    def shape(self) -> tuple[int, int]:
        return self.sizes[0]

    @property
    def residual_size(self) -> tuple[int, int]:
        return self.residual.shape[:2]


def build_pyramid(image: np.ndarray, level_count: int) -> Pyramid:
    """Decompose a float32 H×W×C image into ``level_count`` detail levels."""
    if image.ndim != 3:
        raise ValueError("build_pyramid expects H×W×C data")
    if level_count < 1:
        raise ValueError("level_count must be >= 1")
    height, width = image.shape[:2]
    limit = max_levels(height, width, cap=6)
    if level_count > limit:
        raise ValueError(
            f"{width}×{height} 最多支持 {limit} 层，请求了 {level_count} 层"
        )

    gaussians: list[np.ndarray] = [
        np.ascontiguousarray(image, dtype=np.float32)
    ]
    for _ in range(level_count):
        gaussians.append(downsample(gaussians[-1]))

    details: list[np.ndarray] = []
    for index in range(level_count):
        fine = gaussians[index]
        coarse = gaussians[index + 1]
        details.append(
            np.ascontiguousarray(
                fine - upsample_to(coarse, fine.shape[0], fine.shape[1])
            )
        )

    return Pyramid(
        levels=level_count,
        sizes=tuple(g.shape[:2] for g in gaussians[:-1]),
        gaussians=tuple(gaussians),
        details=tuple(details),
        residual=gaussians[-1],
    )


def reconstruct_pyramid(pyramid: Pyramid) -> np.ndarray:
    """Rebuild the original image from all detail levels and the residual."""
    current = pyramid.residual
    for index in range(pyramid.levels - 1, -1, -1):
        fine_h, fine_w = pyramid.sizes[index]
        current = upsample_to(current, fine_h, fine_w) + pyramid.details[index]
    return np.ascontiguousarray(current)


def blend_pyramids(
    pyramid_a: Pyramid, pyramid_b: Pyramid, mask_pyramid: Pyramid
) -> np.ndarray:
    """Combine two decompositions with a per-level mask pyramid.

    ``mask_pyramid`` holds the mask (1 = take A, 0 = take B) decomposed into
    low-pass levels; every detail band and the residual are blended with the
    mask low-pass of the matching level.  Fine bands use a sharp mask and
    coarse bands use a wide mask, so the transition width differs per scale.
    """
    if not (pyramid_a.levels == pyramid_b.levels == mask_pyramid.levels):
        raise ValueError("pyramid level counts differ")

    levels = pyramid_a.levels
    blended: list[np.ndarray] = []
    for index in range(levels):
        mask = mask_pyramid.gaussians[index]
        blended.append(
            mask * pyramid_a.details[index] + (1.0 - mask) * pyramid_b.details[index]
        )
    mask = mask_pyramid.gaussians[levels]
    blended.append(mask * pyramid_a.residual + (1.0 - mask) * pyramid_b.residual)

    combined = Pyramid(
        levels=levels,
        sizes=pyramid_a.sizes,
        gaussians=tuple(),
        details=tuple(blended[:-1]),
        residual=blended[-1],
    )
    return reconstruct_pyramid(combined)
