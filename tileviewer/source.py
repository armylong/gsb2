"""Loading of a single local, single-frame, 8-bit RGB image.

Only files that decode to exactly one RGB frame are accepted.  Multi-page
TIFFs, animations, grayscale and images with an alpha channel are rejected
with an explicit error instead of being silently converted, so the pixel
grid the viewer talks about is always the pixel grid stored in the file.

EXIF orientation is *not* applied.  The viewer works on the raw pixel grid;
if the file carries a non-default orientation tag this is recorded and the
UI warns about it.
"""

from __future__ import annotations

import hashlib
import os
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from .geometry import Rect

__all__ = ["ImageSource", "SourceError", "load_source", "file_sha256"]

_CHUNK = 1 << 20
_TIFF_SUFFIXES = {".tif", ".tiff"}
_EXIF_ORIENTATION = 0x0112


class SourceError(RuntimeError):
    """The requested file cannot be used as the viewer's source image."""


@dataclass(eq=False)
class ImageSource:
    """A decoded source image plus stable identity information."""

    path: Path
    array: np.ndarray  # H x W x 3, uint8, read-only
    sha256: str
    file_size: int
    mtime_ns: int
    file_format: str
    exif_orientation: int = 1

    @property
    def width(self) -> int:
        return int(self.array.shape[1])

    @property
    def height(self) -> int:
        return int(self.array.shape[0])

    @property
    def short_hash(self) -> str:
        return self.sha256[:12]

    @property
    def bounds(self) -> Rect:
        return Rect(0, 0, self.width, self.height)

    def read_rect(self, rect: Rect) -> np.ndarray:
        """Return a copy of an in-bounds region of the original image."""
        clipped = rect.clipped_to(self.bounds)
        if clipped != rect:
            raise ValueError(f"region {rect} is not fully inside {self.bounds}")
        return np.array(
            self.array[rect.y : rect.y2, rect.x : rect.x2, :], copy=True
        )

    def same_file_as(self, other: ImageSource) -> bool:
        return (
            self.sha256 == other.sha256
            and self.file_size == other.file_size
            and self.mtime_ns == other.mtime_ns
        )


def file_sha256(path: str | os.PathLike[str]) -> str:
    """Hash the complete file content (used as the cache namespace)."""
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            block = handle.read(_CHUNK)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def _validate_array(array: np.ndarray, path: Path) -> np.ndarray:
    if array.ndim != 3:
        raise SourceError(
            f"{path.name}: expected a single RGB image, got an array with "
            f"shape {array.shape}"
        )
    if array.shape[2] != 3:
        raise SourceError(
            f"{path.name}: expected 3 RGB channels, got {array.shape[2]}; "
            "grayscale / RGBA / multi-channel images are out of scope"
        )
    if array.dtype != np.uint8:
        raise SourceError(
            f"{path.name}: expected 8-bit RGB, got dtype {array.dtype}; "
            "16-bit sources are out of scope"
        )
    if array.shape[0] == 0 or array.shape[1] == 0:
        raise SourceError(f"{path.name}: image has an empty dimension")
    contiguous = np.ascontiguousarray(array)
    contiguous.setflags(write=False)
    return contiguous


def _load_with_pillow(path: Path) -> tuple[np.ndarray, str, int]:
    try:
        from PIL import Image
    except ImportError as exc:  # pragma: no cover - dependency error path
        raise SourceError("Pillow is required to read this image") from exc

    try:
        with Image.open(path) as image:
            frame_count = int(getattr(image, "n_frames", 1))
            if frame_count > 1:
                raise SourceError(
                    f"{path.name}: multi-frame image ({frame_count} frames) is "
                    "out of scope; supply a single-frame RGB file"
                )
            if image.mode != "RGB":
                raise SourceError(
                    f"{path.name}: Pillow decodes this file as mode "
                    f"{image.mode!r}, not RGB; convert it to single-frame "
                    "8-bit RGB first"
                )
            try:
                orientation = int(image.getexif().get(_EXIF_ORIENTATION, 1))
            except Exception:
                orientation = 1
            image.load()
            array = np.array(image, dtype=np.uint8, copy=True)
            file_format = image.format or path.suffix.lstrip(".").upper()
    except SourceError:
        raise
    except Exception as exc:
        raise SourceError(f"{path.name}: failed to decode image: {exc}") from exc
    return array, str(file_format), orientation


def _load_tiff(path: Path) -> tuple[np.ndarray, str, int]:
    try:
        import tifffile
    except ImportError as exc:  # pragma: no cover - dependency error path
        raise SourceError("tifffile is required to read this TIFF") from exc

    try:
        with tifffile.TiffFile(path) as tif:
            page_count = len(tif.pages)
            if page_count != 1:
                raise SourceError(
                    f"{path.name}: multi-page TIFF ({page_count} pages) is out "
                    "of scope; supply a single-image RGB TIFF"
                )
            page = tif.pages[0]
            samples = int(getattr(page, "samplesperpixel", 0) or 0)
            if samples not in (0, 3):
                raise SourceError(
                    f"{path.name}: TIFF has {samples} samples per pixel; only "
                    "3-channel RGB is supported"
                )
            array = tif.asarray()
            orientation = 1
            try:
                value = page.tags.get("Orientation")
                if value is not None:
                    orientation = int(value.value)
            except Exception:
                orientation = 1
            compression = getattr(page, "compression", None)
            compression_name = (
                getattr(compression, "name", None) or str(compression)
            )
            file_format = f"TIFF ({compression_name})"
    except SourceError:
        raise
    except Exception as exc:
        raise SourceError(f"{path.name}: failed to decode TIFF: {exc}") from exc

    if array.ndim == 3 and array.shape[0] == 3 and array.shape[-1] != 3:
        # Planar (separate) storage: channels first.
        array = np.transpose(array, (1, 2, 0))
    return array, file_format, orientation


def load_source(path: str | os.PathLike[str]) -> ImageSource:
    """Load and validate a single local RGB image."""
    resolved = Path(path).expanduser()
    try:
        resolved = resolved.resolve(strict=True)
    except FileNotFoundError as exc:
        raise SourceError(f"file not found: {path}") from exc
    if not resolved.is_file():
        raise SourceError(f"not a regular file: {resolved}")

    try:
        stat = resolved.stat()
    except OSError as exc:
        raise SourceError(f"cannot stat {resolved}: {exc}") from exc
    if stat.st_size == 0:
        raise SourceError(f"{resolved.name}: file is empty")

    try:
        digest = file_sha256(resolved)
    except OSError as exc:
        raise SourceError(f"cannot read {resolved}: {exc}") from exc

    suffix = resolved.suffix.lower()
    if suffix in _TIFF_SUFFIXES:
        array, file_format, orientation = _load_tiff(resolved)
    else:
        array, file_format, orientation = _load_with_pillow(resolved)

    array = _validate_array(array, resolved)

    # Guard against files that are replaced while they are being read.
    try:
        stat_after = resolved.stat()
    except OSError as exc:
        raise SourceError(f"cannot stat {resolved}: {exc}") from exc
    if (stat_after.st_size, stat_after.st_mtime_ns) != (
        stat.st_size,
        stat.st_mtime_ns,
    ):
        raise SourceError(
            f"{resolved.name}: file changed while it was being read; try again"
        )

    return ImageSource(
        path=resolved,
        array=array,
        sha256=digest,
        file_size=stat.st_size,
        mtime_ns=stat.st_mtime_ns,
        file_format=file_format,
        exif_orientation=orientation,
    )


def platform_cache_root() -> Path:
    """Default location for generated tiles."""
    override = os.environ.get("TILEVIEWER_CACHE")
    if override:
        return Path(override).expanduser()
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Caches" / "tileviewer"
    if os.name == "nt":  # pragma: no cover - not the target platform
        base = os.environ.get("LOCALAPPDATA")
        if base:
            return Path(base) / "tileviewer" / "cache"
        return Path.home() / "AppData" / "Local" / "tileviewer" / "cache"
    base = os.environ.get("XDG_CACHE_HOME")
    if base:
        return Path(base) / "tileviewer"
    return Path.home() / ".cache" / "tileviewer"
