"""Single build pipeline shared by the GUI and the tests.

The lighting preview deliberately shades the *decoded stored normal bytes*
rather than the continuous height gradient: the screen, the pixel readout and
a re-loaded normal map therefore all agree to the last quantisation step.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .model import (
    BOUNDARY_EXTEND,
    GREEN_Y_UP,
    LightSettings,
    compute_normal_field,
    decode_normal_rgb,
    encode_normal_rgb,
    light_direction_field,
    shade,
    smooth_height,
)


@dataclass(frozen=True)
class BuildParams:
    strength: float = 32.0
    smoothing: float = 0.0
    boundary: str = BOUNDARY_EXTEND
    green: str = GREEN_Y_UP


@dataclass(frozen=True)
class NormalBuild:
    params: BuildParams
    processed: np.ndarray      # processed normalised height
    geometric: np.ndarray      # continuous unit normals (H, W, 3)
    rgb: np.ndarray            # uint8 encoded normal map
    decoded: np.ndarray        # unit normals decoded from ``rgb``
    decoded_raw: np.ndarray    # raw components decoded from ``rgb``
    decoded_length: np.ndarray # vector lengths before renormalising

    @property
    def width(self) -> int:
        return int(self.rgb.shape[1])

    @property
    def height(self) -> int:
        return int(self.rgb.shape[0])


def build_normals(height: np.ndarray, params: BuildParams) -> NormalBuild:
    h = np.asarray(height, dtype=np.float64)
    processed = smooth_height(h, params.smoothing, params.boundary)
    geometric, _, _ = compute_normal_field(processed, params.strength, params.boundary)
    rgb = encode_normal_rgb(geometric, params.green)
    dec = decode_normal_rgb(rgb, params.green)
    return NormalBuild(
        params=params,
        processed=processed,
        geometric=geometric,
        rgb=rgb,
        decoded=dec.unit,
        decoded_raw=dec.raw,
        decoded_length=dec.length,
    )


@dataclass(frozen=True)
class LightingResult:
    light: LightSettings
    lit: np.ndarray            # HxW float, shaded decoded normal map
    flat_lit: np.ndarray       # HxW float, reference flat material
    ndotl: np.ndarray          # HxW raw dot product (can be negative)
    light_vectors: np.ndarray  # HxWx3 surface -> light unit vectors


def shade_build(build: NormalBuild, light: LightSettings) -> LightingResult:
    light = light.clamped()
    w, h = build.width, build.height
    lvec = light_direction_field(w, h, light)
    ndotl = np.sum(build.decoded * lvec, axis=-1)
    lit = shade(build.decoded, lvec, light.ambient, light.diffuse)
    flat_normals = np.zeros((h, w, 3), dtype=np.float64)
    flat_normals[..., 2] = 1.0
    flat_lit = shade(flat_normals, lvec, light.ambient, light.diffuse)
    return LightingResult(
        light=light,
        lit=lit,
        flat_lit=flat_lit,
        ndotl=ndotl,
        light_vectors=lvec,
    )
