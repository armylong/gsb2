"""Animation document: one loaded GIF, exposed for the UI layer."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .compositor import render_all, render_frame_at
from .gif_parser import DISPOSAL_NAMES, GifDocument, parse_gif
from .player import Timeline, effective_duration_ms


@dataclass
class FrameInfo:
    index: int
    bbox: tuple[int, int, int, int]
    is_full_canvas: bool
    disposal: int
    disposal_label: str
    stored_duration_ms: int
    effective_duration_ms: int
    transparent_index: int | None
    interlaced: bool


class AnimationDocument:
    """Parsed GIF plus its fully composited per-frame pictures."""

    def __init__(self, path: str) -> None:
        self.path = path
        with open(path, "rb") as handle:
            raw = handle.read()
        self.file_size = len(raw)
        self.doc: GifDocument = parse_gif(raw)
        # Full-canvas RGBA picture for every display interval.
        self.composited: list[np.ndarray] = render_all(self.doc)
        self.timeline = Timeline(
            stored_durations_ms=[f.duration_ms for f in self.doc.frames],
            loop_count=self.doc.loop_count,
        )

    # -- metadata ---------------------------------------------------------

    @property
    def width(self) -> int:
        return self.doc.width

    @property
    def height(self) -> int:
        return self.doc.height

    @property
    def frame_count(self) -> int:
        return len(self.doc.frames)

    @property
    def loop_count(self) -> int:
        return self.doc.loop_count

    @property
    def uses_transparency(self) -> bool:
        return self.doc.uses_transparency

    @property
    def background_rgb(self) -> tuple[int, int, int]:
        return self.doc.background_rgb

    def loop_description(self) -> str:
        if self.doc.loop_count == 0:
            return "无限循环 (loop=0)"
        total = self.doc.loop_count + 1
        return f"循环 {self.doc.loop_count} 次（共播放 {total} 遍，loop={self.doc.loop_count}）"

    def background_description(self) -> str:
        rgb = self.background_rgb
        if self.uses_transparency:
            return (
                f"透明背景（处置2恢复为透明）；逻辑屏背景色索引 {self.doc.background_index}"
                f" = RGB{rgb}"
            )
        return f"纯色背景 RGB{rgb}（背景色索引 {self.doc.background_index}）"

    # -- per-frame access -------------------------------------------------

    def frame_info(self, index: int) -> FrameInfo:
        frame = self.doc.frames[index]
        x0, y0, x1, y1 = frame.bbox
        is_full = (x0, y0, x1, y1) == (0, 0, self.width, self.height)
        return FrameInfo(
            index=index,
            bbox=frame.bbox,
            is_full_canvas=is_full,
            disposal=frame.disposal,
            disposal_label=DISPOSAL_NAMES.get(frame.disposal, "未知"),
            stored_duration_ms=frame.duration_ms,
            effective_duration_ms=effective_duration_ms(frame.duration_ms),
            transparent_index=frame.transparent_index,
            interlaced=frame.interlaced,
        )

    def all_frame_infos(self) -> list[FrameInfo]:
        return [self.frame_info(i) for i in range(self.frame_count)]

    def tile_image(self, index: int) -> np.ndarray:
        """RGBA image of the stored tile only (never a full canvas)."""
        return self.doc.frames[index].tile_rgba()

    def composited_image(self, index: int) -> np.ndarray:
        """Full-canvas RGBA picture shown during frame ``index``."""
        return self.composited[index]

    def recomposite_from(self, index: int) -> np.ndarray:
        """Re-render from frame 0 up to ``index`` (deterministic seek check)."""
        return render_frame_at(self.doc, index)
