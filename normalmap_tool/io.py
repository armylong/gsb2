"""File I/O helpers: height maps, normal maps and their metadata sidecar.

Normal maps are always read and written numerically through the raw PNG
channel bytes.  OpenCV's reader is used with ``IMREAD_UNCHANGED`` (verified
not to apply gAMA/sRGB transforms to 8-bit images), and no colour-space
conversion is performed on the data.  A colour-managed image viewer may still
*display* a normal map differently, but the exported file and the round-trip
are byte based.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import cv2
import numpy as np

from .model import (
    BOUNDARIES,
    GREEN_CONVENTIONS,
    MAX_HEIGHTMAP_SIDE,
    LightSettings,
)

FORMAT_ID = "normalmap-tool.normalmap/1"

COORDINATE_RECORD = {
    "surface_axes": "x right, y up, z toward viewer",
    "image_rows": "downward",
    "height_brightness": "brighter = higher",
    "normal_encoding": "component in [-1,1] mapped to byte = round((v*0.5+0.5)*255)",
    "green_channel": "G = +Y for y_up (OpenGL); G = -Y for y_down (DirectX)",
}


class ImageLoadError(RuntimeError):
    pass


@dataclass(frozen=True)
class HeightMap:
    data: np.ndarray          # float64 in [0, 1], HxW, row 0 = top
    codes: np.ndarray         # original integer codes (uint8 or uint16), HxW
    bit_depth: int
    source_path: Optional[str]

    @property
    def width(self) -> int:
        return int(self.data.shape[1])

    @property
    def height(self) -> int:
        return int(self.data.shape[0])


@dataclass(frozen=True)
class NormalMapImage:
    rgb: np.ndarray           # uint8 HxWx3, raw PNG bytes in RGB order
    source_path: Optional[str]
    meta: dict[str, Any]


def _read_image(path: str | os.PathLike[str], flags: int) -> np.ndarray:
    # ``np.fromfile`` + ``imdecode`` is used so non-ASCII macOS paths work.
    buf = np.fromfile(os.fspath(path), dtype=np.uint8)
    if buf.size == 0:
        raise ImageLoadError(f"无法读取文件: {path}")
    img = cv2.imdecode(buf, flags)
    if img is None:
        raise ImageLoadError(f"无法解码 PNG: {path}")
    return img


def _write_png(path: str | os.PathLike[str], image: np.ndarray) -> None:
    ok, buf = cv2.imencode(".png", image)
    if not ok:
        raise ImageLoadError(f"无法编码 PNG: {path}")
    buf.tofile(os.fspath(path))


def load_height_png(path: str | os.PathLike[str]) -> HeightMap:
    """Load a grayscale PNG height map.

    * Accepts 8-bit or 16-bit single-channel PNGs (grey+alpha is accepted and
      the alpha is ignored; colour images are refused rather than guessed).
    * The longest side must not exceed 1024 pixels.
    * Height is normalised by the image's own maximum code value, never by the
      window size.
    """
    img = _read_image(path, cv2.IMREAD_UNCHANGED)
    if img.ndim == 3:
        # OpenCV returns grey+alpha as HxWx2.  Ignore the alpha plane; refuse
        # true colour images instead of guessing a luminance.
        if img.shape[2] not in (2, 4):
            raise ImageLoadError(
                "高度图必须是灰度 PNG (单通道或灰度+alpha); 不接受彩色照片推断高度."
            )
        img = img[..., 0]
    if img.ndim != 2:
        raise ImageLoadError("高度图必须是单通道灰度 PNG.")
    if img.dtype == np.uint8:
        bit_depth = 8
        max_code = 255.0
    elif img.dtype == np.uint16:
        bit_depth = 16
        max_code = 65535.0
    else:
        raise ImageLoadError(f"不支持的高度图数据类型: {img.dtype}")
    h, w = img.shape
    if max(h, w) > MAX_HEIGHTMAP_SIDE:
        raise ImageLoadError(
            f"高度图最长边为 {max(h, w)} 像素, 超过上限 {MAX_HEIGHTMAP_SIDE}."
        )
    if h < 3 or w < 3:
        raise ImageLoadError("高度图至少需要 3x3 像素.")
    data = img.astype(np.float64) / max_code
    return HeightMap(data=data, codes=img.copy(), bit_depth=bit_depth,
                     source_path=os.fspath(path))


def load_normal_png(
    path: str | os.PathLike[str],
    green: Optional[str] = None,
) -> NormalMapImage:
    """Load an 8-bit RGB normal map numerically.

    If ``green`` is None the sibling JSON metadata is consulted, falling back
    to y_up.  The sibling metadata (when present) is also returned so the
    lighting check can restore the original strength and boundary.
    """
    img = _read_image(path, cv2.IMREAD_UNCHANGED)
    if img.dtype != np.uint8:
        raise ImageLoadError(
            f"法线图必须是 8 位 RGB PNG (当前 {img.dtype}); 16 位法线无法直接按字节读取."
        )
    if img.ndim == 2 or img.shape[2] < 3:
        raise ImageLoadError("法线图需要 RGB 三个通道.")
    # OpenCV returns BGR(A); store RGB for all downstream code.
    rgb = np.ascontiguousarray(img[..., 2::-1])
    if rgb.shape[2] != 3:
        rgb = rgb[..., :3]
    meta = read_sidecar(path) or {}
    meta_green = meta.get("green_channel")
    chosen = green or (meta_green if meta_green in GREEN_CONVENTIONS else "y_up")
    if chosen not in GREEN_CONVENTIONS:
        raise ImageLoadError(f"未知的绿色通道约定: {chosen}")
    meta = dict(meta)
    meta["green_channel_resolved"] = chosen
    return NormalMapImage(rgb=rgb, source_path=os.fspath(path), meta=meta)


def save_normal_png(
    path: str | os.PathLike[str],
    rgb: np.ndarray,
    *,
    green: str,
    boundary: str,
    strength: float,
    smoothing: float,
    width: int,
    height: int,
    source_heightmap: Optional[str] = None,
    light: Optional[LightSettings] = None,
    extra: Optional[dict[str, Any]] = None,
) -> Path:
    """Write the normal PNG and a JSON sidecar with the full parameter record.

    Returns the path of the sidecar.  RGB input is converted to BGR only for
    the encoder call; no colour transform is applied to the values.
    """
    if green not in GREEN_CONVENTIONS:
        raise ValueError(f"unknown green convention: {green!r}")
    if boundary not in BOUNDARIES:
        raise ValueError(f"unknown boundary: {boundary!r}")
    arr = np.asarray(rgb)
    if arr.dtype != np.uint8 or arr.ndim != 3 or arr.shape[2] != 3:
        raise ValueError("导出法线必须是 uint8 HxWx3 RGB")
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    bgr = cv2.cvtColor(arr, cv2.COLOR_RGB2BGR)
    _write_png(p, bgr)

    record: dict[str, Any] = {
        "format": FORMAT_ID,
        "kind": "tangent_space_normal_map",
        "created_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "image": {
            "file": p.name,
            "width": int(width),
            "height": int(height),
            "pixel_size": "1 pixel = 1 surface unit in x and y",
        },
        "coordinate_system": COORDINATE_RECORD,
        "green_channel": green,
        "boundary": boundary,
        "height_strength": float(strength),
        "height_strength_unit": "pixels of z per full (0..1) height range",
        "smoothing_sigma": float(smoothing),
        "source_heightmap": os.fspath(source_heightmap) if source_heightmap else None,
        "decode_rule": (
            "nx=R/255*2-1; ny=G/255*2-1 (times +1 for y_up, -1 for y_down); "
            "nz=B/255*2-1; renormalise before lighting"
        ),
    }
    if light is not None:
        record["validation_light"] = asdict(light)
    if extra:
        record["extra"] = extra
    sidecar = p.with_suffix(p.suffix + ".json")
    sidecar.write_text(
        json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return sidecar


def read_sidecar(path: str | os.PathLike[str]) -> Optional[dict[str, Any]]:
    p = Path(path)
    candidates = [p.with_suffix(p.suffix + ".json"), p.with_suffix(".json")]
    for c in candidates:
        if c.is_file():
            try:
                data = json.loads(c.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                return None
            if isinstance(data, dict):
                return data
    return None


def light_from_meta(meta: dict[str, Any], default: LightSettings) -> LightSettings:
    raw = meta.get("validation_light")
    if not isinstance(raw, dict):
        return default
    try:
        return LightSettings(
            plane_x=float(raw["plane_x"]),
            plane_y=float(raw["plane_y"]),
            height=float(raw["height"]),
            ambient=float(raw["ambient"]),
            diffuse=float(raw["diffuse"]),
        ).clamped()
    except (KeyError, TypeError, ValueError):
        return default
