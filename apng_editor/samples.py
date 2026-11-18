"""Ready-made sample projects used by the GUI and by the tests.

Every sample is built from code (no binary assets) and has expected pixel
values documented next to it.  ``expected_*`` helpers recompute the pixels
with plain, hand-written formulas instead of calling the editor compositor.
"""

from __future__ import annotations

import numpy as np

from .model import (
    BLEND_OVER,
    BLEND_REPLACE,
    DISPOSE_CLEAR,
    DISPOSE_KEEP,
    DISPOSE_PREVIOUS,
    Frame,
    Project,
)

RED = (200, 30, 40, 255)
BLUE = (30, 60, 200, 255)
GREEN = (30, 170, 80, 255)
YELLOW = (235, 200, 40, 255)
MAGENTA = (200, 40, 170, 255)
SEMI_BLUE = (0, 0, 200, 128)
SEMI_YELLOW = (235, 200, 40, 128)
SEMI_WHITE = (255, 255, 255, 128)
CLEAR = (0, 0, 0, 0)


def solid_tile(width: int, height: int, color) -> np.ndarray:
    tile = np.zeros((height, width, 4), dtype=np.uint8)
    tile[...] = np.asarray(color, dtype=np.uint8)
    return tile


def sample_alpha_overlap() -> Project:
    """Semi-transparent blue over opaque red, then keep.

    Frame 1 paints a 48×48 opaque red square at (8, 12).
    Frame 2 paints a 32×32 half-transparent blue tile at (36, 36) using
    source-over.  At (40, 40), inside both tiles, the expected pixel is
    ``blend_over(red, (0, 0, 200, 128)) = (100, 15, 120, 255)``.  At (65, 65)
    the blue is over the transparent canvas and must stay
    ``(0, 0, 200, 128)`` — the half transparency is preserved.
    """

    base = solid_tile(48, 48, RED)
    overlay = solid_tile(32, 32, SEMI_BLUE)
    project = Project(canvas_width=80, canvas_height=80)
    project.add_frame(
        Frame(base, x=8, y=12, duration_ms=250, blend=BLEND_REPLACE, dispose=DISPOSE_KEEP)
    )
    project.add_frame(
        Frame(overlay, x=36, y=36, duration_ms=180, blend=BLEND_OVER, dispose=DISPOSE_KEEP)
    )
    project.set_loop_count(0)
    return project


def sample_move_and_clear() -> Project:
    """A tile moves, the old area is cleared, a third frame keeps the new one.

    Frame 1: opaque green 24×24 at (4, 4), keep.
    Frame 2: opaque magenta 24×24 at (40, 40), blend replace, dispose clear:
             while frame 2 runs, (41, 41) is magenta and (5, 5) is still
             green; afterwards only its own rectangle is cleared.
    Frame 3: semi-transparent yellow 16×16 at (10, 10), keep.  The green
             square survives at (5, 5), the magenta rectangle is transparent
             at (45, 45), and (12, 12) is ``blend_over(green, yellow)``.
    """

    green = solid_tile(24, 24, GREEN)
    magenta = solid_tile(24, 24, MAGENTA)
    yellow = solid_tile(16, 16, SEMI_YELLOW)
    project = Project(canvas_width=72, canvas_height=72)
    project.add_frame(
        Frame(green, x=4, y=4, duration_ms=200, blend=BLEND_REPLACE, dispose=DISPOSE_KEEP)
    )
    project.add_frame(
        Frame(
            magenta,
            x=40,
            y=40,
            duration_ms=200,
            blend=BLEND_REPLACE,
            dispose=DISPOSE_CLEAR,
        )
    )
    project.add_frame(
        Frame(yellow, x=10, y=10, duration_ms=200, blend=BLEND_OVER, dispose=DISPOSE_KEEP)
    )
    project.set_loop_count(2)
    return project


def sample_restore_previous() -> Project:
    """A covering frame is undone by dispose = previous.

    Frame 1: opaque red 40×40 at (8, 8), keep.
    Frame 2: opaque blue 20×20 at (16, 16), blend replace, dispose previous:
             during frame 2 the blue square is visible at (20, 20), and
             afterwards that rectangle is restored to red.
    Frame 3: semi-transparent white 12×12 at (18, 18) with source-over; it
             blends against the restored red, so (20, 20) becomes
             ``blend_over(red, (255, 255, 255, 128)) = (228, 143, 148, 255)``.
    """

    red = solid_tile(40, 40, RED)
    blue = solid_tile(20, 20, BLUE)
    white = solid_tile(12, 12, SEMI_WHITE)
    project = Project(canvas_width=64, canvas_height=64)
    project.add_frame(
        Frame(red, x=8, y=8, duration_ms=300, blend=BLEND_REPLACE, dispose=DISPOSE_KEEP)
    )
    project.add_frame(
        Frame(
            blue,
            x=16,
            y=16,
            duration_ms=300,
            blend=BLEND_REPLACE,
            dispose=DISPOSE_PREVIOUS,
        )
    )
    project.add_frame(
        Frame(white, x=18, y=18, duration_ms=300, blend=BLEND_OVER, dispose=DISPOSE_KEEP)
    )
    project.set_loop_count(0)
    return project


SAMPLES = {
    "半透明叠加": sample_alpha_overlap,
    "移动后清除": sample_move_and_clear,
    "恢复旧画面": sample_restore_previous,
}


# --------------------------------------------------------------------------
# Independent expected pixels.
#
# These helpers use plain per-pixel arithmetic (explicit Python loops) and do
# not import the compositor.  They act as a second opinion in the tests.
# --------------------------------------------------------------------------


def expected_blend_over(dst, src):
    """Hand-written straight-alpha source-over for one RGBA pixel.

    ``a_out = a_s + a_d (1 - a_s)`` and
    ``c_out = (c_s a_s + c_d a_d (1 - a_s)) / a_out`` with 8-bit rounding.
    """

    sa = src[3] / 255.0
    da = dst[3] / 255.0
    a_out = sa + da * (1.0 - sa)
    if a_out == 0:
        return (0, 0, 0, 0)
    rgb = tuple(
        int(round((src[i] * sa + dst[i] * da * (1.0 - sa)) / a_out))
        for i in range(3)
    )
    return (*rgb, int(round(a_out * 255)))


def expected_alpha_overlap_inside() -> tuple[int, int, int, int]:
    return expected_blend_over(RED, SEMI_BLUE)


def expected_alpha_overlap_outside() -> tuple[int, int, int, int]:
    return SEMI_BLUE


def expected_move_clear_overlap() -> tuple[int, int, int, int]:
    return expected_blend_over(GREEN, SEMI_YELLOW)


def expected_restore_overlap() -> tuple[int, int, int, int]:
    return expected_blend_over(RED, SEMI_WHITE)
