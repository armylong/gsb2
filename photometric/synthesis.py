"""Procedurally generated test scenes ("built-in photographs").

Two scenes are provided:

``sphere``
    A glossy sphere with a small satellite ball.  The main sphere shows a
    smooth normal field, a specular highlight (some of which clips to white),
    self-shadowing near the terminator and a cast shadow from the satellite.

``relief``
    A bas-relief height field containing a rounded bump, a conical dent, a
    raised wall and a rim.  It produces cast shadows on one side of every
    edge, which is where the "surface faces which way?" question is hardest.

Both are rendered under five directional lights.  Images are rendered in
linear radiance, then quantised to 8-bit so the solver sees the same
limitations as a real camera.  Ground-truth normals, albedo and the
shadow/specular masks are kept alongside the pixels for the verification
panel and the automated tests.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from functools import lru_cache

import numpy as np

from . import vecmath
from .rig import LightSpec

SCENE_SIZE = 320


@dataclass
class Scene:
    key: str
    title: str
    description: str
    images: np.ndarray                 # (m, H, W) float32 in [0, 1]
    lights: list[LightSpec]
    source: str = "builtin"            # "builtin" or "files"
    truth_normals: np.ndarray | None = None
    truth_albedo: np.ndarray | None = None
    object_mask: np.ndarray | None = None
    truth_shadow: np.ndarray | None = None
    truth_specular: np.ndarray | None = None
    truth_unlit: np.ndarray | None = None
    notes: list[str] = field(default_factory=list)

    @property
    def height(self) -> int:
        return int(self.images.shape[1])

    @property
    def width(self) -> int:
        return int(self.images.shape[2])

    @property
    def n_lights(self) -> int:
        return int(self.images.shape[0])

    @property
    def has_truth(self) -> bool:
        return self.truth_normals is not None and self.truth_albedo is not None

    def direction_matrix(self) -> np.ndarray:
        return np.stack([light.direction for light in self.lights], axis=0)

    def summary(self) -> str:
        return (f"{self.width}×{self.height} · {self.n_lights} 张灰度图 · "
                f"{'内置真值' if self.has_truth else '用户图片'}")


# ---------------------------------------------------------------------------
# Rendering helpers
# ---------------------------------------------------------------------------

def _smoothstep(edge0: float, edge1: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - edge0) / (edge1 - edge0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def _quantise(radiance: np.ndarray, rng: np.random.Generator,
              exposure: float = 1.0, read_noise: float = 0.0035) -> np.ndarray:
    """Linear radiance -> 8-bit photograph in [0, 1]."""
    noisy = radiance * exposure + rng.normal(0.0, read_noise, radiance.shape)
    return np.clip(np.rint(np.clip(noisy, 0.0, 1.0) * 255.0) / 255.0, 0.0, 1.0)


def _shade(normals: np.ndarray, albedo: np.ndarray, lights: np.ndarray,
           visibility: np.ndarray, spec_strength: float,
           spec_power: float, ambient: float, rng: np.random.Generator,
           exposure: float) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Phong-ish Lambert plus a specular lobe, with per-light visibility."""
    m = len(lights)
    view = np.array([0.0, 0.0, 1.0])
    images = np.empty((m,) + albedo.shape, dtype=np.float64)
    specular = np.zeros_like(images, dtype=bool)
    unlit = np.zeros_like(images, dtype=bool)
    for k, light in enumerate(lights):
        ndl_raw = np.einsum("hwj,j->hw", normals, light)
        ndl = np.clip(ndl_raw, 0.0, 1.0)
        half = light + view
        half /= np.linalg.norm(half)
        ndh = np.clip(np.einsum("hwj,j->hw", normals, half), 0.0, 1.0)
        spec = spec_strength * ndh ** spec_power
        radiance = albedo * ndl + spec
        images[k] = np.where(visibility[k], radiance, radiance * 0.045)
        specular[k] = (spec > 0.028) & visibility[k] & (ndl > 0.15)
        unlit[k] = ndl_raw <= 0.02
    return _quantise(images, rng, exposure), specular, unlit


# ---------------------------------------------------------------------------
# Sphere scene
# ---------------------------------------------------------------------------

_SPHERE_LIGHTS = [(320.0, 46.0), (40.0, 43.0), (120.0, 35.0),
                  (210.0, 24.0), (272.0, 58.0)]


def _ray_sphere_hit(origin: np.ndarray, direction: np.ndarray,
                    center: np.ndarray, radius: float) -> tuple[np.ndarray, np.ndarray]:
    """Distance to the near intersection and whether a hit happened."""
    d = origin - center
    b = np.einsum("...j,j->...", d, direction)
    c = np.einsum("...j,...j->...", d, d) - radius * radius
    disc = b * b - c
    root = np.sqrt(np.maximum(disc, 0.0))
    t = -b - root
    hit = (disc > 0.0) & (t > 1e-6)
    return t, hit


@lru_cache(maxsize=4)
def _build_sphere(size: int = SCENE_SIZE) -> Scene:
    H = W = int(size)
    yy, xx = np.mgrid[0:H, 0:W]
    X = ((xx + 0.5) / W) * 2.0 - 1.0
    Y = 1.0 - ((yy + 0.5) / H) * 2.0

    centres = np.array([[0.01, 0.01, 0.0], [-0.64, -0.58, 0.52]])
    radii = np.array([0.72, 0.185])

    # orthographic rays, front-most sphere wins
    best_t = np.full((H, W), np.inf)
    best_id = np.full((H, W), -1, dtype=np.int8)
    for sid, (c, r) in enumerate(zip(centres, radii)):
        dx = X - c[0]
        dy = Y - c[1]
        rho2 = dx * dx + dy * dy
        inside = rho2 < r * r
        t = 10.0 - c[2] - np.sqrt(np.maximum(r * r - rho2, 0.0))
        take = inside & (t < best_t)
        best_t = np.where(take, t, best_t)
        best_id = np.where(take, sid, best_id)

    mask = best_id >= 0
    normals = np.zeros((H, W, 3), dtype=np.float64)
    points = np.zeros((H, W, 3), dtype=np.float64)
    albedo = np.zeros((H, W), dtype=np.float64)
    for sid, (c, r) in enumerate(zip(centres, radii)):
        sel = best_id == sid
        if not np.any(sel):
            continue
        px = X[sel] - c[0]
        py = Y[sel] - c[1]
        pz = np.sqrt(np.maximum(r * r - px * px - py * py, 1e-9))
        normals[sel, 0] = px / r
        normals[sel, 1] = py / r
        normals[sel, 2] = pz / r
        points[sel, 0] = X[sel]
        points[sel, 1] = Y[sel]
        points[sel, 2] = c[2] + pz

    # textured main material, plain satellite material
    main = best_id == 0
    tex = (0.62
           + 0.055 * np.sin(3.4 * X + 0.6) * np.cos(2.7 * Y - 0.4)
           + 0.025 * np.sin(9.0 * X + 1.2) * np.sin(7.0 * Y + 0.3)
           + 0.018 * np.cos(17.0 * X - 0.7) * np.cos(13.0 * Y + 0.9))
    albedo = np.where(main, np.clip(tex, 0.48, 0.78), 0.50)
    albedo = np.where(mask, albedo, 0.0)

    lights = np.stack([vecmath.light_from_az_el(a, e) for a, e in _SPHERE_LIGHTS])
    visibility = np.zeros((len(lights), H, W), dtype=bool)
    for k, light in enumerate(lights):
        vis = np.ones((H, W), dtype=bool)
        for sid, (c, r) in enumerate(zip(centres, radii)):
            # only the *other* sphere can occlude a point on this one
            other = 1 - sid
            oc = centres[other]
            ro = radii[other]
            d = points - oc
            b = np.einsum("hwj,j->hw", d, light)
            cc = np.einsum("hwj,hwj->hw", d, d) - ro * ro
            disc = b * b - cc
            root = np.sqrt(np.maximum(disc, 0.0))
            t = -b - root
            hits = (disc > 0.0) & (t > 1e-4)
            vis &= ~(hits & (best_id == sid))
        visibility[k] = vis & mask

    rng = np.random.default_rng(20240517)
    images, specular, unlit = _shade(normals, albedo, lights, visibility,
                                     spec_strength=0.52, spec_power=90.0,
                                     ambient=0.0, rng=rng, exposure=1.0)
    images *= mask[None]

    specs = [LightSpec(a, e, True, f"图 {i + 1}") for i, (a, e) in enumerate(_SPHERE_LIGHTS)]
    return Scene(
        key="sphere",
        title="球面 · 镜面小球",
        description=("光滑球面配一颗小卫星球。包含镜面高光（其中有像素被削顶成白色）、"
                     "背光侧以及小球的投影，用来检验饱和、阴影与非朗伯三类标记。"),
        images=images.astype(np.float32),
        lights=specs,
        truth_normals=normals,
        truth_albedo=albedo,
        object_mask=mask,
        truth_shadow=~visibility,
        truth_specular=specular,
        truth_unlit=unlit & mask[None],
        notes=[
            "球面法线解析已知，可直接核对法线方向与编码。",
            "高光峰值被截断，是“数值饱和”的典型来源。",
            "卫星球遮住一部分入射光，产生真正的投射阴影。",
        ],
    )


# ---------------------------------------------------------------------------
# Bas-relief scene
# ---------------------------------------------------------------------------

_RELIEF_LIGHTS = [(310.0, 44.0), (35.0, 46.0), (100.0, 38.0),
                  (175.0, 32.0), (245.0, 55.0)]


def _height_field(X: np.ndarray, Y: np.ndarray) -> np.ndarray:
    bump = 0.30 * np.exp(-(((X + 0.36) ** 2) / 0.052 + ((Y - 0.10) ** 2) / 0.070))
    dent = -0.27 * np.exp(-(((X - 0.33) ** 2) / 0.036 + ((Y + 0.06) ** 2) / 0.052))
    # raised plateau with a sharp wall on its left side
    plateau = 0.20 * _smoothstep(-0.18, 0.02, Y + 0.18) * _smoothstep(0.12, 0.30, Y) \
        * _smoothstep(-0.78, -0.60, X) * _smoothstep(0.05, -0.15, X)
    wall = 0.16 * _smoothstep(-0.30, -0.22, X) * _smoothstep(0.62, 0.50, X) \
        * _smoothstep(-0.82, -0.72, Y) * _smoothstep(-0.60, -0.68, Y)
    rim = 0.10 * (np.exp(-((np.abs(X) - 0.93) ** 2) / 0.0018)
                  + np.exp(-((np.abs(Y) - 0.93) ** 2) / 0.0018))
    ripple = (0.020 * np.sin(2.4 * np.pi * X + 0.5) * np.cos(1.9 * np.pi * Y - 0.3)
              + 0.008 * np.sin(8.0 * X + 1.1) * np.sin(6.5 * Y + 0.4))
    return bump + dent + plateau + wall + rim + ripple


def _bilinear(field: np.ndarray, X: np.ndarray, Y: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    H, W = field.shape
    xf = (X + 1.0) * 0.5 * (W - 1)
    yf = (1.0 - Y) * 0.5 * (H - 1)
    x0 = np.floor(xf).astype(np.int64)
    y0 = np.floor(yf).astype(np.int64)
    inside = (x0 >= 0) & (x0 + 1 < W) & (y0 >= 0) & (y0 + 1 < H)
    x0c = np.clip(x0, 0, W - 2)
    y0c = np.clip(y0, 0, H - 2)
    fx = np.clip(xf - x0, 0.0, 1.0)
    fy = np.clip(yf - y0, 0.0, 1.0)
    v = (field[y0c, x0c] * (1 - fx) * (1 - fy)
         + field[y0c, x0c + 1] * fx * (1 - fy)
         + field[y0c + 1, x0c] * (1 - fx) * fy
         + field[y0c + 1, x0c + 1] * fx * fy)
    return v, inside


def _cast_shadows(h: np.ndarray, lights: np.ndarray) -> np.ndarray:
    H, W = h.shape
    yy, xx = np.mgrid[0:H, 0:W]
    X = ((xx + 0.5) / W) * 2.0 - 1.0
    Y = 1.0 - ((yy + 0.5) / H) * 2.0
    shadow = np.zeros((len(lights), H, W), dtype=bool)
    for k, light in enumerate(lights):
        if light[2] <= 0.03:
            shadow[k] = True
            continue
        blocked = np.zeros((H, W), dtype=bool)
        t = 0.010
        while t < 2.4:
            hh, inside = _bilinear(h, X + t * light[0], Y + t * light[1])
            blocked |= inside & (hh > h + t * light[2] + 0.0015)
            t += 0.010
        shadow[k] = blocked
    return shadow


@lru_cache(maxsize=4)
def _build_relief(size: int = SCENE_SIZE) -> Scene:
    H = W = int(size)
    yy, xx = np.mgrid[0:H, 0:W]
    X = ((xx + 0.5) / W) * 2.0 - 1.0
    Y = 1.0 - ((yy + 0.5) / H) * 2.0

    h = _height_field(X, Y)
    gy, gx = np.gradient(h, 2.0 / H, 2.0 / W)
    # with Y pointing up, n_y = +dh/d(row-spacing)
    normals = np.stack([-gx, gy, np.ones_like(h)], axis=-1)
    normals /= np.linalg.norm(normals, axis=-1, keepdims=True)

    albedo = (0.63
              + 0.045 * np.sin(2.2 * X + 0.3) * np.cos(3.1 * Y - 0.4)
              + 0.022 * np.sin(8.0 * X + 0.9) * np.sin(6.0 * Y + 1.7)
              + 0.015 * np.cos(15.0 * Y + 0.2))
    albedo = np.clip(albedo, 0.46, 0.80)
    mask = np.ones((H, W), dtype=bool)

    lights = np.stack([vecmath.light_from_az_el(a, e) for a, e in _RELIEF_LIGHTS])
    shadow = _cast_shadows(h, lights)
    visibility = ~shadow
    rng = np.random.default_rng(20240518)
    images, specular, unlit = _shade(normals, albedo, lights, visibility,
                                     spec_strength=0.28, spec_power=55.0,
                                     ambient=0.0, rng=rng, exposure=1.0)

    specs = [LightSpec(a, e, True, f"图 {i + 1}") for i, (a, e) in enumerate(_RELIEF_LIGHTS)]
    return Scene(
        key="relief",
        title="浮雕 · 凸起与凹陷",
        description=("倾斜掠射光下的浅浮雕：左侧是圆润的凸包，右中是锥形凹坑，"
                     "还有一堵带直边的矮墙和一圈边框。凸、凹两侧在高光与阴影里很容易看反，"
                     "正是需要靠多方向光度立体消歧的情形。"),
        images=images.astype(np.float32),
        lights=specs,
        truth_normals=normals,
        truth_albedo=albedo,
        object_mask=mask,
        truth_shadow=shadow,
        truth_specular=specular,
        truth_unlit=unlit,
        notes=[
            "凸包与凹坑的局部明暗在单盏灯下几乎可以互换。",
            "矮墙左侧的直边在所有灯下都投出阴影，那里最缺信息。",
            "画面四角有轻微边框遮挡，形成低信息量的边缘。",
        ],
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

BUILTIN_KEYS = ("sphere", "relief")


def builtin_names() -> list[tuple[str, str]]:
    return [("sphere", "球面 · 镜面小球"), ("relief", "浮雕 · 凸起与凹陷")]


def build_builtin(key: str, size: int = SCENE_SIZE) -> Scene:
    if key == "sphere":
        return _build_sphere(int(size))
    if key == "relief":
        return _build_relief(int(size))
    raise KeyError(f"unknown built-in scene: {key}")


def resize_stack(images: np.ndarray, max_side: int) -> tuple[np.ndarray, float]:
    """Bilinearly shrink a stack so its long side is at most ``max_side``.

    Returns the resized stack and the scale factor actually applied (1.0 when
    no resize happened).  Photometric stereo is per-pixel, so solving at a
    smaller size is safe; keeping one size for pixels *and* results avoids
    every coordinate-mapping bug downstream.
    """
    arr = np.asarray(images, dtype=np.float64)
    m, h, w = arr.shape
    longest = max(h, w)
    if longest <= max_side:
        return arr, 1.0
    factor = max_side / float(longest)
    new_h = max(16, int(round(h * factor)))
    new_w = max(16, int(round(w * factor)))
    ys = (np.arange(new_h) + 0.5) * (h / new_h) - 0.5
    xs = (np.arange(new_w) + 0.5) * (w / new_w) - 0.5
    y0 = np.clip(np.floor(ys).astype(int), 0, h - 2)
    x0 = np.clip(np.floor(xs).astype(int), 0, w - 2)
    fy = np.clip(ys - y0, 0, 1).reshape(1, new_h, 1)
    fx = np.clip(xs - x0, 0, 1).reshape(1, 1, new_w)
    a = arr[:, y0][:, :, x0]
    b = arr[:, y0][:, :, x0 + 1]
    c = arr[:, y0 + 1][:, :, x0]
    d = arr[:, y0 + 1][:, :, x0 + 1]
    out = (a * (1 - fy) * (1 - fx) + b * (1 - fy) * fx
           + c * fy * (1 - fx) + d * fy * fx)
    return out, factor


def scene_from_images(images: np.ndarray, directions: np.ndarray,
                      names: list[str] | None = None) -> Scene:
    """Wrap user photographs (already grayscale, same size) as a Scene."""
    arr = np.asarray(images, dtype=np.float32)
    if arr.ndim != 3:
        raise ValueError("expected a stack of grayscale images with shape (m, H, W)")
    dirs = np.asarray(directions, dtype=np.float64)
    if dirs.shape != (arr.shape[0], 3):
        raise ValueError("each image needs one light direction")
    specs = []
    for i, d in enumerate(dirs):
        az, el = vecmath.az_el_from_direction(d)
        specs.append(LightSpec(az, el, True, (names or [])[i] if names and i < len(names) else f"图 {i + 1}"))
    return Scene(
        key="files",
        title="载入的图片",
        description="用户载入的灰度图，光照方向由界面填写。",
        images=arr,
        lights=specs,
        source="files",
        truth_normals=None,
        truth_albedo=None,
        object_mask=(arr.max(axis=0) > 0.03),
        notes=["载入的图片没有真值，重光照对照只能和输入照片比较。"],
    )
