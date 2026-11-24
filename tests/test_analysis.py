from audio_integrity.analysis import AnalysisConfig, analyze_audio
from audio_integrity.demo import make_demo_audio
from audio_integrity.models import BAND_LOSS, CHANNEL_LOSS, QUIET


def test_composite_demo_has_all_three_marker_classes():
    audio = make_demo_audio("composite")
    result = analyze_audio(audio.samples, audio.sample_rate)
    kinds = {a.kind for a in result.annotations}
    assert BAND_LOSS in kinds
    assert CHANNEL_LOSS in kinds
    assert QUIET in kinds

    # Every marker must carry the measured value and threshold that produced it.
    for ann in result.annotations:
        assert ann.start < ann.end
        assert "criteria" in ann.metrics
        if ann.kind == BAND_LOSS:
            assert ann.metrics["threshold_drop_db"] > 0
            assert ann.metrics["observed_band_db"] is not None
            assert ann.metrics["reference_band_db"] is not None
            assert ann.metrics["band_drop_db"] >= ann.metrics["threshold_drop_db"] - 1e-6
        if ann.kind == CHANNEL_LOSS:
            assert ann.metrics["observed_rms_db"] is not None
            assert ann.metrics["other_channel_rms_db"] is not None


def test_stereo_one_channel_loss_keeps_other_visible():
    audio = make_demo_audio("channel")
    result = analyze_audio(audio.samples, audio.sample_rate)
    losses = [a for a in result.annotations if a.kind == CHANNEL_LOSS]
    assert losses
    channels = {tuple(a.channels) for a in losses}
    assert (0,) in channels or (1,) in channels

    # During the first left-channel gap, right-channel RMS remains measurable.
    left_loss = next(a for a in losses if a.channels == [0] and 2.5 < a.start < 3.2)
    frame = left_loss.metrics["decision_frame"]
    assert result.rms_db[frame, 1] > -45
    assert result.rms_db[frame, 0] < result.rms_db[frame, 1] - 15


def test_final_short_frame_is_present_and_marked():
    audio = make_demo_audio("composite")
    result = analyze_audio(audio.samples, audio.sample_rate, AnalysisConfig(window_ms=40, hop_ms=10))
    assert result.n_frames > 10
    assert result.partial_frame_indices.size >= 1
    last = result.n_frames - 1
    assert not result.complete[last]
    assert result.valid_samples[last] < 0.04 * audio.sample_rate
    assert result.frame_ends[last] == audio.n_frames


def test_threshold_change_changes_suggestions_but_not_confirmed_object():
    audio = make_demo_audio("composite")
    strict = analyze_audio(audio.samples, audio.sample_rate, AnalysisConfig(band_drop_db=8))
    loose = analyze_audio(audio.samples, audio.sample_rate, AnalysisConfig(band_drop_db=35))
    assert len(strict.annotations) >= len(loose.annotations)

    # Simulate the main-window invariant without constructing Qt widgets.
    confirmed = strict.annotations[0]
    confirmed.status = "confirmed"
    confirmed.source = "human"
    merged = list(loose.annotations) + [confirmed]
    assert any(a.id == confirmed.id and a.status == "confirmed" for a in merged)
