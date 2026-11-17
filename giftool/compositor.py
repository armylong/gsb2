"""Full-canvas compositor for stored GIF tiles.

The GIF storage model is a sequence of palette-index *tiles* painted onto one
logical canvas.  This module turns that sequence into the full RGBA picture
visible during each frame's display interval.

Rules implemented (GIF89a, Graphic Control Extension):

* **Disposal 0/1 — keep / unspecified:** the canvas is left untouched.
* **Disposal 2 — restore to background:** the frame's tile area is reset to
  the logical screen background.  When the document uses transparency the
  background is treated as *transparent* (the de-facto browser convention,
  matching Pillow's decoder); otherwise it is the solid background color from
  the logical screen descriptor.
* **Disposal 3 — restore to previous:** the whole canvas snapshot taken
  immediately before this frame is painted back after its display interval.

Transparent palette entries contribute *no* pixels: existing canvas content is
left intact rather than overwritten, and there is never any alpha blending
(GIF has no per-pixel alpha).  Because every composite is a deterministic
function of the frame sequence starting from an empty canvas, seeking to any
frame reproduces exactly what a from-the-start playback would show.
"""

from __future__ import annotations

import numpy as np

from .gif_parser import (
    DISPOSAL_BACKGROUND,
    DISPOSAL_PREVIOUS,
    GifDocument,
    RawFrame,
)


class Compositor:
    """Incrementally composites a parsed :class:`GifDocument`."""

    def __init__(self, doc: GifDocument) -> None:
        self.doc = doc
        self._transparent_bg = doc.uses_transparency
        if self._transparent_bg:
            self._canvas = np.zeros((doc.height, doc.width, 4), dtype=np.uint8)
        else:
            rgb = doc.background_rgb
            self._canvas = np.empty((doc.height, doc.width, 4), dtype=np.uint8)
            self._canvas[..., :3] = np.asarray(rgb, dtype=np.uint8)
            self._canvas[..., 3] = 255
        self._next_frame = 0

    @property
    def canvas(self) -> np.ndarray:
        """Current canvas state (a copy-safe view; treat as read-only)."""
        return self._canvas

    def reset(self) -> None:
        self.__init__(self.doc)  # type: ignore[misc]

    def _paint(self, frame: RawFrame) -> None:
        x0, y0, x1, y1 = frame.bbox
        tile = frame.tile_rgba()  # (h, w, 4), alpha 0 at the transparent index
        opaque = tile[..., 3] != 0
        region = self._canvas[y0:y1, x0:x1]
        # Hard replacement of non-transparent pixels only.  Use np.where so
        # the update goes through the region view element-wise: transparent
        # pixels leave whatever was already on the canvas untouched, and
        # opaque pixels (including transparent-index "erase" tiles written by
        # the optimizer) fully replace the previous content.  There is never
        # alpha blending because GIF has no per-pixel alpha.
        mask = opaque[..., None]
        region[:] = np.where(mask, tile, region)

    def _dispose(self, frame: RawFrame) -> None:
        x0, y0, x1, y1 = frame.bbox
        if frame.disposal == DISPOSAL_BACKGROUND:
            region = self._canvas[y0:y1, x0:x1]
            if self._transparent_bg:
                region[...] = 0
            else:
                region[..., :3] = np.asarray(
                    self.doc.background_rgb, dtype=np.uint8
                )
                region[..., 3] = 255
        # DISPOSAL_PREVIOUS is handled by the caller via snapshots.

    def advance(self) -> np.ndarray:
        """Composite one more frame and return the canvas for its interval."""
        if self._next_frame >= len(self.doc.frames):
            msg = "no more frames to composite"
            raise IndexError(msg)
        frame = self.doc.frames[self._next_frame]

        snapshot = None
        if frame.disposal == DISPOSAL_PREVIOUS:
            snapshot = self._canvas.copy()

        self._paint(frame)
        shown = self._canvas.copy()

        if frame.disposal == DISPOSAL_PREVIOUS and snapshot is not None:
            self._canvas = snapshot
        else:
            self._dispose(frame)

        self._next_frame += 1
        return shown

    def render_all(self) -> list[np.ndarray]:
        """Render every frame's full-canvas picture, in order."""
        self.reset()
        return [self.advance() for _ in self.doc.frames]


def render_frame_at(doc: GifDocument, index: int) -> np.ndarray:
    """Deterministically render the full canvas shown during frame ``index``.

    Always starts from an empty canvas and walks from frame 0, so jumping
    straight to a middle frame gives the identical result of playing the
    animation from the beginning.
    """
    if not 0 <= index < len(doc.frames):
        msg = f"frame index {index} out of range"
        raise IndexError(msg)
    compositor = Compositor(doc)
    shown = None
    for i in range(index + 1):
        shown = compositor.advance()
    return shown  # type: ignore[return-value]


def render_all(doc: GifDocument) -> list[np.ndarray]:
    """Convenience wrapper returning all full-canvas RGBA frames."""
    return Compositor(doc).render_all()
