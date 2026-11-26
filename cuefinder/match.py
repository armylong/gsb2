"""归一化互相关检索。

记查询每帧特征为 q_t（单位向量，静音帧为 0），参考每帧为 r_u。
候选起点 s 给出三个量：

    score(s)    = Σ_t q_t·r_{s+t} / #{t: 查询激活帧}
                   ——查询自己的静音帧不参与，参考静音或越界的帧按 0 计
    coverage(s) = #{t: 查询与参考都激活} / #{t: 查询激活}
                   ——查询有多少帧在参考里找得到支持
    overrun(s)  = max(0, 起点 + 查询时长 − 参考有效区间末端)
                   ——命中越过参考末尾多少秒

分母固定为查询激活帧数，所以参考里静音、以及越过参考末尾的部分，
贡献严格为 0——"末尾以外"永远不会被当成匹配。音量变化和查询内部的
短静音不会拉低得分（查询静音帧直接排除在分母之外）。

排序用 score 的覆盖率加权版本（见 rank_key）；overrun 超过 0.02 s
的候选在 search 里降级为"有疑点"。

一条 1.5 s / 5 ms 步长的参考，整条曲线用 FFT 只需几毫秒。
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.signal import fftconvolve, find_peaks

from .features import FeatureSet

END_OVERRUN_TOL_SEC = 0.020    # 越过参考有效末端 20 ms 以上视为越界
COVERAGE_WARN = 0.85           # 覆盖率低于此值提示"依据不完整"


@dataclass
class Peak:
    start_frame: int
    score: float
    coverage: float
    overrun: float


@dataclass
class ScoreCurve:
    score: np.ndarray
    coverage: np.ndarray
    overrun: np.ndarray


def _curve(query: FeatureSet, ref: FeatureSet) -> ScoreCurve:
    T, N = query.n, ref.n
    D = query.feats.shape[0]
    pad = T + N - 1
    rz = np.zeros((D, pad), dtype=np.float64)
    rz[:, :N] = ref.feats

    num = np.zeros(N, dtype=np.float64)
    for d in range(D):
        num += fftconvolve(rz[d], query.feats[d][::-1], mode="valid")[:N]

    qv = query.active.astype(np.float64)
    rv = np.zeros(N + T, dtype=np.float64)
    rv[:N] = ref.active.astype(np.float64)
    overlap = fftconvolve(rv, qv[::-1], mode="valid")[:N]
    total = max(1.0, float(np.count_nonzero(query.active)))
    # 分母固定为查询激活帧数：缺少支持的帧（参考静音或越过末尾）直接拉低得分
    score = num / total
    coverage = np.minimum(overlap / total, 1.0)

    fs = float(ref.cfg.fs)
    starts = (ref.t0 + np.arange(N) * ref.cfg.hop) / fs
    qdur = query.n * query.cfg.hop / fs
    overrun = np.maximum(0.0, starts + qdur - ref.active_end_sec)
    return ScoreCurve(score=score, coverage=coverage, overrun=overrun)


def score_curve(query: FeatureSet, ref: FeatureSet) -> ScoreCurve | None:
    if query.n < 4 or ref.n < 4:
        return None
    return _curve(query, ref)


def find_peaks_in(score: np.ndarray, query: FeatureSet, max_peaks: int = 4,
                  min_distance_frames: int | None = None) -> list[int]:
    if score.size == 0:
        return []
    if min_distance_frames is None:
        min_distance_frames = max(4, query.n // 10)
    distance = max(1, int(min_distance_frames))
    peaks, _ = find_peaks(score, distance=distance)
    cand = set(int(p) for p in peaks)
    cand.add(int(np.argmax(score)))
    if score.size > 1:
        cand.update((0, score.size - 1))
    cand = sorted(cand, key=lambda i: (-score[i], i))
    kept: list[int] = []
    for i in cand:
        if all(abs(i - j) >= distance for j in kept):
            kept.append(i)
        if len(kept) >= max_peaks:
            break
    return kept


def rank_key(score, coverage, overrun=None):
    """排序分：命中度 × 覆盖率加权。

    覆盖率直接由"双方都激活的帧"算出，末尾之外与参考静音的帧已经
    按 0 计入得分，所以不需要再单独打折；这里只按覆盖率给命中度
    一个平滑权重，让"高相似但缺一大块支持"的位置排在
    "相似度一般但完整覆盖"的位置之后。
    """
    cov = np.asarray(coverage, dtype=np.float64)
    return np.asarray(score, dtype=np.float64) * (0.4 + 0.6 * np.clip(cov, 0.0, 1.0))
