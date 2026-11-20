"""Built-in test image: numbered lattice dots, asymmetric arrows, soft edges.

Everything is drawn with OpenCV primitives and a tiny built-in bitmap digit
font, so generating the fixture needs no external font file.
"""

from __future__ import annotations

import cv2
import numpy as np

def _rgba(color: tuple[int, int, int], alpha: int = 255) -> tuple[int, int, int, int]:
    """Build the 4-channel tuple for OpenCV drawing on an RGBA array.

    OpenCV writes tuples in array channel order without interpreting them, so
    passing RGB keeps the declared colours correct for our RGBA canvas.
    """
    return (color[0], color[1], color[2], alpha)


# 3x5 bitmap digits; each string row is one pixel row.
_DIGITS: dict[str, tuple[str, ...]] = {
    "0": ("111", "101", "101", "101", "111"),
    "1": ("010", "110", "010", "010", "111"),
    "2": ("111", "001", "111", "100", "111"),
    "3": ("111", "001", "111", "001", "111"),
    "4": ("101", "101", "111", "001", "001"),
    "5": ("111", "100", "111", "001", "111"),
    "6": ("111", "100", "111", "101", "111"),
    "7": ("111", "001", "010", "010", "010"),
    "8": ("111", "101", "111", "101", "111"),
    "9": ("111", "101", "111", "001", "111"),
}


def draw_number(
    rgba: np.ndarray,
    value: int,
    x: int,
    y: int,
    scale: int = 2,
    color: tuple[int, int, int] = (255, 255, 255),
    halo: tuple[int, int, int] | None = (20, 20, 30),
) -> None:
    """Draw a non-negative integer at top-left ``(x, y)`` in RGBA space.

    Uses the embedded 3x5 font only; no system font is consulted.
    """
    text = str(int(value))
    glyph_w = 3 * scale
    gap = scale
    total_w = len(text) * glyph_w + (len(text) - 1) * gap
    if halo is not None:
        cv2.rectangle(
            rgba,
            (x - scale, y - scale),
            (x + total_w + scale - 1, y + 5 * scale + scale - 1),
            _rgba(halo),
            -1,
        )
    cx = x
    for ch in text:
        rows = _DIGITS[ch]
        for ry, row in enumerate(rows):
            for rx, bit in enumerate(row):
                if bit == "1":
                    cv2.rectangle(
                        rgba,
                        (cx + rx * scale, y + ry * scale),
                        (cx + rx * scale + scale - 1, y + ry * scale + scale - 1),
                        _rgba(color),
                        -1,
                    )
        cx += glyph_w + gap


def _blend_over(dst: np.ndarray, bgr: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """Alpha-composite a BGR colour with per-pixel alpha onto an RGBA canvas."""
    out = dst.copy()
    a = alpha.astype(np.float32)[..., None] / 255.0
    rgb = bgr.astype(np.float32)
    base = dst[..., :3].astype(np.float32)
    base_a = dst[..., 3:4].astype(np.float32) / 255.0
    out_a = a + base_a * (1.0 - a)
    rgb_out = np.divide(
        rgb * a + base * base_a * (1.0 - a),
        np.maximum(out_a, 1e-8),
    )
    out[..., :3] = np.clip(rgb_out + 0.5, 0, 255).astype(np.uint8)
    out[..., 3] = np.clip(out_a[..., 0] * 255.0 + 0.5, 0, 255).astype(np.uint8)
    return out


def _draw_arrow(
    rgba: np.ndarray,
    start: tuple[int, int],
    end: tuple[int, int],
    color: tuple[int, int, int],
    thickness: int = 5,
    bend: tuple[int, int] | None = None,
) -> None:
    """Draw a straight or bent arrow with a filled triangular head."""
    p0 = np.array(start, dtype=np.int32)
    p1 = np.array(end, dtype=np.int32)
    pts = [p0]
    if bend is not None:
        pts.append(np.array(bend, dtype=np.int32))
    pts.append(p1)
    for a, b in zip(pts, pts[1:]):
        cv2.line(rgba, tuple(a), tuple(b), _rgba(color), thickness, cv2.LINE_AA)
    direction = p1 - pts[-2]
    length = float(np.linalg.norm(direction))
    if length < 1e-6:
        return
    u = direction / length
    n = np.array([-u[1], u[0]])
    head_len = 26.0
    head_half = 13.0
    base = p1 - u * head_len
    head = np.array([p1, base + n * head_half, base - n * head_half], dtype=np.int32)
    cv2.fillPoly(rgba, [head], _rgba(color), cv2.LINE_AA)
    # A small dark notch on the head makes the arrow direction unambiguous.
    notch = base + u * 4.0
    cv2.circle(rgba, (int(notch[0]), int(notch[1])), 4, _rgba((25, 25, 35)), -1, cv2.LINE_AA)


def generate_test_image(width: int = 720, height: int = 540) -> np.ndarray:
    """Create an RGBA test image with numbered lattice points and soft edge.

    Layout is intentionally asymmetric: a single large bent arrow, a short
    arrow, a triangular corner wedge, and numbered markers at a 7x5 lattice.
    The outer frame is genuinely semi-transparent over a transparent margin,
    which makes black-fringe bugs visible during warping.
    """
    if width < 160 or height < 160:
        raise ValueError("test image must be at least 160x160")
    w, h = int(width), int(height)
    rgba = np.zeros((h, w, 4), dtype=np.uint8)

    # --- opaque interior with a colourful, asymmetric background -----------
    margin = max(22, min(w, h) // 14)
    x0, x1 = margin, w - margin
    y0, y1 = margin, h - margin
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    u = xx / max(w - 1, 1)
    v = yy / max(h - 1, 1)
    bg = np.zeros((h, w, 3), dtype=np.uint8)
    bg[..., 0] = np.clip(70 + 110 * (1 - v) + 35 * np.sin(6.3 * u), 0, 255)  # B
    bg[..., 1] = np.clip(55 + 90 * u + 25 * np.cos(4.2 * v), 0, 255)  # G
    bg[..., 2] = np.clip(90 + 100 * (1 - u) + 30 * np.sin(5.1 * u + 2.0), 0, 255)  # R
    interior = np.zeros((h, w), dtype=bool)
    interior[y0 + 1 : y1, x0 + 1 : x1] = True
    rgba[interior, :3] = bg[interior]
    rgba[interior, 3] = 255

    # diagonal texture lines for easy visual comparison of the warp
    for k in range(-h, w, 47):
        cv2.line(
            rgba,
            (max(x0, k), max(y0, 0)),
            (min(x1, k + h), min(y1, h)),
            _rgba((245, 245, 245), 70),
            1,
            cv2.LINE_AA,
        )

    # --- semi-transparent colour frame over a transparent margin -----------
    frame_mask = np.zeros((h, w), dtype=bool)
    frame_mask[:y0, :] = True
    frame_mask[y1:, :] = True
    frame_mask[:, :x0] = True
    frame_mask[:, x1:] = True
    # radial-ish alpha: strongest at the image edge, fading to zero in the
    # outermost 8 px so the PNG has a genuinely soft transparent boundary.
    dist_to_edge = np.minimum.reduce([xx, yy, (w - 1) - xx, (h - 1) - yy])
    alpha = np.where(frame_mask, np.clip(40 + 4.0 * dist_to_edge, 0, 190), 0)
    alpha[dist_to_edge < 8] *= dist_to_edge[dist_to_edge < 8] / 8.0
    frame_color = np.zeros((h, w, 3), dtype=np.uint8)
    # RGB (210, 60, 180) on the left, (60, 200, 220) on the right; stored
    # back-to-front because frame_color is consumed as RGB by _blend_over.
    frame_color[..., 0] = 210
    frame_color[..., 1] = 60
    frame_color[..., 2] = 180
    # Alternate the frame colour to make orientation obvious.
    right_half = xx > (w // 2)
    frame_color[right_half, 0] = 60
    frame_color[right_half, 1] = 200
    frame_color[right_half, 2] = 220
    rgba = _blend_over(rgba, frame_color, alpha)

    # --- asymmetric arrows --------------------------------------------------
    _draw_arrow(
        rgba,
        (int(w * 0.58), int(h * 0.68)),
        (int(w * 0.78), int(h * 0.32)),
        (255, 230, 40),
        thickness=6,
        bend=(int(w * 0.63), int(h * 0.40)),
    )
    _draw_arrow(
        rgba,
        (int(w * 0.24), int(h * 0.28)),
        (int(w * 0.36), int(h * 0.24)),
        (255, 120, 80),
        thickness=4,
    )
    # corner wedge only in the top-left: a strong asymmetry cue
    wedge = np.array(
        [
            (x0 + 14, y0 + 80),
            (x0 + 14, y0 + 16),
            (x0 + 78, y0 + 16),
        ],
        dtype=np.int32,
    )
    cv2.fillPoly(rgba, [wedge], _rgba((80, 240, 120)), cv2.LINE_AA)

    # --- numbered lattice dots ---------------------------------------------
    cols, rows = 7, 5
    gx = np.linspace(x0 + 42, x1 - 42, cols)
    gy = np.linspace(y0 + 46, y1 - 46, rows)
    number = 1
    for r in range(rows):
        for c in range(cols):
            cx, cy = int(round(gx[c])), int(round(gy[r]))
            cv2.circle(rgba, (cx, cy), 8, _rgba((255, 255, 255)), -1, cv2.LINE_AA)
            cv2.circle(rgba, (cx, cy), 5, _rgba((25, 60, 140)), -1, cv2.LINE_AA)
            draw_number(
                rgba,
                number,
                cx + 11,
                cy - 8,
                scale=max(1, min(3, min(w, h) // 260)),
                color=(255, 255, 255),
            )
            number += 1

    # Clip any drawing that escaped the opaque interior is allowed: arrows
    # intentionally cross the soft edge to exercise edge interpolation.
    return rgba


def save_test_image(path: str, width: int = 720, height: int = 540) -> np.ndarray:
    """Generate and write a test image, returning the RGBA array."""
    from .io import save_png_rgba

    image = generate_test_image(width, height)
    save_png_rgba(path, image)
    return image
