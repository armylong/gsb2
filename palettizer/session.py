"""Application state independent of Qt, so it can be unit-tested headless.

The UI is a thin shell over :class:`Session`.  Everything that affects the
output - palette, locks, dither settings, threshold, undo history - lives
here and is plain Python/numpy.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .palette import MAX_COLORS, MIN_COLORS, Palette, generate_palette
from .quantize import ALL_MODES, Quantized, Quantizer, Settings

UNDO_LIMIT = 16


@dataclass
class PaletteEdit:
    """One reversible palette change."""

    label: str
    before_colors: list[tuple[int, int, int]]
    before_locks: list[bool]
    after_colors: list[tuple[int, int, int]]
    after_locks: list[bool]


class Session:
    """Document state: source pixels, palette, settings and undo stack."""

    def __init__(self):
        self.rgba: np.ndarray | None = None
        self.source_name: str = ""
        self.palette = Palette()
        self.settings = Settings()
        self._quantizer: Quantizer | None = None
        self._undo: list[PaletteEdit] = []
        self._redo: list[PaletteEdit] = []
        self.last_result: Quantized | None = None
        self.last_report = ""
        self.generation_notes = ""
        self.dirty = False

    # -- document ------------------------------------------------------
    def load(self, rgba: np.ndarray, name: str = "") -> None:
        rgba = np.asarray(rgba, dtype=np.uint8)
        if rgba.ndim != 3 or rgba.shape[2] != 4:
            raise ValueError("rgba must be (H, W, 4)")
        self.rgba = np.ascontiguousarray(rgba)
        self.source_name = name
        self._quantizer = Quantizer(self.rgba)
        self._undo.clear()
        self._redo.clear()
        self.dirty = True

    @property
    def loaded(self) -> bool:
        return self.rgba is not None

    @property
    def size(self) -> tuple[int, int]:
        if self.rgba is None:
            return (0, 0)
        return (self.rgba.shape[1], self.rgba.shape[0])

    def alpha_array(self) -> np.ndarray:
        assert self.rgba is not None
        return self.rgba[..., 3]

    # -- settings ------------------------------------------------------
    def set_settings(self, mode: str | None = None, strength: float | None = None,
                     alpha_threshold: int | None = None) -> bool:
        new = Settings(
            mode=self.settings.mode if mode is None else mode,
            strength=self.settings.strength if strength is None else float(strength),
            alpha_threshold=self.settings.alpha_threshold if alpha_threshold is None else int(alpha_threshold),
        )
        if new != self.settings:
            self.settings = new
            self.dirty = True
            return True
        return False

    def set_mode(self, mode: str) -> None:
        if mode not in ALL_MODES:
            raise ValueError(mode)
        self.set_settings(mode=mode)

    # -- palette / undo -------------------------------------------------
    def _push_edit(self, label: str, before: tuple[list, list]) -> None:
        after = self.palette.snapshot()
        if before == after:
            return
        self._undo.append(PaletteEdit(label, before[0], before[1], after[0], after[1]))
        if len(self._undo) > UNDO_LIMIT:
            self._undo.pop(0)
        self._redo.clear()
        self.dirty = True

    @property
    def undo_depth(self) -> int:
        return len(self._undo)

    def undo(self) -> str | None:
        if not self._undo:
            return None
        edit = self._undo.pop()
        self.palette = Palette(edit.before_colors, edit.before_locks)
        self._redo.append(edit)
        self.dirty = True
        return edit.label

    def redo(self) -> str | None:
        if not self._redo:
            return None
        edit = self._redo.pop()
        self.palette = Palette(edit.after_colors, edit.after_locks)
        self._undo.append(edit)
        self.dirty = True
        return edit.label

    def generate(self, target: int, record_undo: bool = True) -> str:
        if self.rgba is None:
            raise RuntimeError("尚未载入图像")
        if not (MIN_COLORS <= target <= MAX_COLORS):
            raise ValueError(f"目标色数必须在 {MIN_COLORS}..{MAX_COLORS}")
        before = self.palette.snapshot()
        opaque = self.opaque_mask()
        palette, report = generate_palette(self.rgba, opaque, target, self.palette)
        self.palette = palette
        self.generation_notes = report.summary
        if record_undo:
            self._push_edit(f"自动生成 {target} 色", before)
        else:
            self.dirty = True
        return report.summary

    def set_color(self, index: int, rgb, force: bool = False) -> tuple[bool, int]:
        """Change one colour.  Returns (changed, merged_duplicates).

        A colour edit can make an entry identical to another one; that is
        merged immediately and the count is returned so the UI can explain
        why the visible colour count dropped.
        """
        before = self.palette.snapshot()
        changed = self.palette.set_color(index, rgb, force=force)
        merged = 0
        if changed:
            merged = self.palette.dedupe()
            self._push_edit(f"改色 #{index}", before)
        return changed, merged

    def set_locked(self, index: int, locked: bool) -> None:
        before = self.palette.snapshot()
        self.palette.set_locked(index, locked)
        self._push_edit(f"{'锁定' if locked else '解锁'} #{index}", before)

    def set_palette(self, palette: Palette, label: str) -> None:
        """Replace the palette wholesale as one undoable edit."""
        before = self.palette.snapshot()
        self.palette = palette
        self._push_edit(label, before)

    def clear_history(self) -> None:
        """Start a fresh undo history (used when a new document is loaded)."""
        self._undo.clear()
        self._redo.clear()

    def delete_color(self, index: int) -> bool:
        before = self.palette.snapshot()
        deleted = self.palette.delete(index)
        if deleted:
            self._push_edit(f"删除 #{index}", before)
        return deleted

    def add_color(self, rgb) -> tuple[int, bool]:
        before = self.palette.snapshot()
        idx, added = self.palette.add(rgb)
        if added:
            self._push_edit(f"新增 #{idx}", before)
        return idx, added

    # -- alpha ----------------------------------------------------------
    def opaque_mask(self) -> np.ndarray:
        if self.rgba is None:
            raise RuntimeError("尚未载入图像")
        a = self.rgba[..., 3]
        return (a >= self.settings.alpha_threshold) & (a > 0)

    # -- results --------------------------------------------------------
    def compute(self) -> Quantized:
        if self.rgba is None or self._quantizer is None:
            raise RuntimeError("尚未载入图像")
        self.last_result = self._quantizer.result(self.palette, self.settings)
        return self.last_result

    def result_for(self, mode: str, palette: Palette | None = None,
                   settings: Settings | None = None) -> Quantized:
        """Quantise with the given mode/palette without mutating session state.

        The comparison panes call this so that computing all three dither
        modes never changes the document's own settings or palette.
        """
        if self.rgba is None or self._quantizer is None:
            raise RuntimeError("尚未载入图像")
        base = settings or self.settings
        used = Settings(
            mode=mode, strength=base.strength, alpha_threshold=base.alpha_threshold
        )
        # Note: an empty Palette is falsy (it defines __len__), so compare
        # against None explicitly rather than using `or`.
        target = self.palette if palette is None else palette
        return self._quantizer.result(target, used)

    def can_delete(self, index: int) -> bool:
        if not 0 <= index < len(self.palette):
            return False
        return not self.palette.locked[index]
