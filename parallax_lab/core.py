"""Depth-image-based parallax preview core (numpy only).

Model
-----
The scene is a small stack of RGB+D layers, each layer being the *visible*
part of a surface (so the back layer has no samples where a front layer
occludes it -- that is where disocclusion holes come from).  Layers are
forward-warped with a translation camera model:

    dx = -b / D          (b = camera offset in px per metre, D in metres)
    dy = -v / D

then resolved with a z-buffer: for every output pixel the source nearest to the
camera wins.  Output pixels with no source at all are holes.

`render()` optionally fills holes from *background-only* donors (nearest
visible non-front layer pixel).  Foreground pixels are never donors, so
foreground edge colour cannot leak into the fill (requirement 3).

All provenance (which source pixel produced an output pixel) is kept so the
GUI and the tests can query it (requirement 4).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable

import numpy as np

from .scene import Layer, Scene

MIN_DEPTH = 0.05
MAX_DEPTH = 100.0

FILL_RAW = "raw"
FILL_BACKGROUND = "background"

# Marker colour for unfilled holes (bright magenta, not used by sample scenes)
HOLE_RGB = np.array([255, 0, 176], dtype=np.uint8)

# Layout-diff categories
CAT_SAME = 0
CAT_FRONT_TO_BACK = 1
CAT_BACK_TO_FRONT = 2
CAT_TO_HOLE = 3
CAT_FROM_HOLE = 4
CAT_OTHER = 5

CAT_NAMES = {
    CAT_SAME: "same",
    CAT_FRONT_TO_BACK: "front→back",
    CAT_BACK_TO_FRONT: "back→front",
    CAT_TO_HOLE: "→hole",
    CAT_FROM_HOLE: "hole→",
    CAT_OTHER: "other",
}


# ---------------------------------------------------------------------------
# camera / depth edits
# ---------------------------------------------------------------------------


@dataclass
class Camera:
    """Simple translation camera.

    `baseline_px` is the on-screen shift at 1 m; a positive baseline means the
    camera moves right, so content moves left (dx = -baseline / D).
    """

    baseline_px: float = 0.0
    vertical_px: float = 0.0

    def shifts(self, depth: np.ndarray | float):
        d = np.maximum(np.asarray(depth, dtype=np.float64), 1e-6)
        return -self.baseline_px / d, -self.vertical_px / d

    def shift_at(self, depth: float) -> tuple[float, float]:
        dx, dy = self.shifts(np.array([depth], dtype=np.float64))
        return float(dx[0]), float(dy[0])


@dataclass
class LayerEdit:
    """Editable depth for one layer: D' = clip(gain * D + bias + brush).

    `brush` is an additive metre offset per pixel (the GUI's depth brush).
    """

    gain: float = 1.0
    bias: float = 0.0
    brush: np.ndarray | None = None  # (H, W) additive metres

    def apply(self, depth: np.ndarray) -> np.ndarray:
        finite = np.isfinite(depth)
        out = np.full(depth.shape, np.nan, dtype=np.float32)
        if not finite.any():
            return out
        d = depth[finite].astype(np.float64) * self.gain + self.bias
        if self.brush is not None:
            d = d + self.brush[finite].astype(np.float64)
        d = np.clip(d, MIN_DEPTH, MAX_DEPTH)
        out[finite] = d.astype(np.float32)
        return out

    def reset_brush(self, shape: tuple[int, int]):
        if self.brush is not None:
            self.brush[...] = 0.0


# ---------------------------------------------------------------------------
# render result
# ---------------------------------------------------------------------------


@dataclass
class SourceTable:
    """Concatenated source samples (one row per source pixel of every layer)."""

    rgb: np.ndarray      # (M, 3) uint8
    depth: np.ndarray    # (M,) float32, edited
    layer: np.ndarray    # (M,) int8
    yx: np.ndarray       # (M, 2) int32

    def row(self, flat: int) -> dict:
        return {
            "layer": int(self.layer[flat]),
            "x": int(self.yx[flat, 1]),
            "y": int(self.yx[flat, 0]),
            "depth": float(self.depth[flat]),
        }


@dataclass
class ProbeInfo:
    x: int
    y: int
    status: str                     # "visible" | "hole" | "filled"
    layer: int = -1                 # winner layer (-1 for hole)
    source: tuple[int, int] | None = None
    depth: float = float("nan")
    shift: tuple[float, float] = (0.0, 0.0)
    donor_layer: int = -1
    donor_source: tuple[int, int] | None = None
    donor_depth: float = float("nan")
    donor_shift: tuple[float, float] = (0.0, 0.0)

    def describe(self, scene: Scene) -> str:
        def name(i: int) -> str:
            if i < 0:
                return "-"
            return scene.layers[i].name.split(" (")[0]

        if self.status == "visible":
            return (f"visible | layer={name(self.layer)}"
                    f" | source=({self.source[0]}, {self.source[1]})"
                    f" | depth={self.depth:.3f} m"
                    f" | shift=({self.shift[0]:.2f}, {self.shift[1]:.2f})")
        if self.status == "filled":
            return (f"hole -> filled from layer={name(self.donor_layer)}"
                    f" | donor=({self.donor_source[0]}, {self.donor_source[1]})"
                    f" | depth={self.donor_depth:.3f} m")
        return "hole | no source (raw marker)"


@dataclass
class RenderResult:
    scene: Scene
    camera: Camera
    fill_mode: str
    rgb: np.ndarray             # (H, W, 3) uint8 -- what the user sees
    hole_mask: np.ndarray       # (H, W) bool -- destination had no source
    filled_mask: np.ndarray     # (H, W) bool -- holes filled from background
    crack_mask: np.ndarray      # (H, W) bool -- holes closed as sampling cracks
    layer_map: np.ndarray       # (H, W) int8 winner layer, -1 = hole
    source_flat: np.ndarray     # (H, W) int32 flat index into `sources`, -1 hole
    depth_map: np.ndarray       # (H, W) float32 winner edited depth, nan hole
    fill_source_flat: np.ndarray  # (H, W) int32 donor source index for filled holes
    sources: SourceTable
    stats: dict = field(default_factory=dict)

    @property
    def shape(self):
        return self.rgb.shape[:2]

    def probe(self, x: int, y: int) -> ProbeInfo:
        """Which source point produced output pixel (x, y)?"""
        H, W = self.shape
        if not (0 <= x < W and 0 <= y < H):
            raise IndexError(f"probe ({x},{y}) outside {W}x{H}")
        info = ProbeInfo(x=int(x), y=int(y), status="visible")
        if self.hole_mask[y, x]:
            fs = int(self.fill_source_flat[y, x])
            if self.filled_mask[y, x] and fs >= 0:
                row = self.sources.row(fs)
                info.status = "filled"
                info.donor_layer = row["layer"]
                info.donor_source = (row["x"], row["y"])
                info.donor_depth = row["depth"]
                info.donor_shift = self.camera.shift_at(row["depth"])
            else:
                info.status = "hole"
            return info
        row = self.sources.row(int(self.source_flat[y, x]))
        info.layer = row["layer"]
        info.source = (row["x"], row["y"])
        info.depth = row["depth"]
        info.shift = self.camera.shift_at(row["depth"])
        return info


# ---------------------------------------------------------------------------
# nearest-donor (chamfer) fill
# ---------------------------------------------------------------------------

_INF = 1e9
_DIAG = 2 ** 0.5


def _relax(d, i, cand_d, cand_i):
    better = cand_d < d
    d[better] = cand_d[better]
    i[better] = cand_i[better]


def _row_sweep(d: np.ndarray, idx: np.ndarray, forward: bool):
    """Exact 1-D distance transform along one image row (in place).

    For 4-connected horizontal steps the nearest donor at column x minimises
    `d[donor] + |x - donor_x|`.  Sweeping left->right, the winning value is the
    prefix minimum of `d - x`; sweeping right->left it is the suffix minimum of
    `d + x`.  The winning column is the *closest* column attaining that
    minimum: the latest for the forward sweep, the earliest for the backward
    sweep.  When there are several such columns, `np.minimum/maximum.accumulate`
    over a mask that is True exactly at the attaining columns picks the right
    one -- a naive running min of positions would keep stale columns.
    """
    W = d.shape[0]
    xs = np.arange(W, dtype=np.float64)
    if forward:
        key = d - xs
        run = np.minimum.accumulate(key)
        is_min = key == run
        pos = np.maximum.accumulate(np.where(is_min, xs, -1.0)).astype(np.int64)
        new_d = run + xs
    else:
        key = d + xs
        run = np.minimum.accumulate(key[::-1])[::-1]
        is_min = key == run
        # closest attaining column = the next True at or after x
        pos = np.minimum.accumulate(
            np.where(is_min, xs, float(W))[::-1])[::-1].astype(np.int64)
        new_d = run - xs
    valid = (pos >= 0) & (pos < W)
    d[valid] = new_d[valid]
    idx[valid] = idx[pos[valid]]


def nearest_donor(mask: np.ndarray, src_index: np.ndarray) -> np.ndarray:
    """For every pixel return the src_index of the nearest `mask` pixel.

    Two-pass 3-4 chamfer distance transform with donor index propagation.
    Horizontal steps are exact; diagonals use sqrt(2), the standard chamfer
    approximation.  Returns -1 where the mask is empty.
    """
    H, W = mask.shape
    dist = np.where(mask, 0.0, _INF).astype(np.float64)
    idx = np.where(mask, src_index, np.int32(-1)).astype(np.int32)

    # ---- forward pass: rows top -> bottom, then sweep left -> right ------
    for y in range(H):
        if y > 0:
            up = y - 1
            _relax(dist[y, 1:], idx[y, 1:], dist[up, :-1] + _DIAG, idx[up, :-1])
            _relax(dist[y, :], idx[y, :], dist[up, :] + 1.0, idx[up, :])
            _relax(dist[y, :-1], idx[y, :-1], dist[up, 1:] + _DIAG, idx[up, 1:])
        _row_sweep(dist[y], idx[y], forward=True)

    # ---- backward pass: rows bottom -> top, then sweep right -> left -----
    for y in range(H - 1, -1, -1):
        if y < H - 1:
            dn = y + 1
            _relax(dist[y, :-1], idx[y, :-1], dist[dn, 1:] + _DIAG, idx[dn, 1:])
            _relax(dist[y, :], idx[y, :], dist[dn, :] + 1.0, idx[dn, :])
            _relax(dist[y, 1:], idx[y, 1:], dist[dn, :-1] + _DIAG, idx[dn, :-1])
        _row_sweep(dist[y], idx[y], forward=False)

    return idx


# ---------------------------------------------------------------------------
# sampling-crack closure
# ---------------------------------------------------------------------------

# A continuous surface (the ramp preset) sampled at integer pixels and warped
# with `rint` can leave isolated 1-px holes between two samples of the same
# surface.  Those are not disocclusions.  A hole is closed as a crack only if
# its visible neighbours across it are the SAME layer and their depths match
# within this relative tolerance.  Real disocclusions always have the near
# layer on one side and the far layer on the other, so they never qualify.
CRACK_REL_TOL = 0.01


def _close_sampling_cracks(hole, layer_map, depth_map, rgb, source_flat):
    """Close 1-px sampling cracks in place; returns the crack mask."""
    H, W = hole.shape
    cracks = np.zeros_like(hole)

    def sweep(horiz: bool):
        if horiz:
            if W < 3:
                return
            a = (slice(None), slice(None, -2))
            b = (slice(None), slice(2, None))
            mid = (slice(None), slice(1, -1))
        else:
            if H < 3:
                return
            a = (slice(None, -2), slice(None))
            b = (slice(2, None), slice(None))
            mid = (slice(1, -1), slice(None))

        da, db_ = depth_map[a], depth_map[b]
        same = (layer_map[a] == layer_map[b]) & (layer_map[a] >= 0)
        close = np.abs(da - db_) <= np.minimum(da, db_) * CRACK_REL_TOL
        sel = hole[mid] & ~hole[a] & ~hole[b] & same & close
        if not sel.any():
            return
        take_a = sel & (da <= db_)
        take_b = sel & (db_ < da)
        for take, src in ((take_a, a), (take_b, b)):
            if not take.any():
                continue
            source_flat[mid][take] = source_flat[src][take]
            layer_map[mid][take] = layer_map[src][take]
            depth_map[mid][take] = depth_map[src][take]
            rgb[mid][take] = rgb[src][take]
            cracks[mid][take] = True
            hole[mid][take] = False

    sweep(horiz=True)
    sweep(horiz=False)
    return cracks


# ---------------------------------------------------------------------------
# render
# ---------------------------------------------------------------------------


def _layer_shift(camera: Camera, depth: np.ndarray, edit: LayerEdit) -> float:
    """Camera shift at a layer's median edited depth (0 when the layer is empty)."""
    d = edit.apply(depth)
    if not np.isfinite(d).any():
        return 0.0
    return camera.shift_at(float(np.median(d[np.isfinite(d)])))[0]


def render(scene: Scene, camera: Camera | None = None,
           edits: Iterable[LayerEdit] | None = None,
           fill_mode: str = FILL_BACKGROUND) -> RenderResult:
    camera = camera or Camera()
    H, W = scene.shape
    N = H * W
    L = len(scene.layers)
    if edits is None:
        edits = [LayerEdit() for _ in scene.layers]
    edits = list(edits)
    if len(edits) != L:
        raise ValueError("one LayerEdit per layer required")
    if fill_mode not in (FILL_RAW, FILL_BACKGROUND):
        raise ValueError(f"unknown fill mode {fill_mode!r}")

    # ---- gather warped source samples for every layer -------------------
    dst_parts, key_parts = [], []
    rgb_parts, depth_parts, layer_parts, yx_parts = [], [], [], []
    for i, (layer, edit) in enumerate(zip(scene.layers, edits)):
        d = edit.apply(layer.depth)
        valid = np.isfinite(d)
        if not valid.any():
            continue
        ys, xs = np.nonzero(valid)
        dv = d[valid].astype(np.float64)
        dx, dy = camera.shifts(dv)
        xd = xs + np.rint(dx).astype(np.int64)
        yd = ys + np.rint(dy).astype(np.int64)
        ok = (xd >= 0) & (xd < W) & (yd >= 0) & (yd < H)
        if not ok.any():
            continue
        dst_parts.append((yd[ok] * W + xd[ok]).astype(np.int64))
        # depth is distance from the camera in metres: SMALLER = nearer.
        # Negate so the z-buffer can keep a per-pixel maximum.
        dq = np.clip(np.rint(-dv[ok] * 1e5), None, -1).astype(np.int64)
        # nearer depth wins; on a tie the layer nearer the front wins
        key_parts.append(dq * np.int64(L + 1) + np.int64(L - i))
        rgb_parts.append(layer.rgb[ys[ok], xs[ok]])
        depth_parts.append(dv[ok])
        layer_parts.append(np.full(int(ok.sum()), i, dtype=np.int8))
        yx_parts.append(np.stack([ys[ok], xs[ok]], axis=1).astype(np.int32))

    if not dst_parts:
        raise ValueError("nothing warps into the output frame")

    dst = np.concatenate(dst_parts)
    key = np.concatenate(key_parts)
    sources = SourceTable(
        rgb=np.concatenate(rgb_parts).astype(np.uint8),
        depth=np.concatenate(depth_parts).astype(np.float32),
        layer=np.concatenate(layer_parts),
        yx=np.concatenate(yx_parts),
    )
    src_flat_all = np.arange(dst.size, dtype=np.int32)

    # ---- z-buffer: per destination keep the largest (nearness, layer) key --
    empty = np.iinfo(np.int64).min
    zbuf = np.full(N, empty, dtype=np.int64)
    np.maximum.at(zbuf, dst, key)
    win = zbuf > empty

    # deterministic tie-break (same layer, same depth): lowest source index
    winner_flat = np.full(N, np.iinfo(np.int32).max, dtype=np.int32)
    ties = key == zbuf[dst]
    np.minimum.at(winner_flat, dst[ties], src_flat_all[ties])
    winner_flat[~win] = -1

    layer_map = np.full(N, -1, dtype=np.int8)
    depth_map = np.full(N, np.nan, dtype=np.float32)
    rgb_out = np.zeros((N, 3), dtype=np.uint8)
    layer_map[win] = sources.layer[winner_flat[win]]
    depth_map[win] = sources.depth[winner_flat[win]]
    rgb_out[win] = sources.rgb[winner_flat[win]]

    # ---- close sampling cracks -----------------------------------------
    crack = np.zeros((H, W), dtype=bool)
    if (~win).any():
        hm = (~win).reshape(H, W).copy()
        lm2 = layer_map.reshape(H, W).copy()
        dm2 = depth_map.reshape(H, W).copy()
        rgb2 = rgb_out.reshape(H, W, 3).copy()
        sf2 = winner_flat.reshape(H, W).copy()
        crack = _close_sampling_cracks(hm, lm2, dm2, rgb2, sf2)
        closed = crack.reshape(-1)
        if closed.any():
            win = ~hm.reshape(-1)
            layer_map[closed] = lm2.reshape(-1)[closed]
            depth_map[closed] = dm2.reshape(-1)[closed]
            rgb_out[closed] = rgb2.reshape(-1, 3)[closed]
            winner_flat[closed] = sf2.reshape(-1)[closed]

    hole = ~win
    filled = np.zeros(N, dtype=bool)
    fill_src = np.full(N, -1, dtype=np.int32)

    # ---- hole filling from background donors only -----------------------
    if fill_mode == FILL_BACKGROUND and hole.any():
        donor = win & (layer_map >= 1)  # never the frontmost occluder
        if donor.any():
            donor_src = np.where(donor, winner_flat, np.int32(-1)).astype(np.int32)
            donor_at = nearest_donor(donor.reshape(H, W),
                                     donor_src.reshape(H, W)).reshape(-1)
            can = hole & (donor_at >= 0)
            fill_src[can] = donor_at[can].astype(np.int32)
            filled[can] = True
            rgb_out[can] = sources.rgb[fill_src[can]]

    unfilled = hole & ~filled
    rgb_out[unfilled] = HOLE_RGB

    return RenderResult(
        scene=scene,
        camera=camera,
        fill_mode=fill_mode,
        rgb=rgb_out.reshape(H, W, 3),
        hole_mask=hole.reshape(H, W),
        filled_mask=filled.reshape(H, W),
        crack_mask=crack,
        layer_map=layer_map.reshape(H, W),
        source_flat=winner_flat.reshape(H, W),
        depth_map=depth_map.reshape(H, W),
        fill_source_flat=fill_src.reshape(H, W),
        sources=sources,
        stats={
            "holes": int(hole.sum()),
            "filled": int(filled.sum()),
            "unfilled": int(unfilled.sum()),
            "cracks": int(crack.sum()),
            "sources": int(dst.size),
            # Camera shifts at the two layers' representative depths, using the
            # EDITED depth so the readout follows the depth controls.
            "front_shift": _layer_shift(camera, scene.layers[0].depth, edits[0]),
            "back_shift": _layer_shift(camera, scene.layers[-1].depth, edits[-1]),
        },
    )


# ---------------------------------------------------------------------------
# layout difference between two renders (same output coordinate system)
# ---------------------------------------------------------------------------


@dataclass
class LayoutDiff:
    ref: RenderResult
    cur: RenderResult
    mask: np.ndarray            # (H, W) bool -- winner layer or hole status differs
    category: np.ndarray        # (H, W) int8, CAT_*
    counts: dict

    def describe(self) -> str:
        parts = [f"{CAT_NAMES[k]}={self.counts.get(k, 0)}"
                 for k in range(6) if self.counts.get(k, 0)]
        return ", ".join(parts) if parts else "no layout difference"


def layout_diff(ref: RenderResult, cur: RenderResult) -> LayoutDiff:
    """Classify how two layouts differ per output pixel."""
    if ref.shape != cur.shape:
        raise ValueError("renders must share a geometry")
    a = ref.layer_map
    b = cur.layer_map
    same = a == b
    cat = np.zeros_like(a, dtype=np.int8)
    cat[(a == 0) & (b >= 1)] = CAT_FRONT_TO_BACK
    cat[(a >= 1) & (b == 0)] = CAT_BACK_TO_FRONT
    cat[(a >= 0) & (b < 0)] = CAT_TO_HOLE
    cat[(a < 0) & (b >= 0)] = CAT_FROM_HOLE
    cat[same] = CAT_SAME
    cat[~same & (cat == CAT_SAME)] = CAT_OTHER
    counts = {k: int((cat == k).sum()) for k in range(6)}
    return LayoutDiff(ref=ref, cur=cur, mask=~same, category=cat, counts=counts)
