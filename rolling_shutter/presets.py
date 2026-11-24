"""两个内置可复现实验。

两种快门模式始终用同一份 SimParams 渲染，因此对比只反映读出方式差异。
"""
from __future__ import annotations

from .model import DIRECTION_TOP_DOWN, ObjectSpec, SimParams

PRESET_FAST = "fast_motion"
PRESET_FLASH = "flash"


def fast_motion_params() -> SimParams:
    """快移实验：长曝光 + 满帧读出，拖尾与滚动剪切都很明显。

    总读出时间取 1/30 帧周期的 6 位小数近似（GUI 控件精度内可精确往返）。
    """
    return SimParams(
        width=200,
        height=120,
        fps=30.0,
        n_frames=30,
        readout_direction=DIRECTION_TOP_DOWN,
        total_readout=round(1.0 / 30.0, 6),  # 0.033333s，占满整个帧周期
        exposure=0.030,            # 30ms 长曝光 -> 明显拖尾
        ambient=0.05,
        flash_enabled=False,
        objects=(
            ObjectSpec("物体1（快）", x0=10.0, velocity=600.0, width=18.0,
                       y0=15, y1=70, color=(0.20, 0.85, 0.95)),
            ObjectSpec("物体2（慢）", x0=10.0, velocity=260.0, width=12.0,
                       y0=78, y1=105, color=(0.98, 0.55, 0.18)),
        ),
    )


def flash_params() -> SimParams:
    """闪光实验：3ms 短闪光只照亮滚动快门的中部若干行；
    全局快门所有行共用曝光窗，整帧同时被照亮。"""
    return SimParams(
        width=200,
        height=120,
        fps=30.0,
        n_frames=30,
        readout_direction=DIRECTION_TOP_DOWN,
        total_readout=round(1.0 / 30.0, 6),
        exposure=0.020,
        ambient=0.05,
        flash_enabled=True,
        flash_start=0.410,
        flash_duration=0.003,
        flash_intensity=0.85,
        objects=(
            ObjectSpec("物体1（快）", x0=10.0, velocity=200.0, width=16.0,
                       y0=15, y1=70, color=(0.20, 0.85, 0.95)),
            ObjectSpec("物体2（慢）", x0=10.0, velocity=90.0, width=10.0,
                       y0=78, y1=105, color=(0.98, 0.55, 0.18)),
        ),
    )


PRESETS = {
    PRESET_FAST: ("快移实验", fast_motion_params),
    PRESET_FLASH: ("闪光实验", flash_params),
}


def get_preset(key: str) -> SimParams:
    return PRESETS[key][1]()
