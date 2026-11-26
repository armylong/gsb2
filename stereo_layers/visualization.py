"""Array rendering helpers; every public image array here is RGB uint8."""

from __future__ import annotations

import cv2
import numpy as np

from .matching import SingleMatch


def bgr_to_rgb(img: np.ndarray) -> np.ndarray:
    if img.ndim == 2:
        return cv2.cvtColor(img, cv2.COLOR_GRAY2RGB)
    return cv2.cvtColor(img, cv2.COLOR_BGR2RGB)


def _invalid_checker(h: int, w: int, tile: int = 9) -> np.ndarray:
    yy, xx = np.indices((h, w))
    even = ((xx // tile) + (yy // tile)) % 2 == 0
    out = np.empty((h, w, 3), dtype=np.uint8)
    out[even] = (42, 42, 46)
    out[~even] = (74, 43, 52)
    return out


def colorize_disparity(
    result: SingleMatch,
    vmin: float | None = None,
    vmax: float | None = None,
    only_mask: np.ndarray | None = None,
    zero_band: float | None = None,
) -> np.ndarray:
    """Turbo color map; invalid is checkerboard and exact zero is white."""

    d = result.disparity
    h, w = d.shape
    valid = result.geometry_mask & np.isfinite(d)
    if only_mask is not None:
        valid &= only_mask

    ds = result.disparities
    lo = float(ds.min()) if vmin is None else float(vmin)
    hi = float(ds.max()) if vmax is None else float(vmax)
    if hi <= lo:
        hi = lo + 1.0
    band = max(0.25, (hi - lo) * 0.012) if zero_band is None else zero_band

    canvas = _invalid_checker(h, w)
    if np.any(valid):
        norm = np.clip((d[valid] - lo) / (hi - lo), 0.0, 1.0)
        lut = cv2.applyColorMap((norm * 255).astype(np.uint8).reshape(-1, 1), cv2.COLORMAP_TURBO)
        colors = cv2.cvtColor(lut.reshape(-1, 1, 3), cv2.COLOR_BGR2RGB).reshape(-1, 3)
        canvas[valid] = colors

        zero = valid & (np.abs(d) <= band)
        canvas[zero] = (255, 255, 255)
        # A thin dark rim makes the white zero layer legible on bright turbo.
        rim = cv2.dilate(zero.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool) & ~zero
        canvas[rim] = (20, 20, 20)
    return canvas


def dim_rejected(base_rgb: np.ndarray, kept: np.ndarray, alpha: float = 0.62) -> np.ndarray:
    out = base_rgb.copy()
    rejected = ~kept
    dark = np.zeros_like(out)
    out[rejected] = cv2.addWeighted(out, 1.0 - alpha, dark, alpha, 0.0)[rejected]
    # Red hatch-ish sparse dots mark rejected blocks without erasing context.
    yy, xx = np.indices(rejected.shape)
    hatch = rejected & (((xx + yy) % 9) == 0)
    out[hatch] = (255, 72, 72)
    kept_edge = cv2.dilate(kept.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool) ^ kept
    out[kept_edge] = (120, 255, 170)
    return out


def retention_split(result: SingleMatch, kept: np.ndarray) -> np.ndarray:
    raw = colorize_disparity(result)
    filtered = colorize_disparity(result, only_mask=kept)
    filtered = dim_rejected(filtered, kept)
    out = np.concatenate([raw, filtered], axis=1)
    cv2.line(out, (raw.shape[1], 0), (raw.shape[1], out.shape[0]), (255, 255, 255), 2)
    cv2.putText(out, "RAW", (10, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
    cv2.putText(out, "RELIABLE", (raw.shape[1] + 10, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
    return out


def reason_map(
    result: SingleMatch,
    kept: np.ndarray,
    trim_mask: np.ndarray | None = None,
) -> np.ndarray:
    h, w = result.shape
    out = np.full((h, w, 3), 28, dtype=np.uint8)
    out[~result.geometry_mask] = (48, 48, 52)

    # Colors are RGB.
    out[result.range_edge_mask & result.geometry_mask] = (40, 190, 220)     # cyan
    out[result.textureless_mask & result.geometry_mask] = (235, 210, 70)    # yellow
    out[result.repetitive_mask & result.geometry_mask] = (220, 70, 220)    # magenta
    lr_bad = result.geometry_mask & np.isfinite(result.lr_diff) & ~result.lr_consistent
    out[lr_bad] = (235, 120, 45)                                           # orange
    out[kept] = (70, 205, 120)                                             # green
    if trim_mask is not None:
        out[trim_mask] = (170, 170, 255)                                  # lavender
        yy, xx = np.indices(out.shape[:2])
        hatch = trim_mask & (((xx - yy) % 8) == 0)
        out[hatch] = (235, 235, 255)

    # Overlay a fine checker on geometric borders.
    border = ~result.geometry_mask
    yy, xx = np.indices((h, w))
    checker = border & (((xx // 6) + (yy // 6)) % 2 == 0)
    out[checker] = (70, 70, 78)
    return out


def layer_map(labels: np.ndarray, centers: np.ndarray) -> np.ndarray:
    """Categorical near-to-far layer map; -1 uses the invalid checkerboard."""

    h, w = labels.shape
    canvas = _invalid_checker(h, w, tile=10)
    palette = np.array(
        [
            (72, 214, 124),   # near: green
            (245, 171, 53),   # orange
            (64, 196, 220),   # cyan
            (214, 93, 214),   # magenta
            (232, 220, 78),   # yellow
            (96, 125, 255),   # blue
            (235, 235, 235),  # white
            (255, 120, 120),  # red
        ],
        dtype=np.uint8,
    )
    for layer_id in range(max(0, int(labels.max()) + 1)):
        canvas[labels == layer_id] = palette[layer_id % len(palette)]

    valid = labels >= 0
    boundary = valid & (
        (labels != np.roll(labels, 1, axis=1))
        | (labels != np.roll(labels, -1, axis=1))
        | (labels != np.roll(labels, 1, axis=0))
        | (labels != np.roll(labels, -1, axis=0))
    )
    # Roll introduces opposite-edge artifacts; remove image border rows/cols.
    boundary[[0, -1], :] = False
    boundary[:, [0, -1]] = False
    canvas[boundary] = (255, 255, 255)

    legend_w = 178
    legend_h = 12 + 23 * max(1, len(centers))
    cv2.rectangle(canvas, (6, 6), (8 + legend_w, 10 + legend_h), (20, 20, 24), -1)
    for layer_id, center in enumerate(centers):
        y = 24 + layer_id * 23
        color = palette[layer_id % len(palette)].tolist()
        cv2.rectangle(canvas, (12, y - 11), (26, y + 3), color, -1)
        text = f"L{layer_id} |d|={abs(float(center)):.1f}"
        cv2.putText(canvas, text, (32, y), cv2.FONT_HERSHEY_SIMPLEX, 0.48,
                    (255, 255, 255), 1, cv2.LINE_AA)
    return canvas


def lr_heatmap(lr_diff: np.ndarray, cap: float = 5.0) -> np.ndarray:
    h, w = lr_diff.shape
    out = _invalid_checker(h, w, tile=8)
    valid = np.isfinite(lr_diff)
    if np.any(valid):
        norm = np.clip(lr_diff[valid] / cap, 0.0, 1.0)
        lut = cv2.applyColorMap((norm * 255).astype(np.uint8).reshape(-1, 1), cv2.COLORMAP_INFERNO)
        colors = cv2.cvtColor(lut.reshape(-1, 1, 3), cv2.COLOR_BGR2RGB).reshape(-1, 3)
        out[valid] = colors
        good = valid & (lr_diff <= 1.5)
        out[good] = (70, 205, 120)
    return out


def marker_overlay(
    image_bgr: np.ndarray,
    x: int,
    y: int,
    radius: int = 2,
    color: tuple[int, int, int] = (0, 255, 255),
) -> np.ndarray:
    rgb = bgr_to_rgb(image_bgr).copy()
    h, w = rgb.shape[:2]
    k = 2 * max(1, radius) + 1
    x0, y0 = max(0, x - radius), max(0, y - radius)
    x1, y1 = min(w - 1, x + radius), min(h - 1, y + radius)
    cv2.rectangle(rgb, (x0, y0), (x1, y1), (0, 255, 0), 1)
    cv2.drawMarker(rgb, (x, y), color, cv2.MARKER_CROSS, 18, 2)
    return rgb


def candidate_overlay(
    target_bgr: np.ndarray,
    x: int,
    y: int,
    result: SingleMatch,
) -> np.ndarray:
    """Highlight every horizontal integer candidate and the selected match."""

    rgb = bgr_to_rgb(target_bgr).copy()
    h, w = rgb.shape[:2]
    cv2.line(rgb, (0, y), (w - 1, y), (255, 230, 0), 1, cv2.LINE_AA)

    costs = result.cost_volume[:, y, x]
    support = result.support_volume[:, y, x]
    finite = costs[support & np.isfinite(costs)]
    if finite.size:
        lo, hi = float(finite.min()), float(finite.max())
    else:
        lo, hi = 0.0, 1.0

    best_i = int(np.argmin(np.where(support, costs, np.inf)))
    for i, d in enumerate(result.disparities):
        tx = int(x - int(d))
        if not (0 <= tx < w):
            continue
        if not support[i]:
            color = (110, 110, 110)
            r = 2
        else:
            q = 0.5 if hi <= lo else (float(costs[i]) - lo) / (hi - lo)
            # Green = low cost, red = high cost.
            color = (int(255 * q), int(220 * (1.0 - q)), 60)
            r = 4 if i == best_i else 2
        cv2.circle(rgb, (tx, y), r, color, -1 if i == best_i else 1, lineType=cv2.LINE_AA)

    d = result.disparity[y, x]
    if result.geometry_mask[y, x] and np.isfinite(d):
        tx_f = x - float(d)
        tx = int(round(tx_f))
        rad = result.params.get("radius", 2)
        if 0 <= tx < w:
            cv2.rectangle(rgb, (tx - rad, y - rad), (tx + rad, y + rad), (0, 255, 120), 2)
            cv2.line(
                rgb,
                (int(round(tx_f)), max(0, y - 14)),
                (int(round(tx_f)), min(h - 1, y + 14)),
                (0, 255, 255),
                1,
                cv2.LINE_AA,
            )
            lr = result.lr_diff[y, x]
            status = "LR OK" if np.isfinite(lr) and result.lr_consistent[y, x] else "LR FAIL"
            col = (0, 255, 120) if status == "LR OK" else (255, 120, 60)
            text_x = max(2, min(w - 165, tx + 8)) if w >= 165 else 2
            cv2.putText(rgb, f"d={d:.2f} {status}", (text_x, max(18, y - 12)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.48, (0, 0, 0), 3, cv2.LINE_AA)
            cv2.putText(rgb, f"d={d:.2f} {status}", (text_x, max(18, y - 12)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.48, col, 1, cv2.LINE_AA)
    return rgb


def colorbar_rgb(vmin: float, vmax: float, h: int = 220, w: int = 26) -> np.ndarray:
    grad = np.linspace(255, 0, h, dtype=np.uint8)[:, None]
    lut = cv2.applyColorMap(grad, cv2.COLORMAP_TURBO)
    bar = cv2.cvtColor(lut, cv2.COLOR_BGR2RGB)
    bar = np.repeat(bar, w, axis=1)
    if vmin <= 0 <= vmax:
        y = int(round((1.0 - (0.0 - vmin) / max(vmax - vmin, 1e-6)) * (h - 1)))
        cv2.line(bar, (0, y), (w - 1, y), (255, 255, 255), 3)
        cv2.line(bar, (0, y), (w - 1, y), (0, 0, 0), 1)
    cv2.rectangle(bar, (0, 0), (w - 1, h - 1), (230, 230, 230), 1)
    return bar


def cost_curve_rgb(
    disparities: np.ndarray,
    costs: np.ndarray,
    support: np.ndarray,
    best_index: int,
    subpixel: float | None = None,
    width: int = 360,
    height: int = 180,
) -> np.ndarray:
    """Draw the clicked pixel's horizontal matching-cost curve."""

    canvas = np.full((height, width, 3), 250, dtype=np.uint8)
    left, top, right, bottom = 42, 16, width - 14, height - 30
    cv2.rectangle(canvas, (left, top), (right, bottom), (225, 225, 225), 1)

    finite = support & np.isfinite(costs)
    if not np.any(finite):
        cv2.putText(canvas, "no supported candidate", (55, height // 2),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (40, 40, 40), 1)
        return canvas

    vals = costs[finite]
    cmin, cmax = float(vals.min()), float(vals.max())
    if cmax - cmin < 1e-6:
        cmax = cmin + 1.0
    dmin, dmax = float(disparities.min()), float(disparities.max())
    if dmax == dmin:
        dmax = dmin + 1.0

    def xy(d: float, c: float) -> tuple[int, int]:
        x = int(round(left + (d - dmin) / (dmax - dmin) * (right - left)))
        y = int(round(bottom - (c - cmin) / (cmax - cmin) * (bottom - top)))
        return x, y

    prev = None
    for i, d in enumerate(disparities):
        if not finite[i]:
            prev = None
            continue
        p = xy(float(d), float(costs[i]))
        if prev is not None:
            cv2.line(canvas, prev, p, (60, 90, 200), 2, cv2.LINE_AA)
        cv2.circle(canvas, p, 2, (60, 90, 200), -1)
        prev = p

    if 0 <= best_index < len(disparities) and finite[best_index]:
        p = xy(float(disparities[best_index]), float(costs[best_index]))
        cv2.circle(canvas, p, 6, (0, 170, 0), 2, cv2.LINE_AA)
    if subpixel is not None and np.isfinite(subpixel):
        x, _ = xy(float(subpixel), cmin)
        cv2.line(canvas, (x, top), (x, bottom), (0, 150, 220), 1, cv2.LINE_AA)

    cv2.putText(canvas, f"{cmax:.1f}", (4, top + 8), cv2.FONT_HERSHEY_SIMPLEX, 0.35, (60, 60, 60), 1)
    cv2.putText(canvas, f"{cmin:.1f}", (4, bottom), cv2.FONT_HERSHEY_SIMPLEX, 0.35, (60, 60, 60), 1)
    cv2.putText(canvas, str(int(dmin)), (left - 8, height - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.35, (60, 60, 60), 1)
    cv2.putText(canvas, str(int(dmax)), (right - 18, height - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.35, (60, 60, 60), 1)
    cv2.putText(canvas, "SAD cost / disparity", (left, height - 2), cv2.FONT_HERSHEY_SIMPLEX, 0.38, (30, 30, 30), 1)
    return canvas
