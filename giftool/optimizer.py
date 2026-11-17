"""Turn full-canvas quantized frames into storable GIF tiles.

Two storage modes are supported:

* **full frames** — every frame is written as a full-canvas image with
  disposal 1 (keep).  Simple and robust; the file is larger.
* **local optimization** — frames are cropped to bounding boxes and rely on
  GIF frame disposal to reset stale content.  Optimization changes *storage
  only*: the composited result of every display interval is identical to the
  full-frame version.

Why disposal is central
-----------------------
GIF's transparent palette index means *do not draw this pixel*: a
transparent pixel never overwrites whatever is already on the canvas.  So the
transparent index alone cannot erase the trail of a moving object.  The
spec-sanctioned eraser is **disposal 2 (restore to background)**, which after
a frame's display interval resets that frame's tile area.

The local optimizer therefore emits, for every frame:

* a bounding box covering every pixel that differs from the canvas the
  decoder will hold right before this frame (after the previous frame's
  disposal has run);
* inside the box, every pixel that must remain visible as an opaque palette
  index, and every pixel that must be empty as the transparent index (which
  simply leaves the post-disposal background untouched);
* disposal 2 for transparent documents (background = transparent, matching
  the browser convention) and disposal 1 for opaque documents, where every
  pixel is an opaque color so nothing ever needs erasing.

Consecutive frames whose full-canvas index images are identical are merged
up-front into one stored frame whose duration is the sum of the merged
durations.  Total display time and loop behavior are unchanged.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .quantize import QuantizedFrame


@dataclass
class StorageFrame:
    """One frame as it will be embedded in the GIF stream."""

    left: int
    top: int
    width: int
    height: int
    indices: np.ndarray  # cropped tile, uint8
    palette: np.ndarray
    transparent_index: int | None
    disposal: int
    duration_ms: int
    # Display intervals (in input-frame units) represented by this stored
    # frame; always length 1 except for merged identical frames.
    source_indices: list[int]


def merge_identical(
    frames: list[QuantizedFrame], durations_ms: list[int]
) -> tuple[list[QuantizedFrame], list[int], list[list[int]]]:
    """Merge consecutive frames with identical index images.

    Returns merged quantized frames, merged durations and the source-index
    groups each merged frame represents.
    """
    if not frames:
        return [], [], []

    merged_frames: list[QuantizedFrame] = []
    merged_durations: list[int] = []
    groups: list[list[int]] = []
    for i, frame in enumerate(frames):
        if (
            merged_frames
            and frame.transparent_index == merged_frames[-1].transparent_index
            and frame.palette.shape == merged_frames[-1].palette.shape
            and np.array_equal(frame.palette, merged_frames[-1].palette)
            and np.array_equal(frame.indices, merged_frames[-1].indices)
        ):
            merged_durations[-1] += durations_ms[i]
            groups[-1].append(i)
        else:
            merged_frames.append(frame)
            merged_durations.append(durations_ms[i])
            groups.append([i])
    return merged_frames, merged_durations, groups


def build_full_storage(
    frames: list[QuantizedFrame],
    durations_ms: list[int],
) -> list[StorageFrame]:
    """One full-canvas tile per (merged) frame.

    Transparent documents use disposal 2: each frame resets the whole canvas
    to transparent after display, so pixels that disappear are reliably
    cleared.  Opaque documents use disposal 1 (keep) since every cell is an
    opaque color and nothing can be left behind.
    """
    merged, durations, groups = merge_identical(frames, durations_ms)
    height, width = merged[0].indices.shape
    transparent = merged[0].transparent_index is not None
    return [
        StorageFrame(
            left=0,
            top=0,
            width=width,
            height=height,
            indices=frame.indices,
            palette=frame.palette,
            transparent_index=frame.transparent_index,
            disposal=2 if transparent else 1,
            duration_ms=durations[i],
            source_indices=groups[i],
        )
        for i, frame in enumerate(merged)
    ]


def build_optimized_storage(
    frames: list[QuantizedFrame],
    durations_ms: list[int],
) -> list[StorageFrame]:
    """Crop frames to changed bounding boxes, with spec-correct disposal.

    The simulation here mirrors :mod:`giftool.compositor`, including the
    post-display disposal reset, so the produced tiles composite back to
    exactly the input frames.
    """
    merged, durations, groups = merge_identical(frames, durations_ms)
    height, width = merged[0].indices.shape
    transparent = merged[0].transparent_index is not None

    # Canvas the decoder holds just before the current frame; -1 = empty.
    current = np.full((height, width), -1, dtype=np.int32)
    storage: list[StorageFrame] = []

    for i, frame in enumerate(merged):
        target = frame.indices.astype(np.int32).copy()
        if transparent:
            target[frame.alpha_mask] = -1

        changed = target != current

        if not changed.any():
            # Visually identical to the held canvas.  Identical input frames
            # were already merged upstream; emit a minimal no-op tile that
            # preserves this display interval's timing without changing any
            # pixel.  For a transparent document a 1x1 transparent tile under
            # disposal 2 just re-clears an already empty cell; for an opaque
            # document write the cell's existing opaque value so nothing moves.
            if transparent:
                tile = np.asarray([[frame.transparent_index]], dtype=np.uint8)
                noop_disposal = 2
            else:
                tile = frame.indices[:1, :1].copy()
                noop_disposal = 1
            storage.append(
                StorageFrame(
                    left=0,
                    top=0,
                    width=1,
                    height=1,
                    indices=tile,
                    palette=frame.palette,
                    transparent_index=frame.transparent_index,
                    disposal=noop_disposal,
                    duration_ms=durations[i],
                    source_indices=list(groups[i]),
                )
            )
            continue

        rows = np.where(changed.any(axis=1))[0]
        cols = np.where(changed.any(axis=0))[0]
        top, bottom = int(rows[0]), int(rows[-1]) + 1
        left, right = int(cols[0]), int(cols[-1]) + 1

        tile_indices = frame.indices[top:bottom, left:right].copy()
        tile_target = target[top:bottom, left:right]
        if transparent:
            # Empty cells carry the transparent index; the decoder leaves the
            # post-disposal transparent background in place there.
            tile_indices[tile_target == -1] = frame.transparent_index  # type: ignore[assignment]
            disposal = 2
        else:
            # Opaque document: every target cell is an opaque color; keep the
            # canvas so the unchanged area outside the tile stays valid.
            disposal = 1

        storage.append(
            StorageFrame(
                left=left,
                top=top,
                width=right - left,
                height=bottom - top,
                indices=tile_indices,
                palette=frame.palette,
                transparent_index=frame.transparent_index,
                disposal=disposal,
                duration_ms=durations[i],
                source_indices=list(groups[i]),
            )
        )

        # Advance the simulated decoder canvas: paint the tile, then apply
        # this frame's disposal to set up the state before the next frame.
        current[top:bottom, left:right] = tile_target
        if transparent and disposal == 2:
            current[top:bottom, left:right] = -1

    return storage
