"""全局常量与参数对象。"""
from __future__ import annotations

from dataclasses import dataclass, asdict

# 配额里表示“不限次数”的哨兵值（引擎内部使用一个足够大的有限数，
# 这样容量统计、位掩码之外的逻辑都不用特判 None）。
UNLIMITED: int = 10**9

# 特征采样网格边长：把图缩成 FEATURE_GRID×FEATURE_GRID 再比较。
FEATURE_GRID: int = 6

# 支持读取的图片扩展名（小写、含点）。
IMAGE_SUFFIXES: tuple[str, ...] = (
    ".png", ".jpg", ".jpeg", ".bmp", ".webp", ".tif", ".tiff",
)


@dataclass
class MosaicParams:
    """一次排版的可调参数。

    cell_size:    格子在底图上对应的边长（底图像素），越小格子越多。
    max_uses:     每块样块全图最多使用次数；0 表示按格子/样块数自动给配额。
    adjacency_radius: 同一样块的切比雪夫距离小于等于该值时禁止相邻出现，
                  1 = 八邻域不能重复，0 = 不限制。
    seed:         随机种子，相同素材 + 参数 + 固定格可重现排版。
    color_weight / layout_weight / texture_weight: 距离中三类特征的权重。
    improvement_passes: 贪心结束后做几轮保约束局部优化。
    """

    cell_size: int = 40
    max_uses: int = 0
    adjacency_radius: int = 1
    seed: int = 20261126
    color_weight: float = 0.25
    layout_weight: float = 0.45
    texture_weight: float = 0.30
    improvement_passes: int = 2

    def normalized_weights(self) -> tuple[float, float, float]:
        total = self.color_weight + self.layout_weight + self.texture_weight
        if total <= 1e-9:
            return 1 / 3, 1 / 3, 1 / 3
        return (
            self.color_weight / total,
            self.layout_weight / total,
            self.texture_weight / total,
        )

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "MosaicParams":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in (data or {}).items() if k in known})
