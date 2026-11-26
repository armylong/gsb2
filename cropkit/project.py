"""Project model, persistence and mismatch reconciliation.

A project stores everything needed to restore a selection: the source file
identity (path, pixel size, EXIF orientation, content hash), every rectangle
in upright display coordinates, every locator point, and the aspect-ratio
setting.

Coordinates are always saved in *display* space, alongside the display size
and the orientation that produced that space.  On reopen the saved triple
(size, orientation, hash) is compared with the file that is actually there;
any disagreement is surfaced before the selection is trusted.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import List, Optional, Tuple

from cropkit.orientation import Orientation
from cropkit.rectmath import Rect

SCHEMA_VERSION = 2
PROJECT_SUFFIXES = (".json", ".cropkit.json")


# ---------------------------------------------------------------------------
# small value objects
# ---------------------------------------------------------------------------
@dataclass
class SourceInfo:
    path: str
    stored_size: Tuple[int, int]
    orientation: int
    sha256: str = ""

    @property
    def display_size(self) -> Tuple[int, int]:
        return Orientation(self.orientation).display_size(self.stored_size)

    def to_dict(self) -> dict:
        return {
            "path": self.path,
            "stored_width": self.stored_size[0],
            "stored_height": self.stored_size[1],
            "orientation": int(self.orientation),
            "sha256": self.sha256,
        }

    @classmethod
    def from_dict(cls, d) -> "SourceInfo":
        return cls(
            path=str(d.get("path", "")),
            stored_size=(int(d.get("stored_width", 0)),
                         int(d.get("stored_height", 0))),
            orientation=int(d.get("orientation", 1)),
            sha256=str(d.get("sha256", "")),
        )


@dataclass
class CropItem:
    name: str
    rect: Rect
    enabled: bool = True
    ident: str = field(default_factory=lambda: uuid.uuid4().hex[:8])

    def to_dict(self) -> dict:
        d = {"name": self.name, "enabled": self.enabled,
             "id": self.ident, **self.rect.to_dict()}
        return d

    @classmethod
    def from_dict(cls, d) -> "CropItem":
        return cls(
            name=str(d.get("name", "选区")),
            rect=Rect.from_dict(d),
            enabled=bool(d.get("enabled", True)),
            ident=str(d.get("id") or uuid.uuid4().hex[:8]),
        )


@dataclass
class Marker:
    name: str
    x: int
    y: int
    ident: str = field(default_factory=lambda: uuid.uuid4().hex[:8])

    @property
    def point(self) -> Tuple[int, int]:
        return self.x, self.y

    def to_dict(self) -> dict:
        return {"name": self.name, "x": self.x, "y": self.y, "id": self.ident}

    @classmethod
    def from_dict(cls, d) -> "Marker":
        return cls(
            name=str(d.get("name", "定点")),
            x=int(round(d.get("x", 0))),
            y=int(round(d.get("y", 0))),
            ident=str(d.get("id") or uuid.uuid4().hex[:8]),
        )


@dataclass
class Project:
    source: SourceInfo
    crops: List[CropItem] = field(default_factory=list)
    markers: List[Marker] = field(default_factory=list)
    ratio: Optional[str] = None
    path: Optional[str] = None
    dirty: bool = False

    # -- serialisation ----------------------------------------------------
    def to_dict(self) -> dict:
        return {
            "format": "cropkit-project",
            "version": SCHEMA_VERSION,
            "source": self.source.to_dict(),
            "ratio": self.ratio,
            "crops": [c.to_dict() for c in self.crops],
            "markers": [m.to_dict() for m in self.markers],
        }

    @classmethod
    def from_dict(cls, d) -> "Project":
        if d.get("format") != "cropkit-project" and "source" not in d:
            raise ValueError("不是本工具的选区文件")
        version = int(d.get("version", 1))
        if version > SCHEMA_VERSION:
            raise ValueError(
                f"选区文件版本 {version} 高于本工具支持的 {SCHEMA_VERSION}")
        return cls(
            source=SourceInfo.from_dict(d.get("source", {})),
            crops=[CropItem.from_dict(c) for c in d.get("crops", [])],
            markers=[Marker.from_dict(m) for m in d.get("markers", [])],
            ratio=d.get("ratio"),
        )

    def save(self, path: str) -> None:
        payload = json.dumps(self.to_dict(), ensure_ascii=False, indent=2)
        directory = os.path.dirname(os.path.abspath(path)) or "."
        fd, tmp = tempfile.mkstemp(prefix=".cropkit-", suffix=".json",
                                   dir=directory)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(payload)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp, path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        self.path = path
        self.dirty = False

    @classmethod
    def load(cls, path: str) -> "Project":
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        project = cls.from_dict(data)
        project.path = path
        project.dirty = False
        return project


# ---------------------------------------------------------------------------
# source inspection
# ---------------------------------------------------------------------------
def file_sha256(path: str, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            block = fh.read(chunk)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


_HASH_CACHE: dict = {}


def _cached_hash(path: str) -> str:
    """Hash a file, reusing the result until its size or mtime changes."""
    stat = os.stat(path)
    key = (os.path.abspath(path), stat.st_size, stat.st_mtime_ns)
    hit = _HASH_CACHE.get(key)
    if hit is None:
        hit = file_sha256(path)
        # keep the cache small; stale keys for the same path are dropped
        for old in [k for k in _HASH_CACHE if k[0] == key[0]]:
            del _HASH_CACHE[old]
        _HASH_CACHE[key] = hit
    return hit


def read_source_info(path: str, with_hash: bool = True) -> SourceInfo:
    """Read size and orientation without decoding the whole image."""
    from PIL import Image

    with Image.open(path) as img:
        stored = (img.width, img.height)
        try:
            orientation = Orientation(img.getexif().get(0x0112, 1)).value
        except Exception:
            orientation = 1
    return SourceInfo(
        path=str(Path(path)),
        stored_size=stored,
        orientation=orientation,
        sha256=_cached_hash(path) if with_hash else "",
    )


# ---------------------------------------------------------------------------
# mismatch handling
# ---------------------------------------------------------------------------
@dataclass
class Difference:
    field: str
    label: str
    saved: str
    current: str

    @property
    def is_blocking(self) -> bool:
        # A relocated project/source is not itself a reason to doubt the
        # selection; a changed hash, size or orientation is.
        return self.field in ("hash", "stored_size", "orientation")


@dataclass
class Reconciliation:
    differences: List[Difference]
    adapted_rects: List[Rect]
    adapted_markers: List[Tuple[int, int]]

    @property
    def needs_confirmation(self) -> bool:
        return any(d.is_blocking for d in self.differences)


def compare_sources(saved: SourceInfo, actual: SourceInfo) -> List[Difference]:
    diffs: List[Difference] = []
    if os.path.normcase(os.path.abspath(saved.path)) != os.path.normcase(
            os.path.abspath(actual.path)):
        diffs.append(Difference("path", "原图路径",
                                saved.path, actual.path))
    if saved.stored_size != actual.stored_size:
        diffs.append(Difference(
            "stored_size", "照片像素尺寸",
            f"{saved.stored_size[0]} × {saved.stored_size[1]}",
            f"{actual.stored_size[0]} × {actual.stored_size[1]}"))
    if Orientation(saved.orientation).value != Orientation(
            actual.orientation).value:
        diffs.append(Difference(
            "orientation", "方向标记",
            Orientation(saved.orientation).label,
            Orientation(actual.orientation).label))
    if saved.sha256 and actual.sha256 and saved.sha256 != actual.sha256:
        diffs.append(Difference("hash", "文件内容 (SHA-256)",
                                saved.sha256[:12] + "…",
                                actual.sha256[:12] + "…"))
    return diffs


def _clamp_point(point, size):
    x = min(max(int(round(point[0])), 0), max(size[0] - 1, 0))
    y = min(max(int(round(point[1])), 0), max(size[1] - 1, 0))
    return x, y


def _remap_point(point, saved: SourceInfo, actual: SourceInfo):
    """Carry a display point across a source change.

    Three policies, most trustworthy first:

    1. Same file bytes -> the same stored pixels.  Map through stored space,
       which also handles a changed EXIF orientation with an untouched image.
    2. Display size unchanged -> keep the coordinate (content replaced but
       the upright frame is identical).
    3. Display size changed -> scale by relative position in the upright
       image.
    """
    old_o = Orientation(saved.orientation)
    new_o = Orientation(actual.orientation)
    old_size = saved.display_size
    new_size = actual.display_size
    if saved.sha256 and saved.sha256 == actual.sha256 and \
            saved.stored_size == actual.stored_size:
        stored = old_o.to_stored_mapping(point, old_size)
        return new_o.from_stored_mapping(stored, new_size)
    if old_size == new_size:
        return _clamp_point(point, new_size)
    fx = (point[0] + 0.5) / old_size[0] if old_size[0] else 0.0
    fy = (point[1] + 0.5) / old_size[1] if old_size[1] else 0.0
    return (fx * new_size[0] - 0.5, fy * new_size[1] - 0.5)


def _remap_rect(rect: Rect, saved: SourceInfo, actual: SourceInfo) -> Rect:
    old_o = Orientation(saved.orientation)
    new_o = Orientation(actual.orientation)
    old_size = saved.display_size
    new_size = actual.display_size
    if saved.sha256 and saved.sha256 == actual.sha256 and \
            saved.stored_size == actual.stored_size:
        stored = old_o.display_rect_to_stored(rect, old_size)
        return new_o.stored_rect_to_display(stored, new_size).clamped_to(
            *new_size)
    if old_size == new_size:
        return rect.clamped_to(*new_size)
    # Scale the continuous edges of the rectangle (not its pixel centres),
    # so a rect hugging the border keeps hugging the border.
    sx = new_size[0] / old_size[0] if old_size[0] else 1.0
    sy = new_size[1] / old_size[1] if old_size[1] else 1.0
    x0 = round(rect.x0 * sx)
    y0 = round(rect.y0 * sy)
    x1 = round(rect.x1 * sx)
    y1 = round(rect.y1 * sy)
    x1 = max(x1, x0 + 1)
    y1 = max(y1, y0 + 1)
    return Rect(x0, y0, x1, y1).clamped_to(*new_size)


def adapt_project(project: Project, actual: SourceInfo,
                  mode: str = "scale") -> Reconciliation:
    """Build the selection in the new source's display space.

    ``mode="keep"`` keeps raw coordinates (clamped to the new image);
    ``mode="scale"`` carries every point through stored space so both a
    resize and an orientation change behave predictably.
    """
    differences = compare_sources(project.source, actual)
    rects: List[Rect] = []
    markers: List[Tuple[int, int]] = []
    if mode == "keep":
        for c in project.crops:
            rects.append(c.rect.clamped_to(*actual.display_size))
        for m in project.markers:
            x = min(max(m.x, 0), actual.display_size[0] - 1)
            y = min(max(m.y, 0), actual.display_size[1] - 1)
            markers.append((x, y))
    else:
        for c in project.crops:
            rects.append(_remap_rect(c.rect, project.source, actual))
        for m in project.markers:
            px, py = _remap_point((m.x, m.y), project.source, actual)
            markers.append((int(round(px)), int(round(py))))
    return Reconciliation(differences, rects, markers)


def apply_reconciliation(project: Project, actual: SourceInfo,
                         reconciliation: Reconciliation) -> None:
    project.source = actual
    for crop, rect in zip(project.crops, reconciliation.adapted_rects):
        crop.rect = rect
    for marker, (x, y) in zip(project.markers,
                              reconciliation.adapted_markers):
        marker.x, marker.y = x, y
    project.dirty = True
