"""半色调预览工具。

模块划分:
- halftone.core:    灰度转换 / 墨量曲线 / 网点渲染 / 选区统计(纯 numpy, 无 Qt 依赖)
- halftone.samples: 自带素材(渐变、细线、均匀灰块、斜边)
- halftone.io:      图像读取、PNG/参数记录导出与回读校验
- app.*:            PySide6 界面
"""

from .core import (
    DEFAULT_PARAMS,
    GAMMA_RANGE,
    MAX_PERIOD,
    MIN_PERIOD,
    SCREEN_DOT,
    SCREEN_LINE,
    SCREEN_LABELS,
    HalftoneError,
    render_halftone,
    selection_stats,
    target_coverage,
    to_grayscale,
    validate_params,
)
from .samples import SAMPLE_NAMES, build_sample
from .io import (
    MAX_EDGE,
    ImageLoadError,
    export_result,
    load_image,
    verify_export,
)

__all__ = [
    "DEFAULT_PARAMS",
    "GAMMA_RANGE",
    "MAX_PERIOD",
    "MIN_PERIOD",
    "SCREEN_DOT",
    "SCREEN_LINE",
    "SCREEN_LABELS",
    "HalftoneError",
    "render_halftone",
    "selection_stats",
    "target_coverage",
    "to_grayscale",
    "validate_params",
    "SAMPLE_NAMES",
    "build_sample",
    "MAX_EDGE",
    "ImageLoadError",
    "export_result",
    "load_image",
    "verify_export",
]
