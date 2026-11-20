"""自动时间对应关系分析.

流程概要:

1. 从两份录音各提取梅尔对数特征 (采样率可以不同, 统一到 16 kHz 分析)。
2. 在待对齐录音上每 0.5 s 取一个 2 s 窗口, 对参考录音所有可能起点做
   滑动余弦相似度, 保留若干局部峰作为候选。
3. 用动态规划在候选之间连出一条时间单调的路径; 允许跳过一段
   (即待对齐录音缺失中间内容), 但不允许时间倒流。
4. 用带通波形做局部互相关微调, 得到毫秒级对应点。
5. 识别缺失区间 (待对齐录音中不存在、但参考录音中存在的区间) 与
   置信不足区间, 生成单调的分段线性时间映射。

所有对外时间量单位为秒。
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, replace
from typing import Iterable, Sequence

import numpy as np

from .audio import AudioClip
from .features import (
    AlignmentError,
    FeatureSet,
    detect_silent_frames,
    extract_features,
    local_peaks,
    refine_with_waveform,
    window_scores,
)

# ---- 可调参数 (集中放在这里便于验证与调整) --------------------------------

PROBE_WINDOW_S = 2.0
PROBE_STEP_S = 0.5
PROBE_TOP_K = 30
PEAK_MIN_SEPARATION_S = 0.15
PEAK_MIN_SCORE = 0.03
DP_MAX_SKIP_PROBES = 16
DP_SLOPE_LO = 0.85
DP_SLOPE_HI = 1.18
DP_SLOPE_PENALTY = 500.0
DP_GAP_PENALTY = 0.80
DP_AMBIGUOUS_MARGIN = 0.10
DP_AMBIGUOUS_SCORE = 0.30
GAP_MIN_REF_EXCESS_S = 0.60
GAP_BOUNDARY_WINDOW_S = 0.20
WAVEFORM_REFINE_WINDOW_S = 0.30
WAVEFORM_REFINE_SEARCH_S = 0.060
WAVEFORM_REFINE_MIN_NCC = 0.50
LOCAL_CONSISTENCY_WINDOW_S = 3.0
LOCAL_CONSISTENCY_MAX_RESIDUAL_S = 0.030
KNOT_STEP_S = 0.75
LOW_CONF_WINDOW_PAD_S = 0.75
SLOPE_WARN_LO = 0.60
SLOPE_WARN_HI = 1.60
MISMATCH_MIN_SCORE = 0.35
MISMATCH_MIN_NCC = 0.25


# ---- 基础数据结构 -----------------------------------------------------------


@dataclass
class Probe:
    take_time: float
    take_frame: int
    window_s: float
    score_curve: np.ndarray
    candidates: list[tuple[float, float]]  # [(参考时间, 得分)]
    energy: float
    ambiguous: bool = False
    margin: float = 1.0

    @property
    def best_ref(self) -> float:
        return self.candidates[0][0]

    @property
    def best_score(self) -> float:
        return self.candidates[0][1]


@dataclass
class MatchPoint:
    """一个可核对的对应点: 待对齐录音时刻 <-> 参考录音时刻 (窗口中心)。"""

    take_time: float
    ref_time: float
    score: float
    margin: float
    ambiguous: bool
    source: str = "auto"  # "auto" | "manual"
    refined: bool = False
    ncc: float = 0.0

    def as_dict(self) -> dict:
        return {
            "take_s": round(self.take_time, 4),
            "ref_s": round(self.ref_time, 4),
            "score": round(self.score, 4),
            "margin": round(self.margin, 4),
            "ambiguous": self.ambiguous,
            "refined": self.refined,
            "ncc": round(self.ncc, 4),
            "source": self.source,
        }


@dataclass
class GapRegion:
    """参考时间轴上没有对应待对齐录音声音的区间。

    kind:
        "missing"   待对齐录音缺失的中间内容 -> 导出静音, 显著标记
        "lead_in"   待对齐录音开始之前
        "lead_out"  待对齐录音结束之后
    """

    ref_start: float
    ref_end: float
    take_time: float
    kind: str

    @property
    def duration(self) -> float:
        return max(0.0, self.ref_end - self.ref_start)

    @property
    def label(self) -> str:
        return {
            "missing": "缺失区间",
            "lead_in": "参考开头无对应录音",
            "lead_out": "参考结尾无对应录音",
        }.get(self.kind, self.kind)

    def contains(self, t: float) -> bool:
        return self.ref_start - 1e-9 <= t < self.ref_end - 1e-9

    def as_dict(self) -> dict:
        return {
            "kind": self.kind,
            "ref_start_s": round(self.ref_start, 4),
            "ref_end_s": round(self.ref_end, 4),
            "duration_s": round(self.duration, 4),
            "take_time_s": round(self.take_time, 4),
            "label": self.label,
        }


@dataclass
class LowConfidenceRegion:
    ref_start: float
    ref_end: float
    reason: str
    severity: str = "warning"  # "warning" | "info"

    def as_dict(self) -> dict:
        return {
            "ref_start_s": round(self.ref_start, 4),
            "ref_end_s": round(self.ref_end, 4),
            "reason": self.reason,
            "severity": self.severity,
        }


@dataclass
class Anchor:
    """人工锚点: 参考时间 <-> 待对齐录音时间。"""

    ref_time: float
    take_time: float
    note: str = ""

    def as_dict(self) -> dict:
        return {
            "ref_s": round(self.ref_time, 4),
            "take_s": round(self.take_time, 4),
            "note": self.note,
        }

    def copy(self) -> "Anchor":
        return Anchor(self.ref_time, self.take_time, self.note)


class AnchorConflictError(AlignmentError):
    """人工锚点导致时间顺序冲突。"""


@dataclass
class TrendSummary:
    segments: list[dict] = field(default_factory=list)
    samples: list[dict] = field(default_factory=list)
    overall_drift_percent: float | None = None
    notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "segments": self.segments,
            "samples": self.samples,
            "overall_drift_percent": (
                None if self.overall_drift_percent is None
                else round(self.overall_drift_percent, 4)
            ),
            "notes": self.notes,
        }


# ---- 时间映射 ---------------------------------------------------------------


@dataclass
class TimelineCurve:
    """从参考时间到待对齐录音时间的分段线性单调映射。

    knots_ref 严格递增; knots_take 非递减。缺失区间内 take 保持不变;
    take 值可以小于 0 或大于待对齐录音时长, 表示该参考区间没有声音。
    """

    knots_ref: np.ndarray
    knots_take: np.ndarray
    gaps: list[GapRegion] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.knots_ref = np.asarray(self.knots_ref, dtype=np.float64)
        self.knots_take = np.asarray(self.knots_take, dtype=np.float64)
        if len(self.knots_ref) != len(self.knots_take):
            raise ValueError("映射节点长度不一致")
        if len(self.knots_ref) < 2:
            raise ValueError("映射至少需要两个节点")
        if np.any(np.diff(self.knots_ref) <= 0):
            raise ValueError("参考时间节点必须严格递增")
        if np.any(np.diff(self.knots_take) < -1e-9):
            raise ValueError("映射出现时间倒流")

    def take_time_at(self, ref_time: float | np.ndarray):
        return np.interp(ref_time, self.knots_ref, self.knots_take)

    def ref_time_at(self, take_time: float | np.ndarray):
        """逆映射; 缺失接缝处 (take 平台) 取缺失区间中点。"""

        scalar = np.ndim(take_time) == 0
        t = np.atleast_1d(np.asarray(take_time, dtype=np.float64))
        x = np.interp(t, self.knots_take, self.knots_ref)
        for gap in self.gaps:
            if gap.kind != "missing":
                continue
            plateau = np.isclose(t, gap.take_time, atol=0.0015)
            if np.any(plateau):
                x = np.where(plateau, 0.5 * (gap.ref_start + gap.ref_end), x)
        return float(x[0]) if scalar else x

    def local_slope(self, ref_time: float) -> float:
        idx = int(np.searchsorted(self.knots_ref, float(ref_time), side="right") - 1)
        idx = max(0, min(idx, len(self.knots_ref) - 2))
        dr = self.knots_ref[idx + 1] - self.knots_ref[idx]
        if dr <= 0:
            return 0.0
        return float((self.knots_take[idx + 1] - self.knots_take[idx]) / dr)

    def gap_at(self, ref_time: float) -> GapRegion | None:
        for gap in self.gaps:
            if gap.contains(ref_time):
                return gap
        return None

    def as_dict(self) -> dict:
        return {
            "knots_ref_s": [round(float(v), 5) for v in self.knots_ref],
            "knots_take_s": [round(float(v), 5) for v in self.knots_take],
            "gaps": [g.as_dict() for g in self.gaps],
        }


# ---- 分析结果 ---------------------------------------------------------------


@dataclass
class AlignmentResult:
    ref_clip: AudioClip
    take_clip: AudioClip
    matches: list[MatchPoint]
    probes: list[Probe]
    curve: TimelineCurve
    gaps: list[GapRegion]
    low_confidence: list[LowConfidenceRegion]
    trend: TrendSummary
    anchors: list[Anchor] = field(default_factory=list)
    auto_curve: TimelineCurve | None = None
    warnings: list[str] = field(default_factory=list)
    analysis_params: dict = field(default_factory=dict)
    signature: str = ""

    @property
    def ref_duration(self) -> float:
        return self.ref_clip.duration

    @property
    def take_duration(self) -> float:
        return self.take_clip.duration

    @property
    def missing_gaps(self) -> list[GapRegion]:
        return [g for g in self.gaps if g.kind == "missing"]

    @property
    def coverage_regions(self) -> list[tuple[float, float]]:
        """参考时间轴上确实有声音对应的区间。"""

        out: list[tuple[float, float]] = []
        cursor = 0.0
        for gap in sorted(self.gaps, key=lambda g: g.ref_start):
            if gap.ref_start > cursor + 1e-6:
                out.append((cursor, gap.ref_start))
            cursor = max(cursor, gap.ref_end)
        if cursor < self.ref_duration - 1e-6:
            out.append((cursor, self.ref_duration))
        return out

    def matches_at(self, ref_time: float, radius: float = 0.6) -> list[MatchPoint]:
        return [m for m in self.matches if abs(m.ref_time - ref_time) <= radius]

    def gap_at(self, ref_time: float) -> GapRegion | None:
        return self.curve.gap_at(ref_time)

    def with_anchors(self, anchors: Sequence[Anchor]) -> "AlignmentResult":
        """按给定人工锚点重建映射; 非法锚点抛 AnchorConflictError。"""

        cleaned = validate_anchors(anchors, self)
        base = self.auto_curve if self.auto_curve is not None else self.curve
        curve = build_curve_with_anchors(
            base, self.gaps, cleaned, self.take_duration, self.ref_duration
        )
        low = _apply_anchor_confidence(self.low_confidence, cleaned)
        trend = summarise_trend(curve, self.ref_duration, self.take_duration, self.gaps)
        warnings = [w for w in self.warnings if not w.startswith("人工锚点")]
        warnings.append(f"已应用 {len(cleaned)} 个人工锚点, 相邻时间对应关系已按锚点更新")
        return replace(
            self,
            anchors=list(cleaned),
            curve=curve,
            low_confidence=low,
            trend=trend,
            warnings=warnings,
            auto_curve=base,
        )

    def description_dict(self) -> dict:
        return {
            "tool": "dualalign",
            "format_version": 1,
            "roles": {
                "reference": "时间基准, 未做任何时间调整",
                "aligned_take": "经过时间映射/拉伸的待对齐录音, 已放到参考时间轴上",
            },
            "reference": {
                "file": self.ref_clip.path.name,
                "duration_s": round(self.ref_duration, 5),
                "sample_rate": self.ref_clip.sample_rate,
                "channels": self.ref_clip.channels,
            },
            "take": {
                "file": self.take_clip.path.name,
                "duration_s": round(self.take_duration, 5),
                "sample_rate": self.take_clip.sample_rate,
                "channels": self.take_clip.channels,
                "original_sha256": self.take_clip.file_sha256(),
            },
            "output_timeline": "reference",
            "anchors": [a.as_dict() for a in self.anchors],
            "gaps": [g.as_dict() for g in self.gaps],
            "low_confidence": [r.as_dict() for r in self.low_confidence],
            "valid_sound_regions_s": [
                [round(a, 4), round(b, 4)] for a, b in self.coverage_regions
            ],
            "trend": self.trend.as_dict(),
            "matches": [m.as_dict() for m in self.matches],
            "curve": self.curve.as_dict(),
            "warnings": list(self.warnings),
            "analysis_params": self.analysis_params,
        }


# ---- 探测与动态规划 ---------------------------------------------------------


def build_probes(ref_feat: FeatureSet, take_feat: FeatureSet) -> list[Probe]:
    dur = take_feat.duration_s
    window_s = min(PROBE_WINDOW_S, max(0.6, dur / 3.0))
    step_s = min(PROBE_STEP_S, max(0.1, window_s / 2.0))
    window_frames = max(2, int(round(window_s / take_feat.hop_s)))
    step_frames = max(1, int(round(step_s / take_feat.hop_s)))
    peak_sep = max(1, int(round(PEAK_MIN_SEPARATION_S / take_feat.hop_s)))
    peak = float(np.max(take_feat.energy)) if take_feat.energy.size else 0.0
    if peak <= 0:
        raise AlignmentError("待对齐录音没有可用能量")
    min_energy = peak * 0.01
    probes: list[Probe] = []
    last_start = take_feat.frames - window_frames
    for start in range(0, last_start + 1, step_frames):
        seg_energy = float(np.max(take_feat.energy[start:start + window_frames]))
        if seg_energy < min_energy:
            continue
        curve = window_scores(ref_feat, take_feat, start, window_frames)
        peaks = local_peaks(curve, peak_sep, PROBE_TOP_K, PEAK_MIN_SCORE)
        if not peaks:
            continue
        cands = [((idx + delta) * ref_feat.hop_s, score) for idx, delta, score in peaks]
        cands.sort(key=lambda c: c[1], reverse=True)
        probe = Probe(
            take_time=start * take_feat.hop_s,
            take_frame=start,
            window_s=window_frames * take_feat.hop_s,
            score_curve=curve,
            candidates=cands,
            energy=seg_energy,
        )
        _annotate_ambiguity(probe)
        probes.append(probe)
    if len(probes) < 3:
        raise AlignmentError("待对齐录音的有效内容太少, 无法建立时间对应关系")
    return probes


def _annotate_ambiguity(probe: Probe) -> None:
    """标出"多个相近候选"的探针。

    重复节奏会产生大量几乎同分的候选; 若把所有探针都标成不确定,
    整个界面都会被置信不足覆盖。因此以 *路径选择* 的稳定性为准:
    只把最高分明显不突出、或其得分与另一处候选相差很小的探针标为不确定。
    """

    cands = probe.candidates
    if len(cands) < 2:
        probe.margin = 1.0
        probe.ambiguous = False
        return
    best_ref, best = cands[0]
    alternatives = [s for r, s in cands[1:] if abs(r - best_ref) > 0.30]
    second = max(alternatives) if alternatives else 0.0
    probe.margin = max(0.0, (best - second) / max(best, 1e-9))
    # 得分很高且与第二候选有差距 -> 可信; 否则依赖 DP 的连贯性
    probe.ambiguous = (best < DP_AMBIGUOUS_SCORE) or (probe.margin < DP_AMBIGUOUS_MARGIN)


def _path_stability(probes: list[Probe], path: list[tuple[int, int]]) -> list[float]:
    """对路径上每个点, 计算"把该点换成另一个远处候选"后的得分损失。

    返回 0-1 之间的可信度: 1 表示替换任何其他候选都会明显变差。
    """

    stability: list[float] = []
    for k, (pi, pj) in enumerate(path):
        probe = probes[pi]
        chosen = probe.candidates[pj][1]
        prev_ref = probes[path[k - 1][0]].candidates[path[k - 1][1]][0] if k > 0 else None
        next_ref = (
            probes[path[k + 1][0]].candidates[path[k + 1][1]][0]
            if k + 1 < len(path) else None
        )
        chosen_ref = probe.candidates[pj][0]
        prev_take = probes[path[k - 1][0]].take_time if k > 0 else None
        next_take = probes[path[k + 1][0]].take_time if k + 1 < len(path) else None
        best_alt = -1e9
        for j, (ref, score) in enumerate(probe.candidates):
            if j == pj:
                continue
            if abs(ref - chosen_ref) < 0.30:
                continue
            penalty = 0.0
            if prev_ref is not None and prev_take is not None:
                dt = probe.take_time - prev_take
                ratio = (ref - prev_ref) / dt if dt > 0 else 0.0
                if ratio <= 0 or ratio > 1.6:
                    continue
                penalty += DP_SLOPE_PENALTY * (ratio - 1.0) ** 2
            if next_ref is not None and next_take is not None:
                dt = next_take - probe.take_time
                ratio = (next_ref - ref) / dt if dt > 0 else 0.0
                if ratio <= 0 or ratio > 1.6:
                    continue
                penalty += DP_SLOPE_PENALTY * (ratio - 1.0) ** 2
            best_alt = max(best_alt, score - penalty)
        if best_alt < -1e8:
            stability.append(1.0)
        else:
            gap = (chosen - best_alt) / max(chosen, 1e-9)
            stability.append(float(np.clip(gap / 0.25, 0.0, 1.0)))
    return stability


def _dp_path(probes: list[Probe]) -> list[tuple[int, int]]:
    """返回 [(probe 索引, 候选索引)], 按待对齐录音时间递增。"""

    n = len(probes)
    k = max(len(p.candidates) for p in probes)
    neg = -1e18
    dp = np.full((n, k), neg, dtype=np.float64)
    back = [np.full(k, -1, dtype=np.int64) for _ in range(n)]
    back_probe = [np.zeros(k, dtype=np.int64) for _ in range(n)]
    for j, (_, score) in enumerate(probes[0].candidates):
        dp[0, j] = score

    for i in range(1, n):
        for skip in range(1, min(DP_MAX_SKIP_PROBES, i) + 1):
            prev = i - skip
            dt = probes[i].take_time - probes[prev].take_time
            if dt <= 0:
                continue
            for cur_j, (ref_cur, score) in enumerate(probes[i].candidates):
                best = neg
                best_prev = -1
                for prev_j, (ref_prev, _) in enumerate(probes[prev].candidates):
                    if dp[prev, prev_j] <= neg / 2:
                        continue
                    dr = ref_cur - ref_prev
                    if dr <= 0:
                        continue
                    ratio = dr / dt
                    if DP_SLOPE_LO <= ratio <= DP_SLOPE_HI:
                        penalty = DP_SLOPE_PENALTY * (ratio - 1.0) ** 2
                    else:
                        excess = dr - dt * DP_SLOPE_HI
                        if excess < 0:
                            continue
                        penalty = DP_GAP_PENALTY
                    value = dp[prev, prev_j] + score - penalty
                    if value > best:
                        best = value
                        best_prev = prev_j
                if best > dp[i, cur_j]:
                    dp[i, cur_j] = best
                    back[i][cur_j] = best_prev
                    back_probe[i][cur_j] = prev

    tail = max(1, min(8, n))
    best_value = neg
    end_i, end_j = n - 1, int(np.argmax(dp[n - 1]))
    for i in range(n - tail, n):
        j = int(np.argmax(dp[i]))
        if dp[i, j] > best_value:
            best_value = dp[i, j]
            end_i, end_j = i, j
    path: list[tuple[int, int]] = []
    i, j = end_i, end_j
    while i >= 0 and j >= 0:
        path.append((i, j))
        pi = int(back_probe[i][j])
        pj = int(back[i][j])
        if pj < 0:
            break
        i, j = pi, pj
    path.reverse()
    return path


# ---- 缺失边界与曲线构建 -----------------------------------------------------


def _score_window(ref_feat: FeatureSet, take_feat: FeatureSet, take_time: float,
                  ref_time: float, window_s: float) -> float:
    w = max(2, int(round(window_s / take_feat.hop_s)))
    ti = take_feat.frame_of_time(take_time)
    ri = ref_feat.frame_of_time(ref_time)
    if ti < 0 or ti + w > take_feat.frames or ri < 0 or ri + w > ref_feat.frames:
        return -1.0
    a = ref_feat.features[ri:ri + w]
    b = take_feat.features[ti:ti + w]
    return float(np.sum(a * b)) / float(w)


def _robust_line(x: np.ndarray, y: np.ndarray) -> tuple[float, float]:
    """带离群剔除的最小二乘直线 y = a*x + b。"""
    x = np.asarray(x, dtype=np.float64)
    y = np.asarray(y, dtype=np.float64)
    if len(x) < 2:
        return 1.0, (float(y[0] - x[0]) if len(x) else 0.0)
    keep = np.ones(len(x), dtype=bool)
    slope, intercept = np.polyfit(x, y, 1)
    for _ in range(4):
        if keep.sum() < 2:
            break
        slope, intercept = np.polyfit(x[keep], y[keep], 1)
        residual = y - (slope * x + intercept)
        mad = np.median(np.abs(residual[keep])) + 1e-6
        new_keep = np.abs(residual) <= max(4.0 * 1.4826 * mad, 0.010)
        if np.array_equal(new_keep, keep) or new_keep.sum() < 2:
            break
        keep = new_keep
    slope, intercept = np.polyfit(x[keep], y[keep], 1)
    return float(slope), float(intercept)


def _local_consistency_filter(matches: list[MatchPoint]) -> list[MatchPoint]:
    """用局部稳健直线剔除明显偏离的波形级微调结果。

    特征级匹配本身已经由动态规划保证连贯; 但波形互相关在噪声/相似内容处
    可能给出几十毫秒的错误微调。这里在 ±3 秒内做稳健直线拟合, 把残差
    过大的点退回为"未微调"的窗口中心位置, 避免单个坏点扭曲整条曲线。
    """

    if len(matches) < 5:
        return matches
    ref = np.array([m.ref_time for m in matches], dtype=np.float64)
    take = np.array([m.take_time for m in matches], dtype=np.float64)
    out: list[MatchPoint] = []
    for i, m in enumerate(matches):
        near = np.abs(ref - ref[i]) <= LOCAL_CONSISTENCY_WINDOW_S
        near[i] = False
        if near.sum() < 4:
            out.append(m)
            continue
        slope, intercept = _robust_line(ref[near], take[near])
        expected = slope * ref[i] + intercept
        # 以窗口中心为基准的期望位置 (窗口中心相对特征匹配窗口的偏移)
        residual = m.take_time - expected
        if abs(residual) > LOCAL_CONSISTENCY_MAX_RESIDUAL_S:
            out.append(
                MatchPoint(
                    take_time=float(expected),
                    ref_time=m.ref_time,
                    score=m.score,
                    margin=m.margin,
                    ambiguous=m.ambiguous,
                    refined=False,
                    ncc=m.ncc,
                )
            )
        else:
            out.append(m)
    # 重新保证单调
    result: list[MatchPoint] = []
    for m in out:
        if result and (
            m.take_time <= result[-1].take_time + 1e-6
            or m.ref_time <= result[-1].ref_time + 1e-6
        ):
            continue
        result.append(m)
    return result


def _fit_slope(matches: list[MatchPoint]) -> float:
    if len(matches) < 2:
        return 1.0
    ref = np.array([m.ref_time for m in matches], dtype=np.float64)
    take = np.array([m.take_time for m in matches], dtype=np.float64)
    slope, _ = _robust_line(ref, take)
    return max(0.2, min(5.0, slope))


def _monotone(values: np.ndarray) -> np.ndarray:
    """PAVA: 把序列调整为非递减, 尽量少改动。"""

    v = np.asarray(values, dtype=np.float64).copy()
    if v.size <= 1:
        return v
    blocks: list[list[float]] = []
    for value in v:
        blocks.append([float(value), 1.0])
        while len(blocks) >= 2 and blocks[-2][0] / blocks[-2][1] > blocks[-1][0] / blocks[-1][1] + 1e-15:
            s2, c2 = blocks.pop()
            s1, c1 = blocks.pop()
            blocks.append([s1 + s2, c1 + c2])
    out = np.empty_like(v)
    idx = 0
    for total, count in blocks:
        n = int(count)
        out[idx:idx + n] = total / count
        idx += n
    return out


def refine_gap_boundary(
    ref_feat: FeatureSet,
    take_feat: FeatureSet,
    pre_ref: float,
    pre_take: float,
    pre_slope: float,
    post_ref: float,
    post_take: float,
    post_slope: float,
) -> tuple[float, float, float]:
    """找到待对齐录音中缺失的接缝时刻, 以及它前后的参考时间。

    返回 (参考缺失起点, 参考缺失终点, 接缝处的待对齐录音时间)。
    用窗口匹配得分在接缝处交叉的位置估计, 并补偿窗口半宽。
    """

    w_s = GAP_BOUNDARY_WINDOW_S
    t_lo = pre_take + 0.05
    t_hi = post_take - 0.05
    if t_hi <= t_lo:
        t_seam = 0.5 * (pre_take + post_take)
    else:
        step = 0.01
        times = np.arange(t_lo, t_hi + 1e-9, step)
        diffs = np.empty(len(times), dtype=np.float64)
        for i, t in enumerate(times):
            rp = pre_ref + (t - pre_take) / max(pre_slope, 1e-6)
            rq = post_ref + (t - post_take) / max(post_slope, 1e-6)
            sp = _score_window(ref_feat, take_feat, t, rp, w_s)
            sq = _score_window(ref_feat, take_feat, t, rq, w_s)
            diffs[i] = sq - sp
        positive = np.where(diffs > 0)[0]
        if positive.size == 0:
            t_seam = 0.5 * (pre_take + post_take)
        else:
            k = int(positive[0])
            t_seam = float(times[k])
            if k > 0:
                d0, d1 = float(diffs[k - 1]), float(diffs[k])
                if d1 != d0:
                    t_seam = float(times[k - 1] + step * d0 / (d0 - d1))
            t_seam += 0.5 * w_s
    r_pre = pre_ref + (t_seam - pre_take) / max(pre_slope, 1e-6)
    r_post = post_ref + (t_seam - post_take) / max(post_slope, 1e-6)
    return r_pre, r_post, t_seam


def _segment_knots(matches: list[MatchPoint]) -> list[tuple[float, float]]:
    """把一段匹配点压缩成较稀疏、单调、抗噪声的节点 (参考时间, 待对齐时间)。"""

    if not matches:
        return []
    pts = sorted(matches, key=lambda m: m.ref_time)
    ref = np.array([p.ref_time for p in pts], dtype=np.float64)
    take = np.array([p.take_time for p in pts], dtype=np.float64)
    weights = np.array(
        [max(0.05, p.score * (1.0 if not p.ambiguous else 0.35)) for p in pts],
        dtype=np.float64,
    )
    slope, intercept = _robust_line(ref, take)
    residual = take - (slope * ref + intercept)
    threshold = max(0.050, 4.0 * 1.4826 * np.median(np.abs(residual)) + 0.010)
    ok = np.abs(residual) <= threshold
    if ok.sum() < 3:
        ok[:] = True
    ref_ok, take_ok, w_ok = ref[ok], take[ok], weights[ok]
    order = np.argsort(ref_ok)
    ref_ok, take_ok, w_ok = ref_ok[order], take_ok[order], w_ok[order]

    knots: list[tuple[float, float]] = []
    start = 0
    while start < len(ref_ok):
        bin_end = ref_ok[start] + KNOT_STEP_S
        stop = start
        while stop + 1 < len(ref_ok) and ref_ok[stop + 1] < bin_end:
            stop += 1
        rr = ref_ok[start:stop + 1]
        tt = take_ok[start:stop + 1]
        ww = w_ok[start:stop + 1]
        knots.append((float(np.average(rr, weights=ww)), float(np.average(tt, weights=ww))))
        start = stop + 1
    if len(knots) == 1:
        r0, t0 = knots[0]
        knots = [(max(0.0, r0 - 0.5), t0 - 0.5 * slope), (r0 + 0.5, t0 + 0.5 * slope)]
    take_vals = _monotone(np.array([t for _, t in knots], dtype=np.float64))
    return [(r, float(t)) for (r, _), t in zip(knots, take_vals)]


def _split_segments(matches: list[MatchPoint], gaps: list[GapRegion]) -> list[tuple[list[MatchPoint], GapRegion | None]]:
    """按缺失接缝把匹配点切成若干段, 返回 [(匹配点, 该段之前的缺失区间)]。"""

    if not gaps:
        return [(list(matches), None)]
    ordered_gaps = sorted(gaps, key=lambda g: g.take_time)
    segments: list[tuple[list[MatchPoint], GapRegion | None]] = []
    current: list[MatchPoint] = []
    current_gap: GapRegion | None = None
    gi = 0
    for m in matches:
        while gi < len(ordered_gaps) and m.take_time > ordered_gaps[gi].take_time + 1e-6:
            if current:
                segments.append((current, current_gap))
            current = []
            current_gap = ordered_gaps[gi]
            gi += 1
        current.append(m)
    if current:
        segments.append((current, current_gap))
    return segments


def build_curve(
    segments: list[tuple[list[MatchPoint], GapRegion | None]],
    gaps: list[GapRegion],
    ref_duration: float,
) -> TimelineCurve:
    """把各段节点拼接成单调分段线性曲线; 缺失区间内 take 保持不变。"""

    knots_ref: list[float] = []
    knots_take: list[float] = []
    last_slope = 1.0
    for seg_matches, gap_before in segments:
        pts = _segment_knots(seg_matches)
        if not pts:
            continue
        slope = _fit_slope(seg_matches)
        if not knots_ref:
            r_first, t_first = pts[0]
            if r_first > 1e-9:
                knots_ref.append(0.0)
                knots_take.append(t_first - slope * r_first)
        else:
            if gap_before is not None:
                # 上一段末节点之后、缺失起点之前 (若有缝隙) 保持上一段斜率;
                # 缺失区间内 take 固定为接缝值, 形成平台。
                gap_start = max(gap_before.ref_start, knots_ref[-1])
                if gap_start > knots_ref[-1] + 1e-9:
                    knots_ref.append(float(gap_start))
                    knots_take.append(knots_take[-1] + last_slope * (gap_start - knots_ref[-2]))
                if knots_ref[-1] < gap_before.ref_end - 1e-9:
                    knots_ref.append(float(gap_before.ref_end))
                    knots_take.append(float(gap_before.take_time))
        for r, t in pts:
            r = float(r)
            if knots_ref and r <= knots_ref[-1] + 1e-9:
                continue
            if gap_before is not None and r < gap_before.ref_end - 1e-9:
                continue
            t = float(t)
            if knots_ref and gap_before is not None and knots_ref[-1] >= gap_before.ref_end - 1e-9:
                # 缺失后的第一个声音节点: 不允许被拉回接缝之前
                t = max(t, knots_take[-1])
            knots_ref.append(r)
            knots_take.append(t)
        last_slope = slope
    if not knots_ref:
        raise AlignmentError("未能建立时间映射")
    if len(knots_ref) == 1:
        r0, t0 = knots_ref[0], knots_take[0]
        knots_ref = [max(0.0, r0 - 0.5), r0 + 0.5]
        knots_take = [t0 - 0.5 * last_slope, t0 + 0.5 * last_slope]
        order = np.argsort(knots_ref)
        knots_ref = [knots_ref[i] for i in order]
        knots_take = [knots_take[i] for i in order]
    # 首末补齐: 参考时间 0 与 ref_duration
    if knots_ref[0] > 1e-9:
        r0, t0 = knots_ref[0], knots_take[0]
        knots_ref.insert(0, 0.0)
        knots_take.insert(0, t0 - last_slope * r0)
    if knots_ref[-1] < ref_duration - 1e-9:
        r0, t0 = knots_ref[-1], knots_take[-1]
        knots_ref.append(float(ref_duration))
        knots_take.append(t0 + last_slope * (ref_duration - r0))
    ref_arr = np.array(knots_ref, dtype=np.float64)
    take_arr = _monotone(np.array(knots_take, dtype=np.float64))
    if len(ref_arr) < 2:
        raise AlignmentError("时间映射节点不足")
    return TimelineCurve(ref_arr, take_arr, list(gaps))


def _uncovered_edges(curve: TimelineCurve, take_duration: float, ref_duration: float) -> list[GapRegion]:
    """参考开头/结尾没有对应声音的区间。"""

    dense = np.linspace(0.0, ref_duration, max(2000, int(ref_duration * 100)))
    take = np.asarray(curve.take_time_at(dense), dtype=np.float64)
    missing = np.zeros_like(dense, dtype=bool)
    for g in curve.gaps:
        missing |= (dense >= g.ref_start - 1e-9) & (dense < g.ref_end - 1e-9)
    covered = (take >= 0.0) & (take <= take_duration) & (~missing)
    if not covered.any():
        raise AlignmentError("导出时间轴上没有任何有效声音")
    first = int(np.argmax(covered))
    last = len(covered) - 1 - int(np.argmax(covered[::-1]))
    gaps: list[GapRegion] = []
    if first > 0:
        # 用二分细化边界
        r = _first_true_edge(dense, covered, True)
        lead_take = float(curve.take_time_at(r))
        gaps.append(GapRegion(0.0, r, lead_take, "lead_in"))
    if last < len(dense) - 1:
        r = _first_true_edge(dense, covered, False)
        tail_take = float(np.interp(r, curve.knots_ref, curve.knots_take))
        gaps.append(GapRegion(r, float(ref_duration), tail_take, "lead_out"))
    return gaps


def _first_true_edge(dense: np.ndarray, covered: np.ndarray, forward: bool) -> float:
    """forward=True 返回从 0 开始第一个 covered 的位置; 否则返回从末尾往前第一个。"""

    if forward:
        idx = int(np.argmax(covered))
        lo, hi = (dense[idx - 1], dense[idx]) if idx > 0 else (dense[0], dense[0])
    else:
        rev = covered[::-1]
        idx = len(covered) - 1 - int(np.argmax(rev))
        lo, hi = (dense[idx], dense[idx + 1]) if idx + 1 < len(dense) else (dense[idx], dense[idx])
    for _ in range(30):
        mid = 0.5 * (lo + hi)
        i = int(np.clip(round((mid - dense[0]) / max(dense[-1] - dense[0], 1e-9) * (len(dense) - 1)), 0, len(dense) - 1))
        inside = bool(covered[i])
        if forward:
            if inside:
                hi = mid
            else:
                lo = mid
        else:
            if inside:
                lo = mid
            else:
                hi = mid
    return float(0.5 * (lo + hi))


# ---- 置信度与趋势 -----------------------------------------------------------


def _merge_intervals(intervals: Iterable[tuple[float, float, str]]) -> list[tuple[float, float, str]]:
    items = sorted((max(0.0, a), b, reason) for a, b, reason in intervals if b - a > 0.05)
    if not items:
        return []
    merged: list[list] = [list(items[0])]
    for a, b, reason in items[1:]:
        prev = merged[-1]
        if a <= prev[1] + 0.15:
            prev[1] = max(prev[1], b)
            if reason not in prev[2]:
                prev[2] = prev[2] + "; " + reason
        else:
            merged.append([a, b, reason])
    return [(float(a), float(b), str(r)) for a, b, r in merged]


def _compute_low_confidence(
    matches: list[MatchPoint],
    probes: list[Probe],
    path: list[tuple[int, int]],
    gaps: list[GapRegion],
    curve: TimelineCurve,
    ref_feat: FeatureSet,
    take_feat: FeatureSet,
    ref_duration: float,
    stability: list[float] | None = None,
) -> list[LowConfidenceRegion]:
    intervals: list[tuple[float, float, str]] = []
    accepted = {pi for pi, _ in path}
    accepted_times = sorted(probes[i].take_time for i in accepted)
    for m in matches:
        if m.ambiguous:
            intervals.append(
                (
                    m.ref_time - LOW_CONF_WINDOW_PAD_S,
                    m.ref_time + PROBE_WINDOW_S + LOW_CONF_WINDOW_PAD_S,
                    "该位置有多个几乎同分的候选 (重复节奏/相似片段), 自动选择不稳定",
                )
            )
        elif m.score < 0.38:
            intervals.append((m.ref_time - 0.3, m.ref_time + PROBE_WINDOW_S + 0.3, "匹配得分偏低"))
    # 路径上连贯但候选高度重合的位置: 仍给出提示, 但不覆盖整段
    if stability is not None:
        for k, (pi, _) in enumerate(path):
            if k >= len(stability):
                break
            probe = probes[pi]
            if probe.ambiguous and stability[k] < 0.75:
                m = matches[min(k, len(matches) - 1)] if matches else None
                if m is None:
                    continue
                intervals.append(
                    (m.ref_time - 0.5, m.ref_time + PROBE_WINDOW_S + 0.5,
                     "相似候选较多, 依赖前后连贯性选择")
                )
    # 未被路径采用、且周围很长时间没有采用点的探针
    for i, probe in enumerate(probes):
        if i in accepted:
            continue
        nearest = min((abs(probe.take_time - t) for t in accepted_times), default=1e9)
        if nearest < 1.6:
            continue
        r = float(curve.ref_time_at(probe.take_time))
        intervals.append((r - 0.5, r + PROBE_WINDOW_S + 0.5, "该位置未能可靠匹配 (静音/噪声/超出内容)"))
    # 参考或待对齐录音中的静音段
    for feat, is_ref in ((ref_feat, True), (take_feat, False)):
        silent = detect_silent_frames(feat.energy)
        if not silent.any():
            continue
        padded = np.concatenate([[0], silent.astype(np.int8), [0]])
        starts = np.where(np.diff(padded) == 1)[0]
        ends = np.where(np.diff(padded) == -1)[0]
        for s, e in zip(starts, ends):
            t0, t1 = float(s * feat.hop_s), float(e * feat.hop_s)
            if is_ref:
                intervals.append((t0, t1, "参考录音静音, 无法据此校正"))
            else:
                r0 = float(curve.ref_time_at(t0))
                r1 = float(curve.ref_time_at(t1))
                intervals.append((min(r0, r1), max(r0, r1), "待对齐录音静音, 无法据此校正"))
    # 扣除缺失区间
    out: list[LowConfidenceRegion] = []
    for a, b, reason in _merge_intervals(intervals):
        pieces = [(max(0.0, a), min(ref_duration, b))]
        for g in sorted(gaps, key=lambda x: x.ref_start):
            new_pieces = []
            for pa, pb in pieces:
                if g.ref_end <= pa or g.ref_start >= pb:
                    new_pieces.append((pa, pb))
                    continue
                if pa < g.ref_start:
                    new_pieces.append((pa, g.ref_start))
                if pb > g.ref_end:
                    new_pieces.append((g.ref_end, pb))
            pieces = new_pieces
        for pa, pb in pieces:
            if pb - pa >= 0.2:
                out.append(LowConfidenceRegion(pa, pb, reason))
    return sorted(out, key=lambda r: r.ref_start)


def _apply_anchor_confidence(
    low: list[LowConfidenceRegion], anchors: list[Anchor]
) -> list[LowConfidenceRegion]:
    if not anchors:
        return list(low)
    out: list[LowConfidenceRegion] = []
    for region in low:
        pieces = [(region.ref_start, region.ref_end)]
        for a in anchors:
            radius = 1.5
            new = []
            for pa, pb in pieces:
                if a.ref_time + radius <= pa or a.ref_time - radius >= pb:
                    new.append((pa, pb))
                    continue
                if pa < a.ref_time - radius:
                    new.append((pa, a.ref_time - radius))
                if pb > a.ref_time + radius:
                    new.append((a.ref_time + radius, pb))
            pieces = new
        for pa, pb in pieces:
            if pb - pa >= 0.2:
                out.append(LowConfidenceRegion(pa, pb, region.reason, region.severity))
    return sorted(out, key=lambda r: r.ref_start)


def summarise_trend(
    curve: TimelineCurve,
    ref_duration: float,
    take_duration: float,
    gaps: list[GapRegion],
) -> TrendSummary:
    """给出若干位置的偏差、各段斜率与整体漂移趋势。"""

    summary = TrendSummary()
    missing = [g for g in gaps if g.kind == "missing"]
    coverage: list[tuple[float, float]] = []
    cursor = 0.0
    for g in sorted(gaps, key=lambda x: x.ref_start):
        if g.ref_start > cursor + 1e-6:
            coverage.append((cursor, g.ref_start))
        cursor = max(cursor, g.ref_end)
    if cursor < ref_duration - 1e-6:
        coverage.append((cursor, ref_duration))
    for (a, b) in coverage:
        if b - a < 0.5:
            continue
        ra = float(curve.take_time_at(a))
        rb = float(curve.take_time_at(b))
        slope = (rb - ra) / (b - a) if b > a else 1.0
        summary.segments.append(
            {
                "ref_start_s": round(a, 3),
                "ref_end_s": round(b, 3),
                "take_start_s": round(ra, 3),
                "take_end_s": round(rb, 3),
                "slope_take_per_ref": round(float(slope), 5),
                "drift_percent": round(float((slope - 1.0) * 100.0), 3),
            }
        )
        n = 5
        for i in range(n):
            r = a + (b - a) * (i + 0.5) / n
            t = float(curve.take_time_at(r))
            linear = ra + (r - a)
            summary.samples.append(
                {
                    "ref_s": round(float(r), 3),
                    "take_s": round(t, 3),
                    "offset_ms": round((t - r) * 1000.0, 1),
                    "deviation_from_constant_offset_ms": round((t - linear) * 1000.0, 1),
                    "local_slope": round(float(curve.local_slope(r)), 5),
                }
            )
    if summary.segments:
        seg = max(summary.segments, key=lambda s: s["ref_end_s"] - s["ref_start_s"])
        summary.overall_drift_percent = seg["drift_percent"]
        if abs(seg["drift_percent"]) >= 0.05:
            direction = "偏快" if seg["drift_percent"] > 0 else "偏慢"
            summary.notes.append(
                f"待对齐录音相对参考整体{direction}约 {abs(seg['drift_percent']):.2f}% "
                f"(每 10 秒累积约 {abs(seg['drift_percent']) / 10.0:.3f} 秒)"
            )
        else:
            summary.notes.append("未检测到明显的累积漂移 (变化 < 0.05%)")
    if missing:
        summary.notes.append(
            "检测到待对齐录音缺失内容: "
            + ", ".join(f"{g.ref_start:.2f}-{g.ref_end:.2f} s" for g in missing)
        )
    if take_duration < ref_duration - 0.5:
        summary.notes.append("待对齐录音比参考录音短, 参考结尾将导出为静音")
    return summary


# ---- 锚点校验与带锚点重建 ---------------------------------------------------


def validate_anchors(anchors: Sequence[Anchor], result: AlignmentResult) -> list[Anchor]:
    cleaned = [a.copy() for a in anchors]
    cleaned.sort(key=lambda a: a.ref_time)
    missing = result.missing_gaps
    for a in cleaned:
        if not np.isfinite(a.ref_time) or not np.isfinite(a.take_time):
            raise AnchorConflictError("锚点包含非法数值")
        if not (0.0 <= a.ref_time <= result.ref_duration + 1e-6):
            raise AnchorConflictError(
                f"锚点参考时间 {a.ref_time:.3f}s 超出参考录音范围 0-{result.ref_duration:.3f}s"
            )
        if not (0.0 <= a.take_time <= result.take_duration + 1e-6):
            raise AnchorConflictError(
                f"锚点待对齐时间 {a.take_time:.3f}s 超出待对齐录音范围 0-{result.take_duration:.3f}s"
            )
        for g in missing:
            if g.ref_start + 1e-6 < a.ref_time < g.ref_end - 1e-6:
                raise AnchorConflictError(
                    f"锚点参考时间 {a.ref_time:.3f}s 落在缺失区间 "
                    f"{g.ref_start:.3f}-{g.ref_end:.3f}s 内, 该区间没有对应声音"
                )
    for prev, cur in zip(cleaned, cleaned[1:]):
        if cur.ref_time - prev.ref_time < 0.05:
            raise AnchorConflictError(
                f"两个锚点参考时间过近 ({prev.ref_time:.3f}s 与 {cur.ref_time:.3f}s), 至少相隔 0.05s"
            )
        if cur.take_time <= prev.take_time + 1e-6:
            raise AnchorConflictError(
                f"锚点时间顺序冲突: 参考 {prev.ref_time:.3f}s -> 待对齐 {prev.take_time:.3f}s, "
                f"但参考 {cur.ref_time:.3f}s -> 待对齐 {cur.take_time:.3f}s, 会产生倒放/折返"
            )
        for g in missing:
            crosses = prev.ref_time <= g.ref_start + 1e-6 and cur.ref_time >= g.ref_end - 1e-6
            if crosses and not (prev.take_time <= g.take_time + 1e-6 <= cur.take_time + 1e-6):
                raise AnchorConflictError(
                    f"锚点与缺失区间 {g.ref_start:.3f}-{g.ref_end:.3f}s 冲突: "
                    f"缺失接缝位于待对齐 {g.take_time:.3f}s, 锚点要求 "
                    f"{prev.take_time:.3f}s -> {cur.take_time:.3f}s, 时间顺序不一致"
                )
    return cleaned


def _anchor_offsets(base: TimelineCurve, anchors: list[Anchor]) -> np.ndarray:
    return np.array(
        [a.take_time - float(base.take_time_at(a.ref_time)) for a in anchors],
        dtype=np.float64,
    )


def _offset_field(
    refs: np.ndarray,
    anchors: list[Anchor],
    offsets: np.ndarray,
    gaps: list[GapRegion],
    sigma_s: float = 2.5,
) -> np.ndarray:
    """锚点偏移的影响场。

    * 锚点之间: 线性插值, 使两个锚点各自精确命中;
    * 首个/末个锚点之外: 指数衰减回自动曲线, 避免远处被无谓改动;
    * 缺失区间内部与接缝: 偏移为 0 (缺失内容是客观事实, 不被拉伸)。
    """

    ar = np.array([a.ref_time for a in anchors], dtype=np.float64)
    field = np.zeros_like(refs)
    for i, r in enumerate(refs):
        if any(g.ref_start + 1e-9 < r < g.ref_end - 1e-9 for g in gaps):
            field[i] = 0.0
            continue
        if ar.size == 1:
            d = abs(r - ar[0])
            field[i] = offsets[0] * math.exp(-0.5 * (d / sigma_s) ** 2)
            continue
        if r <= ar[0]:
            d = ar[0] - r
            field[i] = offsets[0] * math.exp(-0.5 * (d / sigma_s) ** 2)
        elif r >= ar[-1]:
            d = r - ar[-1]
            field[i] = offsets[-1] * math.exp(-0.5 * (d / sigma_s) ** 2)
        else:
            j = int(np.searchsorted(ar, r, side="right") - 1)
            j = max(0, min(j, len(ar) - 2))
            span = ar[j + 1] - ar[j]
            frac = 0.0 if span <= 0 else (r - ar[j]) / span
            # 平滑插值, 避免在锚点处出现折角
            smooth = frac * frac * (3.0 - 2.0 * frac)
            field[i] = offsets[j] + (offsets[j + 1] - offsets[j]) * smooth
    return field


def build_curve_with_anchors(
    base: TimelineCurve,
    gaps: list[GapRegion],
    anchors: list[Anchor],
    take_duration: float,
    ref_duration: float,
) -> TimelineCurve:
    """以自动曲线为底, 用人工锚点更新相邻时间对应关系。

    锚点本身精确命中; 锚点之间的偏移平滑过渡; 缺失区间保持不变。
    若锚点隐含的时间伸缩会产生倒放/折返, 抛 AnchorConflictError。
    """

    if not anchors:
        return TimelineCurve(base.knots_ref.copy(), base.knots_take.copy(), list(gaps))
    offsets = _anchor_offsets(base, anchors)
    refs = list(base.knots_ref.astype(float))
    takes = list(base.knots_take.astype(float))
    for a in anchors:
        if not any(abs(r - a.ref_time) < 1e-9 for r in refs):
            refs.append(float(a.ref_time))
            takes.append(float(base.take_time_at(a.ref_time)))
    order = np.argsort(np.array(refs), kind="stable")
    refs = [refs[i] for i in order]
    takes = [takes[i] for i in order]
    ref_arr = np.array(refs, dtype=np.float64)
    take_arr = np.array(takes, dtype=np.float64)
    field = _offset_field(ref_arr, anchors, offsets, gaps)
    corrected = take_arr + field
    # 锚点精确命中
    for a in anchors:
        idx = int(np.argmin(np.abs(ref_arr - a.ref_time)))
        corrected[idx] = a.take_time
    mono = _monotone(corrected)
    for a in anchors:
        idx = int(np.argmin(np.abs(ref_arr - a.ref_time)))
        if abs(mono[idx] - a.take_time) > 1e-4:
            raise AnchorConflictError(
                f"锚点 (参考 {a.ref_time:.3f}s -> 待对齐 {a.take_time:.3f}s) "
                "要求的时间伸缩超出可行范围, 会在相邻区间产生倒放/折返或错误拉伸"
            )
    curve = TimelineCurve(ref_arr, mono, list(gaps))
    slopes = np.diff(curve.knots_take) / np.diff(curve.knots_ref)
    # 缺失平台之外不允许停滞/倒流
    plateau = np.zeros_like(slopes, dtype=bool)
    for g in gaps:
        plateau |= (curve.knots_ref[:-1] >= g.ref_start - 1e-9) & (
            curve.knots_ref[1:] <= g.ref_end + 1e-9
        )
    if np.any(slopes[~plateau] <= 1e-4):
        raise AnchorConflictError("锚点导致时间映射出现停滞或倒流")
    return curve


# ---- 主入口 -----------------------------------------------------------------


def _to_matches(probes: list[Probe], path: list[tuple[int, int]],
                ref_feat: FeatureSet, take_feat: FeatureSet,
                stability: list[float] | None = None) -> list[MatchPoint]:
    matches: list[MatchPoint] = []
    for k, (pi, pj) in enumerate(path):
        probe = probes[pi]
        ref_window, score = probe.candidates[pj]
        take_center = probe.take_time + 0.5 * probe.window_s
        ref_center = ref_window + 0.5 * probe.window_s
        refined_ref, ncc = refine_with_waveform(
            ref_feat.signal,
            take_feat.signal,
            ref_feat.sr,
            take_center,
            ref_center,
            WAVEFORM_REFINE_WINDOW_S,
            WAVEFORM_REFINE_SEARCH_S,
        )
        refined = ncc >= WAVEFORM_REFINE_MIN_NCC
        stab = stability[k] if stability is not None and k < len(stability) else 1.0
        # 只有"多个相近候选"且"替换后果不明显"的位置才真正不可靠
        unreliable = (score < DP_AMBIGUOUS_SCORE) or (probe.ambiguous and stab < 0.35)
        matches.append(
            MatchPoint(
                take_time=float(take_center),
                ref_time=float(refined_ref if refined else ref_center),
                score=float(score),
                margin=float(probe.margin),
                ambiguous=bool(unreliable),
                refined=bool(refined),
                ncc=float(ncc),
            )
        )
    matches.sort(key=lambda m: m.take_time)
    dedup: list[MatchPoint] = []
    for m in matches:
        if dedup and (
            m.take_time <= dedup[-1].take_time + 1e-6
            or m.ref_time <= dedup[-1].ref_time + 1e-6
        ):
            if m.score > dedup[-1].score and m.ref_time > dedup[-1].ref_time:
                dedup[-1] = m
            continue
        dedup.append(m)
    return dedup


def _build_missing_gaps(
    ref_feat: FeatureSet,
    take_feat: FeatureSet,
    matches: list[MatchPoint],
) -> list[GapRegion]:
    """按匹配点之间的大跳识别缺失区间。"""

    gaps: list[GapRegion] = []
    for k in range(1, len(matches)):
        prev, cur = matches[k - 1], matches[k]
        dt = cur.take_time - prev.take_time
        dr = cur.ref_time - prev.ref_time
        if dt <= 0 or dr - dt < GAP_MIN_REF_EXCESS_S:
            continue
        pre = [m for m in matches[max(0, k - 40):k] if m.take_time < cur.take_time]
        post = [m for m in matches[k:k + 40] if m.take_time > prev.take_time]
        if len(pre) < 2 or len(post) < 2:
            continue
        pre_slope = _fit_slope(pre)
        post_slope = _fit_slope(post)
        r_lo, r_hi, seam = refine_gap_boundary(
            ref_feat,
            take_feat,
            pre_ref=pre[-1].ref_time,
            pre_take=pre[-1].take_time,
            pre_slope=pre_slope,
            post_ref=post[0].ref_time,
            post_take=post[0].take_time,
            post_slope=post_slope,
        )
        if not np.all(np.isfinite([r_lo, r_hi, seam])) or r_hi - r_lo < 0.15:
            r_lo, r_hi = prev.ref_time, cur.ref_time
            seam = prev.take_time
        gaps.append(
            GapRegion(
                ref_start=float(min(r_lo, r_hi)),
                ref_end=float(max(r_lo, r_hi)),
                take_time=float(seam),
                kind="missing",
            )
        )
    return _merge_gaps(gaps)


def _merge_gaps(gaps: list[GapRegion]) -> list[GapRegion]:
    if not gaps:
        return []
    ordered = sorted(gaps, key=lambda g: g.ref_start)
    merged = [ordered[0]]
    for g in ordered[1:]:
        last = merged[-1]
        if g.ref_start <= last.ref_end + 0.3:
            merged[-1] = GapRegion(
                last.ref_start, max(last.ref_end, g.ref_end), last.take_time, "missing"
            )
        else:
            merged.append(g)
    return merged


def _check_slopes(curve: TimelineCurve) -> list[str]:
    warnings: list[str] = []
    slopes = np.diff(curve.knots_take) / np.diff(curve.knots_ref)
    # 忽略缺失区间的平台
    plateau = np.isclose(slopes, 0.0, atol=1e-6)
    valid = slopes[~plateau]
    if valid.size and (valid.min() < SLOPE_WARN_LO or valid.max() > SLOPE_WARN_HI):
        warnings.append(
            f"局部时间伸缩系数超出 {SLOPE_WARN_LO:.2f}-{SLOPE_WARN_HI:.2f} 的常见范围 "
            f"(实际 {valid.min():.3f}-{valid.max():.3f}), 请检查该区间"
        )
    return warnings


def analyze(ref_clip: AudioClip, take_clip: AudioClip) -> AlignmentResult:
    """分析两份录音, 返回自动对齐结果 (未包含人工锚点)。"""

    if ref_clip.duration < 0.5 or take_clip.duration < 0.5:
        raise AlignmentError("录音过短 (不足 0.5 秒), 无法对齐")
    ref_feat = extract_features(ref_clip)
    take_feat = extract_features(take_clip)
    probes = build_probes(ref_feat, take_feat)
    path = _dp_path(probes)
    if len(path) < 3:
        raise AlignmentError("找不到足够的时间对应点, 请检查两份录音是否为同一段声音")
    stability = _path_stability(probes, path)
    matches = _to_matches(probes, path, ref_feat, take_feat, stability)
    if len(matches) < 3:
        raise AlignmentError("找不到足够的时间对应点, 请检查两份录音是否为同一段声音")
    matches = _local_consistency_filter(matches)
    # 内容不匹配保护: 同一段声音的匹配得分通常在 0.6 以上; 整体过低
    # 说明两份录音很可能不是同一段内容, 不能给出看似合理的对应关系。
    median_score = float(np.median([m.score for m in matches]))
    mean_ncc = float(np.mean([m.ncc for m in matches if m.refined])) if any(
        m.refined for m in matches
    ) else 0.0
    if median_score < MISMATCH_MIN_SCORE and mean_ncc < MISMATCH_MIN_NCC:
        raise AlignmentError(
            f"两份录音的内容相似度过低 (匹配得分中位数 {median_score:.2f}), "
            "请确认它们录的是同一段声音"
        )
    gaps = _build_missing_gaps(ref_feat, take_feat, matches)
    segments = _split_segments(matches, gaps)
    curve = build_curve(segments, gaps, ref_clip.duration)
    edges = _uncovered_edges(curve, take_clip.duration, ref_clip.duration)
    all_gaps = sorted(gaps + edges, key=lambda g: g.ref_start)
    curve.gaps = all_gaps
    low = _compute_low_confidence(
        matches, probes, path, all_gaps, curve, ref_feat, take_feat,
        ref_clip.duration, stability,
    )
    trend = summarise_trend(curve, ref_clip.duration, take_clip.duration, all_gaps)
    warnings: list[str] = []
    if any(m.ambiguous for m in matches):
        warnings.append("部分位置存在相似候选 (重复节奏/静音/噪声), 已标记置信不足区间")
    if gaps:
        warnings.append("待对齐录音中间存在缺失内容, 导出时该区间为静音")
    if any(g.kind in ("lead_in", "lead_out") for g in all_gaps):
        warnings.append("待对齐录音未覆盖参考录音的开头或结尾, 对应区间导出为静音")
    warnings.extend(_check_slopes(curve))
    result = AlignmentResult(
        ref_clip=ref_clip,
        take_clip=take_clip,
        matches=matches,
        probes=probes,
        curve=curve,
        gaps=all_gaps,
        low_confidence=low,
        trend=trend,
        anchors=[],
        auto_curve=curve,
        warnings=warnings,
        analysis_params={
            "probe_window_s": PROBE_WINDOW_S,
            "probe_step_s": PROBE_STEP_S,
            "analysis_sample_rate": ref_feat.sr,
            "dp_slope_range": [DP_SLOPE_LO, DP_SLOPE_HI],
            "gap_min_excess_s": GAP_MIN_REF_EXCESS_S,
        },
    )
    return result
