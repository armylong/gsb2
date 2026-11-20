"""Procedurally generated still-life samples with ground-truth alpha.

Everything here is deterministic: no external assets, no downloaded files, no
segmentation model.  Each sample exercises the hard parts of this tool:

* foreground and background colours are deliberately close (but distinguishable),
* internal holes (background visible through the object),
* a thin / narrow connection,
* soft, anti-aliased edges,
* a textured background (gradient, folds, grain) so flat-colour tricks fail.

Shapes are drawn with OpenCV primitives on a 4x supersampled canvas and box
downsampled.  This gives clean, anti-aliased boundaries.  A mild optical blur is
then applied so that the reference alpha contains a genuine soft edge
(alpha values between 0 and 1) rather than a pure binary cut.
"""

from __future__ import annotations

from dataclasses import dataclass

import cv2
import numpy as np

from .constraints import BG, FG, Stroke

SUPERSAMPLE = 4
EDGE_SIGMA = 0.6


@dataclass(frozen=True)
class SampleSpec:
    key: str
    title: str
    description: str
    width: int
    height: int
    seed: int
    foreground_color: tuple[int, int, int]  # BGR
    background_color: tuple[int, int, int]  # BGR
    box: tuple[int, int, int, int]  # x0, y0, x1, y1
    fg_lines: tuple[tuple[tuple[float, float], ...], ...]
    bg_lines: tuple[tuple[tuple[float, float], ...], ...]


SAMPLES: dict[str, SampleSpec] = {
    "jug": SampleSpec(
        key="jug",
        title="陶罐与细把手",
        description="奶油色陶罐放在米色布面上，颜色相近；把手细窄、罐身有透出的圆孔。",
        width=1000,
        height=760,
        seed=20250917,
        foreground_color=(146, 176, 203),  # BGR cream
        background_color=(170, 181, 192),  # BGR dusty linen
        box=(235, 130, 790, 700),
        fg_lines=(
            ((500, 430), (500, 480), (500, 530)),
            ((741, 430), (743, 455), (734, 490)),
        ),
        bg_lines=(
            ((300, 685), (420, 690), (560, 685), (700, 690)),
            ((412, 360),),
            ((703, 450),),
            ((300, 160), (380, 150)),
        ),
    ),
    "sprig": SampleSpec(
        key="sprig",
        title="细茎枝叶",
        description="细长茎连接多片叶子的静物；叶脉和茎细窄，背景为相近色渐变。",
        width=980,
        height=720,
        seed=31415926,
        foreground_color=(92, 132, 102),  # BGR sage leaf
        background_color=(128, 150, 132),  # BGR sage wall
        box=(170, 200, 830, 660),
        fg_lines=(
            ((330, 545), (420, 500), (520, 462), (610, 415), (700, 348), (755, 292)),
        ),
        bg_lines=(
            ((240, 645), (380, 655), (560, 640), (760, 645)),
            ((240, 170), (400, 160), (560, 170), (760, 160)),
            ((760, 420), (780, 450)),
        ),
    ),
    "ring": SampleSpec(
        key="ring",
        title="带孔圆环",
        description="中央完全透出的陶瓷圆环，环壁较薄，颜色与木桌面接近。",
        width=900,
        height=760,
        seed=27182818,
        foreground_color=(188, 203, 220),  # BGR pale ceramic
        background_color=(152, 172, 192),  # BGR pale wood
        box=(190, 120, 710, 700),
        fg_lines=(
            ((450, 190), (520, 230), (585, 300)),
            ((290, 400), (320, 500), (400, 580), (520, 600)),
        ),
        bg_lines=(
            ((450, 665), (560, 668), (640, 660)),
            ((450, 470),),
            ((200, 300), (196, 360)),
            ((700, 300), (704, 360)),
        ),
    ),
}


# ---------------------------------------------------------------------------
# Vector drawing at supersampled resolution
# ---------------------------------------------------------------------------


def _ellipse_pts(cx: float, cy: float, rx: float, ry: float,
                 angle_deg: float = 0.0, n: int = 96) -> np.ndarray:
    t = np.linspace(0.0, 2.0 * np.pi, n, endpoint=False)
    a = np.deg2rad(angle_deg)
    x = rx * np.cos(t)
    y = ry * np.sin(t)
    xr = x * np.cos(a) - y * np.sin(a) + cx
    yr = x * np.sin(a) + y * np.cos(a) + cy
    return np.stack([xr, yr], axis=1).round().astype(np.int32)


def _fill_ellipse(canvas: np.ndarray, cx, cy, rx, ry, angle_deg=0.0) -> None:
    cv2.fillPoly(canvas, [_ellipse_pts(cx, cy, rx, ry, angle_deg)], 1, cv2.LINE_AA)


def _stroke_polyline(img: np.ndarray, pts, thickness: float) -> None:
    pts = np.asarray(pts, np.float32).round().astype(np.int32)
    cv2.polylines(img, [pts], False, 1, max(1, int(round(thickness))), cv2.LINE_AA)
    radius = max(1, int(round(thickness / 2.0)))
    cv2.circle(img, tuple(pts[0]), radius, 1, -1, cv2.LINE_AA)
    cv2.circle(img, tuple(pts[-1]), radius, 1, -1, cv2.LINE_AA)


def _draw_jug(ss: int) -> np.ndarray:
    w, h = 1000 * ss, 760 * ss
    m = np.zeros((h, w), np.uint8)
    s = ss
    _fill_ellipse(m, 500 * s, 430 * s, 178 * s, 220 * s)  # body
    _stroke_polyline(m, [(500 * s, 218 * s), (500 * s, 300 * s)], 100 * s)  # neck
    _fill_ellipse(m, 500 * s, 215 * s, 78 * s, 20 * s)  # lip
    _fill_ellipse(m, 500 * s, 222 * s, 60 * s, 12 * s)  # lip top
    _stroke_polyline(m, [(556 * s, 226 * s), (604 * s, 208 * s)], 26 * s)  # spout
    _stroke_polyline(
        m,
        [
            (640 * s, 318 * s),
            (724 * s, 380 * s),
            (742 * s, 448 * s),
            (716 * s, 520 * s),
            (644 * s, 560 * s),
        ],
        22 * s,
    )  # handle
    # Round hole through the body.
    cv2.circle(m, (412 * s, 360 * s), 30 * s, 0, -1, cv2.LINE_AA)
    # A subtle foot ring / base so the object has a thin contact edge.
    _fill_ellipse(m, 500 * s, 648 * s, 132 * s, 24 * s)
    return m


def _draw_sprig(ss: int) -> np.ndarray:
    w, h = 980 * ss, 720 * ss
    m = np.zeros((h, w), np.uint8)
    s = ss
    stem = [
        (250 * s, 612 * s),
        (345 * s, 552 * s),
        (432 * s, 505 * s),
        (525 * s, 465 * s),
        (618 * s, 412 * s),
        (704 * s, 345 * s),
        (766 * s, 288 * s),
    ]
    _stroke_polyline(m, stem, 10 * s)
    leaves = (
        (352, 556, 70, 25, -28),
        (430, 510, 82, 28, -35),
        (515, 470, 80, 28, -18),
        (612, 416, 84, 29, -22),
        (694, 348, 74, 26, -50),
        (560, 322, 76, 27, 28),
        (648, 300, 70, 25, 15),
        (716, 318, 62, 22, 5),
        (418, 590, 58, 21, 30),
    )
    for cx, cy, rx, ry, ang in leaves:
        _fill_ellipse(m, cx * s, cy * s, rx * s, ry * s, ang)
    return m


def _draw_ring(ss: int) -> np.ndarray:
    w, h = 900 * ss, 760 * ss
    m = np.zeros((h, w), np.uint8)
    s = ss
    cv2.ellipse(m, (450 * s, 400 * s), (244 * s, 238 * s), 0, 0, 360, 1, -1, cv2.LINE_AA)
    cv2.ellipse(m, (450 * s, 400 * s), (150 * s, 147 * s), 0, 0, 360, 0, -1, cv2.LINE_AA)
    # Thin bridge across the hole (narrow connection).
    cv2.line(m, (332 * s, 400 * s), (568 * s, 400 * s), 1, 9 * s, cv2.LINE_AA)
    return m


_DRAWERS = {"jug": _draw_jug, "sprig": _draw_sprig, "ring": _draw_ring}


# ---------------------------------------------------------------------------
# Texture synthesis
# ---------------------------------------------------------------------------


def _value_noise(rng: np.random.Generator, height: int, width: int, cell: int) -> np.ndarray:
    gh = max(2, height // cell)
    gw = max(2, width // cell)
    coarse = rng.normal(0.0, 1.0, (gh, gw)).astype(np.float32)
    up = cv2.resize(coarse, (width, height), interpolation=cv2.INTER_CUBIC)
    up = cv2.GaussianBlur(up, (0, 0), max(1.0, cell / 4.0))
    up -= up.mean()
    std = up.std()
    return up / std if std > 1e-6 else up


def _fabric_background(
    rng: np.random.Generator, width: int, height: int, base_bgr
) -> np.ndarray:
    xs, ys = np.meshgrid(np.arange(width, dtype=np.float32), np.arange(height, dtype=np.float32))
    base = np.array(base_bgr, np.float32)
    grad = (ys / height - 0.5) * 12.0
    folds = 5.0 * np.sin(xs / (width * 0.21) + 0.7) + 2.5 * np.sin((xs + ys) / (height * 0.17))
    vign = -7.0 * (((xs - width * 0.5) / width) ** 2 + ((ys - height * 0.5) / height) ** 2) * 2.0
    big = _value_noise(rng, height, width, 72) * 4.0
    fine = rng.normal(0.0, 1.8, (height, width)).astype(np.float32)
    lum = grad + folds + vign + big + fine
    weave = 1.1 * np.sin(xs * np.pi / 2.0) * np.sin(ys * np.pi / 2.0)
    tint = np.stack([lum + weave, lum * 0.9 + weave, lum * 0.8], axis=2)
    return np.clip(base[None, None, :] + tint, 0, 255)


def _object_texture(
    rng: np.random.Generator, width: int, height: int, base_bgr
) -> np.ndarray:
    xs, ys = np.meshgrid(np.arange(width, dtype=np.float32), np.arange(height, dtype=np.float32))
    base = np.array(base_bgr, np.float32)
    shade = (0.5 - xs / width) * 14.0 + (0.5 - ys / height) * 10.0
    mottle = _value_noise(rng, height, width, 58) * 5.0
    micro = rng.normal(0.0, 1.3, (height, width)).astype(np.float32)
    lum = shade + mottle + micro
    return np.clip(base[None, None, :] + lum[:, :, None] * np.array([0.85, 1.0, 0.9]), 0, 255)


@dataclass
class Sample:
    spec: SampleSpec
    image: np.ndarray  # BGR uint8
    alpha: np.ndarray  # float32 ground truth [0, 1]
    trimap: np.ndarray  # uint8: 0 bg, 128 soft edge, 255 fg
    box: tuple[int, int, int, int]
    strokes: list[Stroke]

    @property
    def key(self) -> str:
        return self.spec.key


def _scribble_strokes(lines, kind: int) -> list[Stroke]:
    out = []
    for pts in lines:
        radius = 12.0 if kind == FG else 14.0
        out.append(Stroke(kind=kind, radius=radius, points=[(float(x), float(y)) for x, y in pts]))
    return out


def generate_sample(key: str) -> Sample:
    if key not in SAMPLES:
        raise KeyError(f"unknown sample {key!r}")
    spec = SAMPLES[key]
    width, height = spec.width, spec.height
    ss = SUPERSAMPLE
    drawn = _DRAWERS[key](ss)
    cover = cv2.resize(drawn, (width, height), interpolation=cv2.INTER_AREA).astype(np.float32)
    alpha = cv2.GaussianBlur(cover, (0, 0), EDGE_SIGMA)
    alpha = np.clip(alpha, 0.0, 1.0)

    rng = np.random.default_rng(spec.seed)
    bg_tex = _fabric_background(rng, width, height, spec.background_color)
    fg_tex = _object_texture(rng, width, height, spec.foreground_color)

    # Contact shadow on the ground plane, in the *background* texture.
    xs, ys = np.meshgrid(np.arange(width, dtype=np.float32), np.arange(height, dtype=np.float32))
    contact = np.exp(
        -(((xs - width * 0.5) / (width * 0.34)) ** 2 + ((ys - height * 0.90) / (height * 0.08)) ** 2)
    )
    bg_tex = np.clip(bg_tex - contact[:, :, None] * np.array([12.0, 11.0, 10.0]), 0, 255)

    a3 = alpha[:, :, None]
    image = np.clip(fg_tex * a3 + bg_tex * (1.0 - a3), 0, 255).astype(np.uint8)

    trimap = np.zeros((height, width), np.uint8)
    trimap[alpha >= 0.995] = 255
    trimap[(alpha > 0.005) & (alpha < 0.995)] = 128

    return Sample(
        spec=spec,
        image=np.ascontiguousarray(image),
        alpha=alpha.astype(np.float32),
        trimap=trimap,
        box=spec.box,
        strokes=_scribble_strokes(spec.fg_lines, FG) + _scribble_strokes(spec.bg_lines, BG),
    )


def generate_all() -> dict[str, Sample]:
    return {key: generate_sample(key) for key in SAMPLES}


def sample_thumbnail(sample: Sample, max_side: int = 180) -> np.ndarray:
    h, w = sample.image.shape[:2]
    scale = max_side / float(max(h, w))
    return cv2.resize(
        sample.image, (max(1, int(w * scale)), max(1, int(h * scale))), interpolation=cv2.INTER_AREA
    )
