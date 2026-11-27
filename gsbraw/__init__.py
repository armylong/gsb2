"""gsbraw - 原始灰度数据读图 / 错位排查工具.

核心模块:
    layout  从 (宽, 高, 前置跳过, 行间空白, 每像素位数) 计算字节级布局
    decode  向量化解码, 保留有效位掩膜以及每个像素的字节/位来源
    pngio   纯 Python 的 8/16 位灰度 PNG 读写（保留原始灰度精度）
    export  导出 PNG + 参数 JSON + 缺失掩膜, 以及重开核对
    samples 自带错行 / 跨字节样本生成
"""

__version__ = "0.1.0"

from .layout import Interpretation, ParamError, Layout  # noqa: F401
from .decode import Decoded, decode  # noqa: F401
