"""语音段检测、边界扩展与冲突消解。

整个流程只依赖标准库, 且所有边界都使用整数样本(frame)表示, 因此导出和
试听都能做到样本级一致。

参数含义
--------
window_ms / hop_ms
    分析窗长与窗移。每个窗口计算一次 RMS 电平。
open_db
    从静音进入语音的门限 (dBFS)。
close_db
    判定为静音的门限 (dBFS)。通常低于 open_db, 形成迟滞。
min_pause_ms
    只有不短于它的静音才切段; 更短的停顿保留在同一段内。
min_segment_ms
    短于它的原始语音段会被丢弃。
lead_ms / tail_ms
    向段首/段尾外扩的余量。
conflict_policy
    外扩后相邻段重叠时: ``merge`` 合并, ``truncate`` 在重叠中点截断。
keep_pinned
    重新分析时是否原样保留调用方给定的锁定段。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, replace
from typing import Iterable, Sequence

from .audio import AudioData


class SegmentationError(ValueError):
    """参数非法或分析结果不自洽。"""


_CONFLICT_POLICIES = ("merge", "truncate")


@dataclass(frozen=True)
class AnalysisParams:
    window_ms: float = 20.0
    hop_ms: float = 10.0
    open_db: float = -35.0
    close_db: float = -40.0
    min_pause_ms: float = 300.0
    min_segment_ms: float = 80.0
    lead_ms: float = 30.0
    tail_ms: float = 40.0
    conflict_policy: str = "merge"
    keep_pinned: bool = True

    def validate(self, audio: AudioData) -> None:
        finite = (self.window_ms, self.hop_ms, self.min_pause_ms,
                  self.min_segment_ms, self.lead_ms, self.tail_ms)
        if not all(math.isfinite(v) for v in finite):
            raise SegmentationError("时间参数必须是有限数值")
        if not (math.isfinite(self.open_db) and math.isfinite(self.close_db)):
            raise SegmentationError("门限必须是有限数值")
        if self.window_ms <= 0:
            raise SegmentationError("分析窗必须大于 0 ms")
        if self.hop_ms <= 0:
            raise SegmentationError("窗移必须大于 0 ms")
        if self.hop_ms > self.window_ms:
            raise SegmentationError("窗移不应大于分析窗, 否则会漏判语音")
        if self.open_db <= self.close_db:
            raise SegmentationError("开启门限必须高于关闭门限")
        if min(self.min_pause_ms, self.min_segment_ms, self.lead_ms, self.tail_ms) < 0:
            raise SegmentationError("停顿/最短段/余量参数不能为负")
        if self.conflict_policy not in _CONFLICT_POLICIES:
            raise SegmentationError(f"未知冲突策略: {self.conflict_policy}")
        if self.window_ms > audio.duration_seconds * 1000 + 1e-6:
            raise SegmentationError("分析窗长于整段音频")

    def to_dict(self) -> dict[str, object]:
        return {
            "window_ms": self.window_ms,
            "hop_ms": self.hop_ms,
            "open_db": self.open_db,
            "close_db": self.close_db,
            "min_pause_ms": self.min_pause_ms,
            "min_segment_ms": self.min_segment_ms,
            "lead_ms": self.lead_ms,
            "tail_ms": self.tail_ms,
            "conflict_policy": self.conflict_policy,
            "keep_pinned": self.keep_pinned,
        }


@dataclass(frozen=True)
class Segment:
    """[start, end) 帧区间。"""

    start: int
    end: int
    pinned: bool = False
    adjusted: bool = False
    origin: str = "auto"

    @property
    def length(self) -> int:
        return self.end - self.start

    def seconds(self, sample_rate: int) -> tuple[float, float]:
        return self.start / sample_rate, self.end / sample_rate

    def to_dict(self, index: int, sample_rate: int) -> dict[str, object]:
        start_s, end_s = self.seconds(sample_rate)
        return {
            "index": index,
            "start_sample": self.start,
            "end_sample": self.end,
            "start_seconds": start_s,
            "end_seconds": end_s,
            "duration_samples": self.length,
            "duration_seconds": self.length / sample_rate,
            "pinned": self.pinned,
            "adjusted": self.adjusted,
            "origin": self.origin,
        }


@dataclass(frozen=True)
class Envelope:
    """逐窗 RMS 电平, 便于调试或界面展示。"""

    frame_starts: tuple[int, ...]
    levels_db: tuple[float, ...]
    hop_samples: int
    window_samples: int


def _ms_to_samples(ms: float, sample_rate: int, *, minimum: int = 1) -> int:
    return max(minimum, int(round(ms * sample_rate / 1000.0)))


def compute_envelope(
    audio: AudioData, window_ms: float, hop_ms: float
) -> Envelope:
    """计算逐窗 RMS 电平 (dBFS), 末尾窗口对齐到音频结尾。"""
    mono, full_scale = audio.mono
    total = audio.frame_count
    window = min(total, _ms_to_samples(window_ms, audio.sample_rate))
    hop = _ms_to_samples(hop_ms, audio.sample_rate)

    starts: list[int] = list(range(0, max(1, total - window + 1), hop))
    last = max(0, total - window)
    if not starts:
        starts = [0]
    elif starts[-1] != last:
        starts.append(last)

    levels: list[float] = []
    for start in starts:
        chunk = mono[start : start + window]
        if not chunk:
            levels.append(-120.0)
            continue
        mean_square = sum(value * value for value in chunk) / len(chunk)
        rms = math.sqrt(mean_square)
        ratio = rms / full_scale if full_scale else 0.0
        levels.append(20.0 * math.log10(ratio) if ratio > 1e-12 else -120.0)
    return Envelope(tuple(starts), tuple(levels), hop, window)


def detect_speech(
    audio: AudioData, envelope: Envelope, params: AnalysisParams
) -> list[Segment]:
    """返回未经余量扩展的语音段。

    静音时长用“低于关闭门限的窗口数 × 窗移”估计: 窗口彼此重叠, 用窗口
    起点差会系统性少数一个窗长, 计数法则与窗移直接对应。
    """
    if not envelope.levels_db:
        return []
    hop = envelope.hop_samples
    min_pause_samples = params.min_pause_ms * audio.sample_rate / 1000.0

    segments: list[Segment] = []
    in_speech = False
    speech_start = 0
    silence_start: int | None = None
    silence_windows = 0

    for start, level in zip(envelope.frame_starts, envelope.levels_db):
        if not in_speech:
            if level >= params.open_db:
                in_speech = True
                speech_start = start
                silence_start = None
                silence_windows = 0
            continue

        if level > params.close_db:
            # 电平回到关闭门限以上: 刚才的“静音”只是短停顿, 撤销。
            silence_start = None
            silence_windows = 0
            continue

        if silence_start is None:
            silence_start = start
        silence_windows += 1
        if silence_windows * hop < min_pause_samples:
            # 还没长到最短停顿, 继续留在本段。
            continue
        # 段尾取静音起点, 语音尾巴不会被切掉。
        if silence_start > speech_start:
            segments.append(Segment(speech_start, silence_start))
        in_speech = False
        silence_start = None
        silence_windows = 0

    if in_speech and audio.frame_count > speech_start:
        segments.append(Segment(speech_start, audio.frame_count))

    # 丢弃过短的原始语音段
    min_len = _ms_to_samples(params.min_segment_ms, audio.sample_rate, minimum=1)
    return [seg for seg in segments if seg.length >= min_len]


def _expand(
    segments: Sequence[Segment], total: int, lead: int, tail: int
) -> list[Segment]:
    expanded: list[Segment] = []
    for seg in segments:
        start = max(0, seg.start - lead)
        end = min(total, seg.end + tail)
        if end > start:
            expanded.append(replace(seg, start=start, end=end))
    return expanded


def _merge_overlaps(segments: Sequence[Segment]) -> list[Segment]:
    merged: list[Segment] = []
    for seg in segments:
        if merged and seg.start < merged[-1].end:
            prev = merged[-1]
            merged[-1] = Segment(
                start=prev.start,
                end=max(prev.end, seg.end),
                pinned=prev.pinned or seg.pinned,
                adjusted=True,
                origin="merged",
            )
        else:
            merged.append(seg)
    return merged


def _truncate_overlaps(segments: Sequence[Segment]) -> list[Segment]:
    """把重叠的相邻段各退回一半, 重叠区间中点成为新的公共边界。

    若重叠已经把某一段完全吃掉 (中点落在段外), 该段被丢弃。
    """
    result: list[Segment] = []
    for seg in segments:
        current = seg
        if result and current.start < result[-1].end:
            prev = result[-1]
            cut = (prev.end + current.start) // 2
            # 中点必须同时落在两段内部, 否则说明重叠过大, 丢掉较短的一方。
            if prev.start < cut < prev.end and current.start < cut < current.end:
                result[-1] = replace(prev, end=cut)
                current = replace(current, start=cut)
            elif current.end - current.start <= prev.end - prev.start:
                current = replace(current, start=prev.end)
            else:
                result.pop()
        if current.end > current.start:
            result.append(current)
    return result


def _validate_pins(pins: Iterable[Segment], total: int) -> list[Segment]:
    cleaned: list[Segment] = []
    for pin in sorted(pins, key=lambda s: (s.start, s.end)):
        start = max(0, min(int(pin.start), total))
        end = max(0, min(int(pin.end), total))
        if end <= start:
            continue
        if cleaned and start < cleaned[-1].end:
            # 锁定段之间若人为重叠: 前一段优先, 后一段起点后移。
            start = cleaned[-1].end
            if end <= start:
                continue
        origin = pin.origin if pin.origin in ("manual", "pinned") else "pinned"
        cleaned.append(
            Segment(
                start=start,
                end=end,
                pinned=True,
                adjusted=pin.adjusted or start != pin.start or end != pin.end,
                origin=origin,
            )
        )
    return cleaned


def _subtract(
    autos: Sequence[Segment], pins: Sequence[Segment], min_len: int
) -> list[Segment]:
    """从自动段中抠掉锁定区间, 锁定段本身原样保留。"""
    remnants: list[Segment] = []
    for auto in autos:
        pieces: list[tuple[int, int]] = [(auto.start, auto.end)]
        for pin in pins:
            if pin.end <= auto.start or pin.start >= auto.end:
                continue
            next_pieces: list[tuple[int, int]] = []
            for start, end in pieces:
                if pin.end <= start or pin.start >= end:
                    next_pieces.append((start, end))
                    continue
                if start < pin.start:
                    next_pieces.append((start, pin.start))
                if pin.end < end:
                    next_pieces.append((pin.end, end))
            pieces = next_pieces
        for start, end in pieces:
            if end - start >= min_len:
                remnants.append(replace(auto, start=start, end=end,
                                        origin="auto-trimmed"))
    return remnants


def analyze(
    audio: AudioData,
    params: AnalysisParams | None = None,
    *,
    pins: Sequence[Segment] | None = None,
    envelope: Envelope | None = None,
) -> list[Segment]:
    """完整分析流程。

    ``pins`` 是人工调整过的段, 当 ``params.keep_pinned`` 为真时原样保留,
    自动结果中与它们重叠的部分会被裁掉。返回结果始终按起点排序、互不重叠、
    位于 ``[0, frame_count]`` 内。
    """
    params = params or AnalysisParams()
    params.validate(audio)
    if envelope is not None and (
        envelope.hop_samples != _ms_to_samples(params.hop_ms, audio.sample_rate)
        or envelope.window_samples
        != min(
            audio.frame_count,
            _ms_to_samples(params.window_ms, audio.sample_rate),
        )
    ):
        raise SegmentationError("传入的包络与当前分析参数不匹配")
    env = envelope or compute_envelope(audio, params.window_ms, params.hop_ms)
    raw = detect_speech(audio, env, params)
    lead = _ms_to_samples(params.lead_ms, audio.sample_rate, minimum=0)
    tail = _ms_to_samples(params.tail_ms, audio.sample_rate, minimum=0)
    expanded = _expand(raw, audio.frame_count, lead, tail)

    if params.conflict_policy == "merge":
        resolved = _merge_overlaps(expanded)
    else:
        resolved = _truncate_overlaps(expanded)

    if params.keep_pinned and pins:
        pinned = _validate_pins(pins, audio.frame_count)
        if pinned:
            min_len = _ms_to_samples(params.min_segment_ms, audio.sample_rate, minimum=1)
            resolved = _subtract(resolved, pinned, min_len)
            resolved = sorted([*pinned, *resolved], key=lambda s: (s.start, s.end))

    _assert_invariants(resolved, audio.frame_count)
    return resolved


def _assert_invariants(segments: Sequence[Segment], total: int) -> None:
    previous_end = 0
    for seg in segments:
        if not (0 <= seg.start < seg.end <= total):
            raise SegmentationError(
                f"内部错误: 段 [{seg.start}, {seg.end}) 越界, 总长 {total}"
            )
        if seg.start < previous_end:
            raise SegmentationError(
                f"内部错误: 段 [{seg.start}, {seg.end}) 与前段重叠"
            )
        previous_end = seg.end
