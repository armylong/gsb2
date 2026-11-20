import numpy as np
import pytest

from tdoa_lab.dsp import align_to_reference, estimate_delay, fractional_shift, normalized_xcorr
from tdoa_lab.report import analyze_selection, build_report, export_alignment, verify_aligned_wav
from tdoa_lab.synth import make_preset, presets

SR = 48000


def _burst(n=SR, seed=0):
    rng = np.random.default_rng(seed)
    x = np.zeros(n)
    i = n // 3
    t = np.arange(2000) / SR
    x[i:i + 2000] = np.sin(2 * np.pi * 1500 * t) * np.exp(-t / 0.005)
    x += 0.001 * rng.standard_normal(n)
    return x


def test_sign_convention_positive_lag():
    x = _burst()
    y = fractional_shift(x, 9)
    r = estimate_delay(x, y, SR, max_lag=100, window=None)
    assert abs(r.refined_delay - 9) < 0.2


def test_sign_convention_negative_lag():
    x = _burst(seed=1)
    y = fractional_shift(x, -6)
    r = estimate_delay(x, y, SR, max_lag=100, window=None)
    assert abs(r.refined_delay + 6) < 0.2


@pytest.mark.parametrize("d", [0.0, 0.25, 0.5, -3.75])
def test_sub_sample_accuracy_clean(d):
    x = _burst(seed=2)
    y = fractional_shift(x, d)
    r = estimate_delay(x, y, SR, max_lag=100, window=None)
    assert abs(r.refined_delay - d) < 0.12


def test_inverted_detected_without_false_lag():
    x = _burst(seed=3)
    y = -fractional_shift(x, 4.0)
    r = estimate_delay(x, y, SR, max_lag=100, window=None)
    assert r.polarity == -1
    assert abs(r.refined_delay - 4.0) < 0.25


def test_rhythmic_peaks_are_flagged():
    s = make_preset("rhythmic")
    a, b, *_ = s.ch0[:], s.ch1[:], 0, 0
    r = estimate_delay(a, b, s.sr, max_lag=int(0.05 * s.sr), top_k=6)
    amb = [p for p in r.peaks[1:] if p.ambiguous]
    assert amb, "周期信号应保留近似等高的候选峰"
    gaps = {abs(p.lag - r.main_peak.lag) for p in amb}
    assert any(abs(g - 1920) < 8 for g in gaps)


def test_normalized_xcorr_bounded():
    x = _burst(seed=4)
    ncc, lags = normalized_xcorr(x, x, 50)
    assert np.max(ncc) <= 1.0001
    assert abs(lags[np.argmax(ncc)]) == 0


def test_alignment_reduces_lag_to_zero():
    x = _burst(seed=5)
    y = fractional_shift(x, 5.3)
    r = estimate_delay(x, y, SR, max_lag=100, window=None)
    aligned = align_to_reference(y, r.refined_delay, r.polarity)
    r2 = estimate_delay(x, aligned, SR, max_lag=100, window=None)
    assert abs(r2.refined_delay) < 0.1


def test_drift_detected_but_fixed_delay_not():
    fixed = make_preset("clean")
    a = analyze_selection(fixed, 0.2, 0.8)
    assert not a["drift"].changed

    drift = make_preset("drift")
    d = analyze_selection(drift, 0.0, 1.9)
    assert d["drift"].changed
    assert d["drift"].slope_per_s > 10


def test_reference_interval_contains_truth_for_clean():
    s = make_preset("clean")
    a = analyze_selection(s, 0.15, 0.8)
    _, lo, hi, _ = a["ref_interval"]
    assert lo - 1e-6 <= s.truth_delay <= hi + 1e-6


def test_report_and_export_roundtrip(tmp_path):
    s = make_preset("low_snr")
    a = analyze_selection(s, 0.15, 0.8)
    rep = build_report(s, a, a["selected"].refined_lag, s.truth_delay)
    assert rep["detected"]["confidence_label"] in {"高", "中", "低"}
    assert rep["truth"]["in_reference_interval"] is not None
    paths = export_alignment(tmp_path, "unit", a["ch0"], a["ch1"], a["sr"],
                             a["selected"].refined_lag, a["result"].polarity, rep)
    chk = verify_aligned_wav(paths["aligned_wav"], s.sr)
    assert chk["channels"] == 2
    assert abs(chk["lag"]) < 0.5
    assert chk["polarity"] == 1
    assert paths["report_json"].endswith(".json")


def test_all_presets_run():
    for key, _name, _fn in presets():
        s = make_preset(key)
        a = analyze_selection(s, *s.selection)
        assert a["result"].peaks
        assert np.all(np.isfinite(a["result"].correlogram))
