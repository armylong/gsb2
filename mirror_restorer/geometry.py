"""Symmetry-line geometry and reflection warps.

All math is kept in float64.  The OpenCV remap/warp maps are float32 but the
fractional offsets are preserved (never rounded to integer shifts), so an
oblique axis stays sub-pixel accurate all the way into the exported image.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, replace

import cv2
import numpy as np

MapPair = tuple[np.ndarray, np.ndarray]


@dataclass(frozen=True)
class SymLine:
    """A symmetry axis defined by two points, stored as floats."""

    x1: float
    y1: float
    x2: float
    y2: float

    @classmethod
    def from_points(cls, p1: tuple[float, float], p2: tuple[float, float]) -> "SymLine":
        return cls(float(p1[0]), float(p1[1]), float(p2[0]), float(p2[1]))

    @property
    def p1(self) -> np.ndarray:
        return np.array([self.x1, self.y1], dtype=np.float64)

    @property
    def p2(self) -> np.ndarray:
        return np.array([self.x2, self.y2], dtype=np.float64)

    @property
    def length(self) -> float:
        return float(np.hypot(self.x2 - self.x1, self.y2 - self.y1))

    @property
    def angle(self) -> float:
        """Angle of the axis in radians, range (-pi, pi]."""
        return math.atan2(self.y2 - self.y1, self.x2 - self.x1)

    @property
    def unit(self) -> np.ndarray:
        n = max(self.length, 1e-12)
        return np.array([(self.x2 - self.x1) / n, (self.y2 - self.y1) / n], np.float64)

    @property
    def normal(self) -> np.ndarray:
        ux, uy = self.unit
        return np.array([-uy, ux], dtype=np.float64)

    def with_endpoints(
        self, p1: tuple[float, float], p2: tuple[float, float]
    ) -> "SymLine":
        return SymLine.from_points(p1, p2)

    def nudged(self, dx1: float, dy1: float, dx2: float, dy2: float) -> "SymLine":
        return replace(
            self,
            x1=self.x1 + dx1,
            y1=self.y1 + dy1,
            x2=self.x2 + dx2,
            y2=self.y2 + dy2,
        )

    def extended(self, half_length: float) -> "SymLine":
        """Same infinite line, endpoints placed ±half_length around p1."""
        ux, uy = self.unit
        c = self.p1
        return SymLine.from_points(
            (c[0] - ux * half_length, c[1] - uy * half_length),
            (c[0] + ux * half_length, c[1] + uy * half_length),
        )


def line_from_anchor(anchor: np.ndarray, angle: float, half_length: float) -> SymLine:
    u = np.array([math.cos(angle), math.sin(angle)], np.float64)
    return SymLine.from_points(
        (anchor[0] - u[0] * half_length, anchor[1] - u[1] * half_length),
        (anchor[0] + u[0] * half_length, anchor[1] + u[1] * half_length),
    )


def reflection_rt(line: SymLine) -> tuple[np.ndarray, np.ndarray]:
    """Return (R, t) with x_reflected = R @ x + t, float64."""
    ux, uy = line.unit
    r = np.array(
        [[2 * ux * ux - 1, 2 * ux * uy], [2 * ux * uy, 2 * uy * uy - 1]],
        dtype=np.float64,
    )
    c = line.p1
    t = c - r @ c
    return r, t


def reflection_matrix(line: SymLine) -> np.ndarray:
    """2x3 affine matrix (destination pixel -> reflected source pixel)."""
    r, t = reflection_rt(line)
    return np.hstack([r, t.reshape(2, 1)]).astype(np.float64)


def build_maps(
    shape: tuple[int, int], line: SymLine
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Build remap maps plus a boolean inside-image mask.

    Returns:
        map_x, map_y: float32 maps giving the reflected *source* coordinate
            for every destination pixel; fractional values are preserved.
        inside: bool array, True where the reflected source coordinate lies
            inside the image bounds.
    """
    h, w = shape[:2]
    r, t = reflection_rt(line)
    xs, ys = np.meshgrid(
        np.arange(w, dtype=np.float64), np.arange(h, dtype=np.float64)
    )
    map_x = r[0, 0] * xs + r[0, 1] * ys + t[0]
    map_y = r[1, 0] * xs + r[1, 1] * ys + t[1]
    inside = (map_x >= 0.0) & (map_x <= w - 1.0) & (map_y >= 0.0) & (map_y <= h - 1.0)
    return map_x.astype(np.float32), map_y.astype(np.float32), inside


def reflect_points(points: np.ndarray, line: SymLine) -> np.ndarray:
    """Reflect an (N, 2) array of x/y points across the line (float64)."""
    pts = np.asarray(points, dtype=np.float64).reshape(-1, 2)
    r, t = reflection_rt(line)
    return pts @ r.T + t


def point_line_distance(point: tuple[float, float], line: SymLine) -> float:
    p = np.asarray(point, dtype=np.float64)
    ux, uy = line.unit
    vx, vy = p - line.p1
    return float(abs(ux * vy - uy * vx))


def nearest_on_line(point: tuple[float, float], line: SymLine) -> np.ndarray:
    p = np.asarray(point, dtype=np.float64)
    return line.p1 + line.unit * np.dot(p - line.p1, line.unit)


def mirror_image(
    image: np.ndarray,
    line: SymLine,
    maps: MapPair | None = None,
    border_value: int | tuple[int, ...] = 0,
) -> np.ndarray:
    """Reflect the whole image across the line with bilinear interpolation."""
    if maps is None:
        map_x, map_y, _ = build_maps(image.shape, line)
    else:
        map_x, map_y = maps
    return cv2.remap(
        image,
        map_x,
        map_y,
        interpolation=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=border_value,
    )
