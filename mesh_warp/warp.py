"""Piecewise-affine image warping driven by the control mesh.

The renderer inverts the piecewise-affine map per target triangle: for every
pixel it finds the containing target triangle, computes barycentric weights,
and uses them to interpolate the corresponding source position.  Adjacent
triangles share their edge vertices, so on a common edge both affine maps
produce the identical source coordinate: no cracks, no doubled transparent
seams, no content jump.

Colours are interpolated in *premultiplied* alpha space.  This is what keeps a
semi-transparent source border from picking up black fringes (a naive
non-premultiplied bilinear fetch blends RGB with the black RGB of fully
transparent pixels).  Anything outside the source image or outside the
deformed mesh stays fully transparent.
"""

from __future__ import annotations

import cv2
import numpy as np

from .mesh import ControlMesh, MeshError, barycentric

_BILINEAR = cv2.INTER_LINEAR
_BORDER = cv2.BORDER_CONSTANT


def premultiply(rgba: np.ndarray) -> np.ndarray:
    """Convert uint8 RGBA to float32 premultiplied RGBA in ``[0, 1]``."""
    img = rgba.astype(np.float32) / 255.0
    img[..., :3] *= img[..., 3:4]
    return img


def unpremultiply(premul: np.ndarray) -> np.ndarray:
    """Convert float32 premultiplied RGBA in ``[0, 1]`` to uint8 RGBA."""
    alpha = np.clip(premul[..., 3:4], 0.0, 1.0)
    rgb = np.divide(
        premul[..., :3],
        alpha,
        out=np.zeros_like(premul[..., :3]),
        where=alpha > 1e-8,
    )
    rgba = np.concatenate((np.clip(rgb, 0.0, 1.0), alpha), axis=-1)
    # Round half up predictably; cv2/numpy rounding differences otherwise make
    # identity checks depend on the build.
    return np.clip(np.floor(rgba * 255.0 + 0.5), 0, 255).astype(np.uint8)


def _triangle_bounds(
    mesh: ControlMesh, k: int, width: int, height: int
) -> tuple[int, int, int, int] | None:
    tgt = mesh.dst[mesh.tris[k]]
    bx0 = max(int(np.floor(tgt[:, 0].min())), 0)
    by0 = max(int(np.floor(tgt[:, 1].min())), 0)
    bx1 = min(int(np.ceil(tgt[:, 0].max())), width - 1)
    by1 = min(int(np.ceil(tgt[:, 1].max())), height - 1)
    if bx1 < bx0 or by1 < by0:
        return None
    return bx0, by0, bx1, by1


def _triangle_inverse_maps(
    mesh: ControlMesh, k: int, x0: int, x1: int, y0: int, y1: int
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Inverse affine map for every pixel centre in a clipped bbox."""
    tf = mesh.tris[k]
    tgt = mesh.dst[tf]
    src = mesh.src[tf]
    xs = np.arange(x0, x1 + 0.5, 1.0, dtype=np.float32)
    ys = np.arange(y0, y1 + 0.5, 1.0, dtype=np.float32)
    gx, gy = np.meshgrid(xs, ys)
    pts = np.stack((gx, gy), axis=-1).reshape(-1, 2).astype(np.float64)
    inside, bary = barycentric(pts, tgt)
    sx = (bary @ src).astype(np.float32)
    map_x = sx[:, 0].reshape(gy.shape)
    map_y = sx[:, 1].reshape(gy.shape)
    return map_x, map_y, inside.reshape(gy.shape)


def render_warp(
    image_rgba: np.ndarray, mesh: ControlMesh, *, validate: bool = True
) -> np.ndarray:
    """Render the deformed image on the original canvas.

    Parameters
    ----------
    image_rgba:
        ``(H, W, 4)`` uint8 source image.  Must match ``mesh.width`` /
        ``mesh.height``.
    mesh:
        A *valid* control mesh.  Invalid poses raise :class:`MeshError`; the
        caller's validation / drag rejection is expected to have prevented
        them, so this is a final guard rather than a repair path.

    Returns
    -------
    ``(H, W, 4)`` uint8 RGBA result.  Fully transparent outside the mesh and
    outside the source image.  If the mesh is exactly at rest the source is
    returned bit-for-bit unchanged.
    """
    if image_rgba.ndim != 3 or image_rgba.shape[2] != 4:
        raise ValueError("expected an HxWx4 RGBA image")
    h, w = image_rgba.shape[:2]
    if (w, h) != (mesh.width, mesh.height):
        raise ValueError("image size does not match the mesh canvas")
    if validate:
        problems = mesh.validate()
        if problems:
            raise MeshError("refusing to render invalid mesh: " + "; ".join(problems))

    if mesh.is_identity:
        return image_rgba.copy()

    src_pre = premultiply(image_rgba)
    out = np.zeros((h, w, 4), dtype=np.float32)

    for k in range(len(mesh.tris)):
        bounds = _triangle_bounds(mesh, k, w, h)
        if bounds is None:
            continue
        bx0, by0, bx1, by1 = bounds
        map_x, map_y, inside = _triangle_inverse_maps(mesh, k, bx0, bx1, by0, by1)
        patch = cv2.remap(
            src_pre,
            map_x,
            map_y,
            _BILINEAR,
            borderMode=_BORDER,
            borderValue=(0.0, 0.0, 0.0, 0.0),
        )
        region = out[by0 : by1 + 1, bx0 : bx1 + 1]
        # If a pixel centre is exactly on a shared edge it is inside both
        # triangles and both maps agree there, so the overwrite is harmless.
        region[inside] = patch[inside]

    return unpremultiply(out)


def make_preview_source(
    image_rgba: np.ndarray, max_long_edge: int = 700
) -> tuple[np.ndarray, float]:
    """Downscaled source image + scale factor for interactive previews.

    The scale is computed so that source and target control points can be
    multiplied by the same factor; a uniform similarity transform commutes with
    the per-triangle affine map, so the preview is geometrically faithful.
    """
    h, w = image_rgba.shape[:2]
    if max(h, w) <= max_long_edge:
        return image_rgba, 1.0
    factor = float(max_long_edge) / float(max(h, w))
    pw = max(2, int(round(w * factor)))
    ph = max(2, int(round(h * factor)))
    small = unpremultiply(
        cv2.resize(premultiply(image_rgba), (pw, ph), interpolation=cv2.INTER_AREA)
    )
    # Use the exact pixel mapping so the preview mesh covers every preview pixel.
    return small, (pw - 1) / max(w - 1, 1)


def preview_mesh(mesh: ControlMesh, small: np.ndarray, scale: float) -> ControlMesh:
    """Control mesh mapped into preview-image coordinates."""
    h, w = small.shape[:2]
    pm = ControlMesh(mesh.cols, mesh.rows, w, h)
    pm.src = mesh.src * scale
    pm.dst = mesh.dst * scale
    pm.locked = mesh.locked.copy()
    pm.rest_double_areas = pm._rest_double_areas()
    return pm


def render_preview(
    image_rgba: np.ndarray,
    mesh: ControlMesh,
    max_long_edge: int = 700,
    source: tuple[np.ndarray, float] | None = None,
) -> tuple[np.ndarray, float]:
    """Fast lower-resolution render used while a drag is in flight.

    ``source`` may carry a cached ``(small_image, scale)`` pair.
    Returns ``(rgba, scale)`` where ``scale`` is the preview size relative to
    the original canvas.
    """
    small, scale = source if source is not None else make_preview_source(
        image_rgba, max_long_edge
    )
    if scale == 1.0:
        return render_warp(image_rgba, mesh), 1.0
    # The preview is uniformly scaled down, so the absolute height threshold
    # (0.5 px) is not meaningful there.  The full-size pose was already
    # validated before it was committed, so skip re-validation in preview.
    return render_warp(small, preview_mesh(mesh, small, scale), validate=False), scale
