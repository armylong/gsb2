"""结果数据模型，供 DSP 与 UI 共用（无 Qt 依赖）。"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np


@dataclass
class Peak:
    """一个时差候选峰。"""

    lag: int                 # 整采样时差（ch1 相对 ch0）
    score: float             # 归一化互相关值，0..1
    confidence: float        # 0..1，综合峰高、尖锐度与噪声分离
    label: str = ""          # "主峰" / "重复节奏候选" / "弱候选"
    sub_shift: float = 0.0   # 抛物线插值得到的亚采样修正
    ambiguous: bool = False  # 与主峰高度接近，需人工确认

    @property
    def refined_lag(self) -> float:
        return self.lag + self.sub_shift

    @property
    def as_dict(self) -> dict:
        return {
            "lag": self.lag,
            "refined": round(float(self.refined_lag), 4),
            "score": round(float(self.score), 4),
            "confidence": round(float(self.confidence), 4),
            "label": self.label,
            "ambiguous": self.ambiguous,
        }


@dataclass
class TdoaResult:
    peaks: list[Peak]
    lags: np.ndarray                  # 互相关横轴（采样点）
    correlogram: np.ndarray           # 归一化互相关
    max_lag: int
    sr: int
    delay: float                      # 主峰整采样时差
    sub_shift: float                  # 亚采样修正
    polarity: int = 1                 # +1 同相, -1 反相
    polarity_margin: float = 0.0      # 同相/反相相关峰的相对差，0..1
    notes: list[str] = field(default_factory=list)

    @property
    def refined_delay(self) -> float:
        return self.delay + self.sub_shift

    @property
    def delay_seconds(self) -> float:
        return self.refined_delay / self.sr

    @property
    def delay_ms(self) -> float:
        return self.delay_seconds * 1000.0

    @property
    def main_peak(self) -> Peak:
        return self.peaks[0]

    def pdf_peak_at(self, lag: int) -> Peak | None:
        for p in self.peaks:
            if p.lag == lag:
                return p
        return None


@dataclass
class DriftResult:
    times: np.ndarray            # 窗口中心（秒，相对片段起点）
    delays: np.ndarray           # 每个窗口的时差（采样点）
    lo: np.ndarray               # 参考区间下界
    hi: np.ndarray               # 参考区间上界
    slope_per_s: float           # 线性拟合斜率（采样点/秒）
    drift_samples: float         # 首尾窗口时差变化量
    changed: bool                # 是否判定为明显时变
    note: str = ""
