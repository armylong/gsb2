"""数据模型: 轨道 / 片段 / 样本级时间信息."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple


@dataclass
class TrackInfo:
    track_id: int
    handler: str = "?"          # 'vide' / 'soun' / ...
    codec: str = "?"
    timescale: int = 0
    width: int = 0
    height: int = 0
    channels: int = 0
    sample_rate: int = 0
    default_sample_duration: int = 0
    default_sample_size: int = 0
    default_sample_flags: int = 0

    @property
    def kind_label(self) -> str:
        return {"vide": "视频", "soun": "音频"}.get(self.handler, self.handler)


@dataclass
class FragTrack:
    """一个 moof 内某条轨 (traf) 的样本表."""
    track_id: int
    tfdt: Optional[int]               # baseMediaDecodeTime, 轨道 timescale 单位
    sample_count: int
    durations: List[int]              # 每样本时长 (timescale 单位)
    sizes: List[int]
    cts_offsets: List[int]
    sync: List[bool]                  # 是否关键样本
    data_bytes_needed: int            # 样本数据总字节数
    covered_count: int = -1           # 数据实际覆盖的样本数 (-1 = 全部)

    def dts_list(self) -> List[int]:
        if self.tfdt is None:
            return []
        out, t = [], self.tfdt
        for d in self.durations:
            out.append(t)
            t += d
        return out

    def pts_range_units(self) -> Optional[Tuple[int, int]]:
        """(最早显示时间, 最晚显示结束时间), timescale 单位."""
        dts = self.dts_list()
        if not dts:
            return None
        starts = [d + c for d, c in zip(dts, self.cts_offsets)]
        ends = [s + d for s, d in zip(starts, self.durations)]
        return min(starts), max(ends)

    def pts_range_sec(self, timescale: int) -> Optional[Tuple[float, float]]:
        r = self.pts_range_units()
        if r is None or not timescale:
            return None
        return r[0] / timescale, r[1] / timescale

    def covered_pts_range_sec(self, timescale: int) -> Optional[Tuple[float, float]]:
        """只按数据实际覆盖到的样本计算显示时间范围 (截断片段的尾巴不算)."""
        if not timescale:
            return None
        n = self.sample_count if self.covered_count < 0 else self.covered_count
        if n <= 0:
            return None
        dts = self.dts_list()[:n]
        if not dts:
            return None
        starts = [d + c for d, c in zip(dts, self.cts_offsets[:n])]
        ends = [s + d for s, d in zip(starts, self.durations[:n])]
        return min(starts) / timescale, max(ends) / timescale

    def sample_pts_sec(self, timescale: int) -> List[float]:
        dts = self.dts_list()
        return [(d + c) / timescale for d, c in zip(dts, self.cts_offsets)]


@dataclass
class Segment:
    """一个媒体片段 (一个或多个 moof+mdat 的连续字节段)."""
    path: str                  # 来源文件
    byte_start: int
    byte_end: int
    order: int                 # 用户给定顺序中的序号
    sequence_number: Optional[int] = None
    frag_tracks: List[FragTrack] = field(default_factory=list)
    mdat_payload: int = 0      # 片段内 mdat 实际负载字节
    truncated: bool = False    # box 结构被截断
    issues: List[str] = field(default_factory=list)

    @property
    def label(self) -> str:
        import os
        return f"#{self.order} {os.path.basename(self.path)}"

    def track_pts_range_sec(self, track_id: int, timescale: int):
        for ft in self.frag_tracks:
            if ft.track_id == track_id:
                return ft.pts_range_sec(timescale)
        return None


@dataclass
class InitRef:
    """初始化信息 (ftyp+moov) 的字节来源."""
    path: str
    byte_start: int
    byte_end: int
    tracks: Dict[int, TrackInfo] = field(default_factory=dict)


@dataclass
class Issue:
    severity: str              # 'error' | 'warning'
    category: str              # 'init' | 'truncated' | 'order' | 'missing' | 'overlap' | 'timeline'
    message: str


@dataclass
class Presentation:
    init: Optional[InitRef]
    segments: List[Segment]
    issues: List[Issue] = field(default_factory=list)
    # track_id -> 连续覆盖区间 [(start_sec, end_sec), ...] (按 tfdt 排序后合并)
    coverage: Dict[int, List[Tuple[float, float]]] = field(default_factory=dict)

    @property
    def tracks(self) -> Dict[int, TrackInfo]:
        return self.init.tracks if self.init else {}

    def read_init_bytes(self) -> bytes:
        if not self.init:
            raise ValueError("缺少初始化片段 (moov)")
        with open(self.init.path, "rb") as f:
            f.seek(self.init.byte_start)
            return f.read(self.init.byte_end - self.init.byte_start)

    def read_segment_bytes(self, seg: Segment) -> bytes:
        with open(seg.path, "rb") as f:
            f.seek(seg.byte_start)
            return f.read(seg.byte_end - seg.byte_start)
