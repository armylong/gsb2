"""Core (Qt-free) resampling lab.

Sample images are generated in-process as straight-alpha RGBA float arrays in
the range [0, 1]. Every filter shares one separable resampler; the filters
differ only in what happens before the decimation step.

Coordinate system
-----------------
Samples are treated as unit squares: sample ``(i, j)`` covers
``[i, i+1) x [j, j+1)``.  A crop is an axis-aligned window in the same units
and may start on a fractional coordinate.  Moving the crop window by a
fraction of a sample is exactly what changes the phase between the artwork and
the output pixel grid -- the cause of thin-line "blinking".

Diagnostics use *premultiplied* alpha for colour averages so transparent
pixels (which typically carry RGB = 0) do not drag the average towards black.
``fringe_delta`` compares the mean colour of the more opaque pixels against the
alpha-weighted colour; a strongly negative value means the visible edge became
darker than the body, the classic dark fringe.
"""

from __future__ import annotations

import math
from abc import ABC, abstractmethod
from dataclasses import dataclass, asdict
from typing import Iterable, Sequence

import numpy as np

RGBA = np.ndarray
"""float32 array (H, W, 4), straight (non-premultiplied) alpha, values in [0, 1]."""

_LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float64)


# --------------------------------------------------------------------------- #
# Geometry
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Crop:
    x0: float
    y0: float
    width: float
    height: float

    @property
    def x1(self) -> float:
        return self.x0 + self.width

    @property
    def y1(self) -> float:
        return self.y0 + self.height


def placed_crop(
    image_size: tuple[int, int],
    crop_size: tuple[int, int],
    dx: float = 0.0,
    dy: float = 0.0,
) -> tuple[Crop, float, float]:
    """Centre a crop in the image, offset it, and clamp it inside the grid.

    Returns ``(crop, actual_dx, actual_dy)`` where the actual offsets may be
    smaller than requested when clamping kicks in.
    """
    img_w, img_h = image_size
    crop_w = float(min(max(int(crop_size[0]), 1), img_w))
    crop_h = float(min(max(int(crop_size[1]), 1), img_h))
    base_x = (img_w - crop_w) / 2.0
    base_y = (img_h - crop_h) / 2.0
    x0 = min(max(base_x + dx, 0.0), img_w - crop_w)
    y0 = min(max(base_y + dy, 0.0), img_h - crop_h)
    return Crop(x0, y0, crop_w, crop_h), x0 - base_x, y0 - base_y


def croppable_offset(image_size: tuple[int, int], crop_size: tuple[int, int]) -> tuple[float, float]:
    img_w, img_h = image_size
    crop_w = float(min(max(int(crop_size[0]), 1), img_w))
    crop_h = float(min(max(int(crop_size[1]), 1), img_h))
    return (img_w - crop_w) / 2.0, (img_h - crop_h) / 2.0


def output_size(crop: Crop, scale: float) -> tuple[int, int]:
    """Output dimensions; never smaller than 1x1 so extreme shrink stays valid."""
    return (
        max(1, int(round(crop.width * float(scale)))),
        max(1, int(round(crop.height * float(scale)))),
    )


def output_scale(crop: Crop, out_size: tuple[int, int]) -> tuple[float, float]:
    return (out_size[0] / crop.width, out_size[1] / crop.height)


# --------------------------------------------------------------------------- #
# Filter strategies
# --------------------------------------------------------------------------- #
class Filter(ABC):
    """A prefilter/decimate strategy, keyed for the UI."""

    key: str
    name: str
    short: str
    description: str

    def prepare(self, image: RGBA, premultiply: bool) -> RGBA:
        return premultiply_rgba(image) if premultiply else image.astype(np.float32, copy=True)

    def finish(self, work: RGBA, premultiply: bool) -> RGBA:
        out = unpremultiply_rgba(work) if premultiply else work
        return clamp_rgba(out)

    @abstractmethod
    def resample(self, image: RGBA, crop: Crop, out_size: tuple[int, int]) -> RGBA:
        """Resample a working (already premultiplied if enabled) image."""
        raise NotImplementedError


def _indexed_area(image: RGBA, crop: Crop, out_size: tuple[int, int]) -> RGBA:
    """Area resampling restricted to the crop's integer support.

    Each output pixel's footprint is integrated exactly against unit-square
    samples; rows are normalised to sum to one, so a 1x1 output is the true
    average of the whole crop and a footprint narrower than a sample degrades
    to a phase-preserving point sample instead of producing zeros.  Only the
    samples the crop actually touches are read, so the cost is O(output
    footprint * output pixels) rather than O(image).
    """
    h, w = image.shape[:2]

    def support(
        start: float, extent: float, n: int, out_n: int
    ) -> tuple[int, int, np.ndarray]:
        hi = min(n, int(math.ceil(start + extent)))
        lo = max(0, int(math.floor(start)))
        if hi <= lo:  # crop entirely outside the image
            mid = min(max(int(round(start)), 0), n - 1)
            return mid, mid + 1, np.ones((out_n, 1), dtype=np.float64)
        edges = start + np.arange(out_n + 1, dtype=np.float64) * (extent / out_n)
        k = np.arange(lo, hi, dtype=np.float64)[None, :]
        overlap = np.clip(
            np.minimum(edges[1:, None], k + 1.0) - np.maximum(edges[:-1, None], k),
            0.0,
            None,
        )
        row_sum = overlap.sum(axis=1, keepdims=True)
        row_sum[row_sum <= 0.0] = 1.0
        return lo, hi, overlap / row_sum

    y_lo, y_hi, mat_y = support(crop.y0, crop.height, h, out_size[1])
    x_lo, x_hi, mat_x = support(crop.x0, crop.width, w, out_size[0])
    sub = image[y_lo:y_hi, x_lo:x_hi]
    tmp = np.tensordot(mat_x, sub, axes=([1], [1]))  # (out_w, h_sub, 4)
    out = np.tensordot(mat_y, tmp, axes=([1], [1]))  # (out_h, out_w, 4)
    return out.astype(np.float32)


def _bilinear_sample(image: RGBA, xs: np.ndarray, ys: np.ndarray) -> RGBA:
    """Sample at continuous coordinates (x fast axis, y slow axis).

    A correlated lookup (``image[y0][:, x0]``) materialises a full
    ``(out_h, H, W, 4)`` intermediate; flat indices keep this O(out_h*out_w).
    Coordinates outside the image read as transparent black, so a crop that is
    larger than the image (valid for upscaling) does not smear the border
    pixels across the extra margin.
    """
    h, w = image.shape[:2]
    flat = np.concatenate(
        [image.reshape(h * w, -1), np.zeros((1, image.shape[2]), dtype=image.dtype)]
    )
    x = xs - 0.5
    y = ys - 0.5
    x0 = np.floor(x).astype(np.int64)
    y0 = np.floor(y).astype(np.int64)
    x1 = x0 + 1
    y1 = y0 + 1
    fx = (x - x0)[None, :, None]
    fy = (y - y0)[:, None, None]

    def gather(idx_x: np.ndarray, idx_y: np.ndarray) -> RGBA:
        valid = (
            (idx_x[None, :] >= 0)
            & (idx_x[None, :] < w)
            & (idx_y[:, None] >= 0)
            & (idx_y[:, None] < h)
        )
        flat_idx = np.clip(idx_y[:, None] * w + idx_x[None, :], 0, h * w)
        vals = flat[flat_idx]
        return np.where(valid[..., None], vals, 0.0)

    top = gather(x0, y0) * (1.0 - fx) + gather(x1, y0) * fx
    bot = gather(x0, y1) * (1.0 - fx) + gather(x1, y1) * fx
    return (top * (1.0 - fy) + bot * fy).astype(np.float32)


def _sample_centres(crop: Crop, out_size: tuple[int, int]) -> tuple[np.ndarray, np.ndarray]:
    xs = crop.x0 + (np.arange(out_size[0]) + 0.5) * crop.width / out_size[0]
    ys = crop.y0 + (np.arange(out_size[1]) + 0.5) * crop.height / out_size[1]
    return xs, ys


def _gaussian_blur_1d(image: RGBA, sigma: float, axis: int) -> RGBA:
    """Boundary-normalised Gaussian blur along one axis.

    Large sigmas use an FFT convolution (the direct kernel would be hundreds of
    taps wide); small sigmas use a direct accumulation.
    """
    if sigma <= 1e-6:
        return image
    radius = max(1, int(math.ceil(3.0 * sigma)))
    taps = np.arange(-radius, radius + 1, dtype=np.int64)
    weights = np.exp(-0.5 * (taps / sigma) ** 2)

    moved = np.moveaxis(image.astype(np.float64), axis, 0)  # (n, ...)
    n = moved.shape[0]
    pad = np.pad(moved, [(radius, radius)] + [(0, 0)] * (moved.ndim - 1))
    m = pad.shape[0]

    if radius > 24:
        # Linear convolution via FFT: kernel q[r + k] = w_k, output row i sits
        # at index i + 2r of the full convolution.
        size = 1
        while size < m + len(weights):
            size *= 2
        kern = np.zeros(size, dtype=np.float64)
        kern[: 2 * radius + 1] = weights
        q = np.fft.rfft(kern)
        spectrum = np.fft.rfft(pad, n=size, axis=0)
        spectrum *= q[(slice(None),) + (None,) * (pad.ndim - 1)]
        conv = np.fft.irfft(spectrum, n=size, axis=0)[: pad.shape[0] + 2 * radius]
        num = conv[2 * radius : 2 * radius + n]
    else:
        num = np.zeros(moved.shape, dtype=np.float64)
        for k, w in zip(taps, weights):
            start = radius - k
            num += w * pad[start : start + n]

    ones = np.ones((pad.shape[0],), dtype=np.float64)
    den_full = np.convolve(ones, weights, mode="full")
    den = den_full[2 * radius : 2 * radius + n]
    den = np.maximum(den, 1e-12)
    den = den.reshape((n,) + (1,) * (moved.ndim - 1))
    return np.moveaxis((num / den).astype(np.float32), 0, axis)


def _integral_convolve_1d(src: RGBA, half_width: np.ndarray, axis: int) -> RGBA:
    """Exact continuous box convolution with per-position half-widths.

    ``half_width`` is in sample units.  Uses prefix sums, so the cost is
    independent of the box width.  Zero outside the image, divided by the
    nominal (not clipped) width: content near the image border thus fades out
    instead of being renormalised to full brightness.
    """
    n = src.shape[axis]
    moved = np.moveaxis(src.astype(np.float64), axis, 0)  # (n, ...)
    shape = moved.shape
    flat = moved.reshape(n, -1).T  # (pixels*channels, n)
    prefix = np.concatenate([np.zeros((flat.shape[0], 1)), np.cumsum(flat, axis=1)], axis=1)

    centre = np.arange(n, dtype=np.float64) + 0.5
    lo = np.clip(centre - half_width, 0.0, float(n))
    hi = np.clip(centre + half_width, 0.0, float(n))
    lo_i = np.floor(lo).astype(np.int64)
    hi_i = np.floor(hi).astype(np.int64)
    lo_f = lo - lo_i
    hi_f = hi - hi_i

    def cum(idx: np.ndarray) -> np.ndarray:
        return prefix[:, np.clip(idx, 0, n)]

    # Linear interpolation of the cumulative sum between integer knots.
    s_hi = (1.0 - hi_f) * cum(hi_i) + hi_f * cum(hi_i + 1)
    s_lo = (1.0 - lo_f) * cum(lo_i) + lo_f * cum(lo_i + 1)
    width = np.maximum(2.0 * half_width, 1e-12)
    out = ((s_hi - s_lo) / width).T.reshape(shape)
    return np.moveaxis(out, 0, axis).astype(np.float32)


class AreaFilter(Filter):
    key = "area"
    name = "Area average (exact box)"
    short = "Area"
    description = (
        "Integrates the source over each output pixel's footprint.  This is the "
        "ground truth for downscaling: no overshoot, no lost thin lines, and a "
        "1x1 output is the true average of the whole crop."
    )

    def resample(self, image: RGBA, crop: Crop, out_size: tuple[int, int]) -> RGBA:
        return _indexed_area(image, crop, out_size)


class DirectFilter(Filter):
    key = "direct"
    name = "Direct interpolation (bilinear)"
    short = "Direct"
    description = (
        "No prefilter: point-samples the source at each output pixel centre.  "
        "A thin line can fall between the sample points and vanish; shifting "
        "the grid by a fraction of a sample makes it reappear."
    )

    def resample(self, image: RGBA, crop: Crop, out_size: tuple[int, int]) -> RGBA:
        xs, ys = _sample_centres(crop, out_size)
        return _bilinear_sample(image, xs, ys)


class GaussianFilter(Filter):
    key = "gaussian"
    name = "Prefilter: Gaussian"
    short = "Gauss"
    description = (
        "Gaussian blur sized to the output footprint, then point sampling.  "
        "Suppresses aliasing of fine detail; sigma is chosen to match the "
        "variance of the output pixel footprint minus one source sample."
    )

    def resample(self, image: RGBA, crop: Crop, out_size: tuple[int, int]) -> RGBA:
        footprint_x = crop.width / out_size[0]
        footprint_y = crop.height / out_size[1]
        # Matched-filter variance: footprint^2/12; subtract source pixel var 1/12.
        sigma_x = math.sqrt(max(footprint_x**2 - 1.0, 0.0) / 12.0)
        sigma_y = math.sqrt(max(footprint_y**2 - 1.0, 0.0) / 12.0)
        pre = _gaussian_blur_1d(image, sigma_x, axis=1)
        pre = _gaussian_blur_1d(pre, sigma_y, axis=0)
        xs, ys = _sample_centres(crop, out_size)
        return _bilinear_sample(pre, xs, ys)


class MeanFilter(Filter):
    key = "mean"
    name = "Prefilter: matched box"
    short = "Box"
    description = (
        "Box prefilter exactly as wide as one output pixel, applied with "
        "continuous integration, then sampled.  Behaves like the area filter "
        "for downscaling but also handles footprints narrower than a sample."
    )

    def resample(self, image: RGBA, crop: Crop, out_size: tuple[int, int]) -> RGBA:
        footprint_x = crop.width / out_size[0]
        footprint_y = crop.height / out_size[1]
        pre = _integral_convolve_1d(
            image, np.full(image.shape[1], 0.5 * footprint_x), axis=1
        )
        pre = _integral_convolve_1d(
            pre, np.full(image.shape[0], 0.5 * footprint_y), axis=0
        )
        xs, ys = _sample_centres(crop, out_size)
        return _bilinear_sample(pre, xs, ys)


FILTERS: dict[str, Filter] = {
    f.key: f for f in (AreaFilter(), DirectFilter(), GaussianFilter(), MeanFilter())
}
FILTER_ORDER: list[str] = ["area", "direct", "gaussian", "mean"]


# --------------------------------------------------------------------------- #
# Premultiplication helpers
# --------------------------------------------------------------------------- #
def clamp_rgba(image: RGBA) -> RGBA:
    return np.clip(image, 0.0, 1.0).astype(np.float32)


def premultiply_rgba(image: RGBA) -> RGBA:
    out = np.array(image, dtype=np.float32, copy=True)
    out[..., :3] *= out[..., 3:4]
    return out


def unpremultiply_rgba(image: RGBA) -> RGBA:
    """Divide colour by alpha and carry the residual colour forward.

    A pixel can legitimately come out with small alpha but colour energy that
    would need RGB > 1 (e.g. a Gaussian-haloed icon averaged with an opaque
    white body).  Clamping such a pixel to white would create a *light* halo
    instead of the dark one under investigation.  Instead the excess is folded
    back into alpha so that ``RGB * alpha`` (the composited result) is
    preserved exactly -- the two are indistinguishable over any backdrop.
    """
    out = np.array(image, dtype=np.float32, copy=True)
    alpha = np.clip(out[..., 3:4], 0.0, 1.0)
    safe = alpha > 1e-6
    rgb = np.divide(out[..., :3], alpha, out=np.zeros_like(out[..., :3]), where=safe)

    peak = rgb.max(axis=-1, keepdims=True)
    lift = np.maximum(peak, 1.0)
    rgb = rgb / lift
    alpha = np.minimum(alpha * lift, 1.0)
    out[..., :3] = np.clip(rgb, 0.0, 1.0)
    out[..., 3:4] = alpha
    return out


def to_uint8(image: RGBA) -> np.ndarray:
    quant = np.clip(image, 0.0, 1.0) * 255.0
    return np.floor(quant + 0.5).astype(np.uint8)


# --------------------------------------------------------------------------- #
# Metrics
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class Metrics:
    mean_alpha: float
    peak_alpha: float
    colour_luma: float
    composite_luma: float
    interior_luma: float
    edge_luma: float
    edge_delta: float
    fringe_luma: float
    fringe_delta: float
    min_visible_luma: float
    opaque_fraction: float
    visible_pixels: int

    def as_dict(self) -> dict:
        return asdict(self)


def analyse(
    image: RGBA, edge_hi: float = 0.8, edge_lo: float = 0.05, fringe_lo: float = 0.5
) -> Metrics:
    """Summarise one output image (all pixels belong to the same source crop).

    * ``mean_alpha``     plain average transparency of the region.
    * ``colour_luma``    alpha-weighted mean luma (premultiplied estimate).
    * ``composite_luma`` mean luma of the image composited over black.
    * ``interior_luma``  luma of solid pixels (alpha >= ``edge_hi``).
    * ``edge_luma``      luma of semi-transparent edge pixels
                         (``edge_lo <= alpha < edge_hi``).
    * ``edge_delta``     ``edge_luma - interior_luma``; a large negative value
                         means the anti-aliased rim turned darker than the body
                         -- dark fringing.
    * ``fringe_luma``    luma of all clearly visible pixels
                         (alpha >= ``fringe_lo``).
    * ``fringe_delta``   ``fringe_luma - colour_luma``; near 0 means the visible
                         colour equals the alpha-weighted colour, negative means
                         visible pixels are darker on average.
    * ``min_visible_luma`` darkest luma among pixels with alpha >= edge_lo.
    """
    im = np.asarray(image, dtype=np.float64)
    if im.size == 0:
        nan = float("nan")
        return Metrics(0, 0, 0, 0, nan, nan, nan, nan, nan, nan, 0, 0)
    alpha = im[..., 3]
    luma = im[..., :3] @ _LUMA
    mean_alpha = float(alpha.mean())
    peak_alpha = float(alpha.max())

    prem = im.copy()
    prem[..., :3] *= prem[..., 3:4]
    alpha_sum = float(prem[..., 3].sum())
    colour_luma = float((prem[..., :3] @ _LUMA).sum() / alpha_sum) if alpha_sum > 0 else 0.0
    composite_luma = float((prem[..., :3] @ _LUMA).mean())

    interior = alpha >= edge_hi
    edge = (alpha >= edge_lo) & (alpha < edge_hi)
    interior_luma = float(luma[interior].mean()) if interior.any() else float("nan")
    edge_luma = float(luma[edge].mean()) if edge.any() else float("nan")
    edge_delta = (
        edge_luma - interior_luma if interior.any() and edge.any() else float("nan")
    )

    fringe = alpha >= fringe_lo
    fringe_luma = float(luma[fringe].mean()) if fringe.any() else float("nan")
    fringe_delta = fringe_luma - colour_luma if fringe.any() else float("nan")

    visible = alpha >= edge_lo
    min_visible = float(luma[visible].min()) if visible.any() else float("nan")
    return Metrics(
        mean_alpha=mean_alpha,
        peak_alpha=peak_alpha,
        colour_luma=colour_luma,
        composite_luma=composite_luma,
        interior_luma=interior_luma,
        edge_luma=edge_luma,
        edge_delta=edge_delta,
        fringe_luma=fringe_luma,
        fringe_delta=fringe_delta,
        min_visible_luma=min_visible,
        opaque_fraction=float((alpha >= 0.5).mean()),
        visible_pixels=int(visible.sum()),
    )


# --------------------------------------------------------------------------- #
# High-level operations
# --------------------------------------------------------------------------- #
@dataclass
class Result:
    filter_key: str
    filter_name: str
    size: tuple[int, int]
    scale_xy: tuple[float, float]
    rgba: RGBA
    u8: np.ndarray
    metrics: Metrics
    premultiply: bool


def resample(
    image: RGBA,
    crop: Crop,
    out_size: tuple[int, int],
    filter_key: str,
    premultiply: bool = True,
) -> Result:
    filt = FILTERS[filter_key]
    work = filt.prepare(image, premultiply)
    out = filt.finish(filt.resample(work, crop, out_size), premultiply)
    return Result(
        filter_key=filter_key,
        filter_name=filt.name,
        size=out_size,
        scale_xy=output_scale(crop, out_size),
        rgba=out,
        u8=to_uint8(out),
        metrics=analyse(out),
        premultiply=premultiply,
    )


def resample_all(
    image: RGBA,
    crop: Crop,
    out_size: tuple[int, int],
    premultiply: bool = True,
    keys: Sequence[str] = FILTER_ORDER,
) -> dict[str, Result]:
    return {k: resample(image, crop, out_size, k, premultiply) for k in keys}


# --------------------------------------------------------------------------- #
# Sweeps for the charts / exports
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class SweepPoint:
    x: float
    size: tuple[int, int]
    metrics: Metrics


def sweep_scales(
    image: RGBA,
    crop_size: tuple[int, int],
    scales: Iterable[float],
    premultiply: bool = True,
    dx: float = 0.0,
    dy: float = 0.0,
    keys: Sequence[str] = FILTER_ORDER,
) -> dict[str, list[SweepPoint]]:
    out: dict[str, list[SweepPoint]] = {k: [] for k in keys}
    image_size = (image.shape[1], image.shape[0])
    for s in scales:
        crop, _, _ = placed_crop(image_size, crop_size, dx, dy)
        size = output_size(crop, s)
        for key in keys:
            r = resample(image, crop, size, key, premultiply)
            out[key].append(SweepPoint(float(s), size, r.metrics))
    return out


def sweep_offsets(
    image: RGBA,
    crop_size: tuple[int, int],
    offsets: Iterable[float],
    axis: str,
    scale: float,
    premultiply: bool = True,
    keys: Sequence[str] = FILTER_ORDER,
) -> dict[str, list[SweepPoint]]:
    out: dict[str, list[SweepPoint]] = {k: [] for k in keys}
    image_size = (image.shape[1], image.shape[0])
    dx_max, dy_max = croppable_offset(image_size, crop_size)
    for o in offsets:
        dx = float(o) if axis == "x" else 0.0
        dy = float(o) if axis == "y" else 0.0
        dx = min(max(dx, -dx_max), dx_max)
        dy = min(max(dy, -dy_max), dy_max)
        crop, _, _ = placed_crop(image_size, crop_size, dx, dy)
        size = output_size(crop, scale)
        for key in keys:
            r = resample(image, crop, size, key, premultiply)
            out[key].append(SweepPoint(float(o), size, r.metrics))
    return out


# --------------------------------------------------------------------------- #
# Qt image bridge (imported lazily so the core stays headless-capable)
# --------------------------------------------------------------------------- #
def to_qimage(image: RGBA):
    from PySide6.QtGui import QImage

    arr = np.ascontiguousarray(to_uint8(image))
    h, w = arr.shape[:2]
    qimg = QImage(arr.data, w, h, w * 4, QImage.Format.Format_RGBA8888)
    return qimg.copy()  # detach from the transient numpy buffer


def save_png(path: str, image: RGBA) -> None:
    if not to_qimage(image).save(path):
        raise OSError(f"could not write {path}")
