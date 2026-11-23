"""Image I/O for flat-field work: strictly 16-bit single-channel imagery.

Supported formats:
  * PNG (16-bit single-channel gray only)
  * TIFF (16-bit single-channel gray)
  * PGM (P5, maxval > 255 so the samples are genuinely 16-bit)

Everything enters the pipeline as a contiguous ``uint16`` ndarray.  Exposure
metadata (exposure_ms / gain_db / black level / bit depth) is embedded in the
file when present and is otherwise treated as unknown.

The loader also imports a few non-image sidecars so that reference sets can be
exchanged together with their acquisition conditions:
  * ``.npz``     - keys: dark/light/flat (stack), sample (image), meta (json)
  * ``.json``    - same schema, with 16-bit PNGs referenced relative to the file
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

import numpy as np
from PIL import Image, PngImagePlugin

SUPPORTED_SUFFIXES = {".png", ".tif", ".tiff", ".pgm", ".ppm", ".npz", ".json"}

# PNG text chunks we read back; keys are lower-cased for Meta.from_dict.
_PNG_EXPOSURE_KEYS = {
    "ExposureTimeMs": "exposure_ms",
    "GainDb": "gain_db",
    "BlackLevel": "black_level",
    "BitDepth": "bit_depth",
}


class ImageLoadError(Exception):
    """Raised when a file is not a usable 16-bit single-channel grayscale image."""


@dataclass
class Meta:
    """Acquisition conditions stored alongside an image (all optional)."""

    exposure_ms: float | None = None
    gain_db: float | None = None
    black_level: int | None = None
    bit_depth: int | None = None
    note: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "exposure_ms": self.exposure_ms,
            "gain_db": self.gain_db,
            "black_level": self.black_level,
            "bit_depth": self.bit_depth,
            "note": self.note,
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any] | None) -> "Meta":
        if not data:
            return cls()

        def num(key: str) -> float | None:
            value = data.get(key)
            try:
                return None if value is None or value == "" else float(value)
            except (TypeError, ValueError):
                return None

        black = num("black_level")
        depth = num("bit_depth")
        return cls(
            exposure_ms=num("exposure_ms"),
            gain_db=num("gain_db"),
            black_level=None if black is None else int(black),
            bit_depth=None if depth is None else int(depth),
            note=str(data.get("note") or ""),
        )

    def describe(self) -> str:
        parts = []
        if self.exposure_ms is not None:
            parts.append(f"曝光 {self.exposure_ms:g} ms")
        if self.gain_db is not None:
            parts.append(f"增益 {self.gain_db:g} dB")
        if self.black_level is not None:
            parts.append(f"黑电平 {self.black_level}")
        if self.bit_depth is not None:
            parts.append(f"{self.bit_depth} bit")
        if self.note:
            parts.append(self.note)
        return " · ".join(parts) if parts else "未记录曝光条件"

    @property
    def has_conditions(self) -> bool:
        return self.exposure_ms is not None or self.gain_db is not None


@dataclass
class LoadedImage:
    path: Path
    array: np.ndarray
    meta: Meta
    source_kind: str  # "image" | "npz" | "json"
    meta_source: str = "embedded"  # "embedded" | "sidecar" | "none"

    @property
    def shape(self) -> tuple[int, int]:
        return self.array.shape  # type: ignore[return-value]

    def name(self) -> str:
        return self.path.name


@dataclass
class Bundle:
    """A reference set exported from the generator or assembled externally."""

    dark: list[LoadedImage] = field(default_factory=list)
    light: list[LoadedImage] = field(default_factory=list)
    sample: LoadedImage | None = None


# --------------------------------------------------------------------------- #
# Validation
# --------------------------------------------------------------------------- #

def _as_uint16_gray(arr: np.ndarray, hint: str) -> np.ndarray:
    """Validate and normalize a pixel array without changing sample values."""
    arr = np.asarray(arr)
    if arr.ndim == 3:
        raise ImageLoadError(
            f"{hint}: 检测到 {arr.shape[2]} 通道图像。此工具只接受单通道 16 位灰度图，"
            "不做去马赛克或色彩转换。")
    if arr.ndim != 2:
        raise ImageLoadError(f"{hint}: 需要二维单通道图像，实际形状为 {arr.shape}。")
    if arr.dtype == np.uint16:
        return np.ascontiguousarray(arr)
    if arr.dtype == np.uint8:
        raise ImageLoadError(
            f"{hint}: 文件实际是 8 位灰度，只有 256 级。请提供 16 位原始灰度数据。")
    if arr.dtype in (np.uint32, np.int32):
        a_min, a_max = int(arr.min()), int(arr.max())
        if a_min < 0 or a_max > 65535:
            raise ImageLoadError(f"{hint}: 数据范围 {a_min}..{a_max} 超出 16 位。")
        return np.ascontiguousarray(arr.astype(np.uint16))
    if np.issubdtype(arr.dtype, np.floating):
        raise ImageLoadError(f"{hint}: 检测到浮点数据，请提供 16 位整数灰度图。")
    raise ImageLoadError(f"{hint}: 不支持的像素类型 {arr.dtype}。")


def _check_16bit_mode(img: Image.Image, hint: str) -> None:
    if img.mode in ("I;16", "I;16B", "I;16L", "I;16N", "I"):
        return
    if img.mode in ("L", "LA", "P", "RGB", "RGBA"):
        raise ImageLoadError(
            f"{hint}: 位深为 8 bit (模式 {img.mode})。请导出 16 位灰度图。")
    raise ImageLoadError(f"{hint}: 不支持的图像模式 {img.mode}。")


def _read_embedded_meta(img: Image.Image) -> tuple[Meta, str]:
    """Pull exposure info from PNG text chunks, TIFF tags or EXIF."""
    raw: dict[str, Any] = {}
    info = getattr(img, "info", {}) or {}
    for key, field_name in _PNG_EXPOSURE_KEYS.items():
        if key in info:
            raw[field_name] = info[key]
    if "json" in info:  # our own TIFF tag 270 payload
        try:
            payload = json.loads(info["json"])
            if isinstance(payload, dict):
                raw.update(payload)
        except (TypeError, ValueError):
            pass
    tag_v2 = getattr(img, "tag_v2", None)
    if tag_v2 is not None:
        try:
            exif_ifd = tag_v2.get(34665)
            if exif_ifd:
                raw.setdefault("exposure_seconds", float(exif_ifd.get(33434, 0)) or None)
                raw.setdefault("iso", exif_ifd.get(34855))
        except Exception:
            pass
        try:
            value = tag_v2.get(270)
            if isinstance(value, (bytes, bytearray)):
                value = value.decode("utf-8", "ignore")
            if isinstance(value, str) and value.strip().startswith("{"):
                payload = json.loads(value)
                if isinstance(payload, dict):
                    raw.update(payload)
        except (TypeError, ValueError, KeyError):
            pass
        try:
            bits = tag_v2.get(258)
            if bits:
                raw.setdefault("bit_depth", int(bits[0]) if isinstance(bits, tuple) else int(bits))
        except (TypeError, ValueError):
            pass
    if raw.get("exposure_ms") is None and raw.get("exposure_seconds"):
        try:
            raw["exposure_ms"] = float(raw["exposure_seconds"]) * 1000.0
        except (TypeError, ValueError):
            pass
    raw.pop("exposure_seconds", None)
    raw.pop("software", None)
    raw.pop("iso", None)
    meta = Meta.from_dict(raw)
    return meta, ("embedded" if meta.has_conditions else "none")


# --------------------------------------------------------------------------- #
# Reading
# --------------------------------------------------------------------------- #

def read_image(path: str | os.PathLike[str]) -> LoadedImage:
    p = Path(path)
    hint = p.name
    try:
        with Image.open(p) as img:
            img.load()
            _check_16bit_mode(img, hint)
            arr = np.asarray(img)
            meta, meta_source = _read_embedded_meta(img)
    except ImageLoadError:
        raise
    except (OSError, ValueError, SyntaxError) as exc:
        raise ImageLoadError(f"{hint}: 无法解码为图像 ({exc})。") from exc
    arr = _as_uint16_gray(arr, hint)
    return LoadedImage(p, arr, meta, "image", meta_source)


def read_bundle(path: str | os.PathLike[str]) -> Bundle:
    """Read a bundle directory or .npz/.json bundle file."""
    p = Path(path)
    bundle = Bundle()
    if p.is_dir():
        for child in sorted(p.iterdir()):
            kind, entry = _classify_name(child.name)
            if kind is None or not child.is_file():
                continue
            loaded = read_image(child)
            _add_to_bundle(bundle, kind, loaded)
        if bundle.dark and bundle.light and bundle.sample:
            return bundle
        raise ImageLoadError(
            f"{p}: 文件夹中需要同时有 dark*/light*/sample* 命名的 16 位图像，"
            f"当前为 暗场 {len(bundle.dark)} 张、亮场 {len(bundle.light)} 张、"
            f"样品 {'有' if bundle.sample else '无'}。")
    suffix = p.suffix.lower()
    if suffix == ".npz":
        return _read_npz_bundle(p)
    if suffix == ".json":
        return _read_json_bundle(p)
    raise ImageLoadError(f"{p.name}: 参考集需要是目录、.npz 或 .json 文件。")


def _read_npz_bundle(p: Path) -> Bundle:
    bundle = Bundle()
    try:
        data = np.load(p, allow_pickle=False)
    except (OSError, ValueError) as exc:
        raise ImageLoadError(f"{p.name}: 无法读取 npz ({exc})。") from exc
    with data:
        meta = Meta()
        if "meta" in data.files:
            try:
                meta = Meta.from_dict(json.loads(str(data["meta"].item())))
            except (ValueError, TypeError):
                meta = Meta()
        for key, kind in (("dark", "dark"), ("light", "light"), ("flat", "light")):
            if key in data.files:
                stack = data[key]
                arrs = [stack] if stack.ndim == 2 else list(stack)
                for i, arr in enumerate(arrs):
                    img = _as_uint16_gray(arr, f"{p.name}:{key}[{i}]")
                    _add_to_bundle(bundle, kind,
                                   LoadedImage(p, img, meta, "npz", "sidecar"))
        if "sample" in data.files:
            img = _as_uint16_gray(data["sample"], f"{p.name}:sample")
            bundle.sample = LoadedImage(p, img, meta, "npz", "sidecar")
    if not (bundle.dark and bundle.light) or bundle.sample is None:
        raise ImageLoadError(
            f"{p.name}: npz 中需要 dark、light、sample 三个数组 (16 位灰度)。")
    return bundle


def _read_json_bundle(p: Path) -> Bundle:
    try:
        payload = json.loads(p.read_text("utf-8"))
    except (OSError, ValueError) as exc:
        raise ImageLoadError(f"{p.name}: JSON 解析失败 ({exc})。") from exc
    base = p.parent
    bundle = Bundle()
    shared_meta = Meta.from_dict(payload.get("meta"))
    for key, kind in (("dark", "dark"), ("light", "light"), ("flat", "light")):
        for rel in payload.get(key, []) or []:
            child = base / rel
            loaded = read_image(child)
            if not loaded.meta.has_conditions and shared_meta.has_conditions:
                loaded.meta = shared_meta
                loaded.meta_source = "sidecar"
            _add_to_bundle(bundle, kind, loaded)
    sample_rel = payload.get("sample")
    if sample_rel:
        child = base / sample_rel
        loaded = read_image(child)
        if not loaded.meta.has_conditions and shared_meta.has_conditions:
            loaded.meta = shared_meta
            loaded.meta_source = "sidecar"
        bundle.sample = loaded
    if not (bundle.dark and bundle.light) or bundle.sample is None:
        raise ImageLoadError(f"{p.name}: JSON 需要 dark/light 列表与 sample 路径。")
    return bundle


def _classify_name(name: str) -> tuple[str | None, str]:
    stem = Path(name).stem.lower()
    if stem.startswith("dark") or re.match(r"^d\d*$", stem):
        return "dark", stem
    if stem.startswith(("light", "flat", "bright")):
        return "light", stem
    if stem.startswith("sample"):
        return "sample", stem
    return None, stem


def _add_to_bundle(bundle: Bundle, kind: str, loaded: LoadedImage) -> None:
    if kind == "dark":
        bundle.dark.append(loaded)
    elif kind == "light":
        bundle.light.append(loaded)
    elif kind == "sample":
        bundle.sample = loaded


# --------------------------------------------------------------------------- #
# Writing
# --------------------------------------------------------------------------- #

def _pnginfo_for(meta: Meta) -> PngImagePlugin.PngInfo:
    info = PngImagePlugin.PngInfo()
    info.add_text("Software", "FlatField Studio")
    if meta.exposure_ms is not None:
        info.add_text("ExposureTimeMs", f"{meta.exposure_ms:g}")
    if meta.gain_db is not None:
        info.add_text("GainDb", f"{meta.gain_db:g}")
    if meta.black_level is not None:
        info.add_text("BlackLevel", str(meta.black_level))
    info.add_text("BitDepth", "16")
    return info


def write_png(path: str | os.PathLike[str], arr: np.ndarray, meta: Meta | None = None) -> None:
    p = Path(path)
    arr = _as_uint16_gray(arr, p.name)
    image = Image.fromarray(arr, mode=None)
    image.save(p, format="PNG", pnginfo=_pnginfo_for(meta or Meta()))


def write_mask_png(path: str | os.PathLike[str], mask: np.ndarray) -> None:
    """Masks are written as 16-bit PNG with 0 / 65535 so they stay lossless."""
    p = Path(path)
    mask = np.asarray(mask)
    if mask.shape[:2] == (0, 0):
        raise ValueError("empty mask")
    if mask.ndim != 2:
        raise ValueError("mask must be 2-D")
    data = np.where(mask.astype(bool), 65535, 0).astype(np.uint16)
    Image.fromarray(data, mode=None).save(p, format="PNG")


def write_ascii_pgm(path: str | os.PathLike[str], arr: np.ndarray, meta: Meta | None = None) -> None:
    """Portable 16-bit reference export (plain P5, big-endian)."""
    p = Path(path)
    arr = _as_uint16_gray(arr, p.name)
    header = f"P5\n# FlatField Studio 16-bit\n{arr.shape[1]} {arr.shape[0]}\n65535\n"
    with open(p, "wb") as fh:
        fh.write(header.encode("ascii"))
        fh.write(arr.astype(">u2").tobytes())


def write_npz_bundle(
    path: str | os.PathLike[str],
    dark: np.ndarray,
    light: np.ndarray,
    sample: np.ndarray,
    meta: Meta | None = None,
) -> None:
    p = Path(path)
    payload = {
        "dark": dark.astype(np.uint16),
        "light": light.astype(np.uint16),
        "sample": sample.astype(np.uint16),
    }
    if meta is not None:
        payload["meta"] = np.array(json.dumps(meta.to_dict(), ensure_ascii=False))
    np.savez_compressed(p, **payload)


def write_json_bundle(
    path: str | os.PathLike[str],
    files: dict[str, Any],
    meta: Meta | None = None,
) -> None:
    p = Path(path)
    p.write_text(json.dumps({"meta": (meta or Meta()).to_dict(), **files},
                            indent=2, ensure_ascii=False), "utf-8")


def sniff_supported(path: str | os.PathLike[str]) -> bool:
    return Path(path).suffix.lower() in SUPPORTED_SUFFIXES


def iter_supported(paths: Iterable[str | os.PathLike[str]]) -> Iterable[Path]:
    for path in paths:
        p = Path(path)
        if p.is_dir():
            for child in sorted(p.iterdir()):
                if child.suffix.lower() in SUPPORTED_SUFFIXES and child.is_file():
                    yield child
        elif p.suffix.lower() in SUPPORTED_SUFFIXES:
            yield p
