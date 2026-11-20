"""冻结检测核心。

判定一个"停住画面"需要同时满足：

1. 相邻两帧足够相似(短时变化极小)；
2. 相对本段锚点帧的累计漂移仍然很小 —— 由此排除慢速变化/慢摇镜头；
3. 这一段画面的**实际展示时长**(逐帧 PTS 差值之和)不小于最短持续时间。

时长一律取自容器里的逐帧时长，因此不等间隔(VFR)视频、"开头/结尾冻结"、
"单帧长驻留"(某帧被展示了很久)都能得到正确的时间范围。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Tuple

import numpy as np

from .config import DetectionParams
from .frames import feature_grid, grid_distance, iter_gray_frames
from .timeline import VideoTimeline

ProgressCallback = Callable[[int, int], None]

_LABELS = {
    "freeze": "冻结",
    "black": "黑场",
    "static": "静态画面",
}


def _pl(n: int) -> int:
    n = int(n)
    return n - 1 if n >= 2 else 1


def frame_difference(
    a: np.ndarray, b: np.ndarray, tile: int
) -> Tuple[float, float]:
    """兼容旧接口：对整帧直接做分块差异。新代码请用特征网格。"""
    if a.shape != b.shape:
        raise ValueError("两帧尺寸不一致")
    diff = np.abs(np.subtract(a, b, dtype=np.int16)).astype(np.float32) / 255.0
    mae = float(diff.mean())
    h, w = diff.shape
    th, tw = h // tile, w // tile
    if th == 0 or tw == 0:
        return mae, mae
    diff = diff[: th * tile, : tw * tile]
    blocks = diff.reshape(th, tile, tw, tile).mean(axis=(1, 3))
    return mae, float(np.percentile(blocks, 99.0))


def frame_distance(a: np.ndarray, b: np.ndarray, tile: int) -> float:
    """两帧距离(取均值与 p99 的较大者)，用于测试与调试。"""
    mae, p99 = frame_difference(a, b, tile)
    return max(mae, p99)


@dataclass
class FrameInfo:
    index: int
    start: float
    end: float

    @property
    def start_ms(self) -> int:
        return int(round(self.start * 1000))

    @property
    def mid(self) -> float:
        return 0.5 * (self.start + self.end)


@dataclass
class Segment:
    start_frame: int
    end_frame: int
    start_time: float
    end_time: float
    duration: float
    frame_count: int
    min_step_similarity: float
    max_drift: float
    mean_luma: float
    auto_kind: str = "freeze"  # freeze / black / static
    label: str = ""  # "" / static / black / skip
    note: str = ""
    context_before: List[FrameInfo] = field(default_factory=list)
    context_after: List[FrameInfo] = field(default_factory=list)
    timing_exact: bool = True
    single_held_frame: bool = False

    @property
    def start_ms(self) -> int:
        return int(round(self.start_time * 1000))

    @property
    def end_ms(self) -> int:
        return int(round(self.end_time * 1000))

    @property
    def duration_ms(self) -> int:
        return int(round(self.duration * 1000))

    @property
    def ignored(self) -> bool:
        """人工标注为静态/黑场/忽略的段，不计入卡顿问题。"""
        return self.label in ("static", "black", "skip")

    @property
    def kind_display(self) -> str:
        return _LABELS.get(self.auto_kind, self.auto_kind)

    @property
    def label_display(self) -> str:
        return {
            "": "未标注",
            "static": "静态画面",
            "black": "黑场",
            "skip": "忽略",
        }.get(self.label, self.label)

    @property
    def key(self) -> str:
        return f"{self.start_ms}:{self.end_ms}"

    @property
    def frame_range_text(self) -> str:
        return f"{self.start_frame}-{self.end_frame}"

    def to_dict(self) -> Dict[str, object]:
        return {
            "start_frame": self.start_frame,
            "end_frame": self.end_frame,
            "start_ms": self.start_ms,
            "end_ms": self.end_ms,
            "duration_ms": self.duration_ms,
            "frame_count": self.frame_count,
            "min_step_similarity": round(self.min_step_similarity, 6),
            "max_drift": round(self.max_drift, 6),
            "mean_luma": round(self.mean_luma, 4),
            "auto_kind": self.auto_kind,
            "label": self.label,
            "note": self.note,
            "single_held_frame": self.single_held_frame,
            "timing_exact": self.timing_exact,
            "context_before": [
                {"index": f.index, "start_ms": f.start_ms}
                for f in self.context_before
            ],
            "context_after": [
                {"index": f.index, "start_ms": f.start_ms}
                for f in self.context_after
            ],
        }


@dataclass
class AnalysisResult:
    timeline: VideoTimeline
    params: DetectionParams
    segments: List[Segment]
    frame_luma: List[float]
    step_distance: List[float]
    anchor_distance: List[float]
    frames_gray: List[np.ndarray] = field(default_factory=list, repr=False)
    warning: str = ""

    @property
    def active_segments(self) -> List[Segment]:
        return [s for s in self.segments if not s.ignored]

    def to_dict(self) -> Dict[str, object]:
        return {
            "video": self.timeline.path,
            "width": self.timeline.width,
            "height": self.timeline.height,
            "is_vfr": self.timeline.is_vfr,
            "duration_ms": int(round(self.timeline.duration * 1000)),
            "frame_count": self.timeline.frame_count,
            "start_time": self.timeline.start_time,
            "params": self.params.as_dict(),
            "segments": [s.to_dict() for s in self.segments],
            "warning": self.warning,
        }


def _context(
    timeline: VideoTimeline, anchor: int, direction: int, count: int
) -> List[FrameInfo]:
    """取某帧之前/之后各 count 帧(不越界)。"""
    if count <= 0:
        return []
    total = timeline.frame_count
    if direction < 0:
        indices = range(max(0, anchor - count), anchor)
    else:
        indices = range(anchor + 1, min(total, anchor + 1 + count))
    return [
        FrameInfo(i, timeline.pts[i], timeline.frame_end(i)) for i in indices
    ]


def analyze(
    timeline: VideoTimeline,
    params: DetectionParams,
    progress: Optional[ProgressCallback] = None,
) -> AnalysisResult:
    """逐帧分析视频，返回检测结果(含相似度曲线与前后上下文帧)。"""
    step_tol = params.distance_threshold
    drift_tol = params.effective_drift_tolerance

    grays: List[np.ndarray] = []
    grids: List[np.ndarray] = []
    frame_luma: List[float] = []
    step_distance: List[float] = []
    anchor_distance: List[float] = []
    segs: List[Segment] = []

    anchor: Optional[np.ndarray] = None
    run_start = 0
    run_max_step = 0.0
    run_max_drift = 0.0
    prev: Optional[np.ndarray] = None
    decoded = 0

    def close_run(end_index: int) -> None:
        nonlocal run_start, run_max_step, run_max_drift, anchor
        if anchor is None or end_index < run_start:
            return
        start_time = timeline.pts[run_start]
        end_time = timeline.frame_end(end_index)
        duration = end_time - start_time
        single = end_index == run_start
        hold = single and duration * 1000.0 >= params.hold_duration_ms
        if duration + 1e-9 < params.min_duration_ms / 1000.0 and not hold:
            return
        frames = range(run_start, end_index + 1)
        exact = all(timeline.exact[i] for i in frames)
        luma = float(np.mean([frame_luma[i] for i in frames]))
        if luma <= params.black_luma:
            auto_kind = "black"
        elif (not single) and duration * 1000.0 >= params.static_hint_ms:
            auto_kind = "static"
        else:
            # 单帧长驻留是"同一画面被展示了很久"，本质上仍是卡顿冻结，
            # 即便时长超过 static_hint_ms 也不能当作静态画面忽略。
            auto_kind = "freeze"
        segs.append(
            Segment(
                start_frame=run_start,
                end_frame=end_index,
                start_time=start_time,
                end_time=end_time,
                duration=duration,
                frame_count=end_index - run_start + 1,
                min_step_similarity=1.0 - run_max_step,
                max_drift=run_max_drift,
                mean_luma=luma,
                auto_kind=auto_kind,
                context_before=_context(
                    timeline, run_start, -1, params.context_before
                ),
                context_after=_context(
                    timeline, end_index, +1, params.context_after
                ),
                timing_exact=exact,
                single_held_frame=single,
            )
        )

    # 单帧长驻留（解码器卡住、下一帧在很久之后才出现）不会形成"相邻帧相似"
    # 的运行段，因此在扫描时单独识别；与普通冻结段按帧区间去重。
    # 同时要求它明显长于本片的典型帧间隔，避免低帧率视频被整片误报。
    positive = sorted(d for d in timeline.durations if d > 0)
    median_dur = positive[len(positive) // 2] if positive else 0.0
    hold_threshold = max(
        params.hold_duration_ms / 1000.0, 3.0 * median_dur
    )
    holds = {
        i
        for i in range(timeline.frame_count)
        if timeline.durations[i] >= hold_threshold
    }

    for index, gray in iter_gray_frames(timeline, params.analysis_width, progress):
        if index >= timeline.frame_count:
            break
        decoded = index + 1
        grays.append(gray)
        grid = feature_grid(gray, params.tile)
        grids.append(grid)
        frame_luma.append(float(grid.mean()))

        if prev is None:
            step_distance.append(0.0)
            anchor_distance.append(0.0)
            anchor = grid
            run_start = index
            run_max_step = 0.0
            run_max_drift = 0.0
            prev = grid
            continue

        step = max(grid_distance(prev, grid))
        assert anchor is not None
        drift = max(grid_distance(anchor, grid))
        step_distance.append(step)
        anchor_distance.append(drift)

        if step <= step_tol and drift <= drift_tol:
            run_max_step = max(run_max_step, step)
            run_max_drift = max(run_max_drift, drift)
        else:
            close_run(index - 1)
            run_start = index
            anchor = grid
            run_max_step = 0.0
            run_max_drift = 0.0
        prev = grid

    if decoded:
        close_run(decoded - 1)

    # 把"单帧长驻留"补成独立片段（若它尚未被普通相似段覆盖）
    covered = set()
    for seg in segs:
        covered.update(range(seg.start_frame, seg.end_frame + 1))
    for index in sorted(holds):
        if index in covered or index >= decoded:
            continue
        luma = frame_luma[index] if index < len(frame_luma) else 0.0
        duration = timeline.durations[index]
        auto_kind = "black" if luma <= params.black_luma else "freeze"
        segs.append(
            Segment(
                start_frame=index,
                end_frame=index,
                start_time=timeline.pts[index],
                end_time=timeline.frame_end(index),
                duration=duration,
                frame_count=1,
                min_step_similarity=1.0,
                max_drift=0.0,
                mean_luma=luma,
                auto_kind=auto_kind,
                context_before=_context(
                    timeline, index, -1, params.context_before
                ),
                context_after=_context(
                    timeline, index, +1, params.context_after
                ),
                timing_exact=timeline.exact[index],
                single_held_frame=True,
            )
        )

    # 只保留真正解码过的帧
    segs = [s for s in segs if s.end_frame < decoded]
    segs.sort(key=lambda s: (s.start_frame, s.end_frame))

    warning = ""
    if decoded and decoded < timeline.frame_count:
        warning = (
            f"解码帧数({decoded})少于容器帧数({timeline.frame_count})，"
            "已按实际解码帧计算"
        )

    return AnalysisResult(
        timeline=timeline,
        params=params,
        segments=segs,
        frame_luma=frame_luma,
        step_distance=step_distance,
        anchor_distance=anchor_distance,
        frames_gray=grays,
        warning=warning,
    )


def format_timecode(seconds: float) -> str:
    """秒 -> HH:MM:SS.mmm"""
    ms = int(round(max(seconds, 0.0) * 1000))
    h, rem = divmod(ms, 3600_000)
    m, rem = divmod(rem, 60_000)
    s, ms = divmod(rem, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def summarize(result: AnalysisResult) -> Dict[str, object]:
    """给命令行/界面用的汇总统计。"""
    active = result.active_segments
    return {
        "total": len(result.segments),
        "active": len(active),
        "ignored": len(result.segments) - len(active),
        "active_duration_ms": int(round(sum(s.duration for s in active) * 1000)),
        "by_kind": {
            kind: sum(1 for s in result.segments if s.auto_kind == kind)
            for kind in ("freeze", "static", "black")
        },
        "longest_active_ms": max(
            (s.duration_ms for s in active), default=0
        ),
    }
