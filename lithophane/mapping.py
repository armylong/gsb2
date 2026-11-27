"""灰度到物理厚度（毫米）的映射参数与异常类型。"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np


class ParamError(ValueError):
    """所有可由用户调整参数引发的错误基类。"""


class DegenerateRangeError(ParamError):
    """黑白点冲突（黑点 >= 白点）。"""


class ThicknessRangeError(ParamError):
    """厚度上下限冲突（t_min >= t_max）。"""


@dataclass
class ThicknessParams:
    """厚度映射参数，单位均为毫米。

    dark_thick=True（默认，背光浮雕惯例）：越暗越厚；
    dark_thick=False：越亮越厚，即整体翻转厚度方向。
    """

    t_min: float = 0.8
    t_max: float = 3.0
    black_point: float = 0.0
    white_point: float = 1.0
    dark_thick: bool = True

    def validate(self) -> None:
        if self.t_min <= 0 or self.t_max <= 0:
            raise ThicknessRangeError("厚度必须为正数")
        if self.t_max <= self.t_min:
            raise ThicknessRangeError(
                f"厚度上下限冲突：最小厚度 {self.t_min:.3f}mm 必须小于 "
                f"最大厚度 {self.t_max:.3f}mm"
            )
        if not (0.0 <= self.black_point <= 1.0 and 0.0 <= self.white_point <= 1.0):
            raise DegenerateRangeError("黑白点必须落在 0~1 之间")
        if self.black_point >= self.white_point:
            raise DegenerateRangeError(
                f"黑白点冲突：黑点({self.black_point:.3f}) 必须小于 "
                f"白点({self.white_point:.3f})"
            )


def thickness_from_gray(leveled_gray: np.ndarray, p: ThicknessParams) -> np.ndarray:
    """[0,1] 灰度 -> 毫米厚度数组。"""
    p.validate()
    span = p.t_max - p.t_min
    if p.dark_thick:
        return p.t_max - span * leveled_gray
    return p.t_min + span * leveled_gray
