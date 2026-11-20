"""Deterministic, colour-blind-reasonable palette for components and rings."""

from __future__ import annotations

BASE_COLOURS = [
    (230, 159, 0),    # orange
    (86, 180, 233),   # sky blue
    (0, 158, 115),    # bluish green
    (204, 121, 167),  # reddish purple
    (213, 94, 0),     # vermillion
    (0, 114, 178),    # blue
    (240, 228, 66),   # yellow
    (0, 0, 0),        # black (border emphasised)
]


def component_colour(comp_id: int) -> tuple[int, int, int]:
    return BASE_COLOURS[(comp_id - 1) % len(BASE_COLOURS)]


def hole_colour(comp_id: int, hole_index: int, base=None) -> tuple[int, int, int]:
    """Lighten the component colour so holes are recognisably related."""
    r, g, b = base or component_colour(comp_id)
    shift = 35 * (1 + (hole_index % 3))
    return (min(255, r + shift), min(255, g + shift), min(255, b + shift))
