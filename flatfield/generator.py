"""Synthetic acquisition set with known ground truth.

The generator simulates a camera fixed on a bench:

* per-pixel bias (incl. amp glow) and read noise           -> dark frames
* smooth illumination with cos^4 vignetting + low-freq ripple -> light frames
* a few pixels with permanent saturation and "flicker" pixels with excess
  temporal variation                                       -> light frames
* obstructed pixels and one large occluded disk            -> light frames
* one sample frame with a known small-feature texture, lit through the same
  optics                                                  -> sample frame

Ground truth is returned/saved so the GUI can verify background flatness and
texture preservation after correction.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

from .core import FULL_SCALE, Frame
from .io import Meta, write_json_bundle, write_mask_png, write_png

SAT = FULL_SCALE


@dataclass
class SyntheticSet:
    darks: list[Frame]
    lights: list[Frame]
    sample: Frame
    size: tuple[int, int]  # (h, w)
    bias: np.ndarray
    flat_norm: np.ndarray          # illumination normalized at image center
    sample_ideal: np.ndarray       # noise-free expected corrected output (ADU)
    texture: np.ndarray            # known texture, dimensionless
    illumination: np.ndarray       # absolute illumination profile (ADU per unit texture)
    true_defects: np.ndarray       # pixels the generator deliberately broke
    true_large_area: np.ndarray    # large occluded region
    meta: Meta = field(default_factory=Meta)
    seed: int = 0
    background_level: float = 0.08

    @property
    def background_mask(self) -> np.ndarray:
        return self.texture <= self.background_level * 1.25

    @property
    def texture_mask(self) -> np.ndarray:
        return self.texture > self.background_level * 1.25

    @property
    def valid_truth(self) -> np.ndarray:
        return ~self.true_defects


def _gaussian_blur(arr: np.ndarray, sigma: float) -> np.ndarray:
    """Small separable Gaussian blur (no scipy dependency)."""
    if sigma <= 0:
        return arr
    radius = max(1, int(round(3 * sigma)))
    x = np.arange(-radius, radius + 1, dtype=np.float64)
    kernel = np.exp(-0.5 * (x / sigma) ** 2)
    kernel /= kernel.sum()
    padded = np.pad(arr, radius, mode="reflect")
    tmp = np.apply_along_axis(lambda m: np.convolve(m, kernel, mode="valid"), 0, padded)
    out = np.apply_along_axis(lambda m: np.convolve(m, kernel, mode="valid"), 1, tmp)
    return out


def _vignette(h: int, w: int, strength: float = 0.55) -> np.ndarray:
    y = (np.arange(h) - (h - 1) / 2) / max(h - 1, 1) * 2.0
    x = (np.arange(w) - (w - 1) / 2) / max(w - 1, 1) * 2.0
    yy, xx = np.meshgrid(y, x, indexing="ij")
    r2 = yy ** 2 + xx ** 2
    profile = np.cos(np.arctan(np.sqrt(r2) * 1.1)) ** 4
    profile /= profile.max()
    return (1.0 - strength * (1.0 - profile)).astype(np.float32)


def _low_freq_ripple(h: int, w: int, rng: np.random.Generator,
                     amplitude: float) -> np.ndarray:
    yy, xx = np.meshgrid(np.linspace(0, 1, h), np.linspace(0, 1, w), indexing="ij")
    field = np.zeros((h, w), np.float64)
    for _ in range(3):
        fy, fx = rng.uniform(0.5, 1.8, size=2)
        py, px = rng.uniform(0, 2 * np.pi, size=2)
        field += rng.uniform(0.3, 1.0) * np.sin(2 * np.pi * (fy * yy + fx * xx) + py + px)
    field /= max(np.abs(field).max(), 1e-6)
    return (1.0 + amplitude * field).astype(np.float32)


def _make_texture(h: int, w: int, rng: np.random.Generator,
                  background: float = 0.08) -> tuple[np.ndarray, np.ndarray]:
    texture = np.full((h, w), background, np.float32)
    # faint smooth gradient on the background (flatness still meaningful)
    yy, xx = np.meshgrid(np.linspace(-1, 1, h), np.linspace(-1, 1, w), indexing="ij")
    texture += (0.004 * background * (xx + yy)).astype(np.float32)

    region = np.zeros((h, w), bool)
    cy, cx = int(h * 0.5), int(w * 0.5)
    half_h, half_w = int(h * 0.30), int(w * 0.30)
    y0, y1 = cy - half_h, cy + half_h
    x0, x1 = cx - half_w, cx + half_w
    region[y0:y1, x0:x1] = True

    # bar patterns with different periods (small features -> proves resolution kept)
    for i, period in enumerate((4, 6, 9, 13)):
        py0 = y0 + int((i + 0.5) * half_h / 2.2)
        py1 = py0 + max(6, half_h // 7)
        band = ((np.arange(x0, x1) // (period // 2)) % 2).astype(np.float32)
        bar = 0.5 + 0.35 * band
        texture[py0:py1, x0:x1] = np.maximum(texture[py0:py1, x0:x1], bar[None, :])
        region[py0:py1, x0:x1] = True

    # small squares / dots (few pixels wide)
    for _ in range(18):
        side = int(rng.integers(2, 8))
        ry = int(rng.integers(y0 + 4, max(y0 + 5, y1 - side - 4)))
        rx = int(rng.integers(x0 + 4, max(x0 + 5, x1 - side - 4)))
        level = float(rng.uniform(0.15, 0.9))
        patch = texture[ry:ry + side, rx:rx + side]
        texture[ry:ry + side, rx:rx + side] = np.maximum(patch, level)
        region[ry:ry + side, rx:rx + side] = True

    # an edge (step) and a soft disc
    ey = cy + int(half_h * 0.55)
    texture[ey:ey + max(3, h // 60), x0:x1] = 0.75
    region[ey:ey + max(3, h // 60), x0:x1] = True
    dy, dx = cy - int(half_h * 0.5), cx + int(half_w * 0.45)
    radius = max(4, min(h, w) // 60)
    dy_grid, dx_grid = np.mgrid[-radius:radius + 1, -radius:radius + 1]
    disc = (dy_grid ** 2 + dx_grid ** 2) <= radius ** 2
    sub = texture[dy - radius:dy + radius + 1, dx - radius:dx + radius + 1]
    sub[disc] = np.maximum(sub[disc], 0.6)
    region[dy - radius:dy + radius + 1, dx - radius:dx + radius + 1] |= disc

    texture = _gaussian_blur(texture.astype(np.float64), 0.7).astype(np.float32)
    return texture, region


def _disk_mask(h: int, w: int, cy: int, cx: int, radius: int) -> np.ndarray:
    yy, xx = np.mgrid[0:h, 0:w]
    return (yy - cy) ** 2 + (xx - cx) ** 2 <= radius ** 2


def generate_set(
    size: tuple[int, int] = (480, 640),
    seed: int = 20251124,
    n_dark: int = 5,
    n_light: int = 5,
    exposure_ms: float = 30.0,
    gain_db: float = 0.0,
    bias_level: float = 320.0,
    light_center: float = 42000.0,
    read_noise: float = 4.0,
    texture_scale: float = 14000.0,
) -> SyntheticSet:
    h, w = size
    rng = np.random.default_rng(seed)
    meta = Meta(exposure_ms=exposure_ms, gain_db=gain_db,
                black_level=int(round(bias_level)), bit_depth=16,
                note="synthetic")

    # --- optics & sensor --------------------------------------------------
    vignette = _vignette(h, w)
    ripple = _low_freq_ripple(h, w, rng, amplitude=0.02)
    illumination_profile = (vignette * ripple).astype(np.float32)
    center = float(illumination_profile[h // 2, w // 2])
    flat_norm = illumination_profile / center

    bias = (bias_level + _gaussian_blur(rng.normal(0, 1, (h, w)),
                                        sigma=min(h, w) / 8) * 40).astype(np.float32)
    # hot pixels: permanently saturated in the light frames
    hot_pixels = set()
    while len(hot_pixels) < 6:
        hot_pixels.add((int(rng.integers(0, h)), int(rng.integers(0, w))))
    # isolated near-zero response pixels
    dead_pixels = set()
    while len(dead_pixels) < 4 and len(dead_pixels) < h * w - 10:
        p = (int(rng.integers(0, h)), int(rng.integers(0, w)))
        if p not in hot_pixels:
            dead_pixels.add(p)
    # flickering pixels / small clusters
    flicker = np.zeros((h, w), np.float32)
    flicker_pixels: list[tuple[int, int]] = []
    while len(flicker_pixels) < 5:
        p = (int(rng.integers(10, h - 10)), int(rng.integers(10, w - 10)))
        flicker_pixels.append(p)
    # large occluded disk (dust on the window) ~ 2 % of the field
    disk_r = max(14, int(min(h, w) * 0.045))
    disk = _disk_mask(h, w, int(h * 0.24), int(w * 0.74), disk_r)

    true_defects = np.zeros((h, w), bool)
    true_large = disk.copy()
    for r, c in hot_pixels:
        true_defects[r, c] = True
    for r, c in dead_pixels:
        true_defects[r, c] = True
    for r, c in flicker_pixels:
        flicker[r, c] = 0.18
        true_defects[r, c] = True
    true_defects |= disk

    response = flat_norm.copy()
    response[disk] *= 0.025            # obstruction -> nearly zero flat
    for r, c in dead_pixels:
        response[r, c] = 0.0
    for r, c in hot_pixels:
        response[r, c] = 1.0           # handled by clipping

    # --- dark frames ------------------------------------------------------
    darks = []
    for i in range(n_dark):
        frame = bias + rng.normal(0, read_noise, (h, w))
        darks.append(Frame(np.clip(np.rint(frame), 0, SAT).astype(np.uint16),
                           name=f"dark_{i + 1:02d}.png", meta=meta))

    # --- light frames -----------------------------------------------------
    prnu = rng_fixed_pattern(rng, (h, w))
    lights = []
    for i in range(n_light):
        signal = light_center * response * prnu * (1.0 + flicker *
                                                   rng.normal(0, 1, (h, w)))
        frame = bias + signal + rng.normal(0, read_noise + np.sqrt(np.maximum(signal, 0)) * 0.02,
                                           (h, w))
        for r, c in hot_pixels:
            frame[r, c] = SAT
        lights.append(Frame(np.clip(np.rint(frame), 0, SAT).astype(np.uint16),
                            name=f"light_{i + 1:02d}.png", meta=meta))

    # --- sample -----------------------------------------------------------
    texture, texture_region = _make_texture(h, w, rng)
    sample_signal = texture_scale * texture * response * prnu
    # A perfect dark+flat correction reproduces the texture at the average
    # illumination scale: corrected = texture * texture_scale * median(response*prnu)
    norm_scale = float(np.median(response * prnu))
    sample_ideal = (texture * texture_scale * norm_scale).astype(np.float32)
    frame = bias + sample_signal + rng.normal(0, read_noise, (h, w))
    # a couple of specular highlights that clip only on the sample
    highlights = [(int(h * 0.4), int(w * 0.2)), (int(h * 0.66), int(w * 0.83))]
    for r, c in highlights:
        frame[r, c] = SAT
    for r, c in hot_pixels:
        frame[r, c] = SAT
    sample = Frame(np.clip(np.rint(frame), 0, SAT).astype(np.uint16),
                   name="sample.png", meta=meta)

    # texture_region is informative only; keep it inside the texture mask
    _ = texture_region
    return SyntheticSet(
        darks=darks, lights=lights, sample=sample, size=(h, w),
        bias=bias.astype(np.float32), flat_norm=flat_norm.astype(np.float32),
        sample_ideal=sample_ideal.astype(np.float32),
        texture=texture.astype(np.float32),
        illumination=(illumination_profile * light_center).astype(np.float32),
        true_defects=true_defects, true_large_area=true_large,
        meta=meta, seed=seed, background_level=0.08)


def rng_fixed_pattern(rng: np.random.Generator, shape: tuple[int, int]) -> np.ndarray:
    """Per-pixel PRNU-like response, stable across light frames."""
    pattern = rng.normal(0, 0.004, shape)
    return (1.0 + _gaussian_blur(pattern, 0.8)).astype(np.float32)


def save_set(dataset: SyntheticSet, outdir: str | Path) -> dict[str, Any]:
    out = Path(outdir)
    out.mkdir(parents=True, exist_ok=True)
    meta = dataset.meta
    files: dict[str, Any] = {"dark": [], "light": [], "sample": None}
    refs: list[str] = []

    def save(frame: Frame) -> str:
        name = frame.name or f"frame_{len(refs):02d}.png"
        write_png(out / name, frame.array, meta)
        refs.append(name)
        return name

    darks = np.stack([f.array for f in dataset.darks])
    lights = np.stack([f.array for f in dataset.lights])
    np.savez_compressed(
        out / "bundle.npz", dark=darks, light=lights, sample=dataset.sample.array,
        meta=np.array(json.dumps(meta.to_dict(), ensure_ascii=False)))
    for frame in dataset.darks:
        files["dark"].append(save(frame))
    for frame in dataset.lights:
        files["light"].append(save(frame))
    files["sample"] = save(dataset.sample)
    write_json_bundle(out / "bundle.json", files, meta)

    write_mask_png(out / "truth_valid_mask.png", ~dataset.true_defects)
    write_mask_png(out / "truth_large_area.png", dataset.true_large_area)
    write_mask_png(out / "truth_texture_mask.png", dataset.texture_mask)
    np.savez_compressed(
        out / "ground_truth.npz",
        bias=dataset.bias, flat_norm=dataset.flat_norm,
        sample_ideal=dataset.sample_ideal, texture=dataset.texture,
        illumination=dataset.illumination,
        true_defects=dataset.true_defects, true_large_area=dataset.true_large_area,
        background_level=np.array(dataset.background_level, np.float64),
        size=np.array(dataset.size, np.int32), seed=np.array(dataset.seed),
        meta=np.array(json.dumps(meta.to_dict(), ensure_ascii=False)))
    return {
        "dir": str(out),
        "bundle_json": str(out / "bundle.json"),
        "bundle_npz": str(out / "bundle.npz"),
        "ground_truth": str(out / "ground_truth.npz"),
        "files": files,
    }


if __name__ == "__main__":  # pragma: no cover - convenience CLI
    import argparse

    parser = argparse.ArgumentParser(description="Generate a synthetic flat-field dataset")
    parser.add_argument("outdir", nargs="?", default="artifacts/synthetic")
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--height", type=int, default=480)
    parser.add_argument("--darks", type=int, default=5)
    parser.add_argument("--lights", type=int, default=5)
    parser.add_argument("--seed", type=int, default=20251124)
    args = parser.parse_args()
    ds = generate_set((args.height, args.width), seed=args.seed,
                      n_dark=args.darks, n_light=args.lights)
    info = save_set(ds, args.outdir)
    print(json.dumps(info, indent=2, ensure_ascii=False))
