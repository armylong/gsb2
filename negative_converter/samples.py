from __future__ import annotations

"""Deterministic procedural samples used by the GUI and headless checks."""

from dataclasses import dataclass, field

import numpy as np

from .core import ImageDoc, NormRect


@dataclass
class ProgramSample:
    doc: ImageDoc
    title: str
    description: str
    base_rects: list[NormRect] = field(default_factory=list)
    neutral_rects: list[NormRect] = field(default_factory=list)
    suggested_params: dict = field(default_factory=dict)


def _to_u16(rgb01: np.ndarray) -> np.ndarray:
    return np.rint(np.clip(rgb01, 0.0, 1.0) * 65535.0).astype(np.uint16)


def _rect_fill(arr: np.ndarray, x0: int, y0: int, x1: int, y1: int, color) -> None:
    arr[y0:y1, x0:x1] = np.asarray(color, dtype=np.float32).reshape(1, 1, 3)


def _rect_gray_ramp(
    positive: np.ndarray,
    x0: int,
    y0: int,
    x1: int,
    y1: int,
    lo: float,
    hi: float,
) -> None:
    width = max(x1 - x0, 1)
    ramp = np.linspace(lo, hi, width, dtype=np.float32)[None, :, None]
    positive[y0:y1, x0:x1] = np.repeat(ramp, y1 - y0, axis=0)


def color_negative_sample(seed: int = 15429) -> ProgramSample:
    """Orange-masked negative with clean edges, dust, overflow and two ramps."""

    rng = np.random.default_rng(seed)
    h, w = 640, 960
    base = np.array([0.88, 0.56, 0.33], dtype=np.float32)

    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    nx = (xx / w - 0.5) * 2.0
    ny = (yy / h - 0.5) * 2.0
    illumination = 1.0 - 0.10 * (0.55 * nx**2 + 0.8 * ny**2)

    scan = base.reshape(1, 1, 3) * illumination[..., None]
    scan = np.broadcast_to(scan, (h, w, 3)).copy()

    # The positive target is converted to a physically plausible negative by
    # assigning density D = d0 + range*t and transmission base*10^-D.
    x0, y0, x1, y1 = 70, 76, 890, 560
    pw, ph = x1 - x0, y1 - y0
    positive = np.full((ph, pw, 3), 0.46, dtype=np.float32)

    # Two overlapping grey ranges: shadow-to-mid and mid-to-high.
    _rect_gray_ramp(positive, 30, 34, 380, 104, 0.00, 0.58)
    _rect_gray_ramp(positive, 440, 34, 790, 104, 0.42, 1.00)

    # Discrete step wedge gives clear levels for endpoint adjustment.
    steps = 12
    sx0, sy0, block_w, block_h = 30, 132, 62, 34
    for i in range(steps):
        v = i / (steps - 1)
        xa = sx0 + i * block_w
        _rect_fill(positive, xa, sy0, min(xa + block_w - 2, pw - 1), sy0 + block_h, (v, v, v))

    # Colour patches.
    colors = [
        (0.82, 0.12, 0.10),
        (0.10, 0.62, 0.22),
        (0.08, 0.24, 0.82),
        (0.95, 0.72, 0.08),
        (0.05, 0.72, 0.78),
        (0.72, 0.16, 0.72),
        (0.86, 0.55, 0.38),
        (0.10, 0.10, 0.10),
    ]
    cx, cy, cw, ch, gap = 30, 205, 92, 82, 10
    for i, color in enumerate(colors):
        xa = cx + i * (cw + gap)
        _rect_fill(positive, xa, cy, xa + cw, cy + ch, color)

    # A known neutral detail with a subtle vertical texture.
    neutral_x0, neutral_y0, neutral_x1, neutral_y1 = 350, 318, 570, 392
    neutral = np.full((neutral_y1 - neutral_y0, neutral_x1 - neutral_x0, 3), 0.52, np.float32)
    stripe = np.linspace(-0.025, 0.025, neutral.shape[1], dtype=np.float32)[None, :, None]
    neutral += stripe
    positive[neutral_y0:neutral_y1, neutral_x0:neutral_x1] = neutral

    density = 0.06 + 2.16 * positive
    inner_transmission = base.reshape(1, 1, 3) * np.power(10.0, -density)
    scan[y0:y1, x0:x1] = illumination[y0:y1, x0:x1, None] * inner_transmission

    # Scanner black floor and channel-dependent read noise.
    black_floor = np.array([0.0040, 0.0048, 0.0065], dtype=np.float32)
    noise_sigma = np.array([0.0016, 0.0018, 0.0030], dtype=np.float32)
    scan = np.maximum(scan, black_floor.reshape(1, 1, 3))
    scan += rng.normal(0.0, 1.0, size=scan.shape).astype(np.float32) * noise_sigma.reshape(1, 1, 3)

    # Deliberate dust on a top film edge patch.
    dust_x0, dust_y0, dust_x1, dust_y1 = 80, 18, 230, 54
    for _ in range(150):
        px = int(rng.integers(dust_x0 + 3, dust_x1 - 3))
        py = int(rng.integers(dust_y0 + 3, dust_y1 - 3))
        radius = int(rng.integers(1, 3))
        col = np.array([0.03, 0.025, 0.02], np.float32) if rng.random() < 0.65 else np.array([0.92, 0.86, 0.76], np.float32)
        scan[max(0, py-radius):py+radius+1, max(0, px-radius):px+radius+1] = col

    # Deliberate detector overflow/light leak on another edge patch.
    ov_x0, ov_y0, ov_x1, ov_y1 = 730, 16, 880, 56
    oy, ox = np.mgrid[ov_y0:ov_y1, ov_x0:ov_x1]
    ellipse = ((ox - 805) / 55.0) ** 2 + ((oy - 36) / 15.0) ** 2 <= 1.0
    scan[ov_y0:ov_y1, ov_x0:ov_x1][ellipse] = 1.0

    scan = np.clip(scan, 0.0, 1.0)
    doc = ImageDoc(codes=_to_u16(scan), code_max=65535.0, bit_depth=16, path=None)

    def R(px0, py0, px1, py1):
        return NormRect(px0 / w, py0 / h, (px1 - px0) / w, (py1 - py0) / h)

    base_rects = [
        # Good edge samples.
        R(260, 20, 380, 54),
        R(420, 20, 540, 54),
        R(580, 20, 700, 54),
        R(120, 586, 260, 622),
        R(690, 586, 830, 622),
        # Problem samples, intentionally included to demonstrate feedback.
        R(dust_x0, dust_y0, dust_x1, dust_y1),
        R(ov_x0, ov_y0, ov_x1, ov_y1),
    ]
    neutral_rects = [R(x0 + neutral_x0, y0 + neutral_y0, x0 + neutral_x1, y0 + neutral_y1)]

    return ProgramSample(
        doc=doc,
        title="彩色片基 + 双灰阶程序负片",
        description="含橙色片基、两块灰阶范围、色卡、中性细节，以及灰尘/溢出问题片边。",
        base_rects=base_rects,
        neutral_rects=neutral_rects,
        suggested_params={"black": 0.04, "white": 2.22, "gamma": 1.0},
    )


def range_verification_sample() -> ProgramSample:
    """A noiseless negative whose positive output contains exact 0 and 1."""

    h, w = 256, 1024
    base = np.array([0.84, 0.52, 0.30], dtype=np.float32)
    scan = np.broadcast_to(base.reshape(1, 1, 3), (h, w, 3)).copy()

    # Full-height exact gradient in the image interior.
    x0, x1 = 64, 960
    grad = np.linspace(0.0, 1.0, x1 - x0, dtype=np.float32)
    density = 0.05 + 2.20 * grad
    trans = base.reshape(1, 1, 3) * np.power(10.0, -density)[None, :, None]
    scan[48:208, x0:x1] = trans

    # Two explicit endpoint bars make min/max robust.
    scan[70:110, 100:180] = base * 10.0 ** -0.05
    scan[145:185, 820:900] = base * 10.0 ** -2.45

    doc = ImageDoc(codes=_to_u16(scan), code_max=65535.0, bit_depth=16, path=None)

    def R(a, b, c, d):
        return NormRect(a / w, b / h, (c - a) / w, (d - b) / h)

    return ProgramSample(
        doc=doc,
        title="输出范围核对样片",
        description="无噪声已知密度梯度，用于导出后回读暗亮码值范围。",
        base_rects=[R(12, 12, 52, 44), R(972, 12, 1012, 44), R(12, 214, 52, 246)],
        neutral_rects=[],
        suggested_params={"black": 0.05, "white": 2.25, "gamma": 1.0},
    )


def all_samples() -> list[ProgramSample]:
    # Construct lazily by caller if needed; this helper is mainly for menus.
    return [color_negative_sample(), range_verification_sample()]
