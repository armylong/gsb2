"""Palette model: locked colours, dedupe, generation and editing.

Invariants enforced here:

* At most :data:`MAX_COLORS` visible colours (8-bit palette indices).
* A locked colour is never changed by automatic generation.
* Duplicate colours are merged; the merge is reported so the UI can explain
  why the visible colour count is lower than the requested count.
* An image with no opaque pixel yields a valid (possibly empty) palette.
* Transparency is not a palette member: the renderer appends one dedicated
  transparent index after the visible colours.  That index is never counted
  against the 4..32 visible-colour budget, and a palette of 32 colours plus
  the transparent slot still fits in an 8-bit index.
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .color import srgb_to_linear

MIN_COLORS = 4
MAX_COLORS = 32

RGB = tuple[int, int, int]


def clamp_u8(value: int) -> int:
    return max(0, min(255, int(round(value))))


def normalize_rgb(rgb) -> RGB:
    return (clamp_u8(rgb[0]), clamp_u8(rgb[1]), clamp_u8(rgb[2]))


@dataclass
class GenerationReport:
    requested: int
    produced: int
    locked: int
    merged: int = 0
    notes: list[str] = field(default_factory=list)

    @property
    def summary(self) -> str:
        bits = [f"请求 {self.requested} 色，锁定 {self.locked} 色"]
        if self.merged:
            bits.append(f"合并重复 {self.merged} 色")
        bits.append(f"实际可见 {self.produced} 色")
        return "；".join(bits) + ("（" + "；".join(self.notes) + "）" if self.notes else "")


def merge_duplicates(colors, locked_flags=None) -> tuple[list[RGB], list[bool], int]:
    """Return (colors, locks, merged_count) with duplicates collapsed.

    The first occurrence of a colour wins, so a locked colour placed early is
    the one kept.  Locks are OR-ed for merged slots: a duplicate of a locked
    colour stays locked, which keeps the lock invariant conservative.
    """
    colors = [normalize_rgb(c) for c in colors]
    if locked_flags is None:
        locked_flags = [False] * len(colors)
    out_colors: list[RGB] = []
    out_locks: list[bool] = []
    seen: dict[RGB, int] = {}
    merged = 0
    for color, lock in zip(colors, locked_flags):
        if color in seen:
            i = seen[color]
            out_locks[i] = out_locks[i] or bool(lock)
            merged += 1
            continue
        seen[color] = len(out_colors)
        out_colors.append(color)
        out_locks.append(bool(lock))
    return out_colors, out_locks, merged


class Palette:
    """Ordered list of visible colours plus their lock flags.

    The transparent index is not stored here; the renderer appends it.  That
    keeps the palette a pure "visible colours" list whose length is what the
    UI reports as the visible colour count.
    """

    def __init__(self, colors=(), locked=None, capacity: int = MAX_COLORS):
        if capacity < MIN_COLORS or capacity > MAX_COLORS:
            raise ValueError(f"capacity must be in {MIN_COLORS}..{MAX_COLORS}")
        self.capacity = capacity
        if locked is None:
            locked = [False] * len(colors)
        colors, locked, self.last_merge_count = merge_duplicates(colors, locked)
        if len(colors) > MAX_COLORS:
            raise ValueError(f"palette cannot hold more than {MAX_COLORS} visible colours")
        self.colors: list[RGB] = colors
        self.locked: list[bool] = locked

    # -- queries -------------------------------------------------------
    def __len__(self) -> int:
        return len(self.colors)

    def __iter__(self):
        return iter(self.colors)

    def __getitem__(self, i: int) -> RGB:
        return self.colors[i]

    def copy(self) -> "Palette":
        p = Palette.__new__(Palette)
        p.capacity = self.capacity
        p.colors = list(self.colors)
        p.locked = list(self.locked)
        p.last_merge_count = 0
        return p

    def snapshot(self) -> tuple[list[RGB], list[bool]]:
        return list(self.colors), list(self.locked)

    def as_array(self) -> np.ndarray:
        if not self.colors:
            return np.zeros((0, 3), dtype=np.uint8)
        return np.array(self.colors, dtype=np.uint8)

    def contains(self, rgb) -> bool:
        return normalize_rgb(rgb) in self.colors

    def index_of(self, rgb) -> int | None:
        try:
            return self.colors.index(normalize_rgb(rgb))
        except ValueError:
            return None

    def visible_count(self) -> int:
        """Distinct visible colours actually present."""
        return len(self.colors)

    # -- mutations -----------------------------------------------------
    def add(self, rgb) -> tuple[int, bool]:
        """Append a colour unless present.  Returns (index, added)."""
        color = normalize_rgb(rgb)
        if color in self.colors:
            return self.colors.index(color), False
        if len(self.colors) >= self.capacity:
            raise ValueError(f"调色板已满（{self.capacity} 色）")
        self.colors.append(color)
        self.locked.append(False)
        return len(self.colors) - 1, True

    def set_color(self, index: int, rgb, force: bool = False) -> bool:
        """Change one colour.  Locked entries refuse unless force=True."""
        if not 0 <= index < len(self.colors):
            raise IndexError(index)
        if self.locked[index] and not force:
            return False
        self.colors[index] = normalize_rgb(rgb)
        return True

    def set_locked(self, index: int, locked: bool) -> None:
        if not 0 <= index < len(self.colors):
            raise IndexError(index)
        self.locked[index] = bool(locked)

    def delete(self, index: int) -> bool:
        """Delete an unlocked colour.  Locked entries are never deleted."""
        if not 0 <= index < len(self.colors):
            raise IndexError(index)
        if self.locked[index]:
            return False
        del self.colors[index]
        del self.locked[index]
        return True

    def dedupe(self) -> int:
        self.colors, self.locked, merged = merge_duplicates(self.colors, self.locked)
        self.last_merge_count = merged
        return merged


# ---------------------------------------------------------------------------
# Automatic generation
# ---------------------------------------------------------------------------

def _quantize_linear(samples: np.ndarray, k: int, rng: np.random.Generator) -> np.ndarray:
    """k-means in linear RGB on weighted samples.  Returns (k, 3) centres."""
    if k <= 0:
        return np.zeros((0, 3))
    n = samples.shape[0]
    if n == 0:
        return np.zeros((0, 3))
    k = min(k, n)

    # k-means++ seeding, deterministic given the rng.
    centres = np.empty((k, 3), dtype=np.float64)
    first = int(rng.integers(n))
    centres[0] = samples[first]
    closest = np.sum((samples - centres[0]) ** 2, axis=1)
    for i in range(1, k):
        total = float(closest.sum())
        if total <= 0.0:
            centres[i] = samples[int(rng.integers(n))]
        else:
            probs = closest / total
            centres[i] = samples[int(rng.choice(n, p=probs))]
        d = np.sum((samples - centres[i]) ** 2, axis=1)
        closest = np.minimum(closest, d)

    # Lloyd iterations.
    for _ in range(32):
        d = ((samples[:, None, :] - centres[None, :, :]) ** 2).sum(axis=2)
        assign = np.argmin(d, axis=1)
        new_centres = centres.copy()
        moved = 0.0
        for j in range(k):
            members = samples[assign == j]
            if members.shape[0]:
                new_centres[j] = members.mean(axis=0)
        moved = float(np.abs(new_centres - centres).max())
        centres = new_centres
        if moved < 1e-6:
            break
    return centres


def _linear_to_u8(lin: np.ndarray) -> np.ndarray:
    from .color import linear_to_srgb

    return np.clip(np.round(linear_to_srgb(lin) * 255.0), 0, 255).astype(np.uint8)


def generate_palette(
    rgba: np.ndarray,
    opaque_mask: np.ndarray,
    target: int,
    locked: Palette | None = None,
    seed: int = 13759,
) -> tuple[Palette, GenerationReport]:
    """Generate up to `target` visible colours from the opaque pixels.

    `rgba` is (H, W, 4) uint8 as loaded from the file: composite RGB of a
    fully transparent pixel is ignored entirely, because we only read
    `opaque_mask`.  Locked colours are seeded first and never moved.
    """
    if not (MIN_COLORS <= target <= MAX_COLORS):
        raise ValueError(f"target must be in {MIN_COLORS}..{MAX_COLORS}")
    if rgba.ndim != 3 or rgba.shape[2] != 4:
        raise ValueError("rgba must be (H, W, 4)")
    if opaque_mask.shape != rgba.shape[:2]:
        raise ValueError("opaque_mask must match image height/width")

    # Palette defines __len__, so an empty palette is falsy; use explicit
    # None checks so an empty previous palette is still handled correctly.
    lock_colors = (
        [c for c, l in zip(locked.colors, locked.locked) if l] if locked is not None else []
    )
    lock_flags = [True] * len(lock_colors)
    notes: list[str] = []
    dropped = (len(locked.colors) - len(lock_colors)) if locked is not None else 0
    if dropped:
        notes.append(f"重新生成时替换 {dropped} 个未锁定颜色")
    if len(lock_colors) > target:
        # Locked colours are kept in full; the target only bounds the
        # automatic portion.  Report rather than silently drop locks.
        notes.append(f"锁定色 {len(lock_colors)} 个已超过目标 {target}，保持锁定不删除")

    pixels = rgba[opaque_mask][:, :3]
    if pixels.shape[0] == 0:
        pal = Palette(lock_colors, lock_flags)
        report = GenerationReport(target, len(pal), len(lock_colors), 0, notes + ["图像没有不透明像素，调色板保持有效但可为空"])
        return pal, report

    # Unique colours keep k-means fast and make the "fits entirely" case exact.
    uniq, counts = np.unique(pixels, axis=0, return_counts=True)
    lin = srgb_to_linear(uniq.astype(np.float64) / 255.0)
    weights = counts.astype(np.float64)
    weights /= weights.sum()

    remaining = max(0, target - len(lock_colors))
    if remaining == 0:
        colors = lock_colors
        merged = 0
    else:
        if uniq.shape[0] <= remaining:
            # Every distinct source colour fits: use them all exactly.
            auto = [normalize_rgb(tuple(int(v) for v in c)) for c in uniq]
            if len(auto) < MIN_COLORS:
                notes.append(f"源图仅有 {len(auto)} 种不透明颜色，不足 {MIN_COLORS} 色属正常")
            merged = 0
        else:
            rng = np.random.default_rng(seed)
            # Weighted sampling of the linear colours: repeat rare colours
            # less.  Clamp the sample count so 256x256 stays instant.
            caps = np.maximum(1, np.round(weights * 20000).astype(np.int64))
            samples = np.repeat(lin, caps, axis=0)
            centres = _quantize_linear(samples, remaining, rng)
            auto = [normalize_rgb(tuple(int(v) for v in c)) for c in _linear_to_u8(centres)]
            merged = 0
        colors = lock_colors + auto

    colors, flags, merged = merge_duplicates(colors, lock_flags + [False] * (len(colors) - len(lock_flags)))
    if merged:
        notes.append(f"自动色与已有色重复，合并 {merged} 个后实际可见 {len(colors)} 色")
    pal = Palette(colors, flags)
    report = GenerationReport(target, len(pal), len(lock_colors), merged, notes)
    return pal, report
