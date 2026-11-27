"""Mirror sampling, gap detection, color correction and feathered compositing.

The engine never invents pixels: a damaged pixel is filled only when its
reflected source coordinate lies inside the image and the source pixel itself
is not marked as damaged.  Everything else is reported as a gap.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import cv2
import numpy as np

from .geometry import SymLine, build_maps, mirror_image


@dataclass
class RestorationParams:
    feather_px: float = 6.0
    color_correct: bool = True
    cc_strength: float = 0.5          # 0 = no correction, 1 = full fitted model
    cc_band_px: int = 25              # auto sample band around the damage
    cc_slope_limit: float = 0.35      # |slope - 1| clamp (keeps the correction small)
    cc_offset_limit: float = 80.0     # per-channel offset clamp, 8-bit units
    cc_trim: float = 0.15             # residual trimming fraction for the robust fit
    cc_slope_range_floor: float = 40.0  # input range needed before fitting slope


@dataclass
class ColorModel:
    """Per-channel affine: corrected = slope * mirror + offset."""

    slope: np.ndarray
    offset: np.ndarray

    @classmethod
    def identity(cls, channels: int) -> "ColorModel":
        return cls(np.ones(channels, np.float64), np.zeros(channels, np.float64))

    def blend_with_identity(self, strength: float) -> "ColorModel":
        return ColorModel(
            slope=1.0 + (self.slope - 1.0) * strength,
            offset=self.offset * strength,
        )


@dataclass
class RestorationResult:
    result: np.ndarray
    mirrored: np.ndarray
    alpha: np.ndarray                  # float32 0..1 compositing weight
    fill_mask: np.ndarray              # uint8, pixels that actually received mirror data
    gap_mask: np.ndarray               # uint8, damaged pixels that could not be filled
    inside_mask: np.ndarray            # reflected source coordinate inside image
    source_valid: np.ndarray           # reflected source pixel itself undamaged
    color_model: ColorModel
    cc_sample_count: int = 0
    params: RestorationParams = field(default_factory=RestorationParams)


def _remap_mask(mask: np.ndarray, map_x: np.ndarray, map_y: np.ndarray) -> np.ndarray:
    """Sample a mask at reflected coordinates (nearest, no interpolation bias)."""
    return (
        cv2.remap(
            mask.astype(np.uint8),
            map_x,
            map_y,
            interpolation=cv2.INTER_NEAREST,
            borderMode=cv2.BORDER_CONSTANT,
            borderValue=0,
        )
        > 0
    )


def fit_color_model(
    image: np.ndarray,
    mirrored: np.ndarray,
    sample_mask: np.ndarray,
    params: RestorationParams,
) -> tuple[ColorModel, int]:
    """Fit corrected_mirror = slope * mirror + offset against intact pairs.

    Sampling only uses pixels where both the point and its mirror are intact,
    so a damaged side can never bias the fit.  One round of residual trimming
    makes it robust against scratches and dust.
    """
    channels = image.shape[2] if image.ndim == 3 else 1
    src = image.reshape(-1, channels).astype(np.float64)
    mir = mirrored.reshape(-1, channels).astype(np.float64)
    sel = sample_mask.reshape(-1)
    if sel.sum() < 16:
        return ColorModel.identity(channels), int(sel.sum())

    x = mir[sel]
    y = src[sel]
    slopes = np.ones(channels, np.float64)
    offsets = np.zeros(channels, np.float64)
    used = 0

    for c in range(channels):
        xc, yc = x[:, c], y[:, c]

        # robust offset first: the median pair difference survives scratches
        # and stays well-defined even when the local field is nearly constant
        b0 = float(np.median(yc - xc))

        # only fit a slope when the mirrored values actually span a range AND
        # there are enough points; a polyfit on a flat/small field is
        # rank-deficient and produces a wild slope plus a compensating offset
        enough_points = len(xc) >= 64
        enough_range = float(xc.max() - xc.min()) >= params.cc_slope_range_floor
        if enough_points and enough_range:
            keep = np.ones(len(xc), dtype=bool)
            for _ in range(2):
                if keep.sum() < 32:
                    break
                a, b = np.polyfit(xc[keep], yc[keep], 1)
                resid = np.abs(yc - (a * xc + b))
                cut = np.quantile(resid, 1.0 - params.cc_trim)
                new_keep = resid <= max(cut, 1e-6)
                if new_keep.sum() == keep.sum():
                    keep = new_keep
                    break
                keep = new_keep
            if keep.sum() >= 32:
                a = float(np.clip(a, 1 - params.cc_slope_limit,
                                  1 + params.cc_slope_limit))
                b = float(np.clip(b, -params.cc_offset_limit,
                                  params.cc_offset_limit))
                slopes[c], offsets[c] = a, b
                used = max(used, int(keep.sum()))
                continue

        slopes[c] = 1.0
        offsets[c] = float(np.clip(b0, -params.cc_offset_limit,
                                   params.cc_offset_limit))
        used = max(used, len(xc))
    return ColorModel(slopes, offsets), used


def _feather_alpha(damage: np.ndarray, feather_px: float) -> np.ndarray:
    """Distance-based alpha: 0 on the damage boundary, 1 deeper inside.

    Pixels outside the damage mask stay exactly 0, so nothing outside the
    painted/selected region can ever be modified.
    """
    if feather_px <= 0:
        return damage.astype(np.float32)
    dist = cv2.distanceTransform(damage.astype(np.uint8), cv2.DIST_L2, 5)
    t = np.clip(dist / float(feather_px), 0.0, 1.0)
    # smoothstep for a derivative-free seam
    t = t * t * (3.0 - 2.0 * t)
    return (t * damage).astype(np.float32)


def restore(
    image: np.ndarray,
    damage_mask: np.ndarray,
    line: SymLine,
    params: RestorationParams | None = None,
    cc_region: np.ndarray | None = None,
) -> RestorationResult:
    """Run the full mirror-restoration pipeline at original resolution.

    Args:
        image: HxW or HxWx3 uint8 image.
        damage_mask: HxW uint8/bool, non-zero = user-marked damaged area.
        line: symmetry axis (sub-pixel, arbitrary angle).
        cc_region: optional explicit mask restricting color-fit samples;
            when None a band around the damage is used.
    """
    params = params or RestorationParams()
    if image.ndim == 2:
        work = image[:, :, None]
    else:
        work = image
    h, w = work.shape[:2]
    damage = damage_mask > 0

    map_x, map_y, inside = build_maps((h, w), line)
    mirrored = mirror_image(work, line, maps=(map_x, map_y))
    if mirrored.ndim == 2:  # mirror_image squeezes single-channel remaps
        mirrored = mirrored[:, :, None]

    # Source pixel is usable only if the reflected coordinate lands on an
    # intact original pixel.
    source_valid = _remap_mask(~damage, map_x, map_y)
    fillable = damage & inside & source_valid
    gap = damage & ~fillable

    # ---- color correction, learned only from intact/intact pairs ----------
    model = ColorModel.identity(work.shape[2])
    sample_count = 0
    if params.color_correct:
        if cc_region is None:
            band = cv2.dilate(
                damage.astype(np.uint8),
                cv2.getStructuringElement(
                    cv2.MORPH_ELLIPSE,
                    (2 * params.cc_band_px + 1, 2 * params.cc_band_px + 1),
                ),
            ).astype(bool)
            cc_region = band
        mirrored_damage = _remap_mask(damage, map_x, map_y)
        sample_mask = cc_region & inside & ~damage & ~mirrored_damage
        model, sample_count = fit_color_model(work, mirrored, sample_mask, params)
        model = model.blend_with_identity(params.cc_strength)

    corrected = np.clip(
        mirrored.astype(np.float64) * model.slope + model.offset, 0, 255
    ).astype(np.uint8)

    # ---- feathered composite, strictly confined to the damage mask --------
    alpha = _feather_alpha(fillable, params.feather_px)
    out = work.copy()
    a3 = alpha[:, :, None]
    out = (out.astype(np.float32) * (1.0 - a3) + corrected.astype(np.float32) * a3)
    out = np.clip(out, 0, 255).astype(np.uint8)

    if image.ndim == 2:
        out = out[:, :, 0]
        mirrored = mirrored[:, :, 0]

    return RestorationResult(
        result=out,
        mirrored=mirrored,
        alpha=alpha,
        fill_mask=fillable.astype(np.uint8) * 255,
        gap_mask=gap.astype(np.uint8) * 255,
        inside_mask=inside,
        source_valid=source_valid,
        color_model=model,
        cc_sample_count=sample_count,
        params=params,
    )


def overlay_gap_preview(base: np.ndarray, result: RestorationResult) -> np.ndarray:
    """Color-code the preview: green = filled, red = unfillable gap."""
    preview = base.copy()
    if preview.ndim == 2:
        preview = cv2.cvtColor(preview, cv2.COLOR_GRAY2BGR)
    fill = result.fill_mask > 0
    gap = result.gap_mask > 0
    preview[fill] = (0.55 * preview[fill] + 0.45 * np.array([0, 200, 0])).astype(np.uint8)
    preview[gap] = (0.45 * preview[gap] + 0.55 * np.array([0, 0, 230])).astype(np.uint8)
    return preview
