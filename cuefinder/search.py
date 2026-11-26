"""候选排序、证据判断与对齐明细。"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from .features import MATCH_COS, FeatureSet, extract_features
from .match import (
    COVERAGE_WARN,
    END_OVERRUN_TOL_SEC,
    Peak,
    rank_key,
    find_peaks_in,
    score_curve,
)
from .reference import Reference, ReferenceIndex

MIN_QUERY_ACTIVE_SEC = 0.15
MIN_QUERY_FRAMES = 30
FLATNESS_MAX = 0.30
AMBIGUITY_SCORE_MARGIN = 0.04
AMBIGUITY_START_TOL_SEC = 0.08
TOP_N = 5

STATUS_MATCH = "match"
STATUS_WEAK = "weak"
STATUS_AMBIGUOUS = "ambiguous"
STATUS_TOO_SHORT = "too_short"
STATUS_NO_FEATURE = "no_feature"
STATUS_NO_MATCH = "no_match"
STATUS_EMPTY = "empty"

STATUS_LABELS = {
    STATUS_MATCH: "可信命中",
    STATUS_WEAK: "命中有疑点",
    STATUS_AMBIGUOUS: "共同段，依据不足",
    STATUS_TOO_SHORT: "查询太短",
    STATUS_NO_FEATURE: "查询没有明显特征",
    STATUS_NO_MATCH: "没有匹配",
    STATUS_EMPTY: "查询没有可用音频",
}


@dataclass
class Alignment:
    start_frame: int
    start_sample: int
    end_sample: int
    frame_cos: np.ndarray
    query_active: np.ndarray
    ref_active: np.ndarray
    query_feats: np.ndarray
    ref_feats: np.ndarray
    query_mel: np.ndarray
    ref_mel: np.ndarray
    ref_t: np.ndarray
    good: np.ndarray
    evidence: np.ndarray            # 0=查询静音, 1=一致, 2=缺少支持
    unsupported: list[tuple[int, int]]
    ref_overrun_frame: int | None
    hop_sec: float
    fs_query: int = 16000
    fs_ref: int = 16000

    @property
    def n(self) -> int:
        return int(self.frame_cos.size)

    @property
    def support_ratio(self) -> float:
        if self.n == 0:
            return 0.0
        return float(self.good.sum()) / max(1, int(self.query_active.sum()))


@dataclass
class Candidate:
    reference: Reference
    score: float
    coverage: float
    overrun: float
    start_frame: int
    start_sec: float
    end_sec: float
    rank: float
    peaks: list[Peak]
    score_arr: np.ndarray
    coverage_arr: np.ndarray
    overrun_arr: np.ndarray
    passed: bool = False

    @property
    def label(self) -> str:
        return self.reference.label

    @property
    def path(self) -> str:
        return self.reference.path

    @property
    def duration(self) -> float:
        return self.reference.features.duration if self.reference.features else 0.0

    @property
    def end_overrun(self) -> bool:
        return self.overrun > END_OVERRUN_TOL_SEC

    @property
    def coverage_note(self) -> str:
        if self.end_overrun:
            return f"越过参考末尾 {self.overrun*1000:.0f} ms"
        if self.coverage < COVERAGE_WARN:
            return f"只有 {self.coverage:.0%} 的查询帧有支持"
        return ""


@dataclass
class SearchOutcome:
    query: FeatureSet | None
    status: str
    message: str
    candidates: list[Candidate] = field(default_factory=list)
    threshold: float = 0.0
    generation: int = 0
    index_signature: str = ""
    query_path: str = ""
    query_error: str = ""
    notes: list[str] = field(default_factory=list)

    @property
    def status_label(self) -> str:
        return STATUS_LABELS.get(self.status, self.status)

    @property
    def best(self) -> Candidate | None:
        return self.candidates[0] if self.candidates else None

    @property
    def all_candidates(self) -> list[Candidate]:
        return self.candidates


def _cosine_frame(query: FeatureSet, ref: FeatureSet, start: int) -> tuple[np.ndarray, np.ndarray]:
    T = query.n
    rf = np.zeros((ref.feats.shape[0], T), dtype=np.float64)
    rn = np.zeros(T, dtype=np.float64)
    ract = np.zeros(T, dtype=bool)
    valid = max(0, min(T, ref.n - start))
    if valid:
        rf[:, :valid] = ref.feats[:, start:start + valid]
        rn[:valid] = ref.rn[start:start + valid]
        ract[:valid] = ref.active[start:start + valid]
    qact = query.active.astype(bool).copy()
    both = qact & ract
    num = np.einsum("ij,ij->j", query.feats, rf)
    den = np.maximum(query.rn * rn, 1e-9)
    cos = np.where(both, num / den, 0.0)
    return cos, both


EVIDENCE_NONE = 0      # 查询此处没有声音
EVIDENCE_OK = 1        # 与参考一致
EVIDENCE_MISSING = 2   # 查询有声音，但参考没给出支持


def _evidence(cos: np.ndarray, both: np.ndarray, query_active: np.ndarray) -> np.ndarray:
    ev = np.full(cos.size, EVIDENCE_NONE, dtype=np.int8)
    good = (cos >= MATCH_COS) & both
    ev[query_active & good] = EVIDENCE_OK
    ev[query_active & ~good] = EVIDENCE_MISSING
    return ev


def _unsupported_regions(evidence: np.ndarray) -> list[tuple[int, int]]:
    """只统计"查询有声音但缺支持"的连续段；查询自己的静音不算缺依据。"""
    missing = evidence == EVIDENCE_MISSING
    regions: list[tuple[int, int]] = []
    run = None
    for i in range(missing.size):
        if missing[i]:
            if run is None:
                run = i
        elif run is not None:
            regions.append((run, i))
            run = None
    if run is not None:
        regions.append((run, missing.size))
    return [(a, b) for a, b in regions if (b - a) >= 2]


def build_alignment(query: FeatureSet, ref: FeatureSet, start: int) -> Alignment:
    T = query.n
    start = max(0, min(start, max(0, ref.n - 1)))
    cos, both = _cosine_frame(query, ref, start)
    ref_act = np.zeros(T, dtype=bool)
    valid = max(0, min(T, ref.n - start))
    if valid:
        ref_act[:valid] = ref.active[start:start + valid]
    good = (cos >= MATCH_COS) & both
    evidence = _evidence(cos, both, query.active)

    start_sample = ref.t0 + start * ref.cfg.hop
    end_sample = min(len(ref.samples), start_sample + T * ref.cfg.hop)
    ref_t = (start_sample + np.arange(T) * ref.cfg.hop) / float(ref.cfg.fs)
    overrun_frame = None
    for i in range(T):
        if ref_t[i] >= ref.active_end_sec + 1e-6:
            overrun_frame = i
            break
    rfeat = np.zeros((ref.feats.shape[0], T), dtype=np.float64)
    rmel = np.zeros((ref.mel.shape[0], T), dtype=np.float64)
    if valid:
        rfeat[:, :valid] = ref.feats[:, start:start + valid]
        rmel[:, :valid] = ref.mel[:, start:start + valid]
    return Alignment(
        start_frame=start,
        start_sample=start_sample,
        end_sample=end_sample,
        frame_cos=cos,
        query_active=query.active.copy(),
        ref_active=ref_act,
        query_feats=query.feats.copy(),
        ref_feats=rfeat,
        query_mel=query.mel.copy(),
        ref_mel=rmel,
        ref_t=ref_t,
        good=good,
        evidence=evidence,
        unsupported=_unsupported_regions(evidence),
        ref_overrun_frame=overrun_frame,
        hop_sec=query.cfg.hop / float(query.cfg.fs),
        fs_query=query.cfg.fs,
        fs_ref=ref.cfg.fs,
    )


def _match_one(query: FeatureSet, ref: Reference, threshold: float,
               max_peaks: int) -> Candidate | None:
    if not ref.ready or ref.features is None:
        return None
    curve = score_curve(query, ref.features)
    if curve is None:
        return None
    scores, covs, over = curve.score, curve.coverage, curve.overrun
    idxs = find_peaks_in(rank_key(scores, covs, over), query, max_peaks=max_peaks)
    if not idxs:
        return None
    peaks = [Peak(int(i), float(scores[i]), float(covs[i]), float(over[i])) for i in idxs]
    best_idx = max(idxs, key=lambda i: rank_key(scores[i], covs[i], over[i]))
    rf = ref.features
    start_sec = (rf.t0 + best_idx * rf.cfg.hop) / float(rf.cfg.fs)
    qdur = query.n * query.cfg.hop / float(query.cfg.fs)
    end_sec = start_sec + qdur
    return Candidate(
        reference=ref,
        score=float(scores[best_idx]),
        coverage=float(covs[best_idx]),
        overrun=float(over[best_idx]),
        start_frame=int(best_idx),
        start_sec=start_sec,
        end_sec=end_sec,
        rank=float(rank_key(scores[best_idx], covs[best_idx], over[best_idx])),
        peaks=peaks,
        score_arr=scores,
        coverage_arr=covs,
        overrun_arr=over,
    )


def _is_ambiguous(passing: list[Candidate]) -> bool:
    if len(passing) < 2:
        return False
    best = passing[0]
    near = [c for c in passing if best.rank - c.rank <= AMBIGUITY_SCORE_MARGIN]
    if len(near) < 2:
        return False
    near = [c for c in near if abs(c.start_sec - best.start_sec) <= AMBIGUITY_START_TOL_SEC]
    return len(near) >= 2


def query_quality(query: FeatureSet) -> tuple[str, str]:
    if query.active_frames < MIN_QUERY_FRAMES or query.active_duration < MIN_QUERY_ACTIVE_SEC:
        return STATUS_TOO_SHORT, (
            f"有效段 {query.active_duration*1000:.0f} ms（{query.active_frames} 帧），"
            f"不足 {MIN_QUERY_ACTIVE_SEC*1000:.0f} ms；起点无法可靠确定。")
    if query.flatness >= FLATNESS_MAX:
        return STATUS_NO_FEATURE, (
            f"频谱平坦度 {query.flatness:.2f}（接近噪声），"
            "没有稳定的音高/节奏特征，不做匹配判断。")
    return "", ""


def search(index: ReferenceIndex, query_samples: np.ndarray, threshold: float,
           query_path: str = "", max_peaks: int = 4) -> SearchOutcome:
    outcome = SearchOutcome(
        query=None,
        status=STATUS_EMPTY,
        message="",
        threshold=threshold,
        generation=index.generation,
        index_signature=index.signature(),
        query_path=query_path,
    )
    try:
        query = extract_features(np.asarray(query_samples, dtype=np.float64), index.cfg)
    except Exception as exc:  # noqa: BLE001
        outcome.query_error = str(exc)
        outcome.message = f"查询音频不可用: {exc}"
        return outcome
    outcome.query = query

    ready = index.ready()
    quality_status, quality_msg = query_quality(query)
    if quality_status:
        outcome.status = quality_status
        outcome.message = quality_msg
        outcome.notes.append(f"当前索引含 {len(ready)} 条就绪参考。")
        return outcome
    if not ready:
        outcome.status = STATUS_NO_MATCH
        outcome.message = "没有可用的参考音，请先打开参考文件。"
        return outcome

    candidates = []
    for ref in ready:
        c = _match_one(query, ref, threshold, max_peaks)
        if c is not None:
            candidates.append(c)
    for c in candidates:
        c.passed = bool(c.score >= threshold and c.coverage >= 0.5)
    # 达门的排前面；同组内按 rank（越界位置已被打折）
    candidates.sort(key=lambda c: (not c.passed, -c.rank, c.label))
    outcome.candidates = candidates[:TOP_N]

    passing = [c for c in outcome.candidates if c.passed]
    if not passing:
        best = candidates[0].score if candidates else 0.0
        outcome.status = STATUS_NO_MATCH
        outcome.message = (f"没有候选达到门槛 {threshold:.2f}（当前最高 {best:.2f}）；"
                           "可降低门槛观察候选如何变化。")
        return outcome

    if _is_ambiguous(passing):
        best = passing[0]
        near = [c for c in passing if best.rank - c.rank <= AMBIGUITY_SCORE_MARGIN]
        outcome.status = STATUS_AMBIGUOUS
        names = "、".join(c.label for c in near[:4])
        outcome.message = (
            f"{len(near)} 条参考（{names}）在约 {best.start_sec:.2f}s 得到几乎相同的分数，"
            "这段是它们共有的部分，无法据此判断来源；把查询往前后多截一些再查。")
        return outcome

    best = passing[0]
    if best.end_overrun:
        outcome.status = STATUS_WEAK
        outcome.message = (
            f"最佳候选 {best.label} 起点 {best.start_sec:.2f}s，已经越过参考有效末端 "
            f"{best.overrun*1000:.0f} ms；只有 {best.coverage:.0%} 的查询帧有依据，"
            "末尾以外没有匹配，不能当作完整命中。")
        return outcome

    if best.score < threshold:
        outcome.status = STATUS_NO_MATCH
        outcome.message = f"最高 {best.score:.2f} 未达门槛 {threshold:.2f}。"
        return outcome

    if best.coverage < COVERAGE_WARN:
        outcome.status = STATUS_WEAK
        outcome.message = (
            f"最佳候选 {best.label} 起点 {best.start_sec:.2f}s，得分 {best.score:.2f}，"
            f"但只有 {best.coverage:.0%} 的查询帧在参考里找到支持，依据不完整。")
        return outcome

    outcome.status = STATUS_MATCH
    outcome.message = (f"最佳候选 {best.label}，起点 {best.start_sec:.2f}s，"
                       f"得分 {best.score:.2f}，覆盖 {best.coverage:.0%}。")
    return outcome


def align(outcome: SearchOutcome, candidate: Candidate) -> Alignment:
    assert outcome.query is not None
    assert candidate.reference.features is not None
    return build_alignment(outcome.query, candidate.reference.features,
                           candidate.start_frame)
