"""Matting engine: box + scribbles -> alpha.

The function :func:`compute_matting` is intentionally a pure function of

    (original image, current box, current label map, settings)

It never consumes a previous alpha result, so re-running after adding strokes
cannot accumulate mistakes from an earlier cut-out, and loading a new image can
never inherit old constraints.

Pipeline
--------
1. Validate inputs (box size, both scribble classes present, image variation).
2. GrabCut initialised from the mask (not from the previous result).
3. Hard constraints are re-applied after GrabCut: FG pixels become alpha 1,
   BG pixels become alpha 0.
4. A narrow unknown band is built around the binary boundary; local foreground
   and background colours are extrapolated with normalised box filters and the
   band alpha is solved by colour-line projection.
5. A guided filter smooths only that band, preserving the anti-aliased edge.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import cv2
import numpy as np

from .constraints import BG, FG, LabelMap

# Geometry / validation constants.
MIN_BOX_SIDE = 24
MIN_BOX_AREA_RATIO = 0.002
UNIFORM_STD_THRESHOLD = 3.0

MAX_LONG_SIDE = 1200

# Fixed seed for OpenCV's GrabCut k-means so recomputation is deterministic.
DETERMINISTIC_SEED = 20250917


class MattingError(RuntimeError):
    """User-facing failure with a clear, actionable Chinese message."""

    def __init__(self, message: str, *, code: str = "error"):
        super().__init__(message)
        self.message = message
        self.code = code


@dataclass
class ComputeSettings:
    """Settings that influence matting (stored in the constraint record)."""

    box: tuple[int, int, int, int] | None = None  # x0, y0, x1, y1 (exclusive x1/y1)
    refine_radius: int = 3  # unknown-band half width in pixels; 0 disables softening
    grabcut_iterations: int = 4


@dataclass
class MattingResult:
    alpha: np.ndarray  # float32 HxW in [0, 1]
    foreground: np.ndarray  # BGR uint8 HxW: decontaminated foreground colour
    hard_mask: np.ndarray  # bool HxW from GrabCut + constraints
    trimap: np.ndarray  # uint8 HxW: 0 bg, 128 unknown, 255 fg (for debugging/UI)
    box: tuple[int, int, int, int]
    refine_radius: int
    elapsed_ms: float = 0.0
    warnings: list[str] = field(default_factory=list)

    @property
    def alpha_u8(self) -> np.ndarray:
        return np.clip(self.alpha * 255.0 + 0.5, 0, 255).astype(np.uint8)

    @property
    def foreground_ratio(self) -> float:
        return float(np.count_nonzero(self.alpha > 0.5)) / max(1, self.alpha.size)


def _as_bgr_u8(image: np.ndarray) -> np.ndarray:
    if image is None or image.size == 0:
        raise MattingError("没有可处理的图像。", code="no_image")
    if image.dtype != np.uint8:
        image = np.clip(image, 0, 255).astype(np.uint8)
    if image.ndim == 2:
        image = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
    elif image.ndim == 3 and image.shape[2] == 4:
        image = image[:, :, :3]
    if image.ndim != 3 or image.shape[2] != 3:
        raise MattingError("不支持的图像格式。", code="bad_image")
    return np.ascontiguousarray(image)


def normalize_box(
    box: Optional[tuple[int, int, int, int]], width: int, height: int
) -> tuple[int, int, int, int]:
    if box is None:
        raise MattingError("请先在原图上按住鼠标拖出前景的大致范围。", code="no_box")
    x0, y0, x1, y1 = (int(round(v)) for v in box)
    x0, x1 = sorted((x0, x1))
    y0, y1 = sorted((y0, y1))
    x0 = max(0, min(x0, width - 1))
    y0 = max(0, min(y0, height - 1))
    x1 = max(0, min(x1, width))
    y1 = max(0, min(y1, height))
    w, h = x1 - x0, y1 - y0
    if w < MIN_BOX_SIDE or h < MIN_BOX_SIDE:
        raise MattingError(
            f"选框太小：当前 {w}×{h} 像素，至少需要 {MIN_BOX_SIDE}×{MIN_BOX_SIDE}。请重新框选完整的前景范围。",
            code="box_too_small",
        )
    if w * h < MIN_BOX_AREA_RATIO * width * height:
        raise MattingError(
            "选框太小：请框住完整的前景物体（当前选框只占画面很小一部分）。",
            code="box_too_small",
        )
    return x0, y0, x1, y1


def _check_image_variation(image: np.ndarray) -> None:
    std = image.reshape(-1, 3).astype(np.float32).std(axis=0)
    if float(std.max()) < UNIFORM_STD_THRESHOLD:
        raise MattingError(
            "整张图片几乎是同一种颜色，无法区分前景和背景。请换一张有颜色/明暗差异的照片。",
            code="uniform_image",
        )


def _check_constraints(labels: LabelMap, box: tuple[int, int, int, int]) -> tuple[np.ndarray, np.ndarray]:
    x0, y0, x1, y1 = box
    fg = labels.data == FG
    bg = labels.data == BG
    inside = np.zeros_like(fg)
    inside[y0:y1, x0:x1] = True
    fg_in = fg & inside
    bg_in = bg & inside
    if not fg_in.any():
        raise MattingError(
            "缺少确定前景标记：请用“确定前景”画笔在物体内部画几笔。",
            code="no_foreground",
        )
    if not bg_in.any():
        raise MattingError(
            "缺少确定背景标记：请用“确定背景”画笔在物体外的背景上画几笔。",
            code="no_background",
        )
    return fg_in, bg_in


def _box_kernel(radius: int) -> np.ndarray:
    size = max(1, 2 * int(radius) + 1)
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size))


def _build_trimap(
    hard: np.ndarray, refine_radius: int
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return (definite_fg, definite_bg, unknown) boolean masks."""
    if refine_radius <= 0:
        return hard.copy(), ~hard, np.zeros_like(hard)
    radius = int(refine_radius)
    while radius >= 1:
        kernel = _box_kernel(radius)
        dfg = cv2.erode(hard.astype(np.uint8), kernel).astype(bool)
        dbg = cv2.erode((~hard).astype(np.uint8), kernel).astype(bool)
        if dfg.any() and dbg.any():
            unknown = ~(dfg | dbg)
            return dfg, dbg, unknown
        radius -= 1
    # Object thinner than the band: no reliable colour extrapolation possible.
    return hard.copy(), ~hard, np.zeros_like(hard)


def _normalised_box(
    image: np.ndarray, mask: np.ndarray, radius: int
) -> tuple[np.ndarray, np.ndarray]:
    """Extrapolate colours from ``mask`` areas with a normalised box filter.

    Returns ``(colours, support)`` where ``support`` marks pixels that actually
    had masked neighbours (unsupported pixels are left at the image mean).
    """
    ksize = 2 * int(radius) + 1
    src = image.astype(np.float32)
    weight = mask.astype(np.float32)
    num = cv2.boxFilter(src * weight[:, :, None], -1, (ksize, ksize), normalize=False)
    den = cv2.boxFilter(weight, -1, (ksize, ksize), normalize=False)
    out = np.empty_like(src)
    valid = den > 1e-6
    out[valid] = num[valid] / den[valid, None]
    support = valid
    if mask.any():
        fallback = src[mask].mean(axis=0)
    else:
        fallback = np.zeros(3, np.float32)
    out[~valid] = fallback
    return out, support


def _estimate_foreground(
    image: np.ndarray,
    alpha: np.ndarray,
    dfg: np.ndarray,
    dbg: np.ndarray,
    radius: int,
) -> np.ndarray:
    """Recover straight foreground colour, removing background contamination.

    On the colour line ``I = a*F + (1-a)*B`` we invert for F using a local
    background estimate.  Pixels that are (almost) transparent are filled with
    a locally extrapolated object colour instead of black, so downsampling or
    bilinear display can never pull a dark halo into the soft edge.
    """
    src = image.astype(np.float32)
    bg_est, _ = _normalised_box(image, dbg, radius)
    fg_est, fg_support = _normalised_box(image, dfg, max(3, radius))
    global_fg = src[dfg].mean(axis=0) if dfg.any() else np.zeros(3, np.float32)
    fg_est = np.where(fg_support[:, :, None], fg_est, global_fg)

    a = alpha[:, :, None]
    safe = np.maximum(alpha, 0.02)[:, :, None]
    inversed = (src - (1.0 - a) * bg_est) / safe

    out = src.copy()
    edge = (alpha > 0.06) & (alpha < 0.995)
    out[edge] = inversed[edge]
    # Outside the soft band the pixel is already pure foreground; keep it.
    transparent = alpha <= 0.06
    out[transparent] = fg_est[transparent]
    return np.clip(out, 0.0, 255.0).astype(np.uint8)


def _guided_filter(guide: np.ndarray, src: np.ndarray, radius: int, eps: float = 1e-4) -> np.ndarray:
    """Single-channel guided filter (He et al.) implemented with box filters."""
    ksize = 2 * int(radius) + 1
    box = lambda a: cv2.boxFilter(a, -1, (ksize, ksize), normalize=True, borderType=cv2.BORDER_REFLECT)

    mean_i = box(guide)
    mean_p = box(src)
    corr_i = box(guide * guide)
    corr_ip = box(guide * src)
    var_i = corr_i - mean_i * mean_i
    cov_ip = corr_ip - mean_i * mean_p
    a = cov_ip / (var_i + eps)
    b = mean_p - a * mean_i
    return box(a) * guide + box(b)


def _colour_line_alpha(
    image: np.ndarray,
    fg_est: np.ndarray,
    bg_est: np.ndarray,
    unknown: np.ndarray,
    fallback: np.ndarray,
) -> np.ndarray:
    """Solve alpha by projecting (I-B) on (F-B), only at unknown pixels."""
    img = image.astype(np.float32)
    diff_fb = fg_est - bg_est
    denom = np.sum(diff_fb * diff_fb, axis=2)
    # Pixels whose local F/B colours are too close carry little information.
    reliable = unknown & (denom > 18.0 * 18.0)
    alpha = np.empty(unknown.shape, np.float32)
    alpha[:] = fallback.astype(np.float32)
    if reliable.any():
        num = np.sum((img - bg_est) * diff_fb, axis=2)
        est = num / np.maximum(denom, 1e-6)
        alpha[reliable] = np.clip(est[reliable], 0.0, 1.0)
    # In the ambiguous band (F and B nearly identical) fall back to the hard
    # mask, softly ramped inside the band to avoid a one-pixel step.
    return alpha


def compute_matting(
    image: np.ndarray,
    labels: LabelMap,
    settings: ComputeSettings,
) -> MattingResult:
    """Compute alpha from the image and the *current* constraints only.

    The signature deliberately has no "previous alpha" parameter: a recompute
    cannot consume an earlier cut-out.  With ``DETERMINISTIC_SEED`` fixed, the
    same inputs always yield bit-identical output.
    """
    image = _as_bgr_u8(image)
    height, width = image.shape[:2]
    if labels.height != height or labels.width != width:
        raise MattingError("标记与原图尺寸不一致，请重新打开图片后再标记。", code="size_mismatch")
    _check_image_variation(image)
    box = normalize_box(settings.box, width, height)
    fg_user, bg_user = _check_constraints(labels, box)

    x0, y0, x1, y1 = box
    gc_mask = np.full((height, width), cv2.GC_BGD, np.uint8)
    gc_mask[y0:y1, x0:x1] = cv2.GC_PR_FGD
    gc_mask[fg_user] = cv2.GC_FGD
    gc_mask[bg_user] = cv2.GC_BGD

    bgd_model = np.zeros((1, 65), np.float64)
    fgd_model = np.zeros((1, 65), np.float64)
    imports = max(1, int(settings.grabcut_iterations))
    # GrabCut's internal k-means draws random samples.  Seed the OpenCV RNG so
    # the same (image, constraints, settings) always produce the same result --
    # this is what makes "recompute from the original image" reproducible.
    cv2.setRNGSeed(DETERMINISTIC_SEED)
    cv2.grabCut(
        image, gc_mask, None, bgd_model, fgd_model, imports, cv2.GC_INIT_WITH_MASK
    )

    hard = (gc_mask == cv2.GC_FGD) | (gc_mask == cv2.GC_PR_FGD)
    # Hard user constraints always win, regardless of what GrabCut decided.
    hard[fg_user] = True
    hard[bg_user] = False
    # Never keep foreground pixels outside the selected box.
    hard[:y0, :] = False
    hard[y1:, :] = False
    hard[:, :x0] = False
    hard[:, x1:] = False

    warnings: list[str] = []
    if not hard.any():
        raise MattingError(
            "没有找到可信的前景区域：确定前景和确定背景的颜色可能过于接近，或选框没有包住物体。\n"
            "请扩大选框，并补画更明确的确定前景/确定背景笔墨。",
            code="empty_foreground",
        )
    if hard.all():
        raise MattingError(
            "整个选框都被判为前景：请用“确定背景”画笔在物体外侧的背景上补几笔，或缩小选框。",
            code="full_foreground",
        )

    refine_radius = max(0, min(12, int(settings.refine_radius)))
    dfg, dbg, unknown = _build_trimap(hard, refine_radius)

    if refine_radius > 0 and unknown.any():
        radius = max(2, refine_radius + 1)
        fg_est, _ = _normalised_box(image, dfg, radius)
        bg_est, _ = _normalised_box(image, dbg, radius)
        alpha = _colour_line_alpha(image, fg_est, bg_est, unknown, hard)
        guide = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255.0
        smoothed = _guided_filter(guide, alpha, max(2, refine_radius), eps=2e-4)
        # Keep the solution only inside the band; outside it stays binary.
        alpha = np.where(unknown, smoothed, hard.astype(np.float32))
    else:
        alpha = hard.astype(np.float32)

    alpha = np.clip(alpha, 0.0, 1.0)
    alpha[fg_user] = 1.0
    alpha[bg_user] = 0.0
    alpha[:y0, :] = 0.0
    alpha[y1:, :] = 0.0
    alpha[:, :x0] = 0.0
    alpha[:, x1:] = 0.0

    trimap = np.zeros((height, width), np.uint8)
    trimap[dbg] = 0
    trimap[unknown] = 128
    trimap[dfg] = 255
    if not unknown.any():
        trimap[hard] = 255

    foreground = _estimate_foreground(image, alpha, dfg, dbg, max(3, refine_radius + 2))

    return MattingResult(
        alpha=alpha,
        foreground=foreground,
        hard_mask=hard,
        trimap=trimap,
        box=box,
        refine_radius=refine_radius,
        warnings=warnings,
    )


def load_image_opencv(path: str) -> np.ndarray:
    """Load a PNG/JPEG and normalise it for the app (long side <= 1200)."""
    data = np.fromfile(path, dtype=np.uint8)  # supports non-ASCII paths on Windows
    image = cv2.imdecode(data, cv2.IMREAD_COLOR)
    if image is None:
        raise MattingError("无法读取该图片，请确认文件是有效的 PNG 或 JPEG。", code="decode_failed")
    return limit_long_side(image)


def limit_long_side(image: np.ndarray, max_side: int = MAX_LONG_SIDE) -> np.ndarray:
    height, width = image.shape[:2]
    long_side = max(height, width)
    if long_side <= max_side:
        return image
    scale = max_side / float(long_side)
    new_size = (max(1, int(round(width * scale))), max(1, int(round(height * scale))))
    return cv2.resize(image, new_size, interpolation=cv2.INTER_AREA)
