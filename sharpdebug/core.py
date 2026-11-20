"""Image generation and the sharpening / analysis pipeline (no Qt imports).

Pipeline overview
-----------------
The debugger deliberately exposes *unsharp masking per scale* so the user can
see exactly which spatial frequency band is responsible for halos:

1. ``base``      : the input image converted to float in linear-ish sRGB space.
   We keep the encoded values (0..1 after /255) because photo editors work on
   display-referred data; every metric shown is measured on these values.
2. ``blur_i``    : Gaussian blur at scale ``sigma_i``.  A detail layer is
   ``base - blur_i`` (positive = brighter than its neighbourhood).
3. ``gate_i``    : a soft edge gate derived from the gradient magnitude of the
   *blurred* layer, scaled by ``1 - edge_threshold``.  Where the gradient is
   strong (object silhouette) the gate falls to 0, which is what kills the
   white fringe along cut-outs.
4. ``detail_i``  : ``gate_i * (base - blur_i)`` - the editable detail layer.
5. result        : ``base + strength * sum(weight_i * detail_i)`` then clipped.

All arrays are float64 in ``[0, 1]`` unless stated otherwise.  Nothing in this
module auto-levels or normalises for display; the UI applies fixed display
transforms so measured overshoot is never hidden.
"""
from __future__ import annotations

from dataclasses import dataclass, field
import numpy as np

# ---------------------------------------------------------------------------
# Colour helpers
# ---------------------------------------------------------------------------

LUMA = np.array([0.2126, 0.7152, 0.0722], dtype=np.float64)


def rgb_to_hsv(rgb: np.ndarray) -> np.ndarray:
    """Vectorised RGB->HSV, input/output ``[..., 3]`` in ``[0, 1]``."""
    rgb = np.asarray(rgb, dtype=np.float64)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    maxc = rgb.max(axis=-1)
    minc = rgb.min(axis=-1)
    delta = maxc - minc
    h = np.zeros_like(maxc)
    mask = delta > 1e-12
    idx = mask & (maxc == r)
    h[idx] = ((g[idx] - b[idx]) / delta[idx]) % 6.0
    idx = mask & (maxc == g)
    h[idx] = (b[idx] - r[idx]) / delta[idx] + 2.0
    idx = mask & (maxc == b)
    h[idx] = (r[idx] - g[idx]) / delta[idx] + 4.0
    h = (h / 6.0) % 1.0
    s = np.where(maxc > 1e-12, delta / np.maximum(maxc, 1e-12), 0.0)
    v = maxc
    return np.stack([h, s, v], axis=-1)


def luma(rgb: np.ndarray) -> np.ndarray:
    return np.asarray(rgb, dtype=np.float64) @ LUMA


# ---------------------------------------------------------------------------
# Filters
# ---------------------------------------------------------------------------


def _gaussian_kernel(sigma: float) -> np.ndarray:
    radius = max(1, int(np.ceil(sigma * 3.0)))
    x = np.arange(-radius, radius + 1, dtype=np.float64)
    k = np.exp(-(x * x) / (2.0 * sigma * sigma))
    return k / k.sum()


def _convolve1d(a: np.ndarray, k: np.ndarray, axis: int) -> np.ndarray:
    """Separable 1-D convolution along ``axis`` of an HxWxC float array."""
    r = len(k) // 2
    pad_width = [(0, 0), (0, 0), (0, 0)]
    pad_width[axis] = (r, r)
    padded = np.pad(a, pad_width, mode="reflect")
    out = np.zeros_like(a)
    n = a.shape[axis]
    for i, w in enumerate(k):
        sl = [slice(None), slice(None), slice(None)]
        sl[axis] = slice(i, i + n)
        out += w * padded[tuple(sl)]
    return out


def _separable(img: np.ndarray, k: np.ndarray) -> np.ndarray:
    """Apply a 1-D kernel horizontally and vertically. HxW or HxWxC."""
    a = np.asarray(img, dtype=np.float64)
    single = a.ndim == 2
    if single:
        a = a[..., None]
    out = _convolve1d(_convolve1d(a, k, axis=1), k, axis=0)
    return out[..., 0] if single else out


def gaussian_blur(img: np.ndarray, sigma: float) -> np.ndarray:
    """Separable Gaussian blur with reflect padding. Works on HxW or HxWxC."""
    if sigma <= 0:
        return img.astype(np.float64, copy=True)
    return _separable(img, _gaussian_kernel(sigma))


def _box_blur(img: np.ndarray, radius: int) -> np.ndarray:
    """Cheap box blur used for the gradient gate (per channel or 2-D)."""
    if radius < 1:
        return np.asarray(img, dtype=np.float64)
    k = np.ones(2 * radius + 1, dtype=np.float64) / (2 * radius + 1)
    return _separable(img, k)


def gradient_magnitude(img: np.ndarray, smooth_sigma: float = 1.0) -> np.ndarray:
    """Sobel gradient magnitude of the luma channel, lightly smoothed."""
    y = luma(img) if img.ndim == 3 else np.asarray(img, dtype=np.float64)
    if smooth_sigma > 0:
        y = gaussian_blur(y, smooth_sigma)
    gy, gx = np.gradient(y)
    return np.hypot(gx, gy)


# ---------------------------------------------------------------------------
# Sharpen configuration & result container
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ScaleSpec:
    """One editable detail scale."""

    sigma: float
    weight: float = 1.0
    gate_sigma: float = 1.0
    enabled: bool = True


DEFAULT_SCALES: tuple[ScaleSpec, ...] = (
    ScaleSpec(sigma=0.7, weight=1.0),
    ScaleSpec(sigma=1.6, weight=0.8),
    ScaleSpec(sigma=3.5, weight=0.5),
)


@dataclass
class SharpenParams:
    strength: float = 1.0
    edge_threshold: float = 0.15  # 0..1; higher == allow more edge detail through
    edge_softness: float = 0.06   # width of the soft gate transition
    scales: list[ScaleSpec] = field(default_factory=lambda: list(DEFAULT_SCALES))
    # 0 = float, 1 = integer 8-bit (adds what a real export would do)
    quantize_bits: int = 0
    # "rgb"   : unsharp mask per channel (classic; can shift hue at edges)
    # "luma"  : one luminance detail added to all channels (hue preserving)
    chroma: str = "rgb"


@dataclass
class SharpenResult:
    base: np.ndarray            # HxWx3 float, input (sRGB 0..1)
    blurs: list[np.ndarray]     # HxWx3 per scale
    gates: list[np.ndarray]     # HxW per scale
    details: list[np.ndarray]   # HxWx3 per scale, gated detail
    raw_details: list[np.ndarray]  # HxWx3 per scale, ungated (for comparison)
    result: np.ndarray          # HxWx3 float, clipped 0..1
    result_unclipped: np.ndarray  # HxWx3 float, can exceed 0..1


def _shift_by(a: np.ndarray, offset: int, axis: int) -> np.ndarray:
    """``out[x] = a[x + offset]`` along ``axis``, edge padded.

    Positive ``offset`` moves samples towards lower indices (the output looks
    "ahead" in the array); negative looks back.
    """
    if offset == 0:
        return a.copy()
    pad = [(0, 0)] * a.ndim
    pad[axis] = (abs(offset), abs(offset))
    p = np.pad(a, pad, mode="edge")
    sl = [slice(None)] * a.ndim
    start = abs(offset) + offset
    sl[axis] = slice(start, start + a.shape[axis])
    return p[tuple(sl)]


def _dilate1d(a: np.ndarray, offset: int, axis: int) -> np.ndarray:
    """``a[x] = max(a[x], a[x + offset])`` along ``axis`` (edge padded)."""
    if offset <= 0:
        return a
    return np.maximum(a, _shift_by(a, offset, axis))


def _max_1d(a: np.ndarray, radius: int, axis: int) -> np.ndarray:
    """Exact sliding max over a window of 2*radius+1 along one axis.

    Classic two-overlapping-blocks trick: build max over a power-of-two window
    by doubling, then two copies shifted by ``w - block`` cover any window
    length between ``block`` and ``2*block``.  O(log r) passes and exact,
    unlike doubling a cross-shaped 2-D window.
    """
    w = 2 * radius + 1
    if w <= 1:
        return a
    block = 1 << (w.bit_length() - 1)   # largest power of two <= w
    d = a
    step = 1
    while step < block:
        d = _dilate1d(d, step, axis)
        step *= 2
    # d[i] holds max(a[i .. i+block-1]).
    # Window at i is [i-radius, i+radius].  It is covered by the block
    # starting at i-radius and the block starting at i-radius+offset:
    #   [i-r, i-r+block-1]  ∪  [i-r+offset, i-r+offset+block-1]
    offset = w - block
    lo = _shift_by(d, -radius, axis)
    hi = _shift_by(d, offset - radius, axis)
    return np.maximum(lo, hi)


def max_filter(a: np.ndarray, radius: int) -> np.ndarray:
    """Exact square max filter, O(log r) passes per axis.

    The array is padded with -inf by ``2*radius`` so the two-block sliding-max
    construction never folds edge samples back into a window (which would make
    the result larger than the true window max).  The -inf border can never
    win a max, so after cropping the result equals the clipped-window maximum.
    """
    a = np.asarray(a, dtype=np.float64)
    if radius < 1:
        return a.copy()
    pad = 2 * radius
    p = np.pad(a, pad, mode="constant", constant_values=-np.inf)
    out = _max_1d(_max_1d(p, radius, axis=0), radius, axis=1)
    h, w = a.shape
    return out[pad : pad + h, pad : pad + w]


def gate_from_gradient(
    grad: np.ndarray, threshold: float, softness: float
) -> np.ndarray:
    """Soft suppression gate: 1 in flat areas, 0 on strong edges.

    ``threshold`` is the gradient magnitude (in normalized units) above which
    suppression starts.  A smoothstep of half-width ``softness`` avoids banding.
    """
    t = float(np.clip(threshold, 0.0, 1.0))
    s = max(float(softness), 1e-4)
    # smoothstep from 1 at grad<=t-s to 0 at grad>=t+s
    x = np.clip((grad - (t - s)) / (2.0 * s), 0.0, 1.0)
    smooth = x * x * (3.0 - 2.0 * x)
    return 1.0 - smooth


def _normalise_gradient(grad: np.ndarray) -> np.ndarray:
    """Map raw Sobel magnitudes to a 0..1 scale for the threshold slider.

    A full black/white step in 0..1 linear values has a Sobel magnitude of
    about 0.35 per side after the 0.8 px pre-smoothing used here, so dividing
    by 0.35 puts a fully saturated edge at ~1.0.  This is a fixed constant,
    never rescaled per image, so the threshold means the same thing on every
    photo.
    """
    return np.clip(grad / 0.35, 0.0, 1.0)


def compute_sharpen(base: np.ndarray, params: SharpenParams) -> SharpenResult:
    """Run the full multi-scale unsharp mask with edge gating.

    The gate is computed per scale and *dilated* by the halo extent of that
    scale (≈2σ).  A gate based on the instantaneous gradient alone only
    suppresses the edge pixel itself, while the visible white fringe sits in
    the 1–3σ band next to the edge - exactly where the gradient has already
    fallen off.  Dilation is what makes the threshold slider actually control
    the fringe.
    """
    base = np.asarray(base, dtype=np.float64)
    if base.ndim == 2:
        base = np.repeat(base[..., None], 3, axis=-1)
    base = np.clip(base, 0.0, 1.0)
    blurs, gates, details, raw_details = [], [], [], []
    acc = np.zeros_like(base)
    grad_norm = _normalise_gradient(gradient_magnitude(base, smooth_sigma=0.8))
    dilate_cache: dict[int, np.ndarray] = {}
    for spec in params.scales:
        blur = gaussian_blur(base, spec.sigma)
        raw = base - blur
        if spec.enabled and spec.weight > 0:
            radius = max(1, int(round(2.0 * spec.sigma)))
            if radius not in dilate_cache:
                dilate_cache[radius] = max_filter(grad_norm, radius)
            g = gate_from_gradient(
                dilate_cache[radius], params.edge_threshold, params.edge_softness
            )
            detail = raw * g[..., None]
        else:
            g = np.zeros(base.shape[:2], dtype=np.float64)
            detail = np.zeros_like(base)
        blurs.append(blur)
        gates.append(g)
        raw_details.append(raw)
        details.append(detail)
        if spec.enabled:
            acc += spec.weight * detail
    if params.chroma == "luma":
        # luminance-only detail: add the same scalar to R, G and B.  This is
        # the standard "luminance sharpening" that cannot rotate hue.
        acc = np.repeat((acc @ LUMA)[..., None], 3, axis=-1)
    unclipped = base + params.strength * acc
    result = np.clip(unclipped, 0.0, 1.0)
    if params.quantize_bits == 8:
        result = np.round(result * 255.0) / 255.0
        unclipped = np.round(unclipped * 255.0) / 255.0
    return SharpenResult(
        base=base,
        blurs=blurs,
        gates=gates,
        details=details,
        raw_details=raw_details,
        result=result,
        result_unclipped=unclipped,
    )


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------


def clipping_stats(result: SharpenResult, original_rgb8: np.ndarray | None = None) -> dict:
    """Clipped pixels, per-channel and hue shift vs the original image.

    ``original_rgb8`` is accepted for API symmetry with the export path and is
    currently unused; hue comparison is always against ``result.base`` so the
    numbers match exactly what the canvases show.
    """
    base = result.base
    out = result.result
    eps = 1e-9
    clipped_hi = (out >= 1.0 - eps).any(axis=-1)
    clipped_lo = (out <= eps).any(axis=-1)
    any_clip = clipped_hi | clipped_lo
    n = out.shape[0] * out.shape[1]

    hsv_in = rgb_to_hsv(base)
    hsv_out = rgb_to_hsv(out)
    sat_mask = (hsv_in[..., 1] > 0.08) & (hsv_out[..., 1] > 0.08)
    dh = np.abs(hsv_out[..., 0] - hsv_in[..., 0])
    dh = np.minimum(dh, 1.0 - dh)  # circular distance
    dh_deg = np.degrees(dh)
    hue_changed = sat_mask & (dh_deg > 1.0)

    sat_in = hsv_in[..., 1]
    sat_out = hsv_out[..., 1]
    # Only count a saturation loss where there was real saturation to begin
    # with.  Clipped pixels are excluded here because their saturation change
    # is a clipping artefact, not a tonal one - and clipping is reported on
    # its own map so nothing is hidden.
    sat_mask_fg = (sat_in > 0.08) & ~any_clip
    desat = sat_mask_fg & ((sat_out - sat_in) < -0.05)

    measured_dh = dh_deg[sat_mask]
    return {
        "pixels": n,
        "clipped_high": int(clipped_hi.sum()),
        "clipped_low": int(clipped_lo.sum()),
        "clipped_any": int(any_clip.sum()),
        "clipped_ratio": float(any_clip.sum() / max(n, 1)),
        "clipped_mask": any_clip,
        "clipped_high_mask": clipped_hi,
        "clipped_low_mask": clipped_lo,
        "hue_shift_px": int(hue_changed.sum()),
        "hue_shift_ratio": float(hue_changed.sum() / max(n, 1)),
        "hue_shift_deg_max": float(measured_dh.max()) if measured_dh.size else 0.0,
        "hue_shift_deg_mean": float(measured_dh.mean()) if measured_dh.size else 0.0,
        "hue_shift_mask": hue_changed,
        "desat_px": int(desat.sum()),
        "desat_mask": desat,
        "max_overshoot": float((result.result_unclipped.max(axis=(0, 1)) - 1.0).max()),
        "max_undershoot": float((0.0 - result.result_unclipped.min(axis=(0, 1))).max()),
    }


def profile_line(
    img: np.ndarray, p0: tuple[float, float], p1: tuple[float, float], n: int = 400
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Sample an image along a line. Returns (x, y) pixel coords and values.

    ``values`` is HxWx3 sampled bilinearly (nearest at edges).
    """
    a = np.asarray(img, dtype=np.float64)
    if a.ndim == 2:
        a = a[..., None]
    h, w = a.shape[:2]
    x = np.linspace(p0[0], p1[0], n)
    y = np.linspace(p0[1], p1[1], n)
    x = np.clip(x, 0, w - 1)
    y = np.clip(y, 0, h - 1)
    x0 = np.floor(x).astype(int)
    y0 = np.floor(y).astype(int)
    x1 = np.minimum(x0 + 1, w - 1)
    y1 = np.minimum(y0 + 1, h - 1)
    fx = (x - x0)[:, None]
    fy = (y - y0)[:, None]
    v00 = a[y0, x0]
    v10 = a[y0, x1]
    v01 = a[y1, x0]
    v11 = a[y1, x1]
    vals = (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy
    return x, y, vals


def to_display_rgb(img: np.ndarray) -> np.ndarray:
    """float 0..1 -> uint8 for the *image* canvas. Never auto-levels."""
    a = np.clip(np.asarray(img, dtype=np.float64), 0.0, 1.0)
    return np.round(a * 255.0).astype(np.uint8)


def detail_to_display(detail: np.ndarray, scale: float) -> np.ndarray:
    """Symmetric fixed-gain display for a detail layer.

    ``scale`` is a display gain, *not* per-image autoscaling: the same gain is
    used for all scales and is shown to the user, so amplitudes stay
    comparable.  The gain maps a detail of ±(1/scale) to full colour; the
    layer's true RMS is reported numerically next to the image.  Positive
    detail -> warm, negative -> cool on a neutral grey.
    """
    d = np.asarray(detail, dtype=np.float64)
    if d.ndim == 2:
        d = d[..., None]
    v = luma(d) * float(scale)          # luminance of the detail
    v = np.clip(v, -1.0, 1.0)
    # diverging ramp: blue (neg) -> grey (0) -> red (pos)
    grey = np.array([0.5, 0.5, 0.5])
    pos = np.array([0.95, 0.25, 0.18])
    neg = np.array([0.20, 0.45, 0.95])
    t = np.abs(v)[..., None]
    target = np.where(v[..., None] >= 0, pos, neg)
    return grey * (1 - t) + target * t


def heatmap_display(mask: np.ndarray) -> np.ndarray:
    """Binary/float mask -> red-on-dark display (fixed, no autoscale)."""
    m = np.asarray(mask, dtype=np.float64)
    if m.ndim == 3:
        m = m.max(axis=-1)
    m = np.clip(m, 0, 1)
    bg = np.array([0.12, 0.12, 0.14])
    fg = np.array([1.0, 0.25, 0.2])
    return bg * (1 - m[..., None]) + fg * m[..., None]


# ---------------------------------------------------------------------------
# Synthetic test charts
# ---------------------------------------------------------------------------


def synth_photo(
    width: int = 720,
    height: int = 480,
    seed: int = 7,
    include_step: bool = True,
) -> np.ndarray:
    """Synthetic "small product photo": object on a seamless backdrop.

    Contains a saturated object with a hard silhouette (the halo magnet),
    a specular highlight (clipping risk), a fine fabric-like texture patch
    (detail that must survive), and optionally a black/white step edge.
    """
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:height, 0:width].astype(np.float64)
    img = np.zeros((height, width, 3), dtype=np.float64)

    # soft studio backdrop: light warm grey with a gentle falloff
    nx = (xx / width) - 0.5
    ny = (yy / height) - 0.5
    falloff = 1.0 - 0.35 * np.clip(np.hypot(nx, ny * 1.1), 0, 1) ** 2
    backdrop = np.array([0.78, 0.76, 0.72])
    img[:] = backdrop * falloff[..., None]

    # product: rounded rectangle body, saturated teal
    cx, cy = width * 0.42, height * 0.50
    bw, bh = width * 0.26, height * 0.36
    dx = np.abs(xx - cx) - (bw - 40)
    dy = np.abs(yy - cy) - (bh - 40)
    outside = np.hypot(np.maximum(dx, 0), np.maximum(dy, 0)) - 40.0
    inside = np.clip(-outside / 3.0, 0, 1)  # antialiased silhouette
    body_col = np.array([0.14, 0.52, 0.60])
    img = img * (1 - inside[..., None]) + body_col * inside[..., None]

    # cylindrical shading across the body to give it volume
    shade = 1.0 - 0.45 * np.clip((xx - (cx - bw)) / (2 * bw), 0, 1)
    img = np.where(inside[..., None] > 0, img * shade[..., None], img)

    # specular highlight (will clip when over-sharpened)
    spec = np.exp(-(((xx - (cx - bw * 0.45)) / (bw * 0.22)) ** 2
                    + ((yy - (cy - bh * 0.45)) / (bh * 0.16)) ** 2))
    img = np.clip(img + spec[..., None] * np.array([1.0, 0.98, 0.92]) * 0.75, 0, 1)

    # fine texture patch on the right: fabric weave, low contrast, high freq
    tx0, tx1 = int(width * 0.68), int(width * 0.94)
    ty0, ty1 = int(height * 0.24), int(height * 0.70)
    weave = (
        np.sin(xx * 1.7) * np.sin(yy * 1.45) * 0.5
        + rng.normal(0, 0.35, (height, width))
    )
    weave = np.clip(weave, -1, 1)
    patch = 0.42 + 0.06 * weave
    patch_rgb = np.stack([patch * 0.95, patch * 0.80, patch * 0.62], axis=-1)
    mask_patch = np.zeros((height, width))
    mask_patch[ty0:ty1, tx0:tx1] = 1.0
    mask_patch = gaussian_blur(mask_patch, 1.2)
    img = img * (1 - mask_patch[..., None]) + patch_rgb * mask_patch[..., None]

    # dark lettering on the body: hard, high-contrast small features
    for i in range(3):
        x0 = int(cx - bw * 0.5)
        y0 = int(cy + bh * 0.10 + i * 16)
        x1 = x0 + int(bw * (0.5 - i * 0.12))
        img[y0 : y0 + 5, x0:x1] = np.array([0.05, 0.06, 0.07])

    # optional step edge across the lower-left backdrop (for profile checks)
    if include_step:
        edge_y = int(height * 0.84)
        img[edge_y:, : int(width * 0.30)] = 0.04
        img[edge_y:, int(width * 0.30) : int(width * 0.55)] = 0.96

    img = np.clip(img, 0.0, 1.0)
    # camera-ish grain so detail layers are not perfectly clean
    img = np.clip(img + rng.normal(0, 0.006, img.shape), 0, 1)
    return img


def synth_step_chart(width: int = 1024, height: int = 512) -> np.ndarray:
    """Step edges at three contrast levels + a dense line-pair zone.

    The step transitions are softened by ~2 px (an erf-like ramp), which is
    what a real lens produces; a perfectly hard step cannot get "sharper" and
    would make the edge-width measurement meaningless.  The rendered bands are
    wide enough (13 % of height) that overshoot and undershoot lobes are fully
    separated from the plateau sampling window.
    """
    rng = np.random.default_rng(3)
    yy, xx = np.mgrid[0:height, 0:width].astype(np.float64)
    img = np.full((height, width, 3), 0.5, dtype=np.float64)
    edge_x = width * 0.5
    bands = [(0.02, 0.98), (0.24, 0.44), (0.60, 0.90)]
    soft = 2.0  # px, transition sigma
    t = (xx - edge_x) / (soft * 1.41421356)
    # erf via tanh approximation is plenty for a synthetic ramp
    ramp = 0.5 * (1.0 + np.tanh(1.1283791671 * t))
    for i, (lo, hi) in enumerate(bands):
        y0 = int(height * (0.06 + i * 0.18))
        y1 = y0 + int(height * 0.14)
        img[y0:y1] = (lo + (hi - lo) * ramp[y0:y1])[..., None]
    # dense texture: vertical line pairs with increasing frequency, low contrast
    tex_y0 = int(height * 0.64)
    tex_y1 = height - int(height * 0.04)
    phase = 2.0 * np.pi * (xx / width) ** 2 * 28.0
    stripes = 0.5 + 0.10 * np.sin(phase)
    img[tex_y0:tex_y1] = stripes[tex_y0:tex_y1][..., None]
    # a few hard 1-px lines to check ringing
    for x in (int(width * 0.62), int(width * 0.70), int(width * 0.78)):
        img[tex_y0 + 6 : tex_y0 + 20, x] = 0.95
    img = np.clip(img + rng.normal(0, 0.004, img.shape), 0, 1)
    return img



def synth_stripes(width: int = 768, height: int = 384) -> np.ndarray:
    """Dense texture: variable-contrast pattern + micro-text and colour noise."""
    rng = np.random.default_rng(11)
    yy, xx = np.mgrid[0:height, 0:width].astype(np.float64)
    freq = 0.35
    base = 0.5 + 0.16 * np.sin(xx * freq) * np.cos(yy * freq * 0.7)
    # chirp patch
    chirp = 0.5 + 0.10 * np.sin(2 * np.pi * ((xx / width) ** 2) * 40.0)
    chirp[:, : width // 2] = 0.5
    base = 0.5 * base + 0.5 * chirp
    # micro texture
    base += 0.04 * rng.normal(size=(height, width))
    base = np.clip(base, 0, 1)
    tint = np.stack([base * 0.9, base * 0.98, base * 0.85], axis=-1)
    return np.clip(tint, 0, 1)
