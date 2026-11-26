"""Deterministic two-layer stereo samples for local verification/demos."""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np


@dataclass
class TwoLayerScene:
    left: np.ndarray
    right: np.ndarray
    ground_truth_disparity_left: np.ndarray
    ground_truth_disparity_right_signed: np.ndarray
    foreground_mask_left: np.ndarray
    foreground_mask_right: np.ndarray
    occluded_background_left: np.ndarray
    bg_disp: int
    fg_disp: int
    convention: str = "d=x_left-x_right, x_right=x_left-d"


def _rich_background(h: int, w: int, rng: np.random.Generator) -> np.ndarray:
    img = rng.integers(70, 210, size=(h, w, 3), dtype=np.uint8)
    img = cv2.GaussianBlur(img, (3, 3), 0.6)

    # Large, irregular high-contrast shapes make stable block matches.
    for _ in range(42):
        center = (int(rng.integers(0, w)), int(rng.integers(0, h)))
        radius = int(rng.integers(5, 22))
        color = tuple(int(c) for c in rng.integers(0, 255, size=3))
        if rng.random() < 0.5:
            cv2.circle(img, center, radius, color, -1, lineType=cv2.LINE_AA)
        else:
            p1 = (center[0] - radius, center[1] - radius // 2)
            p2 = (center[0] + radius, center[1] + radius // 2)
            cv2.rectangle(img, p1, p2, color, -1, lineType=cv2.LINE_AA)

    # A genuinely low-texture patch: only a very shallow gradient.
    x0, y0, x1, y1 = int(w * 0.08), int(h * 0.10), int(w * 0.31), int(h * 0.34)
    grad = np.linspace(232, 238, x1 - x0, dtype=np.uint8)[None, :, None]
    patch = np.repeat(grad, y1 - y0, axis=0)
    patch = np.repeat(patch, 3, axis=2)
    img[y0:y1, x0:x1] = patch

    # Repeated vertical stripes: locally matchable but globally ambiguous.
    sx0, sy0, sx1, sy1 = int(w * 0.55), int(h * 0.72), int(w * 0.94), int(h * 0.92)
    period = 10
    stripe = np.ones((sy1 - sy0, sx1 - sx0, 3), dtype=np.uint8) * 225
    for x in range(0, sx1 - sx0, period):
        stripe[:, x : x + period // 2] = (25, 25, 25)
    img[sy0:sy1, sx0:sx1] = stripe
    cv2.rectangle(img, (sx0, sy0), (sx1, sy1), (0, 0, 0), 1)
    return img


def _foreground_layer(h: int, w: int, rect: tuple[int, int, int, int], seed: int) -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed + 101)
    x0, y0, x1, y1 = rect
    layer = np.zeros((h, w, 3), dtype=np.uint8)
    mask = np.zeros((h, w), dtype=np.uint8)

    yy, xx = np.mgrid[y0:y1, x0:x1]
    base = rng.integers(40, 220, size=(y1 - y0, x1 - x0, 3), dtype=np.uint8)
    base = cv2.GaussianBlur(base, (3, 3), 0.5)
    layer[y0:y1, x0:x1] = base
    mask[y0:y1, x0:x1] = 255

    # Strong corners/checker/circles keep the foreground itself matchable.
    cv2.rectangle(layer, (x0, y0), (x1 - 1, y1 - 1), (20, 20, 20), 3)
    step = 18
    for y in range(y0 + 8, y1 - 8, step):
        for x in range(x0 + 8, x1 - 8, step):
            if ((x - x0) // step + (y - y0) // step) % 2 == 0:
                cv2.rectangle(layer, (x - 6, y - 6), (x + 6, y + 6), (245, 245, 245), -1)
            else:
                cv2.circle(layer, (x, y), 6, (10, 10, 10), -1)
    return layer, mask


def make_two_layer_pair(
    width: int = 320,
    height: int = 220,
    bg_disp: int = 4,
    fg_disp: int = 18,
    seed: int = 7,
    edge_touch: str | None = None,
) -> TwoLayerScene:
    """Create row-aligned left/right images with exactly two integer layers.

    ``edge_touch`` can be ``None``, ``"left"``, ``"right"`` or ``"both"``.
    The foreground rectangle is placed in a wide intermediate canvas and the
    two views are crops, which reveals background naturally at occlusion
    boundaries instead of copying foreground pixels into the background.
    """

    rng = np.random.default_rng(seed)
    max_d = max(abs(int(bg_disp)), abs(int(fg_disp)))
    margin = max_d + 32
    wide_w = width + 2 * margin
    bg_wide = _rich_background(height, wide_w, rng)

    if edge_touch == "left":
        x0_out, x1_out = 0, int(width * 0.48)
    elif edge_touch == "right":
        x0_out, x1_out = int(width * 0.52), width
    elif edge_touch == "both":
        x0_out, x1_out = 0, width
    else:
        x0_out, x1_out = int(width * 0.36), int(width * 0.73)
    y0_out, y1_out = int(height * 0.25), int(height * 0.75)
    rect_wide = (margin + x0_out, y0_out, margin + x1_out, y1_out)
    fg_wide, fg_mask_wide = _foreground_layer(height, wide_w, rect_wide, seed)

    left_bg = bg_wide[:, margin : margin + width].copy()
    right_bg = bg_wide[:, margin + bg_disp : margin + bg_disp + width].copy()
    left_fg = fg_wide[:, margin : margin + width]
    right_fg = fg_wide[:, margin + fg_disp : margin + fg_disp + width]
    left_fg_m = fg_mask_wide[:, margin : margin + width]
    right_fg_m = fg_mask_wide[:, margin + fg_disp : margin + fg_disp + width]

    left = left_bg.copy()
    left[left_fg_m > 0] = left_fg[left_fg_m > 0]
    right = right_bg.copy()
    right[right_fg_m > 0] = right_fg[right_fg_m > 0]

    gt = np.full((height, width), float(bg_disp), dtype=np.float32)
    fg_left = left_fg_m > 0
    gt[fg_left] = float(fg_disp)

    fg_right = right_fg_m > 0
    gt_right = np.full((height, width), -float(bg_disp), dtype=np.float32)
    gt_right[fg_right] = -float(fg_disp)

    # Exact left-reference background points covered by the shifted foreground
    # in the right image are half-occluded in the right view.
    xs = np.arange(width)[None, :].repeat(height, axis=0)
    mapped_x = xs - int(bg_disp)
    inside = (mapped_x >= 0) & (mapped_x < width)
    right_fg_at_map = np.zeros((height, width), dtype=bool)
    valid_flat = inside
    ys = np.arange(height)[:, None]
    mx = np.clip(mapped_x, 0, width - 1)
    right_fg_at_map = right_fg_m[ys, mx] > 0
    occluded = (~fg_left) & inside & right_fg_at_map

    return TwoLayerScene(
        left=left,
        right=right,
        ground_truth_disparity_left=gt,
        ground_truth_disparity_right_signed=gt_right,
        foreground_mask_left=fg_left,
        foreground_mask_right=fg_right,
        occluded_background_left=occluded,
        bg_disp=int(bg_disp),
        fg_disp=int(fg_disp),
    )
