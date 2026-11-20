"""参数配置。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Optional


@dataclass
class DetectionParams:
    """一次冻结检测的参数。

    similarity:
        相邻两帧的相似度阈值(0~1]，越大越严格。1 - similarity 即允许的
        逐帧最大差异。
    min_duration_ms:
        冻结区间的最短**实际展示时长**(毫秒)。按时长而不是帧数判断，
        因此不等间隔帧(VFR)下依旧准确。
    drift_tolerance:
        相对区间起始锚点帧的累计漂移容差。用于把"停住"和"慢速变化/慢摇"
        区分开。留空(None)时自动取 ``2.5 * (1 - similarity)``。
    context_before / context_after:
        每个命中区间前后各展示/导出几帧，方便人工复核。
    hold_duration_ms:
        "单帧长驻留"阈值：某一帧的实际展示时长超过该值就单独构成一次冻结，
        即便它和相邻帧内容并不相同(解码器卡住后跳帧的典型表现)。
    black_luma:
        整段平均亮度不高于该值(0~1)时自动标记为黑场。
    static_hint_ms:
        命中区间达到该时长且不是黑场时，自动提示为"静态画面"(可人工忽略)。
    analysis_width:
        分析时缩放到的宽度，越大越准、越慢。
    tile:
        分块差异统计的块大小(像素)，用于识别局部慢速变化。
    """

    similarity: float = 0.995
    min_duration_ms: int = 500
    hold_duration_ms: int = 200
    drift_tolerance: Optional[float] = None
    context_before: int = 4
    context_after: int = 4
    black_luma: float = 0.08
    static_hint_ms: int = 2000
    analysis_width: int = 240
    tile: int = 8

    def __post_init__(self) -> None:
        if not 0.0 < self.similarity <= 1.0:
            raise ValueError("similarity 必须在 (0, 1] 范围内")
        if self.min_duration_ms < 0:
            raise ValueError("min_duration_ms 不能为负")
        if self.hold_duration_ms < 0:
            raise ValueError("hold_duration_ms 不能为负")
        if self.drift_tolerance is not None and not 0.0 <= self.drift_tolerance <= 1.0:
            raise ValueError("drift_tolerance 必须在 [0, 1] 范围内")
        if self.context_before < 0 or self.context_after < 0:
            raise ValueError("context 帧数不能为负")
        if not 0.0 <= self.black_luma <= 1.0:
            raise ValueError("black_luma 必须在 [0, 1] 范围内")
        if self.analysis_width < 32:
            raise ValueError("analysis_width 至少为 32")
        if self.tile < 2:
            raise ValueError("tile 至少为 2")

    @property
    def distance_threshold(self) -> float:
        """相邻帧允许的最大距离。"""
        return 1.0 - self.similarity

    @property
    def effective_drift_tolerance(self) -> float:
        if self.drift_tolerance is not None:
            return self.drift_tolerance
        return min(0.5, max(self.distance_threshold, 2.5 * self.distance_threshold))

    def as_dict(self) -> Dict[str, Any]:
        return {
            "similarity": self.similarity,
            "min_duration_ms": self.min_duration_ms,
            "hold_duration_ms": self.hold_duration_ms,
            "drift_tolerance": self.drift_tolerance,
            "effective_drift_tolerance": self.effective_drift_tolerance,
            "context_before": self.context_before,
            "context_after": self.context_after,
            "black_luma": self.black_luma,
            "static_hint_ms": self.static_hint_ms,
            "analysis_width": self.analysis_width,
            "tile": self.tile,
        }
