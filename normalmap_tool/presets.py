"""Built-in synthetic height maps with independent expected geometry.

All presets are generated at 256x256 and stored as 8-bit height codes, then
normalised to [0, 1].  The ramps are constructed so that, at interior pixels,
a central difference recovers exactly ``1/255`` height per pixel; their
expected normals are therefore analytic rather than measured from the same
finite-difference code path used by the app.
"""

from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Optional

import numpy as np

from .model import (
    BOUNDARY_EXTEND,
    BOUNDARY_WRAP,
    VALIDATION_LIGHT,
    LightSettings,
)

PRESET_SIZE = 256

PRESET_FLAT = "flat"
PRESET_HORIZONTAL = "hramp"
PRESET_VERTICAL = "vramp"
PRESET_WAVE = "wave"

PRESET_ORDER = (PRESET_FLAT, PRESET_HORIZONTAL, PRESET_VERTICAL, PRESET_WAVE)


@dataclass(frozen=True)
class PresetSpec:
    key: str
    label: str
    description: str
    default_boundary: str
    default_strength: float
    has_analytic_normal: bool


PRESETS = {
    PRESET_FLAT: PresetSpec(
        key=PRESET_FLAT,
        label="平面",
        description="均匀中间灰; 期望法线 (0, 0, 1), 平坦区朝向正 z。",
        default_boundary=BOUNDARY_EXTEND,
        default_strength=32.0,
        has_analytic_normal=True,
    ),
    PRESET_HORIZONTAL: PresetSpec(
        key=PRESET_HORIZONTAL,
        label="水平斜坡",
        description="亮度从左到右增加, 每像素上升 1/255; 期望法线向 -x 倾斜。",
        default_boundary=BOUNDARY_EXTEND,
        default_strength=32.0,
        has_analytic_normal=True,
    ),
    PRESET_VERTICAL: PresetSpec(
        key=PRESET_VERTICAL,
        label="竖直斜坡",
        description="亮度从上到下增加 (图像行向下), 期望法线向 +y 倾斜。",
        default_boundary=BOUNDARY_EXTEND,
        default_strength=32.0,
        has_analytic_normal=True,
    ),
    PRESET_WAVE: PresetSpec(
        key=PRESET_WAVE,
        label="周期波纹",
        description="两个方向均以图像尺寸为周期的正弦波纹; 适合测试 wrap 边界。",
        default_boundary=BOUNDARY_WRAP,
        default_strength=32.0,
        has_analytic_normal=False,
    ),
}


@dataclass(frozen=True)
class PresetData:
    key: str
    codes: np.ndarray       # uint8, original 8-bit height codes
    height: np.ndarray      # float64 in [0, 1]
    width: int
    height_px: int


def generate_preset(key: str, size: int = PRESET_SIZE) -> PresetData:
    if key not in PRESETS:
        raise KeyError(f"unknown preset: {key!r}")
    size = int(size)
    if size < 8 or size > 1024:
        raise ValueError("preset size must be between 8 and 1024")
    rows = np.arange(size, dtype=np.float64)[:, None]
    cols = np.arange(size, dtype=np.float64)[None, :]

    if key == PRESET_FLAT:
        codes = np.full((size, size), 128, dtype=np.uint8)
    elif key == PRESET_HORIZONTAL:
        # Exact 8-bit ramp: code[c] = c when size == 256; generally spans 0..255.
        span = size - 1
        codes = np.rint(cols * (255.0 / span)).astype(np.uint8)
        codes = np.broadcast_to(codes, (size, size)).copy()
    elif key == PRESET_VERTICAL:
        span = size - 1
        codes = np.rint(rows * (255.0 / span)).astype(np.uint8)
        codes = np.broadcast_to(codes, (size, size)).copy()
    elif key == PRESET_WAVE:
        # Both terms are periodic over ``size`` pixels along their axis.
        field = (
            0.5
            + 0.32 * np.sin(2.0 * math.pi * cols / size)
            + 0.16 * np.sin(2.0 * math.pi * rows / size + math.pi / 3.0)
        )
        codes = np.rint(np.clip(field, 0.0, 1.0) * 255.0).astype(np.uint8)
    else:  # pragma: no cover - guarded above
        raise KeyError(key)

    return PresetData(
        key=key,
        codes=codes,
        height=codes.astype(np.float64) / 255.0,
        width=size,
        height_px=size,
    )


def preset_defaults(key: str) -> dict:
    spec = PRESETS[key]
    return {
        "boundary": spec.default_boundary,
        "strength": spec.default_strength,
        "smoothing": 0.0,
        "light": VALIDATION_LIGHT,
    }


WAVE_LATERAL_AMPLITUDE = 0.32
WAVE_ROW_AMPLITUDE = 0.16
WAVE_ROW_PHASE = math.pi / 3.0


def expected_normal_wave(strength: float, size: int) -> np.ndarray:
    """Analytic normals of the continuous periodic wave (independent check).

    Same sine law as :func:`generate_preset`, differentiated in continuous
    coordinates.  Compared against the app's finite differences this differs
    by the height field's 8-bit quantisation, not by a code path shared with
    the generator.
    """
    n = int(size)
    cols = np.broadcast_to(np.arange(n, dtype=np.float64)[None, :], (n, n))
    rows = np.broadcast_to(np.arange(n, dtype=np.float64)[:, None], (n, n))
    k = 2.0 * math.pi / float(n)
    dh_dcol = k * WAVE_LATERAL_AMPLITUDE * np.cos(k * cols)
    dh_drow = k * WAVE_ROW_AMPLITUDE * np.cos(k * rows + WAVE_ROW_PHASE)
    s = float(strength)
    vec = np.stack([-s * dh_dcol, s * dh_drow, np.ones_like(dh_dcol)], axis=-1)
    return vec / np.linalg.norm(vec, axis=-1, keepdims=True)


def wave_tolerance(strength: float) -> float:
    """Budget for finite-difference vs analytic wave normals.

    An 8-bit height code rounds by up to half a code, so a central difference
    can be off by 1/255; after multiplying by the strength and normalising the
    budget is about ``strength / 255 * 1.1``.  The minimum keeps 8-bit *normal*
    storage rounding (about 0.004 per channel) covered for small strengths.
    """
    return max(0.02, 1.1 * float(strength) / 255.0)


def expected_normal_for_ramp(key: str, strength: float, size: int) -> Optional[np.ndarray]:
    """Analytic interior normal for the flat and ramp presets.

    For a ramp spanning the full 0..255 code range over ``size - 1`` pixels,
    dh/dpixel = 1 / (size - 1).  Returns ``None`` for the wave preset.
    """
    if key == PRESET_FLAT:
        return np.array([0.0, 0.0, 1.0], dtype=np.float64)
    if key not in (PRESET_HORIZONTAL, PRESET_VERTICAL):
        return None
    slope = float(strength) / float(max(size - 1, 1))
    if key == PRESET_HORIZONTAL:
        n = np.array([-slope, 0.0, 1.0], dtype=np.float64)
    else:
        # Height increases downward: dh/dy = -dh/drow, so n_y = +slope.
        n = np.array([0.0, slope, 1.0], dtype=np.float64)
    return n / np.linalg.norm(n)


def fixed_lamp_intensity(
    normal: np.ndarray,
    row: int,
    col: int,
    width: int,
    height: int,
    light: LightSettings = VALIDATION_LIGHT,
) -> float:
    from .model import light_direction_at, shade

    n = np.asarray(normal, dtype=np.float64).reshape(1, 1, 3)
    l = light_direction_at(row, col, width, height, light).reshape(1, 1, 3)
    return float(shade(n, l, light.ambient, light.diffuse)[0, 0])
