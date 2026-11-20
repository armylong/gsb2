"""duotone：双色印刷墨量估算与分色草稿工具（PySide6 本地 GUI）。"""

from .curves import ToneCurve
from .model import InkParams, composite, ink_usage
from .samples import make_check_strip, make_color_chart, make_gradient
from .separation import PipelineResult, rerender, run_pipeline

__all__ = [
    "ToneCurve",
    "InkParams",
    "composite",
    "ink_usage",
    "make_gradient",
    "make_color_chart",
    "make_check_strip",
    "run_pipeline",
    "rerender",
    "PipelineResult",
]
