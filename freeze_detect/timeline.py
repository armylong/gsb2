"""使用 ffprobe 读取每个视频帧的真实展示时长。

要点：
* 逐帧的 ``pts_time`` / ``duration_time`` 来自容器(PTS 差值)，是"实际展示时长"
  的权威来源；不能用恒定帧率去推算。
* 部分容器(如 mkv)的帧没有 duration_time，这里用下一帧 pts 补齐。
* 流起始时间不是 0 时，所有时间都换算为相对流起点的时间轴，
  这样冻结区间给出的 [start, end) 可直接用于 ffmpeg 的 ``-ss``。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple


class FFmpegError(RuntimeError):
    """ffmpeg/ffprobe 调用失败。"""


def require_binary(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise FFmpegError(f"找不到 {name}，请先安装 ffmpeg 并确认在 PATH 中")
    return path


def _median(values: List[float]) -> Optional[float]:
    if not values:
        return None
    values = sorted(values)
    n = len(values)
    if n % 2:
        return values[n // 2]
    return 0.5 * (values[n // 2 - 1] + values[n // 2])


@dataclass
class VideoTimeline:
    path: str
    width: int
    height: int
    stream_index: int
    start_time: float
    pts: List[float] = field(default_factory=list)
    durations: List[float] = field(default_factory=list)
    # 时长来源：True=容器逐帧 duration_time；False=由相邻 pts 推算
    exact: List[bool] = field(default_factory=list)
    is_vfr: bool = False
    codec: str = ""
    stream_duration: Optional[float] = None
    fps_nominal: Optional[float] = None

    @property
    def frame_count(self) -> int:
        return len(self.pts)

    @property
    def duration(self) -> float:
        """整段视频覆盖的时长(秒)，以逐帧时长累加为准。"""
        if not self.pts:
            return 0.0
        return self.pts[-1] + self.durations[-1]

    def frame_end(self, i: int) -> float:
        return self.pts[i] + self.durations[i]

    def frame_time_range(self, i: int) -> Tuple[float, float]:
        return self.pts[i], self.frame_end(i)

    def index_at(self, t: float) -> int:
        """返回覆盖时间 t 的帧下标(二分查找)。"""
        if not self.pts:
            return 0
        lo, hi = 0, len(self.pts) - 1
        if t <= self.pts[0]:
            return 0
        if t >= self.frame_end(hi):
            return hi
        while lo < hi:
            mid = (lo + hi + 1) // 2
            if self.pts[mid] <= t:
                lo = mid
            else:
                hi = mid - 1
        return lo

    def timing_exact_count(self) -> int:
        return sum(1 for e in self.exact if e)


def _probe_json(path: str, entries: str) -> dict:
    cmd = [
        require_binary("ffprobe"),
        "-hide_banner",
        "-v",
        "error",
        "-show_entries",
        entries,
        "-of",
        "json",
        path,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise FFmpegError(f"ffprobe 读取失败: {proc.stderr.strip()[-500:]}")
    return json.loads(proc.stdout or "{}")


def _float_or_none(value) -> Optional[float]:
    if value is None or value == "N/A":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _parse_rate(rate: Optional[str]) -> Optional[float]:
    if not rate:
        return None
    if "/" in rate:
        num, den = rate.split("/", 1)
        try:
            n, d = float(num), float(den)
        except ValueError:
            return None
        if d == 0:
            return None
        return n / d
    return _float_or_none(rate)


def read_timeline(path: str) -> VideoTimeline:
    """读取视频的逐帧真实展示时长。"""
    if not os.path.exists(path):
        raise FFmpegError(f"文件不存在: {path}")

    info = _probe_json(
        path,
        "stream=index,codec_type,codec_name,width,height,time_base,start_time,"
        "duration,avg_frame_rate,r_frame_rate,nb_frames",
    )
    video_streams = [
        s for s in info.get("streams", []) if s.get("codec_type") == "video"
    ]
    if not video_streams:
        raise FFmpegError(f"文件中没有视频流: {path}")
    stream = video_streams[0]

    frames = _probe_json(
        path, "frame=stream_index,pts,pts_time,duration,duration_time"
    ).get("frames", [])
    sel = int(stream["index"])
    frames = [f for f in frames if int(f.get("stream_index", 0)) == sel]
    if not frames:
        raise FFmpegError(f"视频没有可用的帧信息: {path}")

    width = int(stream.get("width") or 0)
    height = int(stream.get("height") or 0)
    if width <= 0 or height <= 0:
        raise FFmpegError("无法获取视频分辨率")

    frames.sort(key=lambda f: _float_or_none(f.get("pts_time")) or 0.0)

    start = _float_or_none(stream.get("start_time"))
    if start is None:
        start = _float_or_none(frames[0].get("pts_time")) or 0.0

    pts = [(_float_or_none(f.get("pts_time")) or 0.0) - start for f in frames]
    # 去重/保持单调：极端情况下同一时间戳重复，用递增补齐
    for i in range(1, len(pts)):
        if pts[i] < pts[i - 1]:
            pts[i] = pts[i - 1]
    if pts and pts[0] < 0:
        pts = [max(p, 0.0) for p in pts]

    durations: List[float] = []
    exact: List[bool] = []
    for i, f in enumerate(frames):
        dv = _float_or_none(f.get("duration_time"))
        if dv is not None and dv > 1e-9:
            durations.append(dv)
            exact.append(True)
            continue
        if i + 1 < len(pts) and pts[i + 1] > pts[i]:
            durations.append(pts[i + 1] - pts[i])
        else:
            durations.append(float("nan"))
        exact.append(False)

    # 末帧缺失：用容器流时长或前一帧时长
    # stream.duration 相对流自身的时间轴
    stream_duration_rel = _float_or_none(stream.get("duration"))

    if durations and durations[-1] != durations[-1]:  # NaN
        if stream_duration_rel is not None and stream_duration_rel > pts[-1]:
            durations[-1] = stream_duration_rel - pts[-1]
        else:
            fallback = _median([d for d in durations[:-1] if d == d and d > 0])
            durations[-1] = fallback or (1.0 / 30.0)

    if durations and durations[0] <= 0:
        nxt = _median([d for d in durations[1:] if d > 0])
        durations[0] = nxt or (1.0 / 30.0)

    # 末帧若来自容器流时长，允许它比相邻帧推算值更准一些
    if (
        durations
        and stream_duration_rel is not None
        and not exact[-1]
        and stream_duration_rel >= pts[-1]
    ):
        durations[-1] = max(stream_duration_rel - pts[-1], durations[-1])

    if not durations:
        raise FFmpegError("没有解析到任何帧时长")

    positive = [d for d in durations if d > 0]
    median = _median(positive) or 0.0
    is_vfr = False
    if median > 0 and len(positive) > 1:
        deviations = sorted(abs(d - median) / median for d in positive)
        p95 = deviations[min(len(deviations) - 1, int(len(deviations) * 0.95))]
        is_vfr = p95 > 0.02

    nominal = _parse_rate(stream.get("r_frame_rate"))
    if nominal and nominal > 1000:
        nominal = None

    return VideoTimeline(
        path=path,
        width=width,
        height=height,
        stream_index=sel,
        start_time=start,
        pts=pts,
        durations=durations,
        exact=exact,
        is_vfr=is_vfr,
        codec=str(stream.get("codec_name") or ""),
        stream_duration=stream_duration_rel,
        fps_nominal=nominal,
    )


def probe_summary(path: str) -> Dict[str, object]:
    """用于界面展示的简要元数据。"""
    info = _probe_json(path, "format=format_name,duration")
    return info.get("format", {})
