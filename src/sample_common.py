"""Shared constants and geometry for the temporal-denoise sample.

Everything that must agree between the generator, the verification script and
the viewer lives here so the sample can be reproduced bit-for-bit.
"""
from __future__ import annotations

import math

FPS = 25
WIDTH = 960
HEIGHT = 540
DURATION_S = 8.0
FRAME_COUNT = int(FPS * DURATION_S)

# Shot layout: a moving subject for ~3.3 s, then a hard cut to a second shot.
CUT_FRAME = int(3.3 * FPS)          # 82: first frame of shot B
SHOT_A_LEN = CUT_FRAME
SHOT_B_LEN = FRAME_COUNT - CUT_FRAME

# Deterministic noise: one seed per logical shot/id so re-running the generator
# yields identical raw frames (the encoded videos are a convenience view).
SEED = 20261121
CLEAN_SEED = SEED
NOISE_SEED = SEED + 17
FLICKER_SEED = SEED + 31

SUBJECT_RADIUS = 26                  # original-resolution pixels
SUBJECT_DILATE = 7                   # overlay/metric safety margin
SUBJECT_COLOR_BGR = (48, 82, 220)   # warm red-orange disc

ORIGINAL_NAME = "original.mp4"
CLEAN_NAME = "clean_ground_truth.mp4"
MASK_NAME = "moving_mask.mp4"
AUDIO_NAME = "tone.wav"
MANIFEST_NAME = "manifest.json"


def shot_bounds() -> list[tuple[int, int]]:
    """Inclusive frame ranges of each shot."""
    return [(0, CUT_FRAME - 1), (CUT_FRAME, FRAME_COUNT - 1)]


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def subject_center(frame: int) -> tuple[float, float]:
    """Centre of the moving disc (original-resolution pixels).

    Shot A sweeps left->right with a gentle vertical wave, so a fixed temporal
    window smears it into a visible motion trail.  Shot B sweeps the other way
    at a slightly different rhythm, so the two shots cannot be mistaken.
    """
    if frame < CUT_FRAME:
        t = frame / max(1, SHOT_A_LEN - 1)
        x = lerp(0.13, 0.87, t) * WIDTH
        y = (0.50 + 0.21 * math.sin(2 * math.pi * t * 1.5)) * HEIGHT
        return x, y
    t = (frame - CUT_FRAME) / max(1, SHOT_B_LEN - 1)
    x = lerp(0.84, 0.18, t) * WIDTH
    y = (0.58 + 0.15 * math.cos(2 * math.pi * t * 2.0)) * HEIGHT
    return x, y
