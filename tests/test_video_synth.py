"""ffmpeg round-trip tests: decode, timestamps (incl. VFR), synth samples."""
import numpy as np
import pytest

from slitscan import synth
from slitscan.video import decode_frames, probe


def test_probe_reports_dimensions(sample_clips):
    info = probe(str(sample_clips["constant"]))
    assert (info.width, info.height) == (synth.WIDTH, synth.HEIGHT)
    assert info.frame_count == 30
    assert info.duration > 0


def test_decode_matches_probe_count(sample_clips):
    path = str(sample_clips["constant"])
    info = probe(path)
    frames, ts = decode_frames(path, info)
    assert frames.shape == (30, synth.HEIGHT, synth.WIDTH, 3)
    assert frames.dtype == np.uint8
    assert len(ts) == 30


def test_cfr_timestamps_are_even(sample_clips):
    info = probe(str(sample_clips["constant"]))
    dts = np.diff(info.timestamps)
    assert np.allclose(dts, dts[0], rtol=0.05)
    assert info.is_vfr is False


def test_vfr_timestamps_are_uneven(sample_clips):
    info = probe(str(sample_clips["vfr"]))
    dts = np.diff(info.timestamps)
    assert np.std(dts) > 1e-3
    assert info.is_vfr is True
    # total duration is still comparable to the CFR clip (same nominal fps)
    assert info.timestamps[-1] == pytest.approx(3.0, abs=0.3)


def test_encoded_frame_id_survives_encoding(sample_clips):
    path = str(sample_clips["constant"])
    info = probe(path)
    frames, _ = decode_frames(path, info)
    # luminance barcode must survive the lossy h264/yuv420p round trip
    for i in (0, 7, 15, 29):
        assert synth.read_encoded_index(frames[i]) == i % 32
    # the pure renderer is, of course, exact
    f7 = synth.render_frame("constant", 7, 0.7, 3.0)
    assert synth.read_encoded_index(f7) == 7


def test_reverse_pattern_contains_both_motion_directions(sample_clips):
    path = str(sample_clips["reverse"])
    info = probe(path)
    frames, _ = decode_frames(path, info)
    # bar centroid per frame from brightness
    def centroid(frame):
        col_bright = frame[:, :, :3].mean(axis=(0, 2))
        xs = np.arange(len(col_bright))
        return float((xs * col_bright).sum() / max(col_bright.sum(), 1))

    centroids = np.array([centroid(f) for f in frames])
    diffs = np.diff(centroids)
    assert np.any(diffs > 0.2) and np.any(diffs < -0.2)
