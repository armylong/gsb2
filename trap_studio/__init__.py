"""Trap Studio: 两块专色墨版的本地搭接(trapping)打样工具。"""

from .geometry import compute_trap, edt, shift_mask, boundary_4, nearest_pixel

__all__ = [
    "compute_trap",
    "edt",
    "shift_mask",
    "boundary_4",
    "nearest_pixel",
]
