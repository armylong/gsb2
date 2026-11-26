"""波段数据模型与统计。

BandData 保存:
  data  —— 原始二维数组, 原样保留输入 dtype (uint8/uint16/uint32/float32/float64)
  valid —— 布尔掩码, True 表示有效像素; 无值像素不参与任何统计与渲染拉伸
所有统计在 float64 上进行, 避免高位深整数运算溢出。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np

FLOAT_DTYPES = (np.float16, np.float32, np.float64)


@dataclass
class RangeStats:
    """某区域内有效像素的数值统计。"""

    count: int
    minimum: float
    maximum: float
    mean: float
    median: float
    percentiles: tuple[float, float]  # 2% / 98%, 供参考

    @classmethod
    def empty(cls) -> "RangeStats":
        return cls(0, np.nan, np.nan, np.nan, np.nan, (np.nan, np.nan))


@dataclass
class BandData:
    name: str
    data: np.ndarray
    valid: np.ndarray
    source_path: Optional[str] = None
    nodata_value: Optional[float] = None

    def __post_init__(self) -> None:
        if self.data.ndim != 2:
            raise ValueError(f"波段 {self.name!r} 必须是二维数组, 实际 ndim={self.data.ndim}")
        if self.valid.shape != self.data.shape:
            raise ValueError("valid 掩码与 data 形状不一致")
        if self.valid.dtype != bool:
            self.valid = self.valid.astype(bool)

    @property
    def shape(self) -> tuple[int, int]:
        return self.data.shape  # type: ignore[return-value]

    @property
    def dtype(self) -> np.dtype:
        return self.data.dtype

    def stats_in(self, roi: Optional[tuple[int, int, int, int]] = None) -> RangeStats:
        """统计全图或参考区内的有效像素。

        roi = (x0, y0, x1, y1), 半开区间 [x0, x1) x [y0, y1), 原像素坐标。
        """
        values = self.roi_values(roi)
        if values.size == 0:
            return RangeStats.empty()
        return RangeStats(
            count=int(values.size),
            minimum=float(values.min()),
            maximum=float(values.max()),
            mean=float(values.mean()),
            median=float(np.median(values)),
            percentiles=(
                float(np.percentile(values, 2)),
                float(np.percentile(values, 98)),
            ),
        )

    def roi_values(self, roi: Optional[tuple[int, int, int, int]] = None) -> np.ndarray:
        """取出参考区内的有效值 (float64 一维数组); roi=None 表示全图。"""
        if roi is None:
            mask = self.valid
            block = self.data
        else:
            x0, y0, x1, y1 = _clipped_rect(roi, self.shape)
            if x1 <= x0 or y1 <= y0:
                return np.empty(0, dtype=np.float64)
            block = self.data[y0:y1, x0:x1]
            mask = self.valid[y0:y1, x0:x1]
        return block[mask].astype(np.float64, copy=False)


def _clipped_rect(
    roi: tuple[int, int, int, int], shape: tuple[int, int]
) -> tuple[int, int, int, int]:
    """把参考区裁到图像范围内, 全部取整为原像素索引。"""
    h, w = shape
    x0, y0, x1, y1 = roi
    x0 = max(0, min(int(round(x0)), w))
    y0 = max(0, min(int(round(y0)), h))
    x1 = max(0, min(int(round(x1)), w))
    y1 = max(0, min(int(round(y1)), h))
    if x1 < x0:
        x0, x1 = x1, x0
    if y1 < y0:
        y0, y1 = y1, y0
    return x0, y0, x1, y1


def clip_counts(
    band: BandData,
    lo: float,
    hi: float,
    roi: Optional[tuple[int, int, int, int]] = None,
) -> tuple[int, int]:
    """统计参考区内低于下界 / 高于上界的有效像素数。"""
    values = band.roi_values(roi)
    if values.size == 0:
        return 0, 0
    return int(np.count_nonzero(values < lo)), int(np.count_nonzero(values > hi))


def same_shape(bands: list[BandData]) -> bool:
    return len({b.shape for b in bands}) == 1
