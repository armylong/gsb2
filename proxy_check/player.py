"""帧精确播放模型(不依赖 Qt, 可直接单测)。

时间轴以"原片帧"为单位: 单步、滑块、切换视图都不改变当前位置,
代理帧按帧号映射, 误差不超过一个源帧。
"""

from __future__ import annotations

from dataclasses import dataclass

from .ffmedia import MediaInfo


@dataclass
class FrameRef:
    index: int
    time: float


class PlayerModel:
    def __init__(self, source: MediaInfo, proxy: MediaInfo):
        self.source = source
        self.proxy = proxy
        self._index = 0
        self.playing = False

    # ---- 位置 -----------------------------------------------------------
    @property
    def frame_count(self) -> int:
        return self.source.nb_video_frames

    @property
    def index(self) -> int:
        return self._index

    def set_index(self, value: int) -> int:
        self._index = max(0, min(int(value), self.frame_count - 1))
        return self._index

    def step(self, delta: int) -> int:
        """按原片帧单步(可正可负), 到边界自动夹住。"""
        return self.set_index(self._index + delta)

    def play(self) -> None:
        if self.frame_count > 1:
            self.playing = True

    def pause(self) -> None:
        self.playing = False

    def toggle(self) -> bool:
        self.playing = not self.playing
        return self.playing

    def advance(self) -> int | None:
        """播放时钟每 tick 调用一次: 前进一步, 越过末帧则停下并返回 None。"""
        if not self.playing:
            return self._index
        if self._index >= self.frame_count - 1:
            self.playing = False
            return None
        self._index += 1
        return self._index

    # ---- 帧引用 ---------------------------------------------------------
    def source_ref(self) -> FrameRef:
        return FrameRef(self._index, self._index / self.source.frame_rate)

    def proxy_ref(self) -> FrameRef:
        # 同帧率 CFR: 同序号帧即同内容位置, 天然满足 <=1 源帧误差。
        pi = min(self._index, self.proxy.nb_video_frames - 1)
        return FrameRef(pi, pi / self.proxy.frame_rate)

    def source_pts(self) -> float:
        pts = self.source.packet_pts
        return pts[self._index] if pts else self._index / self.source.frame_rate

    def proxy_pts(self) -> float:
        ref = self.proxy_ref()
        pts = self.proxy.packet_pts
        return pts[ref.index] if pts else ref.time

    def frame_error(self) -> float:
        """当前位置两边实际 PTS 之差(秒), 用于界面展示对应误差。"""
        return abs(self.proxy_pts() - self.source_pts())
