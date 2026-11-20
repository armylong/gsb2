"""Image and mesh persistence.

Exports never include overlays: the PNG written here is exactly
:func:`mesh_warp.warp.render_warp` output, and the JSON stores only source /
target control-point positions, lock state and the fixed triangulation.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np

from .mesh import MAX_GRID, MIN_GRID, ControlMesh, MeshError, regular_grid

MAX_LONG_EDGE = 1200
MESH_FORMAT = "mesh-warp-control-mesh"
MESH_VERSION = 1


class ImageLoadError(ValueError):
    """Raised when an image cannot be used as a deformable source."""


@dataclass
class LoadedImage:
    rgba: np.ndarray
    path: Path
    sha256: str

    @property
    def width(self) -> int:
        return int(self.rgba.shape[1])

    @property
    def height(self) -> int:
        return int(self.rgba.shape[0])


def load_image_rgba(path: str | Path, max_long_edge: int = MAX_LONG_EDGE) -> LoadedImage:
    """Load a PNG as uint8 RGBA.

    * Grayscale / BGR PNGs are expanded with an opaque alpha channel.
    * Alpha is preserved exactly; fully transparent RGB is left untouched but
      will be premultiplied before interpolation.
    * Images whose long edge exceeds ``max_long_edge`` are rejected rather than
      silently rescaled, so pixel coordinates stay meaningful.
    """
    p = Path(path)
    if p.suffix.lower() != ".png":
        raise ImageLoadError("only PNG files are supported")
    data = np.fromfile(str(p), dtype=np.uint8)
    if data.size == 0:
        raise ImageLoadError(f"cannot read image: {p}")
    img = cv2.imdecode(data, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise ImageLoadError(f"cannot decode PNG: {p}")
    if img.dtype != np.uint8:
        # 16-bit PNGs: scale down to 8 bit per channel consistently.
        img = np.clip(img.astype(np.float64) / 257.0 + 0.5, 0, 255).astype(np.uint8)
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2RGBA)
    elif img.shape[2] == 3:
        img = cv2.cvtColor(img, cv2.COLOR_BGR2RGBA)
    elif img.shape[2] == 4:
        img = cv2.cvtColor(img, cv2.COLOR_BGRA2RGBA)
    else:
        raise ImageLoadError(f"unsupported channel count: {img.shape[2]}")

    h, w = img.shape[:2]
    if max(w, h) > max_long_edge:
        raise ImageLoadError(
            f"image is {w}x{h}, long edge exceeds the {max_long_edge} px limit; "
            "please resize it first"
        )
    if w < MIN_GRID or h < MIN_GRID:
        raise ImageLoadError(f"image is too small for a control mesh: {w}x{h}")
    digest = hashlib.sha256(img.tobytes()).hexdigest()
    return LoadedImage(np.ascontiguousarray(img), p, digest)


def save_png_rgba(path: str | Path, rgba: np.ndarray) -> None:
    """Write uint8 RGBA to PNG without any overlay."""
    arr = np.asarray(rgba)
    if arr.ndim != 3 or arr.shape[2] != 4 or arr.dtype != np.uint8:
        raise ValueError("save_png_rgba expects uint8 HxWx4")
    bgra = cv2.cvtColor(arr, cv2.COLOR_RGBA2BGRA)
    ok, encoded = cv2.imencode(".png", bgra)
    if not ok:
        raise OSError(f"failed to encode PNG: {path}")
    Path(path).write_bytes(encoded.tobytes())


def _points(points: np.ndarray) -> list[list[float]]:
    # Python's JSON float repr round-trips IEEE doubles exactly, so a reload
    # reproduces the same warp pixel-for-pixel.
    return [[float(x), float(y)] for x, y in points]


def mesh_to_dict(mesh: ControlMesh, image: LoadedImage | None = None) -> dict[str, Any]:
    """Serialize mesh state with exact (round-trip safe) coordinates."""
    doc: dict[str, Any] = {
        "format": MESH_FORMAT,
        "version": MESH_VERSION,
        "image": {"width": mesh.width, "height": mesh.height},
        "grid": {"cols": mesh.cols, "rows": mesh.rows},
        "source_points": _points(mesh.src),
        "target_points": _points(mesh.dst),
        "locked": [bool(v) for v in mesh.locked],
        "triangles": mesh.tris.astype(int).tolist(),
    }
    if image is not None:
        doc["image"]["sha256"] = image.sha256
        doc["image"]["path_hint"] = image.path.name
    return doc


def save_mesh_json(
    path: str | Path, mesh: ControlMesh, image: LoadedImage | None = None
) -> None:
    doc = mesh_to_dict(mesh, image)
    Path(path).write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")


def mesh_from_dict(
    doc: dict[str, Any],
    *,
    width: int | None = None,
    height: int | None = None,
    image_sha256: str | None = None,
) -> ControlMesh:
    """Rebuild a mesh from JSON, validating size, topology and pose."""
    if doc.get("format") != MESH_FORMAT:
        raise MeshError("not a mesh-warp control mesh file")
    if int(doc.get("version", 0)) != MESH_VERSION:
        raise MeshError(f"unsupported mesh format version: {doc.get('version')}")
    image = doc.get("image", {})
    fw, fh = int(image.get("width", 0)), int(image.get("height", 0))
    if width is not None and height is not None and (fw, fh) != (width, height):
        raise MeshError(
            f"mesh is for a {fw}x{fh} image, current image is {width}x{height}"
        )
    if fw < 2 or fh < 2:
        raise MeshError("mesh file has invalid image dimensions")
    grid = doc.get("grid", {})
    cols, rows = int(grid.get("cols", 0)), int(grid.get("rows", 0))
    if not (MIN_GRID <= cols <= MAX_GRID and MIN_GRID <= rows <= MAX_GRID):
        raise MeshError(f"mesh file has unsupported grid: {cols}x{rows}")

    mesh = ControlMesh(cols, rows, fw, fh)
    src = np.asarray(doc.get("source_points"), dtype=np.float64)
    dst = np.asarray(doc.get("target_points"), dtype=np.float64)
    if src.shape != mesh.src.shape or dst.shape != mesh.src.shape:
        raise MeshError("mesh point arrays do not match the declared grid")
    if not np.allclose(src, regular_grid(cols, rows, fw, fh), atol=1e-4):
        raise MeshError("mesh source points are not a regular lattice for this image")
    locked = np.asarray(doc.get("locked", np.zeros(mesh.n_points)), dtype=bool)
    if locked.shape != (mesh.n_points,):
        raise MeshError("mesh lock state does not match the grid")
    tris = np.asarray(doc.get("triangles"), dtype=np.int64)
    if tris.shape != mesh.tris.shape or not np.array_equal(tris, mesh.tris):
        raise MeshError("mesh triangulation does not match the fixed topology")
    if image_sha256 is not None and image.get("sha256"):
        if str(image["sha256"]) != image_sha256:
            raise MeshError(
                "this mesh was saved for different image content of the same size"
            )
    mesh.set_dst(dst)
    mesh.locked = locked
    return mesh


def load_mesh_json(
    path: str | Path,
    *,
    width: int | None = None,
    height: int | None = None,
    image_sha256: str | None = None,
) -> ControlMesh:
    try:
        doc = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise MeshError(f"cannot read mesh JSON: {exc}") from exc
    if not isinstance(doc, dict):
        raise MeshError("mesh JSON root must be an object")
    return mesh_from_dict(
        doc, width=width, height=height, image_sha256=image_sha256
    )
