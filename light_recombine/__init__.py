"""本地灯光通道重组工具。

线性光浮点管线: npy 通道 -> 倍率/独显合成 (float32, 不截断)
-> 曝光/色调映射/sRGB -> 屏幕预览与 PNG。
"""

from .channels import (
    CHANNEL_ORDER,
    CHANNEL_LABELS,
    LoadedChannel,
    LoadStatus,
)
from .composite import (
    CompositeResult,
    DisplayParams,
    ParamState,
    compute_composite,
    encode_srgb8,
    linear_to_srgb,
    probe_pixel,
    tonemap,
)
from .io_npy import (
    load_channel_file,
    load_channels,
    save_params,
    load_params,
)
from .example_scene import build_example_scene

__all__ = [
    "CHANNEL_ORDER",
    "CHANNEL_LABELS",
    "LoadedChannel",
    "LoadStatus",
    "CompositeResult",
    "DisplayParams",
    "ParamState",
    "compute_composite",
    "encode_srgb8",
    "linear_to_srgb",
    "probe_pixel",
    "tonemap",
    "load_channel_file",
    "load_channels",
    "save_params",
    "load_params",
    "build_example_scene",
]
