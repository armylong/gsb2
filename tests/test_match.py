import numpy as np

from cuefinder.features import extract_features
from cuefinder.match import find_peaks_in, rank_key, score_curve


def _chirp(start, end, dur, fs=16000, amp=0.5):
    n = int(dur * fs)
    freq = np.linspace(start, end, n)
    return amp * np.sin(2 * np.pi * np.cumsum(freq) / fs)


def test_perfect_match_scores_one():
    lead = np.zeros(int(0.2 * 16000))
    ref = np.concatenate([lead, _chirp(400, 900, 0.6)])
    offset = int(0.2 * 16000) + int(0.15 * 16000)
    q = ref[offset:offset + int(0.3 * 16000)]
    fr = extract_features(ref)
    fq = extract_features(q)
    curve = score_curve(fq, fr)
    assert curve is not None
    best = int(np.argmax(curve.score))
    assert abs(curve.score[best] - 1.0) < 1e-5
    expected = (offset - fr.t0) // fq.cfg.hop
    assert abs(best - expected) <= 1
    assert curve.coverage[best] > 0.99
    assert curve.overrun[best] == 0.0


def test_end_overrun_is_penalised():
    ref = extract_features(_chirp(400, 900, 0.5))
    tail = _chirp(400, 900, 0.5)[-2000:]
    q = np.concatenate([tail, _chirp(900, 1200, 0.3)])
    fq = extract_features(q)
    curve = score_curve(fq, ref)
    last = curve.score[-1]
    assert curve.coverage[-1] < 0.6
    assert curve.overrun[-1] > 0.05
    assert last < 0.75
    assert rank_key(last, curve.coverage[-1], curve.overrun[-1]) < 0.4


def test_end_boundary_never_invented():
    """落在最后的起点，越界帧不得参与分子（得分不能是 1.0）。"""
    ref = extract_features(_chirp(400, 900, 0.5))
    q = _chirp(400, 900, 0.5)[-1000:]
    q = np.concatenate([q, np.ones(4000) * 0.4])  # 查询后段与参考无关
    fq = extract_features(q)
    curve = score_curve(fq, ref)
    best = int(np.argmax(curve.score))
    assert curve.score[best] < 1.0
    assert curve.overrun[best] > 0.0


def test_rank_key_rewards_coverage():
    assert rank_key(0.8, 1.0) > rank_key(0.8, 0.4)


def test_peaks_separated():
    score = np.zeros(300)
    score[70] = 1.0
    score[72] = 0.9      # 距离小于最小间距，应被吸收
    score[200] = 0.8
    query = extract_features(_chirp(400, 800, 0.05))
    peaks = find_peaks_in(score, query, max_peaks=3)
    assert 70 in peaks
    assert 200 in peaks
    assert 72 not in peaks
