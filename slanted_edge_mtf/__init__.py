"""slanted_edge_mtf —— 斜边法细节保留能力(MTF/SFR)离线分析工具。

核心管线遵循 ISO 12233 斜边法思路:
直边鲁棒拟合 -> 按到边距离重采样得到 ESF -> 微分得到 LSF ->
加窗 FFT 得到 MTF, 并给出 MTF50(单位: 周期/原图像素)与可信度提示。
"""

from .analysis import AnalysisResult, Flag, analyze, to_gray

__all__ = ["AnalysisResult", "Flag", "analyze", "to_gray"]
__version__ = "1.0.0"
