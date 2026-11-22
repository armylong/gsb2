"""On-disk preview pyramid with resumable, verifiable tile generation.

Layout::

    <root>/<source-sha256>/t<tile>_m<margin>_<resample>/
        pyramid.json            # source + config + level geometry (atomic)
        L000/
            level.json          # tile list, written last (atomic)
            c000_col_r000_row.png
        L001/
            ...

Everything is namespaced by the SHA-256 of the *file content*, so a
different image saved under the same name never reuses old tiles.  A level
only counts as complete when ``level.json`` exists and every tile it lists
is present with the recorded size; anything else is reported as missing,
partial or stale and can be regenerated.

Tile PNGs are lossless.  Each one stores the tile's full region (core plus
margins, clipped at the level border); the level manifest records both
rectangles so a reader can tell official pixels from overlap.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import tempfile
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from enum import Enum
from pathlib import Path

import numpy as np
from PIL import Image

from .geometry import LevelGeometry, Rect, level_sizes
from .source import ImageSource

__all__ = [
    "CACHE_FORMAT_VERSION",
    "PYRAMID_ALGORITHM",
    "CacheConfig",
    "LevelState",
    "LevelStatus",
    "PyramidInfo",
    "LevelComparison",
    "CacheManager",
    "build_level_array",
    "resample_filter",
    "stitch_tiles",
]

CACHE_FORMAT_VERSION = 1
PYRAMID_ALGORITHM = "direct-from-original/lanczos-halving-ladder"

_RESAMPLE_CHOICES = {
    "nearest": Image.Resampling.NEAREST,
    "bilinear": Image.Resampling.BILINEAR,
    "bicubic": Image.Resampling.BICUBIC,
    "lanczos": Image.Resampling.LANCZOS,
}

ProgressCallback = Callable[[int, int, str], None]
CancelCheck = Callable[[], bool]


class CacheError(RuntimeError):
    """Raised when a cache directory cannot be read or written."""


class CancelledError(RuntimeError):
    """Raised when generation stops because the caller cancelled it."""


class LevelState(str, Enum):
    MISSING = "missing"
    PARTIAL = "partial"
    COMPLETE = "complete"
    STALE = "stale"


@dataclass(frozen=True)
class CacheConfig:
    tile_size: int = 512
    margin: int = 16
    resample: str = "lanczos"
    min_level_size: int = 256
    max_levels: int = 10

    def __post_init__(self) -> None:
        if self.tile_size < 16:
            raise ValueError("tile_size must be at least 16")
        if self.margin < 0:
            raise ValueError("margin must be non-negative")
        if self.margin >= self.tile_size:
            raise ValueError("margin must be smaller than tile_size")
        if self.resample not in _RESAMPLE_CHOICES:
            raise ValueError(
                f"unknown resample filter {self.resample!r}; "
                f"choose from {sorted(_RESAMPLE_CHOICES)}"
            )
        if self.min_level_size < 1:
            raise ValueError("min_level_size must be positive")
        if self.max_levels < 1:
            raise ValueError("max_levels must be positive")

    @property
    def directory_name(self) -> str:
        return f"t{self.tile_size}_m{self.margin}_{self.resample}"

    def to_dict(self) -> dict:
        return {
            "tile_size": self.tile_size,
            "margin": self.margin,
            "resample": self.resample,
            "min_level_size": self.min_level_size,
            "max_levels": self.max_levels,
        }

    @classmethod
    def from_dict(cls, data: Mapping) -> CacheConfig:
        return cls(
            tile_size=int(data["tile_size"]),
            margin=int(data["margin"]),
            resample=str(data["resample"]),
            min_level_size=int(data["min_level_size"]),
            max_levels=int(data["max_levels"]),
        )


def resample_filter(name: str) -> Image.Resampling:
    try:
        return _RESAMPLE_CHOICES[name]
    except KeyError as exc:
        raise ValueError(f"unknown resample filter: {name!r}") from exc


@dataclass(frozen=True)
class PyramidInfo:
    source_sha256: str
    source_width: int
    source_height: int
    config: CacheConfig
    sizes: tuple[tuple[int, int], ...]

    @property
    def level_count(self) -> int:
        return len(self.sizes)

    def geometry(self, index: int) -> LevelGeometry:
        width, height = self.sizes[index]
        return LevelGeometry(
            width=width,
            height=height,
            tile_size=self.config.tile_size,
            margin=self.config.margin,
        )

    def to_dict(self) -> dict:
        return {
            "format": CACHE_FORMAT_VERSION,
            "algorithm": PYRAMID_ALGORITHM,
            "source_sha256": self.source_sha256,
            "source_width": self.source_width,
            "source_height": self.source_height,
            "config": self.config.to_dict(),
            "levels": [
                {
                    "index": index,
                    "width": width,
                    "height": height,
                    "tile_size": self.config.tile_size,
                    "margin": self.config.margin,
                    "cols": self.geometry(index).cols,
                    "rows": self.geometry(index).rows,
                }
                for index, (width, height) in enumerate(self.sizes)
            ],
        }

    def matches(self, data: Mapping) -> bool:
        try:
            return (
                int(data["format"]) == CACHE_FORMAT_VERSION
                and data["algorithm"] == PYRAMID_ALGORITHM
                and data["source_sha256"] == self.source_sha256
                and int(data["source_width"]) == self.source_width
                and int(data["source_height"]) == self.source_height
                and CacheConfig.from_dict(data["config"]) == self.config
                and tuple(
                    (int(level["width"]), int(level["height"]))
                    for level in data["levels"]
                )
                == self.sizes
            )
        except (KeyError, TypeError, ValueError):
            return False


@dataclass(frozen=True)
class LevelStatus:
    index: int
    state: LevelState
    width: int
    height: int
    cols: int
    rows: int
    tiles_present: int
    detail: str = ""

    @property
    def tile_count(self) -> int:
        return self.cols * self.rows

    @property
    def usable(self) -> bool:
        return self.state is LevelState.COMPLETE

    def describe(self) -> str:
        head = (
            f"L{self.index:02d} {self.width}x{self.height} "
            f"{self.cols}x{self.rows} tiles"
        )
        if self.state is LevelState.COMPLETE:
            return f"{head} - complete"
        if self.state is LevelState.MISSING:
            return f"{head} - missing"
        if self.state is LevelState.PARTIAL:
            return (
                f"{head} - incomplete ({self.tiles_present}/{self.tile_count}"
                " tiles present)"
            )
        return f"{head} - stale ({self.detail or 'configuration changed'})"


@dataclass(frozen=True)
class LevelComparison:
    index: int
    equal: bool
    mismatched_pixels: int
    max_channel_delta: int
    compared_pixels: int

    def describe(self) -> str:
        total = self.compared_pixels
        if self.equal:
            return (
                f"L{self.index:02d}: stitched tiles match reference exactly "
                f"({total} px)"
            )
        return (
            f"L{self.index:02d}: {self.mismatched_pixels}/{total} px differ, "
            f"max channel delta {self.max_channel_delta}"
        )


def _resample_array(
    array: np.ndarray, width: int, height: int, filter_name: str
) -> np.ndarray:
    if array.shape[1] == width and array.shape[0] == height:
        return np.array(array, copy=True)
    image = Image.fromarray(array, mode="RGB")
    resized = image.resize((width, height), resample=resample_filter(filter_name))
    return np.array(resized, dtype=np.uint8, copy=True)


def build_level_array(
    source: ImageSource,
    info: PyramidInfo,
    index: int,
) -> np.ndarray:
    """Build the reference image of one level, deterministically.

    Level 0 is the original pixels.  Every other level is resized directly
    from the original to its ceiling-divided size, so the result does not
    depend on which other levels exist or were generated.
    """
    width, height = info.sizes[index]
    return _resample_array(
        source.array, width, height, info.config.resample
    )


def stitch_tiles(
    tiles: Iterable[tuple[Rect, np.ndarray]],
    width: int,
    height: int,
) -> np.ndarray:
    """Compose tile cores into one level-sized RGB array."""
    canvas = np.zeros((height, width, 3), dtype=np.uint8)
    for core, tile in tiles:
        if tile.ndim != 3 or tile.shape[2] != 3:
            raise ValueError(f"tile for {core} is not RGB")
        if tile.shape[0] != core.h or tile.shape[1] != core.w:
            raise ValueError(
                f"tile for {core} has shape {tile.shape}, expected "
                f"{core.h}x{core.w}"
            )
        if not Rect(0, 0, width, height).clipped_to(core) == core:
            raise ValueError(f"tile core {core} lies outside the level")
        canvas[core.y : core.y2, core.x : core.x2, :] = tile
    return canvas


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent)
    )
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, path)
    except BaseException:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def _atomic_write_json(path: Path, payload: Mapping) -> None:
    _atomic_write(
        path,
        json.dumps(payload, indent=2, sort_keys=False).encode("utf-8"),
    )


def _read_json(path: Path) -> dict | None:
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


class CacheManager:
    """Owns the tile cache for one source image and one configuration."""

    def __init__(
        self,
        root: str | os.PathLike[str],
        source: ImageSource,
        config: CacheConfig | None = None,
        *,
        sizes: Sequence[tuple[int, int]] | None = None,
    ) -> None:
        self.root = Path(root).expanduser()
        self.source = source
        self.config = config or CacheConfig()
        if sizes is None:
            sizes = level_sizes(
                source.width,
                source.height,
                min_size=self.config.min_level_size,
                max_levels=self.config.max_levels,
            )
        self.info = PyramidInfo(
            source_sha256=source.sha256,
            source_width=source.width,
            source_height=source.height,
            config=self.config,
            sizes=tuple(sizes),
        )
        self.directory = (
            self.root / source.sha256 / self.config.directory_name
        )
        self._manifests: dict[int, dict | None] = {}
        self._integrity_cache: dict[int, tuple[bool, str]] = {}

    # ------------------------------------------------------------------
    # paths
    # ------------------------------------------------------------------
    @property
    def manifest_path(self) -> Path:
        return self.directory / "pyramid.json"

    def level_directory(self, index: int) -> Path:
        self._check_index(index)
        return self.directory / f"L{index:03d}"

    def level_manifest_path(self, index: int) -> Path:
        return self.level_directory(index) / "level.json"

    def tile_path(self, index: int, col: int, row: int) -> Path:
        return self.level_directory(index) / f"c{col:04d}_r{row:04d}.png"

    def _check_index(self, index: int) -> None:
        if not 0 <= index < self.info.level_count:
            raise IndexError(
                f"level {index} outside 0..{self.info.level_count - 1}"
            )

    def geometry(self, index: int) -> LevelGeometry:
        self._check_index(index)
        return self.info.geometry(index)

    # ------------------------------------------------------------------
    # pyramid manifest
    # ------------------------------------------------------------------
    def write_pyramid_manifest(self) -> None:
        _atomic_write_json(self.manifest_path, self.info.to_dict())

    def read_pyramid_manifest(self) -> dict | None:
        return _read_json(self.manifest_path)

    def pyramid_manifest_ok(self) -> bool:
        data = self.read_pyramid_manifest()
        return data is not None and self.info.matches(data)

    # ------------------------------------------------------------------
    # level manifests
    # ------------------------------------------------------------------
    def _load_level_manifest(self, index: int) -> dict | None:
        if index not in self._manifests:
            self._manifests[index] = _read_json(self.level_manifest_path(index))
        return self._manifests[index]

    def _invalidate_level_manifest(self, index: int) -> None:
        self._manifests.pop(index, None)
        self._integrity_cache.pop(index, None)

    def _manifest_matches(self, index: int, data: Mapping) -> tuple[bool, str]:
        """Validate a level manifest and the tile bytes it describes.

        The expensive part (hashing every tile) is memoised per level so
        that repeated status refreshes do not re-hash a large level; the
        memo is dropped whenever the level is regenerated or cleared.
        """
        cached = self._integrity_cache.get(index)
        if cached is not None:
            return cached
        result = self._verify_level_integrity(index, data)
        self._integrity_cache[index] = result
        return result

    def _verify_level_integrity(
        self, index: int, data: Mapping
    ) -> tuple[bool, str]:
        try:
            if int(data["format"]) != CACHE_FORMAT_VERSION:
                return False, "cache format changed"
            if data["algorithm"] != PYRAMID_ALGORITHM:
                return False, "pyramid algorithm changed"
            if data["source_sha256"] != self.source.sha256:
                return False, "source content changed"
            if CacheConfig.from_dict(data["config"]) != self.config:
                return False, "tile configuration changed"
            if int(data["level"]) != index:
                return False, "level index mismatch"
            geom = self.geometry(index)
            if (int(data["width"]), int(data["height"])) != (
                geom.width,
                geom.height,
            ):
                return False, "level size changed"
            tiles = data["tiles"]
            if not isinstance(tiles, list) or len(tiles) != geom.tile_count:
                return False, "tile list is incomplete"
            seen: set[tuple[int, int]] = set()
            for entry in tiles:
                col, row = int(entry["col"]), int(entry["row"])
                seen.add((col, row))
                core = Rect(*entry["core"])
                full = Rect(*entry["full"])
                if core != geom.core_rect(col, row):
                    return False, "tile core geometry mismatch"
                if full != geom.full_rect(col, row):
                    return False, "tile margin geometry mismatch"
                # Content check: a tile overwritten on disk must not be
                # silently mixed with freshly generated tiles.  A *missing*
                # tile is not stale: it is simply not generated yet and is
                # reported as partial by level_status().
                path = self.tile_path(index, col, row)
                try:
                    size = path.stat().st_size
                except OSError:
                    continue
                if size != int(entry["bytes"]):
                    return False, "tile size changed on disk"
                if _sha256_bytes(path.read_bytes()) != entry.get("sha256"):
                    return False, "tile content changed on disk"
            return len(seen) == geom.tile_count, "duplicate tile entries"
        except (KeyError, TypeError, ValueError, IndexError):
            return False, "level manifest is malformed"

    # ------------------------------------------------------------------
    # status
    # ------------------------------------------------------------------
    def level_status(self, index: int) -> LevelStatus:
        geom = self.geometry(index)
        manifest = self._load_level_manifest(index)
        if manifest is None:
            present = self._count_tile_files(index, geom)
            state = LevelState.PARTIAL if present else LevelState.MISSING
            return LevelStatus(
                index=index,
                state=state,
                width=geom.width,
                height=geom.height,
                cols=geom.cols,
                rows=geom.rows,
                tiles_present=present,
                detail="level manifest missing",
            )
        ok, reason = self._manifest_matches(index, manifest)
        if not ok:
            return LevelStatus(
                index=index,
                state=LevelState.STALE,
                width=geom.width,
                height=geom.height,
                cols=geom.cols,
                rows=geom.rows,
                tiles_present=self._count_tile_files(index, geom),
                detail=reason,
            )
        present = 0
        for entry in manifest["tiles"]:
            path = self.tile_path(index, int(entry["col"]), int(entry["row"]))
            try:
                size = path.stat().st_size
            except OSError:
                continue
            if size == int(entry["bytes"]):
                present += 1
        state = (
            LevelState.COMPLETE
            if present == geom.tile_count
            else LevelState.PARTIAL
        )
        return LevelStatus(
            index=index,
            state=state,
            width=geom.width,
            height=geom.height,
            cols=geom.cols,
            rows=geom.rows,
            tiles_present=present,
            detail="" if state is LevelState.COMPLETE else "tile files missing",
        )

    def statuses(self) -> list[LevelStatus]:
        return [self.level_status(i) for i in range(self.info.level_count)]

    def _count_tile_files(self, index: int, geom: LevelGeometry) -> int:
        directory = self.level_directory(index)
        if not directory.is_dir():
            return 0
        count = 0
        for col in range(geom.cols):
            for row in range(geom.rows):
                if self.tile_path(index, col, row).is_file():
                    count += 1
        return count

    def cached_bytes(self) -> int:
        if not self.directory.is_dir():
            return 0
        total = 0
        for path in self.directory.rglob("*"):
            if path.is_file():
                total += path.stat().st_size
        return total

    # ------------------------------------------------------------------
    # generation
    # ------------------------------------------------------------------
    def generate(
        self,
        levels: Sequence[int] | None = None,
        *,
        force: bool = False,
        progress: ProgressCallback | None = None,
        should_cancel: CancelCheck | None = None,
    ) -> list[int]:
        """Generate the requested (default: incomplete) levels.

        Returns the levels that were written by this call.  Cancelling leaves
        finished tiles and finished levels on disk; the next call resumes at
        the first unfinished tile.  ``CancelledError`` is raised.
        """
        if levels is None:
            levels = [
                status.index
                for status in self.statuses()
                if status.state is not LevelState.COMPLETE
            ]
        levels = list(dict.fromkeys(levels))
        for index in levels:
            self._check_index(index)

        todo: list[tuple[int, int, int]] = []
        prepared: dict[int, LevelGeometry] = {}
        for index in levels:
            geom = self.geometry(index)
            prepared[index] = geom
            status = self.level_status(index)
            # A stale level (tiles edited on disk, or a manifest that no
            # longer matches) must never be mixed with fresh tiles.
            if (force or status.state is LevelState.STALE) and (
                self.level_directory(index).exists()
            ):
                shutil.rmtree(self.level_directory(index), ignore_errors=True)
                self._invalidate_level_manifest(index)
            geometry = self.level_directory(index) / "geometry.json"
            _atomic_write_json(
                geometry,
                {
                    "format": CACHE_FORMAT_VERSION,
                    "algorithm": PYRAMID_ALGORITHM,
                    "source_sha256": self.source.sha256,
                    "config": self.config.to_dict(),
                    "level": index,
                    "width": geom.width,
                    "height": geom.height,
                    "tile_size": self.config.tile_size,
                    "margin": self.config.margin,
                },
            )
            for tile in geom.iter_tiles():
                if self.tile_path(index, tile.col, tile.row).is_file():
                    continue
                todo.append((index, tile.col, tile.row))

        total = len(todo)
        done = 0
        if progress is not None:
            progress(done, total, "ready")

        self.write_pyramid_manifest()

        # Build each level image only when that level still has work.
        level_arrays: dict[int, np.ndarray] = {}
        written: list[int] = []
        for index in levels:
            geom = prepared[index]
            pending = [item for item in todo if item[0] == index]
            if not pending:
                # Rebuild the manifest so a fully present level is marked done.
                self._finalize_level(index, geom, progress, should_cancel)
                continue
            self._check_cancel(should_cancel, done, total, index)
            if index not in level_arrays:
                level_arrays[index] = build_level_array(self.source, self.info, index)
            array = level_arrays[index]
            for _level, col, row in pending:
                self._check_cancel(should_cancel, done, total, index)
                tile = geom.tile(col, row)
                patch = array[
                    tile.full.y : tile.full.y2, tile.full.x : tile.full.x2, :
                ]
                buffer = io.BytesIO()
                Image.fromarray(patch, mode="RGB").save(buffer, format="PNG")
                data = buffer.getvalue()
                path = self.tile_path(index, col, row)
                _atomic_write(path, data)
                done += 1
                if progress is not None:
                    progress(
                        done,
                        total,
                        f"L{index:02d} tile c{col} r{row} ({done}/{total})",
                    )
            level_arrays.pop(index, None)
            self._finalize_level(index, geom, progress, should_cancel)
            written.append(index)

        return written

    def _check_cancel(
        self,
        should_cancel: CancelCheck | None,
        done: int,
        total: int,
        index: int,
    ) -> None:
        if should_cancel is not None and should_cancel():
            raise CancelledError(
                f"generation cancelled at level {index} ({done}/{total} tiles)"
            )

    def _finalize_level(
        self,
        index: int,
        geom: LevelGeometry,
        progress: ProgressCallback | None,
        should_cancel: CancelCheck | None,
    ) -> None:
        """Write level.json (last) listing every tile with core/full rects."""
        self._check_cancel(should_cancel, 0, 0, index)
        entries = []
        for tile in geom.iter_tiles():
            path = self.tile_path(index, tile.col, tile.row)
            try:
                data = path.read_bytes()
            except OSError as exc:
                raise CacheError(
                    f"tile {path} disappeared while finalizing L{index:02d}"
                ) from exc
            entries.append(
                {
                    "col": tile.col,
                    "row": tile.row,
                    "core": [tile.core.x, tile.core.y, tile.core.w, tile.core.h],
                    "full": [tile.full.x, tile.full.y, tile.full.w, tile.full.h],
                    "bytes": len(data),
                    "sha256": _sha256_bytes(data),
                }
            )
        _atomic_write_json(
            self.level_manifest_path(index),
            {
                "format": CACHE_FORMAT_VERSION,
                "algorithm": PYRAMID_ALGORITHM,
                "source_sha256": self.source.sha256,
                "config": self.config.to_dict(),
                "level": index,
                "width": geom.width,
                "height": geom.height,
                "tile_size": geom.tile_size,
                "margin": geom.margin,
                "complete": True,
                "tiles": entries,
            },
        )
        self._invalidate_level_manifest(index)
        if progress is not None:
            progress(0, 0, f"L{index:02d} finalized")

    # ------------------------------------------------------------------
    # reading
    # ------------------------------------------------------------------
    def require_complete(self, index: int) -> None:
        status = self.level_status(index)
        if status.state is not LevelState.COMPLETE:
            raise CacheError(f"level {index} is not complete: {status.describe()}")

    def read_tile_bytes(self, index: int, col: int, row: int) -> bytes:
        geom = self.geometry(index)
        if not (0 <= col < geom.cols and 0 <= row < geom.rows):
            raise IndexError(f"tile ({col}, {row}) outside level {index}")
        path = self.tile_path(index, col, row)
        try:
            return path.read_bytes()
        except OSError as exc:
            raise CacheError(f"cannot read tile {path}: {exc}") from exc

    def read_tile_array(self, index: int, col: int, row: int) -> np.ndarray:
        data = self.read_tile_bytes(index, col, row)
        with Image.open(io.BytesIO(data)) as image:
            array = np.array(image.convert("RGB"), dtype=np.uint8, copy=True)
        geom = self.geometry(index)
        full = geom.full_rect(col, row)
        if array.shape[:2] != (full.h, full.w):
            raise CacheError(
                f"tile ({col}, {row}) of level {index} has size "
                f"{array.shape[1]}x{array.shape[0]}, expected {full.w}x{full.h}"
            )
        return array

    def read_tile_core(
        self, index: int, col: int, row: int
    ) -> tuple[Rect, np.ndarray]:
        """Read one tile and cut out its official (non-overlapping) area."""
        geom = self.geometry(index)
        tile = geom.tile(col, row)
        full_array = self.read_tile_array(index, col, row)
        dx = tile.core.x - tile.full.x
        dy = tile.core.y - tile.full.y
        core_array = full_array[
            dy : dy + tile.core.h, dx : dx + tile.core.w, :
        ].copy()
        return tile.core, core_array

    def stitch_level(self, index: int) -> np.ndarray:
        """Reassemble a level from tile cores only."""
        self.require_complete(index)
        geom = self.geometry(index)
        return stitch_tiles(
            (
                self.read_tile_core(index, tile.col, tile.row)
                for tile in geom.iter_tiles()
            ),
            geom.width,
            geom.height,
        )

    def reference_level(self, index: int) -> np.ndarray:
        return build_level_array(self.source, self.info, index)

    def compare_level(self, index: int) -> LevelComparison:
        """Compare every tile core against a freshly built level reference.

        Tiles are checked one core at a time, at the core's exact level
        position.  Since the cores cover the level exactly and never overlap
        (see :meth:`LevelGeometry.core_rect`), this is equivalent to
        stitching the level and comparing it pixel by pixel, but it needs
        memory for one tile instead of a second full level image.
        """
        self.require_complete(index)
        geom = self.geometry(index)
        reference = self.reference_level(index)
        mismatched = 0
        max_delta = 0
        compared = 0
        for tile in geom.iter_tiles():
            core_rect, patch = self.read_tile_core(index, tile.col, tile.row)
            expected = reference[
                core_rect.y : core_rect.y2, core_rect.x : core_rect.x2, :
            ]
            diff = np.abs(
                patch.astype(np.int16) - expected.astype(np.int16)
            )
            pixel_diff = diff.max(axis=2)
            mismatched += int(np.count_nonzero(pixel_diff))
            if pixel_diff.size:
                max_delta = max(max_delta, int(pixel_diff.max()))
            compared += int(pixel_diff.size)
        return LevelComparison(
            index=index,
            equal=mismatched == 0,
            mismatched_pixels=mismatched,
            max_channel_delta=max_delta,
            compared_pixels=compared,
        )

    # ------------------------------------------------------------------
    # maintenance
    # ------------------------------------------------------------------
    def clear_level(self, index: int) -> None:
        self._check_index(index)
        shutil.rmtree(self.level_directory(index), ignore_errors=True)
        self._invalidate_level_manifest(index)

    def clear_all(self) -> None:
        shutil.rmtree(self.directory, ignore_errors=True)
        self._manifests.clear()
        self._integrity_cache.clear()

    def orphan_directories(self) -> list[Path]:
        """Other content-hash directories under the cache root."""
        if not self.root.is_dir():
            return []
        return sorted(
            path
            for path in self.root.iterdir()
            if path.is_dir() and path.name != self.source.sha256
        )
