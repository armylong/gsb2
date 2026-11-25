"""通道定义与加载结果的数据结构。"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

import numpy as np

# 固定通道顺序: 底色(材质反照率)、自发光、漫反射光、镜面光。
# 合成语义: final = base + emission + diffuse + specular (各乘倍率)。
CHANNEL_ORDER = ("base", "emission", "diffuse", "specular")
CHANNEL_LABELS = {
    "base": "底色 base",
    "emission": "自发光 emission",
    "diffuse": "漫反射光 diffuse",
    "specular": "镜面光 specular",
}


class LoadStatus(Enum):
    """单通道加载状态。缺失/尺寸不符绝不拿别的图顶替。"""

    OK = "ok"                    # 正常加载
    MISSING = "missing"          # 没有给路径或文件不存在
    SHAPE_MISMATCH = "shape"     # 尺寸/形状与参考不一致
    BAD_DATA = "bad"             # 文件无法解析或数值非法


@dataclass
class LoadedChannel:
    """一路通道的加载结果。

    data 仅在 status == OK 时为 HxWx3 float32 数组, 否则为 None;
    合成时缺失通道按 0 处理, 并在界面明确标出可预览范围。
    """

    name: str
    status: LoadStatus
    data: np.ndarray | None = None
    path: str | None = None
    detail: str = ""

    @property
    def available(self) -> bool:
        return self.status == LoadStatus.OK and self.data is not None


@dataclass
class ChannelSet:
    """一次加载的整套通道, 以第一个成功通道的尺寸为参考尺寸。"""

    channels: dict[str, LoadedChannel] = field(default_factory=dict)

    def get(self, name: str) -> LoadedChannel | None:
        return self.channels.get(name)

    @property
    def reference_shape(self) -> tuple[int, int] | None:
        for name in CHANNEL_ORDER:
            ch = self.channels.get(name)
            if ch is not None and ch.available:
                h, w = ch.data.shape[:2]
                return (h, w)
        return None

    def available_names(self) -> list[str]:
        return [n for n in CHANNEL_ORDER
                if (ch := self.channels.get(n)) is not None and ch.available]
