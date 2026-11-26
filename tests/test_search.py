import numpy as np

from cuefinder.reference import ReferenceIndex
from cuefinder.search import (STATUS_AMBIGUOUS, STATUS_MATCH, STATUS_NO_MATCH,
                              STATUS_TOO_SHORT, STATUS_WEAK, search, align)
from cuefinder.synth import build_query, build_reference_set


def _index(tmp_path):
    refs = build_reference_set()
    idx = ReferenceIndex()
    for name, sig in refs.items():
        p = tmp_path / f"{name}.wav"
        from cuefinder.audio import write_wav
        write_wav(p, sig, 16000)
        idx.add(p)
    return idx, refs


def test_correct_start_hits_right_reference(tmp_path):
    idx, refs = _index(tmp_path)
    q = build_query("correct_start", refs)
    out = search(idx, q, threshold=0.55)
    assert out.status == STATUS_MATCH
    assert out.best.label == "cue_b_trill"
    assert abs(out.best.start_sec - 0.90) < 0.02
    assert out.best.coverage > 0.98


def test_similar_prefix_is_ambiguous(tmp_path):
    idx, refs = _index(tmp_path)
    q = build_query("similar_prefix", refs)
    out = search(idx, q, threshold=0.55)
    assert out.status == STATUS_AMBIGUOUS
    assert len(out.candidates) >= 2


def test_middle_gap_and_gain_still_finds(tmp_path):
    idx, refs = _index(tmp_path)
    q = build_query("middle_gap", refs)
    out = search(idx, q, threshold=0.55)
    assert out.status == STATUS_MATCH
    assert out.best.label == "cue_d_rise"
    assert abs(out.best.start_sec - 0.55) < 0.03


def test_background_noise_still_finds(tmp_path):
    idx, refs = _index(tmp_path)
    q = build_query("background_noise", refs)
    out = search(idx, q, threshold=0.55)
    assert out.status == STATUS_MATCH
    assert out.best.label == "cue_c_bell"
    assert abs(out.best.start_sec - 0.55) < 0.05


def test_no_match(tmp_path):
    idx, refs = _index(tmp_path)
    q = build_query("no_match", refs)
    out = search(idx, q, threshold=0.55)
    assert out.status == STATUS_NO_MATCH
    assert out.best is None or out.best.score < 0.55


def test_end_overrun_warns(tmp_path):
    idx, refs = _index(tmp_path)
    q = build_query("end_overrun", refs)
    out = search(idx, q, threshold=0.55)
    assert out.status == STATUS_WEAK
    assert out.best.label == "cue_c_bell"
    assert out.best.overrun > 0.05


def test_too_short(tmp_path):
    idx, refs = _index(tmp_path)
    q = refs["cue_c_bell"][int(1.20 * 16000):int(1.24 * 16000)]
    out = search(idx, q, threshold=0.55)
    assert out.status == STATUS_TOO_SHORT


def test_noise_query_has_no_feature(tmp_path):
    idx, refs = _index(tmp_path)
    rng = np.random.default_rng(3)
    out = search(idx, 0.4 * rng.normal(size=16000), threshold=0.55)
    assert out.status in {"no_feature", "empty", "no_match"}


def test_index_change_invalidates_stale_generation(tmp_path):
    idx, refs = _index(tmp_path)
    q = build_query("correct_start", refs)
    out1 = search(idx, q, threshold=0.55)
    gen1 = out1.generation
    idx.remove(idx.ready()[0].path)
    out2 = search(idx, q, threshold=0.55)
    assert out2.generation > gen1
    assert out2.index_signature != out1.index_signature


def test_removing_best_reference_changes_candidates(tmp_path):
    idx, refs = _index(tmp_path)
    q = build_query("correct_start", refs)
    out = search(idx, q, threshold=0.55)
    best_path = out.best.path
    idx.remove(best_path)
    out2 = search(idx, q, threshold=0.55)
    assert all(c.path != best_path for c in out2.candidates)
    assert out2.status != STATUS_MATCH or out2.best.path != best_path


def test_alignment_end_overrun_unsupported(tmp_path):
    idx, refs = _index(tmp_path)
    q = build_query("end_overrun", refs)
    out = search(idx, q, threshold=0.55)
    al = align(out, out.best)
    assert al.ref_overrun_frame is not None
    assert al.unsupported
    assert al.support_ratio < 0.7
