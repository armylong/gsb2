"""JPEG 编码失真分析工具核心包。

约定:所有图像数组均为 uint8、形状 (H, W, 3)、通道顺序为 RGB。
OpenCV 仅用于热图伪彩色映射,其 BGR 输出在 heatmap 处显式转回 RGB。
"""

__version__ = "0.1.0"
