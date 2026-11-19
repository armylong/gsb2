"""公开数据模型。

本模块只依赖标准库，便于界面层、分割层与测试共用同一套对象。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional

import numpy as np


class ThresholdMode(str, Enum):
    FIXED = "fixed"
    LOCAL = "local"


class Polarity(str, Enum):
    """前景是亮还是暗。"""

    BRIGHT = "bright"
    DARK = "dark"

    @property
    def label(self) -> str:
        return "亮目标（前景像素 > 阈值）" if self is Polarity.BRIGHT else "暗目标（前景像素 < 阈值）"


class Connectivity(int, Enum):
    FOUR = 4
    EIGHT = 8


class FilterReason(str, Enum):
    KEPT = "kept"
    SMALL = "small"
    LARGE = "large"
    BORDER = "border"
    MANUAL = "manual"

    @property
    def text(self) -> str:
        return {
            FilterReason.KEPT: "计入",
            FilterReason.SMALL: "面积小于下限",
            FilterReason.LARGE: "面积大于上限",
            FilterReason.BORDER: "接触边界",
            FilterReason.MANUAL: "人工忽略",
        }[self]


@dataclass(frozen=True)
class ThresholdParams:
    mode: ThresholdMode = ThresholdMode.FIXED
    polarity: Polarity = Polarity.DARK
    fixed_value: int = 128
    # 局部阈值（自适应均值，与逆二值化等价）的像素半径，实际窗口 2*r+1
    local_radius: int = 15
    local_offset: int = 10

    def describe(self) -> str:
        if self.mode is ThresholdMode.FIXED:
            op = ">" if self.polarity is Polarity.BRIGHT else "<"
            return f"固定阈值 {self.fixed_value}（前景 = 像素值 {op} {self.fixed_value}）"
        win = 2 * self.local_radius + 1
        if self.polarity is Polarity.BRIGHT:
            return (
                f"局部阈值：{win}×{win} 邻域均值 + {self.local_offset}"
                f"（前景 = 像素值 > 邻域均值 + {self.local_offset}）"
            )
        return (
            f"局部阈值：{win}×{win} 邻域均值 - {self.local_offset}"
            f"（前景 = 像素值 < 邻域均值 - {self.local_offset}）"
        )


@dataclass(frozen=True)
class SegmentParams:
    threshold: ThresholdParams = field(default_factory=ThresholdParams)
    connectivity: Connectivity = Connectivity.EIGHT
    # 去小噪点：删除等效面积不超过该半径圆盘的独立小块（0 表示不去噪）
    despeckle_radius: int = 0
    # 填小间隙：填补等效面积不超过该半径圆盘的内部孔洞（0 表示不填补）
    fill_radius: int = 0

    def signature(self) -> tuple:
        t = self.threshold
        return (t.mode.value, t.polarity.value, t.fixed_value, t.local_radius, t.local_offset,
                self.connectivity.value, self.despeckle_radius, self.fill_radius)


@dataclass(frozen=True)
class RegionStats:
    label_id: int
    area: int
    centroid_x: float
    centroid_y: float
    bbox: tuple[int, int, int, int]  # x, y, w, h（左闭右开）
    touches_border: bool
    hole_count: int
    hole_area: int

    @property
    def width(self) -> int:
        return self.bbox[2]

    @property
    def height(self) -> int:
        return self.bbox[3]


@dataclass
class RegionRecord:
    """一个真实连通域；编号 label_id 按最上方再最左方排序，从 1 开始。"""

    stats: RegionStats
    included: bool = True
    reason: FilterReason = FilterReason.KEPT

    @property
    def excluded(self) -> bool:
        return not self.included

    def to_row(self) -> dict:
        s = self.stats
        return {
            "编号": s.label_id,
            "面积(px)": s.area,
            "质心X": round(s.centroid_x, 3),
            "质心Y": round(s.centroid_y, 3),
            "外接矩形X": s.bbox[0],
            "外接矩形Y": s.bbox[1],
            "外接矩形宽": s.bbox[2],
            "外接矩形高": s.bbox[3],
            "触边": "是" if s.touches_border else "否",
            "孔洞数": s.hole_count,
            "孔洞面积(px)": s.hole_area,
            "是否计入": "是" if self.included else "否",
            "排除原因": self.reason.text,
        }


@dataclass
class FilterCriteria:
    min_area: int = 0
    max_area: int = 0  # 0 表示不限
    exclude_border: bool = False

    def is_active(self) -> bool:
        return self.min_area > 0 or self.max_area > 0 or self.exclude_border

    def check(self, stats: RegionStats, manual: bool = False) -> FilterReason:
        """组合筛选，原因优先级：人工忽略 > 触边 > 面积下限 > 面积上限。

        本函数只决定“是否计入”；无论什么原因被筛掉，区域都保留在标签图与表格中。
        """
        if manual:
            return FilterReason.MANUAL
        if stats.touches_border and self.exclude_border:
            return FilterReason.BORDER
        if self.min_area > 0 and stats.area < self.min_area:
            return FilterReason.SMALL
        if self.max_area > 0 and stats.area > self.max_area:
            return FilterReason.LARGE
        return FilterReason.KEPT


@dataclass
class SegmentationResult:
    base_mask: np.ndarray            # 二值处理范围（阈值后、去噪/填隙前）
    mask: np.ndarray                 # 最终前景（uint8，0/1）
    labels: np.ndarray               # int32，0 为背景，1..N 按编号排序
    regions: list[RegionRecord]
    params: SegmentParams
    hole_mask: np.ndarray            # 最终前景中被包围的孔洞像素（uint8，0/1）
    calc: dict = field(default_factory=dict)

    def region_by_id(self, label_id: int) -> Optional[RegionRecord]:
        if 1 <= label_id <= len(self.regions):
            return self.regions[label_id - 1]
        return None

    @property
    def total_count(self) -> int:
        return len(self.regions)

    @property
    def included_count(self) -> int:
        return sum(1 for r in self.regions if r.included)

    @property
    def included_area(self) -> int:
        return sum(r.stats.area for r in self.regions if r.included)


@dataclass
class Demo:
    key: str
    name: str
    image: np.ndarray
    expected: dict
    note: str = ""
