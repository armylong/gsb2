"""Pure-computation core for slit-scan strip building.

Everything in this module works on plain numpy arrays / dataclasses so it can
be unit-tested without a GUI or video files.  Coordinate convention:

* frame columns are integer indices ``0 .. frame_width-1``
* a slit is described by an integer ``left`` edge and a fixed ``width``
* ``-1`` in a source-column map means "no original pixel here" (padded /
  synthetic) and is also what the GUI uses to highlight unrecoverable columns.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Callable, Literal, Sequence

import numpy as np

PaddingMode = Literal["edge", "reflect", "zero", "limit"]
LayoutMode = Literal["frame", "interval"]


@dataclass
class SlitConfig:
    """User-tunable slit and time-range configuration."""

    width: int = 16
    # slit center (in source pixels) at the first / last selected moment.
    # Equal values => static slit; different => linear pan over time.
    start_center: float = 100.0
    end_center: float = 100.0
    padding: PaddingMode = "edge"
    # trim window in source-video seconds (None => full extent)
    trim_start: float | None = None
    trim_end: float | None = None
    # skipped (cut out) source-time ranges in seconds
    skip_intervals: list[tuple[float, float]] = field(default_factory=list)
    # layout
    layout: LayoutMode = "frame"
    interval: float = 0.1  # used only when layout == "interval"
    max_page_width: int = 8000  # split output pages beyond this width

    def clamp_width(self, frame_width: int) -> None:
        self.width = max(1, min(int(self.width), frame_width))


@dataclass
class SliceBlock:
    """Index record for one vertical slice (= one selected moment).

    One block occupies ``width`` consecutive columns in the output strip.
    ``source_cols`` has exactly ``width`` entries; ``-1`` marks a padded
    column that has no corresponding original pixel.
    """

    global_x0: int          # first output column across the whole (unpaged) strip
    page: int               # 0-based output page
    page_x0: int            # first column on that page
    width: int
    frame_index: int        # -1 when no real frame could be assigned
    t: float                # source timestamp in seconds
    slit_left: int          # integer left edge in source coordinates (may be <0)
    source_cols: list[int]  # length == width, -1 = padded
    synthetic: bool         # duplicate/missing frame or contains padding?
    skipped: bool = False   # block lies inside a user skip interval

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class BuildResult:
    pages: list[np.ndarray]          # each uint8 HxWx3
    blocks: list[SliceBlock]
    frame_width: int
    frame_height: int
    timestamps: np.ndarray          # source pts per decoded frame
    config: SlitConfig

    @property
    def total_width(self) -> int:
        return sum(p.shape[1] for p in self.pages)


# --------------------------------------------------------------------------- #
# slit geometry
# --------------------------------------------------------------------------- #

def slit_center_at(t: float, t0: float, t1: float, c0: float, c1: float) -> float:
    """Linear interpolation of slit center between two key moments."""
    if t1 <= t0:
        return c0
    f = (t - t0) / (t1 - t0)
    return c0 + (c1 - c0) * f


def slit_left_for_center(center: float, width: int) -> int:
    """Integer left edge whose interval [left, left+width) covers ``center``."""
    return int(round(center - width / 2.0))


def resolve_slit(
    left: int, width: int, frame_width: int, padding: PaddingMode
) -> tuple[int, list[int], bool]:
    """Resolve a slit against frame bounds.

    Returns ``(clamped_left, source_cols, needs_pad)`` where ``source_cols``
    has length ``width`` and maps every output column to a source column
    (``-1`` when padded).  ``padding='limit'`` shifts the slit back inside the
    frame instead of padding.
    """
    if padding == "limit":
        left = max(0, min(left, frame_width - width))
        return left, list(range(left, left + width)), False

    right = left + width
    cols: list[int] = []
    needs_pad = left < 0 or right > frame_width

    for x in range(left, right):
        if 0 <= x < frame_width:
            cols.append(x)
            continue
        if padding == "zero":
            cols.append(-1)
        elif padding == "edge":
            cols.append(min(max(x, 0), frame_width - 1))
        elif padding == "reflect":
            # mirror around the boundary, e.g. -1 -> 1, -2 -> 2
            if x < 0:
                cols.append(min(-x, frame_width - 1))
            else:
                cols.append(max(2 * frame_width - x - 1, 0))
        else:  # pragma: no cover - guarded by type literal
            raise ValueError(f"unknown padding mode {padding!r}")
    return left, cols, needs_pad


# --------------------------------------------------------------------------- #
# frame selection (trim / skip / layout)
# --------------------------------------------------------------------------- #

def _in_any_interval(t: float, intervals: Sequence[tuple[float, float]]) -> bool:
    return any(a <= t < b for a, b in intervals)


def select_moments(
    timestamps: np.ndarray,
    config: SlitConfig,
) -> list[tuple[int, float, bool, bool]]:
    """Decide which frames contribute slices.

    Returns tuples ``(frame_index, t, synthetic, skipped)``.  For interval
    layout, target times are generated on a fixed grid; a frame reused by two
    grid points is marked ``synthetic`` (duplicate) and a grid point with no
    nearby frame gets ``frame_index=-1``.
    """
    n = len(timestamps)
    if n == 0:
        return []

    t0 = config.trim_start if config.trim_start is not None else float(timestamps[0])
    t1 = config.trim_end if config.trim_end is not None else float(timestamps[-1])
    t0, t1 = max(t0, float(timestamps[0])), min(t1, float(timestamps[-1]))
    if t1 < t0:
        return []

    if config.layout == "frame":
        out: list[tuple[int, float, bool, bool]] = []
        for i, t in enumerate(timestamps):
            tf = float(t)
            if not (t0 <= tf <= t1):
                continue
            skipped = _in_any_interval(tf, config.skip_intervals)
            if skipped:
                continue
            out.append((i, tf, False, False))
        return out

    # fixed-interval grid
    if config.interval <= 0:
        raise ValueError("interval must be > 0 in interval layout")
    grid = np.arange(t0, t1 + config.interval * 0.5, config.interval)
    ts = np.asarray(timestamps, dtype=float)
    last_used = -1
    out = []
    for gt in grid:
        gt = float(gt)
        if _in_any_interval(gt, config.skip_intervals):
            continue
        idx = int(np.argmin(np.abs(ts - gt)))
        # nearest frame must be within one grid spacing, else treat as missing
        if abs(float(ts[idx]) - gt) > config.interval:
            out.append((-1, gt, True, False))
            continue
        dup = idx == last_used
        last_used = idx
        out.append((idx, gt, dup, False))
    return out


# --------------------------------------------------------------------------- #
# strip assembly
# --------------------------------------------------------------------------- #

def _paste_slice(
    canvas: np.ndarray,
    frame: np.ndarray | None,
    source_cols: Sequence[int],
    x0: int,
    padding: PaddingMode,
) -> None:
    """Paste one width-w slice into ``canvas`` at column offset ``x0``."""
    for k, src in enumerate(source_cols):
        dst = x0 + k
        if frame is None or src < 0:
            if padding == "zero" or frame is None:
                canvas[:, dst, :] = 0
            else:  # edge/reflect always carry a real index; keep black fallback
                canvas[:, dst, :] = 0
        else:
            canvas[:, dst, :] = frame[:, src, :]


def build_strip(
    frames: np.ndarray,
    timestamps: np.ndarray,
    config: SlitConfig,
    progress: Callable[[float], None] | None = None,
) -> BuildResult:
    """Build the (possibly multi-page) slit strip and its position index.

    ``frames`` is an uint8 array of shape ``(N, H, W, 3)``; ``timestamps``
    the per-frame presentation time in seconds (supports VFR).
    """
    if frames.ndim != 4 or frames.shape[-1] != 3:
        raise ValueError("frames must have shape (N, H, W, 3)")
    h, w = frames.shape[1], frames.shape[2]
    config.clamp_width(w)

    moments = select_moments(timestamps, config)
    if not moments:
        raise ValueError("no frames selected (check trim / skip ranges)")

    t_first = moments[0][1]
    t_last = moments[-1][1]
    sw = config.width
    total = len(moments) * sw
    # page capacity is a whole number of slices so page joins never split a
    # slice and never introduce a gap: total width == sum of page widths
    page_cap = max(sw, (int(config.max_page_width) // sw) * sw)
    blocks_per_page = page_cap // sw
    pages: list[np.ndarray] = []
    blocks: list[SliceBlock] = []
    cursor = 0  # global output columns already written (gap-free)

    for mi, (fi, t, synth, skipped) in enumerate(moments):
        center = slit_center_at(t, t_first, t_last,
                                config.start_center, config.end_center)
        left = slit_left_for_center(center, sw)
        clamped_left, cols, padded = resolve_slit(left, sw, w, config.padding)
        frame = frames[fi] if fi >= 0 else None

        page = mi // blocks_per_page
        page_x = (mi % blocks_per_page) * sw
        if page == len(pages):
            pages.append(np.zeros((h, page_cap, 3), dtype=np.uint8))

        _paste_slice(pages[page], frame, cols, page_x, config.padding)
        blocks.append(SliceBlock(
            global_x0=cursor,
            page=page,
            page_x0=page_x,
            width=sw,
            frame_index=fi,
            t=t,
            slit_left=clamped_left,
            source_cols=list(cols),
            synthetic=synth or padded or fi < 0,
            skipped=skipped,
        ))
        cursor += sw
        if progress is not None:
            progress((mi + 1) / len(moments))

    # trim the final page to its actual used width (all earlier pages stay
    # exactly page_cap wide), keeping the column sequence perfectly contiguous
    if pages:
        last_used = blocks[-1].page_x0 + sw
        pages[-1] = pages[-1][:, :last_used, :].copy()

    assert sum(p.shape[1] for p in pages) == total
    return BuildResult(pages=pages, blocks=blocks, frame_width=w,
                       frame_height=h, timestamps=np.asarray(timestamps),
                       config=config)


# --------------------------------------------------------------------------- #
# reverse lookup: output position -> source frame, and back
# --------------------------------------------------------------------------- #

def x_to_block(blocks: Sequence[SliceBlock], page: int, x: int) -> SliceBlock | None:
    """Find the block covering column ``x`` on page ``page``."""
    for b in blocks:
        if b.page == page and b.page_x0 <= x < b.page_x0 + b.width:
            return b
    return None


def frame_to_block(blocks: Sequence[SliceBlock], frame_index: int) -> SliceBlock | None:
    """Find the output block produced from ``frame_index`` (first match)."""
    for b in blocks:
        if b.frame_index == frame_index:
            return b
    return None


def block_has_real_pixels(block: SliceBlock) -> bool:
    """Whether at least one output column maps to an original source pixel."""
    return any(c >= 0 for c in block.source_cols)
