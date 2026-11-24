"""滚动快门 / 全局快门合成模拟。"""
from .export import export_clip, verify_export
from .model import (
    DIRECTION_BOTTOM_UP,
    DIRECTION_TOP_DOWN,
    MODE_GLOBAL,
    MODE_ROLLING,
    Clip,
    ObjectSpec,
    SimParams,
    render_clip,
    row_timing,
)
from .presets import PRESET_FAST, PRESET_FLASH, get_preset

__all__ = [
    "ObjectSpec", "SimParams", "Clip", "render_clip", "row_timing",
    "export_clip", "verify_export", "get_preset",
    "PRESET_FAST", "PRESET_FLASH",
    "MODE_GLOBAL", "MODE_ROLLING",
    "DIRECTION_TOP_DOWN", "DIRECTION_BOTTOM_UP",
]
