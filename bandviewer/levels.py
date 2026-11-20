"""灰阶（量化级别）的生成与解析。

级别统一表示为取值 [0, 1] 的升序 numpy 数组，至少包含两个元素。
"""
from __future__ import annotations

import numpy as np


def uniform_levels(count: int) -> np.ndarray:
    """等间距灰阶，例如 count=4 -> [0, 1/3, 2/3, 1]。"""
    count = int(count)
    if count < 2:
        raise ValueError("灰阶级数至少为 2")
    return np.linspace(0.0, 1.0, count, dtype=np.float64)


def gamma_levels(count: int, gamma: float) -> np.ndarray:
    """对均匀级别做 gamma 重映射。

    gamma>1 时暗部级别更密集（观察暗部高光过渡很有用），
    gamma<1 时亮部级别更密集。
    """
    if count < 2:
        raise ValueError("灰阶级数至少为 2")
    if gamma <= 0:
        raise ValueError("gamma 必须为正数")
    return np.power(uniform_levels(count), gamma)


def spaced_levels(count: int, spacing: str = "uniform", gamma: float = 2.2) -> np.ndarray:
    """按命名间距方案生成级别。"""
    if spacing == "uniform":
        return uniform_levels(count)
    if spacing == "gamma-dark":
        # 暗部密集：x^gamma
        return gamma_levels(count, gamma)
    if spacing == "gamma-light":
        # 亮部密集：x^(1/gamma)
        return gamma_levels(count, 1.0 / gamma)
    raise ValueError(f"未知间距方案: {spacing!r}")


def parse_custom_levels(text: str) -> np.ndarray:
    """解析用户输入的自定义灰阶。

    支持 0-255 整数或 0-1 浮点，自动按是否存在 >1 的值判断量纲，
    自动排序并去重，至少需要两个不同的值。示例输入：
    ``0 32 64 96 128 160 192 224 255`` 或 ``0, 0.25, 0.5, 0.75, 1``。
    """
    tokens = [t for t in text.replace(",", " ").replace(";", " ").split() if t]
    if len(tokens) < 2:
        raise ValueError("自定义灰阶至少需要 2 个值")
    values = np.array([float(t) for t in tokens], dtype=np.float64)
    if np.any(values < 0):
        raise ValueError("灰阶值不能为负")
    if values.max() > 1.0:
        # 按 8-bit 量纲输入
        if values.max() > 255.0:
            raise ValueError("8-bit 量纲下灰阶值不能超过 255")
        values = values / 255.0
    values = np.clip(values, 0.0, 1.0)
    values = np.unique(np.round(values, 8))
    if values.size < 2:
        raise ValueError("自定义灰阶至少需要 2 个不同的值")
    return values


def level_index_on_8bit(levels: np.ndarray) -> np.ndarray:
    """把 [0,1] 级别换算到 8-bit 显示值（四舍五入，保留重复时也不合并）。"""
    return np.rint(np.asarray(levels, dtype=np.float64) * 255.0).astype(np.uint8)


def describe_levels(levels: np.ndarray) -> str:
    """生成级别的简短描述，用于界面与自检输出。"""
    eights = level_index_on_8bit(levels)
    return ", ".join(f"{v:.3f}({int(q)})" for v, q in zip(levels, eights))
