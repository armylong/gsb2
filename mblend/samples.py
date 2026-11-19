"""Built-in sample pairs for self-testing and demonstration.

Every sample pair is generated deterministically from noise so the tool can
be exercised without external files.  The set covers wide luminance
differences, fine stripes (to expose high-frequency detail handling) and
large flat colour blocks (to expose low-frequency seams), plus an odd-size
pair.  ``DEFAULT_SAMPLE`` is the odd-size pair.
"""

from __future__ import annotations

import numpy as np

DEFAULT_SAMPLE = "odd_size"

_SAMPLES = (
    "brightness",
    "stripes",
    "blocks",
    "odd_size",
)


def sample_names() -> tuple[str, ...]:
    return _SAMPLES


def _checkerboard(height: int, width: int, cell: int) -> np.ndarray:
    yy = (np.arange(height)[:, None] // cell) % 2
    xx = (np.arange(width)[None, :] // cell) % 2
    return ((yy + xx) % 2).astype(np.float32)


def _linear_gradient(height: int, width: int, horizontal: bool) -> np.ndarray:
    if horizontal:
        ramp = np.linspace(0.0, 1.0, width, dtype=np.float32)[None, :]
        return np.repeat(ramp, height, axis=0)
    ramp = np.linspace(0.0, 1.0, height, dtype=np.float32)[:, None]
    return np.repeat(ramp, width, axis=1)


def _to_rgb8(linear_rgb: np.ndarray) -> np.ndarray:
    linear_rgb = np.clip(linear_rgb, 0.0, 1.0)
    from .color import linear_to_srgb

    return np.clip(np.rint(linear_to_srgb(linear_rgb) * 255.0), 0, 255).astype(
        np.uint8
    )


def _pair_brightness(height: int, width: int) -> tuple[np.ndarray, np.ndarray]:
    """Same structure, strong low-frequency luminance difference."""
    rng = np.random.default_rng(20240101)
    base = np.zeros((height, width, 3), dtype=np.float32)
    warmth = _linear_gradient(height, width, horizontal=True)
    base[..., 0] = 0.05 + 0.20 * warmth
    base[..., 1] = 0.05 + 0.12 * warmth
    base[..., 2] = 0.06 + 0.04 * warmth

    # soft blobs, identical in both images
    yy = np.arange(height, dtype=np.float32)[:, None] / max(height, 1)
    xx = np.arange(width, dtype=np.float32)[None, :] / max(width, 1)
    blobs = np.zeros((height, width), dtype=np.float32)
    for _ in range(6):
        cx, cy = rng.uniform(0.15, 0.85, size=2)
        sigma = rng.uniform(0.08, 0.2)
        blobs += np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * sigma * sigma))
    blobs = np.clip(blobs / max(float(blobs.max()), 1e-6), 0.0, 1.0)

    a = base + blobs[..., None] * 0.05
    b = base * 0.18 + blobs[..., None] * 0.01
    b[..., 2] += 0.05
    return _to_rgb8(a), _to_rgb8(b)


def _pair_stripes(height: int, width: int) -> tuple[np.ndarray, np.ndarray]:
    """Fine stripes over a smooth background, with a strong luminance step."""
    yy = np.arange(height, dtype=np.float32)[:, None]
    xx = np.arange(width, dtype=np.float32)[None, :]

    period = 3
    diagonal = ((np.floor((xx + yy) / period) % 2) * 2.0 - 1.0).astype(np.float32)
    vertical = ((np.floor(xx / 2) % 2) * 2.0 - 1.0).astype(np.float32)

    ramp = _linear_gradient(height, width, horizontal=True)
    warm = np.stack(
        [
            0.35 + 0.30 * ramp,
            0.28 + 0.20 * ramp,
            0.20 + 0.10 * ramp,
        ],
        axis=2,
    ).astype(np.float32)
    cool = np.stack(
        [
            0.10 + 0.05 * ramp,
            0.16 + 0.10 * ramp,
            0.30 + 0.16 * ramp,
        ],
        axis=2,
    ).astype(np.float32)

    a = warm + diagonal[..., None] * 0.06 + vertical[..., None] * 0.03
    b = cool + diagonal[..., None] * 0.03 - vertical[..., None] * 0.02
    return _to_rgb8(a), _to_rgb8(b)


def _pair_blocks(height: int, width: int) -> tuple[np.ndarray, np.ndarray]:
    """Large flat colour blocks so low-frequency seams are obvious."""
    yy = np.arange(height, dtype=np.float32)[:, None]
    xx = np.arange(width, dtype=np.float32)[None, :]
    cell = max(12, min(height, width) // 4)
    tile = (np.floor(xx / cell) + np.floor(yy / cell)) % 2

    warm = np.array([0.55, 0.30, 0.12], dtype=np.float32)
    cool = np.array([0.10, 0.28, 0.50], dtype=np.float32)
    light = np.array([0.75, 0.70, 0.55], dtype=np.float32)
    dark = np.array([0.03, 0.04, 0.06], dtype=np.float32)

    a = np.where(tile[..., None] > 0.5, warm, light)
    b = np.where(tile[..., None] > 0.5, cool, dark)
    # a small sharp square in the middle adds high-frequency content
    h0, h1 = height // 2 - 4, height // 2 + 4
    w0, w1 = width // 2 - 4, width // 2 + 4
    a = a.astype(np.float32).copy()
    b = b.astype(np.float32).copy()
    a[h0:h1, w0:w1] = [0.9, 0.9, 0.2]
    b[h0:h1, w0:w1] = [0.02, 0.02, 0.02]
    return _to_rgb8(a), _to_rgb8(b)


def _odd_size_pair() -> tuple[np.ndarray, np.ndarray]:
    """979×643 pair (both odd, differently rounded) mixing all three motifs."""
    height, width = 643, 979
    rng = np.random.default_rng(7)
    yy = np.arange(height, dtype=np.float32)[:, None]
    xx = np.arange(width, dtype=np.float32)[None, :]

    blocks = _checkerboard(height, width, 61)[..., None]
    ramp = _linear_gradient(height, width, horizontal=True)[..., None]
    a = np.concatenate(
        [0.15 + 0.45 * ramp, 0.12 + 0.28 * ramp, 0.10 + 0.12 * ramp], axis=2
    )
    b = np.concatenate(
        [0.03 + 0.06 * ramp, 0.05 + 0.10 * ramp, 0.09 + 0.22 * ramp], axis=2
    )
    a = a * (0.7 + 0.3 * blocks)
    b = b * (0.6 + 0.4 * blocks)

    stripes = ((np.floor((xx + 0.6 * yy) / 2.0) % 2) * 2.0 - 1.0) * 0.02
    a += stripes[..., None]
    b -= stripes[..., None] * 0.5

    # fine noise of different phase, plus a hard-edged bright patch in A only
    a += rng.normal(0.0, 0.012, a.shape).astype(np.float32)
    b += rng.normal(0.0, 0.012, b.shape).astype(np.float32)
    a[120:180, 240:330] = [0.85, 0.80, 0.25]
    b[430:470, 700:860] = [0.02, 0.03, 0.05]
    return _to_rgb8(a), _to_rgb8(b)


def make_sample(name: str) -> tuple[np.ndarray, np.ndarray]:
    """Return ``(rgb_a, rgb_b)`` uint8 sRGB arrays for a built-in sample."""
    if name == "brightness":
        return _pair_brightness(512, 768)
    if name == "stripes":
        return _pair_stripes(360, 540)
    if name == "blocks":
        return _pair_blocks(400, 600)
    if name == "odd_size":
        return _odd_size_pair()
    raise KeyError(f"unknown sample: {name}")
