"""Self-contained test animation generator.

No GIFs are downloaded: every fixture is synthesized here as full-canvas
RGBA frames plus hand-crafted storage tiles that exercise specific GIF
features, and each fixture ships with its independently computed expected
full-canvas frames.  All animations stay well under a few dozen frames, in
line with the tool's short-animation scope.

Scenarios covered
-----------------
* ``local_move``      — an object moves through partial tiles; old pixels
  must be erased (disposal 2 / transparent index).
* ``object_disappear`` — a shape is present then vanishes, proving stale
  pixels are cleared.
* ``transparent_bg``   — frames over a transparent background.
* ``restore_previous`` — disposal 3 (restore to previous) semantics.
* ``varied_durations`` — deliberately unequal per-frame durations, including
  a sub-20 ms frame that triggers the short-frame playback rule.
* ``identical_frames`` — consecutive identical frames that must be merged
  without changing total display time.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from giftool.gif_parser import (
    DISPOSAL_BACKGROUND,
    DISPOSAL_KEEP,
    DISPOSAL_PREVIOUS,
)
from giftool.gif_writer import encode_gif
from giftool.optimizer import StorageFrame

W = 12
H = 12

# A small fixed palette so expected frames are easy to reason about.  The four
# visible colors occupy indices 0-3; the transparent sentinel is a separate
# fifth entry so it can never alias a visible color (the same invariant the
# production quantizer enforces).
RED = (255, 0, 0)
GREEN = (0, 200, 0)
BLUE = (0, 0, 255)
YELLOW = (255, 220, 0)
TRANSPARENT = 4
SENTINEL = (1, 2, 3)


def _palette() -> np.ndarray:
    return np.array([RED, GREEN, BLUE, YELLOW, SENTINEL], dtype=np.uint8)


def _blank() -> np.ndarray:
    return np.zeros((H, W, 4), dtype=np.uint8)


def _fill_block(canvas: np.ndarray, x: int, y: int, w: int, h: int,
                color: tuple[int, int, int]) -> None:
    canvas[y : y + h, x : x + w, :3] = color
    canvas[y : y + h, x : x + w, 3] = 255


@dataclass
class Fixture:
    name: str
    gif_bytes: bytes
    expected_frames: list[np.ndarray]
    durations_ms: list[int]
    loop_count: int
    description: str


def _storage(
    left: int,
    top: int,
    indices: np.ndarray,
    palette: np.ndarray,
    disposal: int,
    duration: int,
    source: int,
    transparent: int | None = TRANSPARENT,
) -> StorageFrame:
    h, w = indices.shape
    return StorageFrame(
        left=left,
        top=top,
        width=w,
        height=h,
        indices=indices.astype(np.uint8),
        palette=palette,
        transparent_index=transparent,
        disposal=disposal,
        duration_ms=duration,
        source_indices=[source],
    )


def local_move_fixture() -> Fixture:
    """A red block steps right across partial tiles; its trail is erased."""
    palette = _palette()
    frames: list[StorageFrame] = []
    expected: list[np.ndarray] = []
    durations = [120, 120, 120, 120]
    positions = [0, 3, 6, 9]
    for i, x in enumerate(positions):
        canvas = _blank()
        _fill_block(canvas, x, 4, 2, 4, RED)
        expected.append(canvas)
        # Tile spans the moving region; vacated columns carry transparent idx.
        tile = np.full((4, 11), TRANSPARENT, dtype=np.uint8)
        tile[:, x : x + 2] = 0  # red index 0
        frames.append(_storage(0, 4, tile, palette, DISPOSAL_BACKGROUND,
                               durations[i], i))
    return Fixture(
        "local_move",
        encode_gif((W, H), frames, 0),
        expected,
        durations,
        0,
        "局部移动图块，移动后旧位置必须被擦除",
    )


def object_disappear_fixture() -> Fixture:
    """A green square is shown then disappears entirely."""
    palette = _palette()
    durations = [200, 200]
    present = _blank()
    _fill_block(present, 3, 3, 5, 5, GREEN)
    empty = _blank()
    full_present = np.full((H, W), TRANSPARENT, np.uint8)
    full_present[3:8, 3:8] = 1
    full_empty = np.full((H, W), TRANSPARENT, np.uint8)
    frames = [
        _storage(0, 0, full_present, palette, DISPOSAL_BACKGROUND, durations[0], 0),
        _storage(0, 0, full_empty, palette, DISPOSAL_KEEP, durations[1], 1),
    ]
    return Fixture(
        "object_disappear",
        encode_gif((W, H), frames, 1),
        [present, empty],
        durations,
        1,
        "物体出现后消失，旧像素不得残留",
    )


def transparent_background_fixture() -> Fixture:
    """Opaque shapes floating over a fully transparent background."""
    palette = _palette()
    durations = [150, 150]
    f0 = _blank()
    _fill_block(f0, 1, 1, 4, 4, BLUE)
    f1 = _blank()
    _fill_block(f1, 6, 6, 4, 4, YELLOW)
    idx0 = np.full((H, W), TRANSPARENT, np.uint8)
    idx0[1:5, 1:5] = 2
    idx1 = np.full((H, W), TRANSPARENT, np.uint8)
    idx1[6:10, 6:10] = 3
    frames = [
        _storage(0, 0, idx0, palette, DISPOSAL_BACKGROUND, durations[0], 0),
        _storage(0, 0, idx1, palette, DISPOSAL_BACKGROUND, durations[1], 1),
    ]
    return Fixture(
        "transparent_bg",
        encode_gif((W, H), frames, 0),
        [f0, f1],
        durations,
        0,
        "透明背景上的不透明图形",
    )


def restore_previous_fixture() -> Fixture:
    """Disposal 3: a temporary overlay is removed to reveal the prior frame."""
    palette = _palette()
    durations = [200, 100, 200]
    base = _blank()
    _fill_block(base, 0, 0, W, 3, RED)
    overlay = base.copy()
    _fill_block(overlay, 4, 5, 4, 4, GREEN)
    # Frame 0: red banner (full canvas, keep).
    idx0 = np.full((H, W), TRANSPARENT, np.uint8)
    idx0[0:3, :] = 0
    # Frame 1: green overlay tile with disposal 3.
    idx1 = np.full((4, 4), 1, np.uint8)
    # Frame 2: red banner again (full canvas).
    idx2 = idx0.copy()
    frames = [
        _storage(0, 0, idx0, palette, DISPOSAL_KEEP, durations[0], 0),
        _storage(4, 5, idx1, palette, DISPOSAL_PREVIOUS, durations[1], 1),
        _storage(0, 0, idx2, palette, DISPOSAL_KEEP, durations[2], 2),
    ]
    return Fixture(
        "restore_previous",
        encode_gif((W, H), frames, 1),
        [base, overlay, base],
        durations,
        1,
        "处置3 恢复前一画面：临时叠加层移除后还原",
    )


def varied_durations_fixture() -> Fixture:
    """Unequal durations including a sub-20 ms short frame."""
    palette = _palette()
    durations = [10, 250, 70, 400]  # first triggers the 100 ms playback rule
    expected: list[np.ndarray] = []
    frames: list[StorageFrame] = []
    for i, color in enumerate((RED, GREEN, BLUE, YELLOW)):
        canvas = _blank()
        _fill_block(canvas, i, i, 3, 3, color)
        expected.append(canvas)
        idx = np.full((H, W), TRANSPARENT, np.uint8)
        idx[i : i + 3, i : i + 3] = i
        frames.append(
            _storage(0, 0, idx, palette, DISPOSAL_BACKGROUND, durations[i], i)
        )
    return Fixture(
        "varied_durations",
        encode_gif((W, H), frames, 2),
        expected,
        durations,
        2,
        "不同帧时长，含低于20ms的短帧",
    )


def identical_frames_fixture() -> Fixture:
    """Three identical frames in a row; merging keeps total duration intact."""
    palette = _palette()
    durations = [100, 100, 100, 200]
    canvas = _blank()
    _fill_block(canvas, 2, 2, 6, 6, BLUE)
    idx = np.full((H, W), TRANSPARENT, np.uint8)
    idx[2:8, 2:8] = 2
    last = _blank()
    _fill_block(last, 2, 2, 6, 6, RED)
    idx_last = np.full((H, W), TRANSPARENT, np.uint8)
    idx_last[2:8, 2:8] = 0
    frames = [
        _storage(0, 0, idx, palette, DISPOSAL_BACKGROUND, durations[0], 0),
        _storage(0, 0, idx, palette, DISPOSAL_BACKGROUND, durations[1], 1),
        _storage(0, 0, idx, palette, DISPOSAL_BACKGROUND, durations[2], 2),
        _storage(0, 0, idx_last, palette, DISPOSAL_BACKGROUND, durations[3], 3),
    ]
    return Fixture(
        "identical_frames",
        encode_gif((W, H), frames, 0),
        [canvas, canvas, canvas, last],
        durations,
        0,
        "连续相同帧，合并后总时长保持一致",
    )


def all_fixtures() -> list[Fixture]:
    return [
        local_move_fixture(),
        object_disappear_fixture(),
        transparent_background_fixture(),
        restore_previous_fixture(),
        varied_durations_fixture(),
        identical_frames_fixture(),
    ]
