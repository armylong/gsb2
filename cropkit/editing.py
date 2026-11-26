"""Editing state, independent of Qt.

The UI is a thin shell over this class: every operation (create, move,
widen, translate, tighten, marker handling) lives here so it can be unit
tested without a display server.  Coordinates are always integer upright
(display) pixels.
"""

from __future__ import annotations

import copy
from typing import List, Optional, Tuple

from cropkit.orientation import Orientation
from cropkit.project import CropItem, Marker, Project, SourceInfo
from cropkit.rectmath import Rect, parse_ratio, resize_handle, tighten


class Editor:
    def __init__(self, source: SourceInfo, crops=None, markers=None,
                 ratio: Optional[str] = None):
        self.source = source
        self.orientation = Orientation(source.orientation)
        self.size: Tuple[int, int] = source.display_size
        self.crops: List[CropItem] = list(crops or [])
        self.markers: List[Marker] = list(markers or [])
        self.ratio = ratio
        self.active_crop: Optional[int] = None
        self.active_marker: Optional[int] = None
        self._undo: List[dict] = []
        self._redo: List[dict] = []
        self._pending: Optional[dict] = None
        self.on_change = None  # callable set by the window

    # ------------------------------------------------------------------
    # change notification / undo
    # ------------------------------------------------------------------
    def _notify(self) -> None:
        if self.on_change:
            self.on_change()

    def snapshot(self) -> dict:
        return {
            "source": self.source.to_dict(),
            "crops": [c.to_dict() for c in self.crops],
            "markers": [m.to_dict() for m in self.markers],
            "ratio": self.ratio,
            "active_crop": self.active_crop,
            "active_marker": self.active_marker,
        }

    def _restore(self, data: dict) -> None:
        from cropkit.project import SourceInfo

        self.source = SourceInfo.from_dict(data["source"])
        self.orientation = Orientation(self.source.orientation)
        self.size = self.source.display_size
        self.crops = [CropItem.from_dict(c) for c in data["crops"]]
        self.markers = [Marker.from_dict(m) for m in data["markers"]]
        self.ratio = data["ratio"]
        self.active_crop = data["active_crop"]
        self.active_marker = data["active_marker"]
        self._notify()

    def begin_interaction(self) -> None:
        """Capture state before a drag so the whole drag is one undo step."""
        if self._pending is None:
            self._pending = self.snapshot()

    def end_interaction(self) -> None:
        if self._pending is None:
            return
        before = self._pending
        self._pending = None
        if before != self.snapshot():
            self._undo.append(before)
            self._redo.clear()
        self._notify()

    def _push(self) -> None:
        self._undo.append(self.snapshot())
        self._redo.clear()

    def _changed(self) -> None:
        self._notify()

    @property
    def can_undo(self) -> bool:
        return bool(self._undo)

    @property
    def can_redo(self) -> bool:
        return bool(self._redo)

    def undo(self) -> None:
        if not self._undo:
            return
        self._redo.append(self.snapshot())
        self._restore(self._undo.pop())

    def redo(self) -> None:
        if not self._redo:
            return
        self._undo.append(self.snapshot())
        self._restore(self._redo.pop())

    # ------------------------------------------------------------------
    # coordinate helpers
    # ------------------------------------------------------------------
    def display_to_stored(self, x: float, y: float) -> Tuple[float, float]:
        return self.orientation.to_stored_mapping((x, y), self.size)

    def stored_to_display(self, x: float, y: float) -> Tuple[float, float]:
        return self.orientation.from_stored_mapping((x, y), self.size)

    def corner_sources(self) -> dict:
        return self.orientation.corner_sources()

    def display_rect_to_stored(self, rect: Rect) -> Rect:
        return self.orientation.display_rect_to_stored(rect, self.size)

    def stored_rect_to_display(self, rect: Rect) -> Rect:
        return self.orientation.stored_rect_to_display(rect, self.size)

    # ------------------------------------------------------------------
    # crops
    # ------------------------------------------------------------------
    def _unique_crop_name(self) -> str:
        used = {c.name for c in self.crops}
        i = 1
        while f"裁片 {i}" in used:
            i += 1
        return f"裁片 {i}"

    def _unique_marker_name(self) -> str:
        used = {m.name for m in self.markers}
        i = 1
        while f"定点 {i}" in used:
            i += 1
        return f"定点 {i}"

    def add_crop(self, rect: Rect, name: Optional[str] = None,
                 select: bool = True) -> Optional[int]:
        rect = rect.normalized().clamped_to(*self.size)
        if rect.width < 1 or rect.height < 1:
            return None
        self._push()
        self.crops.append(CropItem(name or self._unique_crop_name(), rect))
        index = len(self.crops) - 1
        if select:
            self.active_crop = index
        self._changed()
        return index

    def remove_crop(self, index: Optional[int] = None) -> None:
        index = self.active_crop if index is None else index
        if index is None or not (0 <= index < len(self.crops)):
            return
        self._push()
        self.crops.pop(index)
        if self.active_crop == index:
            self.active_crop = min(index, len(self.crops) - 1) \
                if self.crops else None
        elif self.active_crop is not None and self.active_crop > index:
            self.active_crop -= 1
        self._changed()

    def set_crop_rect(self, index: int, rect: Rect, record: bool = True,
                      keep_ratio: bool = False) -> None:
        if not (0 <= index < len(self.crops)):
            return
        if record:
            self._push()
        r = rect.normalized().clamped_to(*self.size)
        if keep_ratio:
            ratio = parse_ratio(self.ratio or "")
            if ratio:
                r = tighten(r, ratio)
        self.crops[index].rect = r
        self._changed()

    def resize_crop(self, index: int, handle: int, dx: float, dy: float,
                    start: Rect, keep_ratio: bool = False) -> None:
        """Drag-resize from a handle, starting from ``start`` (the rect when
        the drag began), so the drag never accumulates rounding error."""
        if not (0 <= index < len(self.crops)):
            return
        ratio = parse_ratio(self.ratio or "") if keep_ratio else None
        new = resize_handle(start, handle, dx, dy, ratio, self.size)
        self.crops[index].rect = new.normalized().clamped_to(*self.size)
        self._changed()

    def move_crop_to(self, index: int, start: Rect, dx: float, dy: float,
                     keep_ratio: bool = False) -> None:
        if not (0 <= index < len(self.crops)):
            return
        moved = start.translated(int(round(dx)), int(round(dy)))
        self.crops[index].rect = moved.clamped_to(*self.size)
        self._changed()

    def set_crop_name(self, index: int, name: str) -> None:
        if 0 <= index < len(self.crops) and name.strip():
            self._push()
            self.crops[index].name = name.strip()
            self._changed()

    def set_crop_enabled(self, index: int, enabled: bool) -> None:
        if 0 <= index < len(self.crops):
            self._push()
            self.crops[index].enabled = bool(enabled)
            self._changed()

    def targets(self, only_active: bool) -> List[int]:
        if only_active:
            return [] if self.active_crop is None else [self.active_crop]
        return list(range(len(self.crops)))

    def widen(self, amount: int, only_active: bool = False,
              sides: str = "all") -> int:
        """Expand rectangles outward by ``amount`` pixels, clipped to the
        image.  Returns how many rectangles changed."""
        amount = max(0, int(amount))
        if amount == 0:
            return 0
        changed = 0
        self._push()
        for i in self.targets(only_active):
            crop = self.crops[i]
            r = crop.rect
            left = amount if sides in ("all", "x", "left") else 0
            right = amount if sides in ("all", "x", "right") else 0
            top = amount if sides in ("all", "y", "top") else 0
            bottom = amount if sides in ("all", "y", "bottom") else 0
            new = Rect(r.x0 - left, r.y0 - top, r.x1 + right, r.y1 + bottom)
            new = new.clipped_to(*self.size)
            if new != r:
                crop.rect = new
                changed += 1
        if changed:
            self._changed()
        else:
            self._undo.pop()
        return changed

    def translate(self, dx: int, dy: int, only_active: bool = False) -> int:
        if dx == 0 and dy == 0:
            return 0
        changed = 0
        self._push()
        for i in self.targets(only_active):
            crop = self.crops[i]
            new = crop.rect.translated(dx, dy).clamped_to(*self.size)
            if new != crop.rect:
                crop.rect = new
                changed += 1
        if changed:
            self._changed()
        else:
            self._undo.pop()
        return changed

    def set_ratio(self, ratio: Optional[str]) -> None:
        self.ratio = ratio
        self._changed()

    def tighten_to_ratio(self, ratio_text: Optional[str] = None,
                         only_active: bool = False,
                         mode: str = "center") -> int:
        ratio = parse_ratio(ratio_text if ratio_text is not None
                            else (self.ratio or ""))
        if not ratio:
            return 0
        changed = 0
        self._push()
        for i in self.targets(only_active):
            crop = self.crops[i]
            new = tighten(crop.rect, ratio, mode=mode)
            if new != crop.rect:
                crop.rect = new
                changed += 1
        if changed:
            self.ratio = ratio_text if ratio_text is not None else self.ratio
            self._changed()
        else:
            self._undo.pop()
        return changed

    # ------------------------------------------------------------------
    # markers
    # ------------------------------------------------------------------
    def add_marker(self, x: int, y: int, name: Optional[str] = None,
                   select: bool = True) -> Optional[int]:
        x = min(max(int(round(x)), 0), self.size[0] - 1)
        y = min(max(int(round(y)), 0), self.size[1] - 1)
        self._push()
        self.markers.append(Marker(name or self._unique_marker_name(), x, y))
        index = len(self.markers) - 1
        if select:
            self.active_marker = index
        self._changed()
        return index

    def set_marker_position(self, index: int, x: int, y: int,
                            record: bool = True) -> None:
        if not (0 <= index < len(self.markers)):
            return
        x = min(max(int(round(x)), 0), self.size[0] - 1)
        y = min(max(int(round(y)), 0), self.size[1] - 1)
        if (x, y) == (self.markers[index].x, self.markers[index].y):
            return
        if record:
            self._push()
        self.markers[index].x = x
        self.markers[index].y = y
        self._changed()

    def set_marker_name(self, index: int, name: str) -> None:
        if 0 <= index < len(self.markers) and name.strip():
            self._push()
            self.markers[index].name = name.strip()
            self._changed()

    def remove_marker(self, index: Optional[int] = None) -> None:
        index = self.active_marker if index is None else index
        if index is None or not (0 <= index < len(self.markers)):
            return
        self._push()
        self.markers.pop(index)
        if self.active_marker == index:
            self.active_marker = min(index, len(self.markers) - 1) \
                if self.markers else None
        elif self.active_marker is not None and self.active_marker > index:
            self.active_marker -= 1
        self._changed()

    def crops_containing_marker(self, marker_index: int) -> List[int]:
        if not (0 <= marker_index < len(self.markers)):
            return []
        m = self.markers[marker_index]
        return [i for i, c in enumerate(self.crops)
                if c.rect.contains(m.x, m.y)]

    # ------------------------------------------------------------------
    # hit testing
    # ------------------------------------------------------------------
    def crop_at(self, x: float, y: float) -> Optional[int]:
        # topmost first
        for i in range(len(self.crops) - 1, -1, -1):
            if self.crops[i].rect.contains(x, y):
                return i
        return None

    def marker_at(self, x: float, y: float, radius: float = 0.0
                  ) -> Optional[int]:
        best = None
        best_d = None
        for i, m in enumerate(self.markers):
            d = ((m.x - x) ** 2 + (m.y - y) ** 2) ** 0.5
            if d <= radius and (best_d is None or d < best_d):
                best, best_d = i, d
        return best

    def select_crop(self, index: Optional[int]) -> None:
        """Select a crop.  The marker selection is kept: "find this crop"
        and "find this marker" are different questions."""
        if self.active_crop == index:
            self._changed()
            return
        self.active_crop = index
        self._changed()

    def select_marker(self, index: Optional[int]) -> None:
        if self.active_marker == index:
            self._changed()
            return
        self.active_marker = index
        self._changed()

    # ------------------------------------------------------------------
    # project conversion
    # ------------------------------------------------------------------
    def to_project(self) -> Project:
        return Project(
            source=copy.deepcopy(self.source),
            crops=copy.deepcopy(self.crops),
            markers=copy.deepcopy(self.markers),
            ratio=self.ratio,
            dirty=True,
        )

    def load_project(self, project: Project) -> None:
        self.source = project.source
        self.orientation = Orientation(project.source.orientation)
        self.size = project.source.display_size
        self.crops = project.crops
        self.markers = project.markers
        self.ratio = project.ratio
        self.active_crop = 0 if self.crops else None
        self.active_marker = 0 if self.markers else None
        self._undo.clear()
        self._redo.clear()
        self._notify()
