"""Generate synthetic emblem test images.

Three scenarios required by the spec:
  1. tilted.png       — emblem with a ~14° tilted symmetry axis, one missing
                        corner on a single side
  2. both_sides.png   — damage at mirrored positions on BOTH sides (gap)
  3. illumination.png — a smooth lighting gradient across the axis

Symmetry is constructed directly in the final image frame: every primitive is
defined by point sets, and each point's reflection across the ground-truth
axis is added to the same polygon/line before rasterization.  Both halves
therefore share one rasterization pass and the saved pristine image matches
its own reflection at lattice-pair level (no lossy rotate step).

Run:  python -m tests.make_fixtures <output_dir>
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import TYPE_CHECKING

import cv2
import numpy as np

if TYPE_CHECKING:
    from mirror_restorer.geometry import SymLine

SIZE = 560          # emblem design size
CANVAS = 720        # output canvas with margin so reflections stay in-image
ANGLE_DEG = 14.0
SEED = 44789
BG = 235


def _frame_transform(angle_deg: float, size: int, canvas: int
                     ) -> tuple[np.ndarray, SymLine]:
    """Canonical emblem frame -> output image frame on a larger canvas."""
    a = np.radians(angle_deg)
    cc = (size - 1) / 2.0          # emblem design center
    ox = (canvas - size) / 2.0     # top-left offset of the design on the canvas
    ca, sa = np.cos(a), np.sin(a)
    m = np.array([
        [ca, -sa, ox + cc - ca * cc + sa * cc],
        [sa, ca, ox + cc - sa * cc - ca * cc],
    ], np.float64)
    p0 = m @ np.array([cc, 0.0, 1.0])
    p1 = m @ np.array([cc, size - 1.0, 1.0])
    from mirror_restorer.geometry import SymLine
    line = SymLine(float(p0[0]), float(p0[1]), float(p1[0]), float(p1[1]))
    return m, line


class SymmetricCanvas:
    """Draws shapes that are exactly symmetric under the given axis.

    All input coordinates live in a canonical frame where the axis is the
    vertical line x=size/2.  Points are mapped into the image frame by M, and
    every primitive is completed with its reflected point set.
    """

    def __init__(self, design_size: int, canvas_size: int,
                 m: np.ndarray, line: "SymLine"):
        self.size = design_size
        self.canvas_size = canvas_size
        self.m = m
        self.line = line
        self.img = np.full((canvas_size, canvas_size), BG, np.uint8)

    def _map(self, pts: np.ndarray) -> np.ndarray:
        ones = np.ones((len(pts), 1), np.float64)
        return (self.m @ np.hstack([pts, ones]).T).T

    def _sym_polygon(self, canonical_pts: np.ndarray) -> np.ndarray:
        """Map a half-shape and append its reflection to close the shape."""
        c = (self.size - 1) / 2.0
        half = self._map(canonical_pts)
        mirror_canon = canonical_pts.copy()
        mirror_canon[:, 0] = 2 * c - mirror_canon[:, 0]
        other = self._map(mirror_canon)
        return np.vstack([half, other[::-1]])

    def fill_symmetric(self, canonical_pts: np.ndarray, color: int) -> None:
        poly = np.round(self._sym_polygon(canonical_pts)).astype(np.int32)
        cv2.fillPoly(self.img, [poly], color)

    def stroke_symmetric(self, canonical_pts: np.ndarray, color: int,
                         thickness: int, closed: bool = False) -> None:
        poly = np.round(self._sym_polygon(canonical_pts)).astype(np.int32)
        cv2.polylines(self.img, [poly], closed, color, thickness,
                      lineType=cv2.LINE_AA)

    def axis_centered_circle(self, radius: int, color: int, thickness: int) -> None:
        c = (self.size - 1) / 2.0
        center = np.round(self._map(np.array([[c, c]]))[0]).astype(int)
        cv2.circle(self.img, tuple(center), radius, color, thickness,
                   lineType=cv2.LINE_AA)

    def axis_centered_ellipse(self, cy: float, ax1: float, ax2: float,
                              color: int, thickness: int) -> None:
        c = (self.size - 1) / 2.0
        center = np.round(self._map(np.array([[c, cy]]))[0]).astype(int)
        angle = np.degrees(np.arctan2(self.m[1, 0], self.m[0, 0]))
        cv2.ellipse(self.img, tuple(center), (int(ax1), int(ax2)), angle,
                    0, 360, color, thickness, lineType=cv2.LINE_AA)


def _draw_emblem(design_size: int, canvas_size: int,
                 m: np.ndarray, line) -> np.ndarray:
    sc = SymmetricCanvas(design_size, canvas_size, m, line)
    c = (design_size - 1) / 2.0

    sc.axis_centered_circle(220, 60, 10)
    sc.axis_centered_circle(190, 90, 6)

    # laurel leaves: one leaf outline on the right, reflected automatically
    for j in range(9):
        t = j / 8.0
        y = c - 150 + t * 300
        x = c + 150 - 40 * np.sin(t * np.pi)
        leaf = np.array([
            [x - 26, y], [x, y - 12], [x + 26, y], [x, y + 12],
        ], np.float64)
        sc.fill_symmetric(leaf, 70)

    sc.axis_centered_ellipse(c - 30, 90, 110, 50, 8)

    # five-point star, drawn as one right-half polygon + reflected half
    star = []
    for j in range(5):
        aa = -np.pi / 2 + j * 2 * np.pi / 5
        star.append([c + 45 * np.cos(aa), c - 30 + 45 * np.sin(aa)])
        aa2 = aa + np.pi / 5
        star.append([c + 18 * np.cos(aa2), c - 30 + 18 * np.sin(aa2)])
    star = np.array(star, np.float64)
    right_half = star[star[:, 0] >= c - 1e-9]
    right_half = right_half[np.argsort(np.arctan2(right_half[:, 1] - (c - 30),
                                                  right_half[:, 0] - c))]
    # include the two axis crossing points so the polygon closes on the axis
    axis_pts = np.array([[c, c - 30 - 45], [c, c - 30 + 45]], np.float64)
    half_poly = np.vstack([axis_pts[0], right_half, axis_pts[1]])
    sc.fill_symmetric(half_poly, 40)

    # caption bars: right-half horizontal segments, reflected to full bars
    for j, width in enumerate((60, 90, 60)):
        y = c + 150 + j * 18
        seg = np.array([[c, y], [c + width / 2, y]], np.float64)
        sc.stroke_symmetric(seg, 70, 6)

    return sc.img


def _poly_damage(mask: np.ndarray, pts: list[tuple[int, int]]) -> None:
    cv2.fillPoly(mask, [np.array(pts, np.int32)], 255)


def build_all(out_dir: Path) -> dict:
    rng = np.random.default_rng(SEED)
    out_dir.mkdir(parents=True, exist_ok=True)

    m, line = _frame_transform(ANGLE_DEG, SIZE, CANVAS)
    gray = _draw_emblem(SIZE, CANVAS, m, line)

    # symmetric grain: reflect the noise field across the axis before adding
    from mirror_restorer.geometry import build_maps
    h, w = gray.shape
    noise = rng.normal(0, 2.5, (h, w)).astype(np.float32)
    # mirror noise onto itself so paired pixels get the same grain value
    map_x, map_y, _ = build_maps((h, w), line)
    noise_mir = cv2.remap(noise, map_x, map_y, cv2.INTER_NEAREST)
    noise = 0.5 * (noise + noise_mir)
    gray = np.clip(gray.astype(np.float32) + noise, 0, 255).astype(np.uint8)
    pristine = cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)
    cv2.imwrite(str(out_dir / "pristine.png"), pristine)

    # --- scenario 1: single-side missing corner ----------------------------
    # The canvas margin guarantees every reflected source coordinate is
    # in-image; out-of-bounds handling is covered by a dedicated unit test.
    dmg_one = np.zeros((h, w), np.uint8)
    _poly_damage(dmg_one, [
        (w - 150, 150), (w - 150, 330), (w - 260, 290), (w - 190, 170),
    ])
    tilted = pristine.copy()
    tilted[dmg_one > 0] = (18, 18, 18)
    cv2.imwrite(str(out_dir / "tilted.png"), tilted)
    cv2.imwrite(str(out_dir / "tilted_damage_mask.png"), dmg_one)

    # --- scenario 2: damage at mirrored positions on both sides ------------
    from mirror_restorer.geometry import reflection_rt
    r, t = reflection_rt(line)
    ys, xs = np.where(dmg_one > 0)
    pts = np.stack([xs, ys], 1).astype(np.float64)
    q = pts @ r.T + t
    valid = ((q[:, 0] >= 0) & (q[:, 0] < w) &
             (q[:, 1] >= 0) & (q[:, 1] < h))
    dmg_both = dmg_one.copy()
    qi = np.round(q[valid]).astype(np.int64)
    dmg_both[qi[:, 1], qi[:, 0]] = 255
    dmg_both = cv2.dilate(dmg_both, np.ones((5, 5), np.uint8))
    both = pristine.copy()
    both[dmg_both > 0] = (18, 18, 18)
    cv2.imwrite(str(out_dir / "both_sides.png"), both)
    cv2.imwrite(str(out_dir / "both_sides_damage_mask.png"), dmg_both)

    # --- scenario 3: illumination ramp along the axis normal ---------------
    nx, ny = line.normal
    gx, gy = np.meshgrid(np.arange(w, dtype=np.float32),
                         np.arange(h, dtype=np.float32))
    center = (CANVAS - 1) / 2.0
    grad = 28.0 * ((gx - center) * nx + (gy - center) * ny) / (SIZE / 2)
    illum = np.clip(gray.astype(np.float32) + grad, 0, 255).astype(np.uint8)
    illum_bgr = cv2.cvtColor(illum, cv2.COLOR_GRAY2BGR)
    illum_bgr[dmg_one > 0] = (18, 18, 18)
    cv2.imwrite(str(out_dir / "illumination.png"), illum_bgr)
    cv2.imwrite(str(out_dir / "illumination_damage_mask.png"), dmg_one)

    roi = (int(center - 70), int(center - 70),
           int(center + 70), int(center + 70))
    meta = {
        "size": CANVAS,
        "design_size": SIZE,
        "line_gt": {"x1": line.x1, "y1": line.y1, "x2": line.x2, "y2": line.y2,
                    "angle_deg": ANGLE_DEG},
        "suggest_roi": roi,
    }
    (out_dir / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    return meta


if __name__ == "__main__":
    target = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("tests/fixtures")
    info = build_all(target)
    print(json.dumps(info, indent=2))
    print(f"fixtures written to {target}")
