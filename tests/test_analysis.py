"""核心算法测试: 合成、检测、重复键合并、短停顿、拒绝理由、导出与历史对比."""

from __future__ import annotations

import csv
import json

import numpy as np
import pytest

from dtmf_lab.analysis import (
    DetectionSettings,
    detect,
    diff_results,
    diff_summary,
    export_result_json,
    export_segments_csv,
    frame_readout,
    spectrum_at,
)
from dtmf_lab.samples import SCENARIOS, render_scenario, scenario_by_name
from dtmf_lab.tones import (
    HIGH_GROUP,
    KEYPAD,
    LOW_GROUP,
    SynthSettings,
    ToneOverride,
    normalize_key_input,
    synthesize,
)
from dtmf_lab.wavio import load_wav, save_wav

ALL_KEYS = "123A456B789C*0#D"


# ---------- 合成 ----------


def test_keypad_frequencies_are_the_standard_groups():
    assert KEYPAD["1"] == (697.0, 1209.0)
    assert KEYPAD["9"] == (852.0, 1477.0)
    assert KEYPAD["0"] == (941.0, 1336.0)
    assert KEYPAD["D"] == (941.0, 1633.0)
    assert len(KEYPAD) == 16


def test_synthesize_places_each_key_with_gaps():
    settings = SynthSettings(key_ms=80, gap_ms=50, lead_ms=100, tail_ms=100)
    result = synthesize("123", settings)
    assert result.duration == pytest.approx(0.1 + 0.08 * 3 + 0.05 * 2 + 0.1, abs=1e-3)
    starts = [seg[1] for seg in result.segments]
    ends = [seg[2] for seg in result.segments]
    for i in range(len(starts) - 1):
        assert ends[i] + 0.05 == pytest.approx(starts[i + 1], abs=1e-3)


def test_gain_split_controls_group_strength():
    quiet_low = synthesize("5", SynthSettings(low_gain=0.1, high_gain=0.5))
    loud_low = synthesize("5", SynthSettings(low_gain=0.5, high_gain=0.1))
    # 不同增益组合下总峰值应接近 (归一化), 但两组音的相对强度要反过来
    from dtmf_lab.analysis import analyze_core

    seg = slice(int(0.32 * 8000), int(0.37 * 8000))
    m1 = analyze_core(quiet_low.samples[seg], 8000, DetectionSettings())
    m2 = analyze_core(loud_low.samples[seg], 8000, DetectionSettings())
    assert m1["twist_db"] > 0 > m2["twist_db"]
    assert abs(m1["twist_db"]) > 8 and abs(m2["twist_db"]) > 8


def test_normalize_key_input_accepts_separators_and_rejects_unknown():
    assert normalize_key_input("1 2,3|A") == "123A"
    assert normalize_key_input("1\t2\n3") == "123"
    assert normalize_key_input("ab*#") == "AB*#"
    with pytest.raises(ValueError):
        normalize_key_input("12X")


def test_invalid_synth_settings_are_rejected():
    with pytest.raises(ValueError):
        synthesize("1", SynthSettings(key_ms=1))
    with pytest.raises(ValueError):
        synthesize("", SynthSettings())
    with pytest.raises(ValueError):
        synthesize("1", SynthSettings(low_gain=2.0))
    with pytest.raises(ValueError):
        synthesize("123", SynthSettings(), [ToneOverride(), ToneOverride()])


# ---------- 基础识别 ----------


def test_clean_sequence_round_trips_every_key():
    for key in ALL_KEYS:
        result = synthesize(key, SynthSettings(key_ms=80, gap_ms=60))
        detected = detect(result.samples, result.sample_rate, DetectionSettings())
        assert detected.keys == key, f"键 {key} 未正确识别, 得到 {detected.keys!r}"
        assert len(detected.confirmed) == 1
        assert detected.rejected == []


def test_detected_boundaries_match_synthesis():
    settings = SynthSettings(key_ms=90, gap_ms=70)
    result = synthesize("1234", settings)
    detected = detect(result.samples, result.sample_rate, DetectionSettings())
    for (key, t0, t1), seg in zip(result.segments, detected.accepted):
        assert seg.key == key
        assert abs(seg.start_s - t0) < 0.02
        assert abs(seg.end_s - t1) < 0.02
        assert seg.duration_ms == pytest.approx(90, abs=8)


# ---------- 按住 / 重复键 ----------


def test_long_hold_produces_exactly_one_result():
    result = synthesize("5", SynthSettings(key_ms=2000))
    detected = detect(result.samples, result.sample_rate, DetectionSettings())
    assert detected.keys == "5"
    assert len(detected.accepted) == 1
    assert detected.accepted[0].duration_ms > 1800


def test_same_key_with_real_release_stays_two_keys():
    result = synthesize("55", SynthSettings(gap_ms=70))
    detected = detect(result.samples, result.sample_rate, DetectionSettings())
    assert detected.keys == "55"
    assert len(detected.accepted) == 2
    assert all(seg.verdict == "accept" for seg in detected.accepted)


def test_repeated_same_key_with_tiny_gap_is_merged_and_flagged():
    result = synthesize("55", SynthSettings(gap_ms=20))
    detected = detect(result.samples, result.sample_rate, DetectionSettings(min_release_ms=40))
    assert detected.keys == "5"  # 合并成一次按住
    assert len(detected.accepted) == 1
    seg = detected.accepted[0]
    assert seg.verdict == "review"
    assert seg.reason_code == "merged_hold"
    assert seg.merged_from == 2
    assert any("空白" in note for note in seg.notes)


def test_loosening_min_release_splits_the_same_audio():
    result = synthesize("55", SynthSettings(gap_ms=20))
    loose = detect(result.samples, result.sample_rate, DetectionSettings(min_release_ms=10))
    assert loose.keys == "55"
    assert len(loose.accepted) == 2


def test_different_keys_with_short_gap_are_flagged_but_kept():
    result = synthesize("12", SynthSettings(gap_ms=15))
    detected = detect(result.samples, result.sample_rate, DetectionSettings(min_release_ms=40))
    assert detected.keys == "12"
    assert all(seg.verdict == "review" for seg in detected.accepted)
    assert all(seg.reason_code == "tight_gap" for seg in detected.accepted)


# ---------- 拒绝条件 ----------


def test_single_tone_is_rejected_with_missing_component_reason():
    result = synthesize("6", SynthSettings(), [ToneOverride(drop_high=True)])
    detected = detect(result.samples, result.sample_rate, DetectionSettings())
    assert detected.keys == ""
    assert len(detected.rejected) == 1
    seg = detected.rejected[0]
    assert seg.reason_code == "missing_component"
    assert "缺少" in seg.reason
    assert seg.key is None


def test_non_adjacent_dual_tone_is_not_a_key():
    """两支音都在, 但频率不靠近任何一组标称值时不能算成功."""
    sr = 8000
    n = int(0.1 * sr)
    t = np.arange(n) / sr
    wave = 0.45 * np.sin(2 * np.pi * 710 * t) + 0.45 * np.sin(2 * np.pi * 1280 * t)
    data = np.concatenate([np.zeros(1600), wave, np.zeros(1600)]).astype(np.float32)
    seg = detect(data, sr, DetectionSettings())
    assert seg.keys == ""
    assert seg.rejected
    assert seg.rejected[0].reason_code == "off_frequency"


def test_frequency_outside_tolerance_is_rejected():
    result = synthesize("0", SynthSettings(), [ToneOverride(high_offset_hz=-40)])
    detected = detect(result.samples, result.sample_rate, DetectionSettings())
    assert detected.keys == ""
    assert detected.rejected[0].reason_code == "off_frequency"


def test_frequency_slightly_off_is_review_not_accept():
    result = synthesize("8", SynthSettings(), [ToneOverride(low_offset_hz=8.0)])
    detected = detect(result.samples, result.sample_rate, DetectionSettings())
    assert detected.keys == "8"
    seg = detected.accepted[0]
    assert seg.verdict == "review"
    assert any("容差" in note for note in seg.notes)


def test_heavy_twist_is_rejected():
    result = synthesize("9", SynthSettings(), [ToneOverride(low_gain=0.05)])
    detected = detect(result.samples, result.sample_rate, DetectionSettings())
    assert detected.keys == ""
    assert detected.rejected[0].reason_code == "twist"


def test_mild_twist_is_review():
    result = synthesize("7", SynthSettings(low_gain=0.18, high_gain=0.5))
    detected = detect(result.samples, result.sample_rate, DetectionSettings())
    assert detected.keys == "7"
    assert detected.accepted[0].verdict == "review"


def test_short_key_is_rejected_but_kept_as_candidate():
    result = synthesize("258", SynthSettings(key_ms=25))
    detected = detect(result.samples, result.sample_rate, DetectionSettings())
    assert detected.keys == ""
    assert len(detected.rejected) == 3
    assert all(seg.reason_code == "too_short" for seg in detected.rejected)
    # 缺一支音 / 单支音的情况同样不能成功
    lone = synthesize("3", SynthSettings(), [ToneOverride(drop_low=True)])
    lone_result = detect(lone.samples, lone.sample_rate, DetectionSettings())
    assert lone_result.keys == ""
    assert lone_result.rejected[0].reason_code == "missing_component"


def test_heavy_noise_is_rejected():
    result = synthesize("258", SynthSettings(noise_level=1.0))
    detected = detect(result.samples, result.sample_rate, DetectionSettings())
    assert detected.keys == ""
    assert all(seg.reason_code == "noisy" for seg in detected.rejected)


def test_light_noise_is_flagged_but_recognized():
    result = synthesize("258", SynthSettings(noise_level=0.3))
    detected = detect(result.samples, result.sample_rate, DetectionSettings())
    assert detected.keys == "258"


def test_invalid_detection_settings_raise():
    with pytest.raises(ValueError):
        DetectionSettings(frame_ms=5).validate()
    with pytest.raises(ValueError):
        DetectionSettings(max_twist_db=0).validate()
    with pytest.raises(ValueError):
        detect(np.zeros(8000), 8000, DetectionSettings(min_key_ms=1))


# ---------- 历史对比 ----------


def test_diff_reports_lost_segments():
    strict = synthesize("123", SynthSettings())
    settings_strict = DetectionSettings()
    before = detect(strict.samples, strict.sample_rate, settings_strict)
    # 用一套把短键都拒绝的门限 (100 毫秒) 重识别同一段
    after = detect(strict.samples, strict.sample_rate, DetectionSettings(min_key_ms=100))
    entries = diff_results(after, before)
    assert all(e.kind == "lost" for e in entries)
    assert len(entries) == 3
    summary = diff_summary(entries)
    assert "丢失 3" in summary


def test_diff_detects_new_and_same():
    audio = synthesize("55", SynthSettings(gap_ms=20))
    merged = detect(audio.samples, audio.sample_rate, DetectionSettings(min_release_ms=40))
    split = detect(audio.samples, audio.sample_rate, DetectionSettings(min_release_ms=10))
    forward = diff_results(split, merged)
    kinds = {entry.kind for entry in forward}
    assert "new" in kinds
    backward = diff_results(merged, split)
    assert any(entry.kind == "lost" for entry in backward)


# ---------- 导出 ----------


def test_csv_export_contains_rejected_and_status(tmp_path):
    audio = synthesize("456", SynthSettings(), [ToneOverride(), ToneOverride(drop_low=True), ToneOverride()])
    detected = detect(audio.samples, audio.sample_rate, DetectionSettings())
    path = tmp_path / "清单.csv"
    export_segments_csv(str(path), detected)
    with path.open(encoding="utf-8-sig") as fh:
        rows = list(csv.DictReader(fh))
    assert len(rows) == 3
    statuses = {row["状态"] for row in rows}
    assert "确定" in statuses
    assert "拒绝" in statuses
    rejected_rows = [row for row in rows if row["类别"] == "拒绝候选"]
    assert len(rejected_rows) == 1
    assert rejected_rows[0]["原因代码"] == "missing_component"
    assert rejected_rows[0]["原因"]


def test_json_export_includes_history(tmp_path):
    audio = synthesize("12", SynthSettings())
    r1 = detect(audio.samples, audio.sample_rate, DetectionSettings())
    r2 = detect(audio.samples, audio.sample_rate, DetectionSettings(min_key_ms=200))
    path = tmp_path / "结果.json"
    from dtmf_lab.analysis import DetectionRun, run_to_dict

    run1 = DetectionRun("旧", "10:00:00", "内存音频", r1)
    run2 = DetectionRun("新", "10:00:05", "内存音频", r2)
    export_result_json(str(path), r2, history=[run_to_dict(run1), run_to_dict(run2)])
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["keys"] == ""
    assert len(payload["rejected"]) == 2
    assert len(payload["runs"]) == 2
    assert payload["settings"]["min_key_ms"] == 200.0


def test_wav_round_trip(tmp_path):
    audio = synthesize("10", SynthSettings())
    path = tmp_path / "test.wav"
    save_wav(str(path), audio.samples, audio.sample_rate)
    clip = load_wav(str(path))
    assert clip.sample_rate == audio.sample_rate
    assert clip.duration == pytest.approx(audio.duration, abs=1e-3)
    detected = detect(clip.samples, clip.sample_rate, DetectionSettings())
    assert detected.keys == "10"


# ---------- 光标读数 / 频谱 ----------


def test_frame_readout_on_tone_and_silence():
    audio = synthesize("5", SynthSettings())
    settings = DetectionSettings()
    on_tone = frame_readout(audio.samples, audio.sample_rate, 0.35, settings)
    assert on_tone.key == "5"
    assert on_tone.verdict in ("accept", "review")
    in_gap = frame_readout(audio.samples, audio.sample_rate, 0.15, settings)
    assert in_gap.key is None
    assert in_gap.verdict == "reject"
    assert in_gap.reason_code in ("no_tone", "missing_component")


def test_spectrum_has_peaks_at_nominal_frequencies():
    audio = synthesize("9", SynthSettings())
    freqs, mag = spectrum_at(audio.samples, audio.sample_rate, 0.35, window_ms=50)
    low_f, high_f = KEYPAD["9"]
    def amp_at(f):
        return float(mag[np.argmin(np.abs(freqs - f))])
    baseline = float(np.median(mag))
    assert amp_at(low_f) > baseline * 5
    assert amp_at(high_f) > baseline * 5


# ---------- 场景 ----------


@pytest.mark.parametrize("scenario_name", [s.name for s in SCENARIOS])
def test_every_scenario_runs(scenario_name):
    scenario = scenario_by_name(scenario_name)
    audio = render_scenario(scenario)
    detected = detect(audio.samples, audio.sample_rate, DetectionSettings())
    # 所有场景都应产出至少一个按键或一个带原因的拒绝候选
    assert detected.all_segments(), f"场景 {scenario_name} 没有任何结果"
    for seg in detected.rejected:
        assert seg.reason and seg.reason_code


def test_scenarios_cover_required_cases():
    names = {s.name for s in SCENARIOS}
    must_have = {
        "hold_repeat",  # 连续重复键
        "fast_repeat",  # 停顿短于可分辨范围 (同键)
        "fast_pair",  # 停顿短于可分辨范围 (不同键)
        "missing_high",  # 缺一支音
        "short_key",  # 短键
        "slight_offset",  # 轻微频差
        "twist_heavy",  # 强弱差很大
        "noisy_light",  # 背景声
    }
    assert must_have <= names


def test_scenario_expectations_hold():
    checks = {
        "clean_digits": lambda r: r.keys == "123A" and len(r.confirmed) == 4,
        "hold_repeat": lambda r: r.keys == "555",
        "hold_long": lambda r: r.keys == "5" and len(r.accepted) == 1,
        "fast_repeat": lambda r: r.keys == "5" and r.accepted[0].verdict == "review",
        "fast_pair": lambda r: r.keys == "12" and all(s.verdict == "review" for s in r.accepted),
        "missing_high": lambda r: r.keys == "" and r.rejected[0].reason_code == "missing_component",
        "short_key": lambda r: r.keys == "" and all(s.reason_code == "too_short" for s in r.rejected),
        "slight_offset": lambda r: r.keys == "8" and r.accepted[0].verdict == "review",
        "big_offset": lambda r: r.keys == "" and r.rejected[0].reason_code == "off_frequency",
        "twist_heavy": lambda r: r.keys == "" and r.rejected[0].reason_code == "twist",
        "noisy_heavy": lambda r: r.keys == "" and all(s.reason_code == "noisy" for s in r.rejected),
        "solo_tone": lambda r: r.keys == "" and r.rejected[0].reason_code == "missing_component",
    }
    for name, predicate in checks.items():
        audio = render_scenario(scenario_by_name(name))
        detected = detect(audio.samples, audio.sample_rate, DetectionSettings())
        assert predicate(detected), f"场景 {name} 的结果不符合期望: keys={detected.keys!r}"


# ---------- 帮助函数 ----------


def test_group_constants_cover_all_keys():
    used_low = {KEYPAD[k][0] for k in KEYPAD}
    used_high = {KEYPAD[k][1] for k in KEYPAD}
    assert used_low == set(LOW_GROUP)
    assert used_high == set(HIGH_GROUP)


# ---------- 稳健性 ----------


@pytest.mark.parametrize(
    "data",
    [
        np.zeros(8000),
        np.zeros(40),
        np.array([0.5]),
        np.random.default_rng(0).normal(0, 1e-4, 8000),
        np.ones(8000) * 0.3,
    ],
)
def test_silent_and_degenerate_inputs_do_not_crash(data):
    result = detect(data, 8000, DetectionSettings())
    assert result.keys == ""
    # 不能凭空认出按键
    assert result.confirmed == []


def test_low_level_signal_at_end_of_noisy_recording_is_found():
    """按键在长录音的末尾、且音量不占主导时, 峰值不能只按 95 分位估."""
    sr = 8000
    noise = np.random.default_rng(3).normal(0, 0.02, sr * 3)
    t = np.arange(int(0.09 * sr)) / sr
    burst = 0.45 * np.sin(2 * np.pi * 697 * t) + 0.45 * np.sin(2 * np.pi * 1209 * t)
    data = np.concatenate([noise, burst, np.zeros(1600)]).astype(np.float32)
    detected = detect(data, sr, DetectionSettings())
    assert detected.keys == "1"
    # 底噪本身不能被当成几十条候选
    assert len(detected.all_segments()) == 1


def test_ten_millisecond_key_is_reported_not_silently_dropped():
    audio = synthesize("5", SynthSettings(key_ms=10))
    detected = detect(audio.samples, audio.sample_rate, DetectionSettings())
    assert detected.keys == ""
    assert len(detected.rejected) == 1
    assert detected.rejected[0].reason_code == "too_short"


def test_long_key_duration_is_measured_accurately():
    audio = synthesize("5", SynthSettings(key_ms=500))
    detected = detect(audio.samples, audio.sample_rate, DetectionSettings())
    assert detected.keys == "5"
    assert detected.accepted[0].duration_ms == pytest.approx(500, abs=12)
